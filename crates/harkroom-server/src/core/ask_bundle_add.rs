//! S5.3 C3b-2b-2 — MCP `message.askBundle` 중 **있던 묶음에 줄을 더하는 길**(`bundleId` 가 있을 때). TS `services/askBundles.ts` 의
//! `upsertAskBundle`(있던 묶음 갈래)·`prepareItems`, `messages.ts` 의 `checkAskMirror`·`askBundleItemFor`·`gateAwaitingAccount`,
//! `push/pushJobs.ts` 의 `enqueueBundlePush`, `mcpPlugin.ts` 의 묶음 푸시를 옮긴다.
//!
//! - **새 묶음 세우기**(`bundleId` 없음, P6-4e)는 판정([`prepare_new`])과 커밋 뒤 알림·푸시([`after_new`])만 여기 있고, 글 쓰기는
//!   `mcp::msg_post::answer_bundle_new` 가 서비스 `postMessage` 와 같은 길로 한다.
//! - **담을 수 있는 원본**은 TS `checkAskMirror` 와 같다: 원본이 있고, **부른 에이전트가 그 채널을 볼 수 있고**, 거울이 아니고,
//!   사람 앞이고, 열려 있어야 한다. 하나라도 거절이면 아무것도 담지 않는다(`rootId` 를 실어 거절).
//! - 줄의 사본(물음·선택지·`link`)은 **서버가 원본 meta 에서 만든다**. 에이전트가 주는 것은 원본 id 뿐이다 — 권한 요청·머지 거절
//!   카드의 `link` 표지도 원본 meta 로 붙인다.
//! - TS 로 넘기는 원본(닫힌 쪽): 권한 거울 표지가 있으면 요청 전체를 읽은 바이트 그대로 TS 로. 사본의 물음 글자를
//!   JS 와 같게 자를 수 없는 경우(서로게이트 쌍 가운데서 잘림, 물음이 글자가 아님)도 TS 로.
//! - 묶음 바꾸기·묶음과 새로 담긴 원본의 `message.updated`·묶음 푸시는 한 트랜잭션이다. 쓰기를 시작한 뒤의 DB 오류는 TS 로 넘기지 않고
//!   고정 문장의 도구 오류로 답한다(security W1).
use super::ask::read_ask_meta;
use super::ask_sync::announce_updated;
use super::msg_read::{channel_visible, is_uuid, message_by_id};
use crate::auth::Account;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::sync::OnceLock;

/// 이 길이 쓰는 권한 — C3b-1 `ASK_PRIVILEGES`(글 meta UPDATE·outbox) + 묶음 푸시(`push_job` INSERT).
pub const ASK_BUNDLE_ADD_PRIVILEGES: &[(&str, &str)] = &[
    ("message.meta", "UPDATE"),
    ("event_outbox", "INSERT"),
    ("push_job", "INSERT"),
];
pub const ASK_BUNDLE_ADD_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// TS shared `ASK_BUNDLE_MAX_ITEMS`·`MAX_MESSAGE_BODY_CHARS`·`MODEL_ID_MAX`, pushJobs `BUNDLE_PUSH_WINDOW_SEC`.
pub const ASK_BUNDLE_MAX_ITEMS: usize = 20;
const MAX_MESSAGE_BODY_CHARS: usize = 8000;
const MODEL_ID_MAX: usize = 120;
const BUNDLE_PUSH_WINDOW_SEC: i32 = 60;
const PROMPT_MAX: usize = 200;

/// TS `ASK_BUNDLE_REFUSAL_MESSAGE` 중 이 길이 쓰는 줄(`bundle_full` 은 상한을 끼운 글자).
pub const REFUSALS: &[(&str, &str)] = &[
    (
        "mirror_not_found",
        "no such choice request, or you cannot see its channel",
    ),
    (
        "mirror_of_mirror",
        "that card is itself a mirror — bundle the original card",
    ),
    (
        "mirror_not_human",
        "only cards addressed to humans can be bundled",
    ),
    ("mirror_resolved", "that card is already answered or closed"),
    ("bundle_not_found", "no such bundle card"),
    (
        "bundle_not_yours",
        "only the agent that posted the bundle can change it",
    ),
    (
        "bundle_other_thread",
        "the bundle lives in another channel or thread",
    ),
    (
        "bundle_full",
        "a bundle holds at most 20 rows — open a new bundle",
    ),
];

pub fn refusal_message(code: &str) -> &'static str {
    REFUSALS
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, m)| *m)
        .expect("refusal text")
}

#[derive(Debug)]
pub enum Added {
    /// 고친 뒤의 묶음 글(JSON 글자).
    Bundle(String),
    /// 거절 — (코드, 걸린 원본 id).
    Refused(&'static str, Option<String>),
    /// 채널을 못 본다(TS `forbidden`).
    Forbidden,
    Handoff,
}

pub struct Args<'a> {
    pub channel: &'a str,
    pub thread_root: &'a str,
    /// 없으면 새 묶음(P6-4e — [`crate::core::mcp`] `msg_post::answer_bundle_new`).
    pub bundle: Option<&'a str>,
    pub roots: Vec<&'a str>,
}

fn utf16_in(s: &str, lo: usize, hi: usize) -> bool {
    (lo..=hi).contains(&s.encode_utf16().count())
}

/// zod 입력 스키마 그대로 받는 것만. `bundleId` 는 없을 수 있다(새 묶음). 모양이 틀리면 None(TS 의 검증 오류).
pub fn parse_args(args: &Value) -> Option<Args<'_>> {
    let o = args.as_object()?;
    let id = |k: &str| o.get(k)?.as_str().filter(|s| is_uuid(s));
    let body = o.get("body")?.as_str()?;
    if !utf16_in(body, 1, MAX_MESSAGE_BODY_CHARS) {
        return None;
    }
    if let Some(m) = o.get("model")
        && !m.as_str().is_some_and(|m| utf16_in(m, 1, MODEL_ID_MAX))
    {
        return None;
    }
    let items = o.get("items")?.as_array()?;
    if !(1..=ASK_BUNDLE_MAX_ITEMS).contains(&items.len()) {
        return None;
    }
    let mut roots = Vec::with_capacity(items.len());
    for i in items {
        let r = i
            .as_object()?
            .get("mirrorOf")?
            .as_str()
            .filter(|s| is_uuid(s))?;
        // TS `[...new Set(rootIds)]` — 처음 나온 자리.
        if !roots.contains(&r) {
            roots.push(r);
        }
    }
    Some(Args {
        channel: id("channelId")?,
        thread_root: id("threadRootId")?,
        bundle: match o.get("bundleId") {
            None => None,
            Some(_) => Some(id("bundleId")?),
        },
        roots,
    })
}

struct Sql {
    read: String,
    item_root: String,
    update: String,
    gate: String,
    push: String,
    mention: regex::Regex,
}

/// JS `\s`·`trim` 의 글자(WhiteSpace + LineTerminator).
const JS_SPACE_CLASS: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_string()
        };
        Sql {
            read: format!(
                "select b.meta, b.\"channelId\"::text, b.\"threadRootId\"::text, b.\"authorId\"::text, b.id::text from ({}) b",
                frag("bundle_read")
            ),
            item_root: format!(
                "select r.meta, r.body, r.\"channelId\"::text, r.\"threadRootId\"::text, r.\"authorId\"::text from ({}) r",
                frag("bundle_item_root")
            ),
            update: format!("{} returning id::text", frag("bundle_items_update")),
            gate: frag("gate_awaiting"),
            push: frag("bundle_push"),
            mention: regex::Regex::new(&format!("<@[0-9a-f-]{{36}}>{JS_SPACE_CLASS}*"))
                .expect("mention regex"),
        }
    })
}

/// JS 참·거짓.
fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// 이 원본을 담는 일은 TS 가 한다 — 권한 거울(서버가 세운 카드의 다른 꼴). 연쇄 백스톱은 TS `prepareItems` 도 보통 원본과
/// 같은 판정(`checkAskMirror` — 소유자 계정 앞이라 보통 `mirror_not_human`)이라 Rust 가 맡는다.
const TS_ONLY_MARKERS: &[&str] = &["permissionMirror"];

/// JS `s.slice(0, n)`(UTF-16 단위). 서로게이트 쌍 가운데서 잘리면 None(JS 는 짝 없는 서로게이트를 남긴다 — 같게 못 낸다).
fn js_slice(s: &str, n: usize) -> Option<String> {
    let mut units = 0;
    let mut out = String::new();
    for c in s.chars() {
        let w = c.len_utf16();
        if units + w > n {
            return (units == n).then_some(out);
        }
        units += w;
        out.push(c);
    }
    Some(out)
}

/// TS `askBundleItemFor` — 원본 meta·본문에서 줄 사본을 만든다. 원본이 없거나 물음이 아니면 `Ok(None)`.
/// 같은 글자를 낼 수 없으면 `Err(())`(→ TS).
fn item_from(
    root_id: &str,
    meta: &Value,
    body: &str,
    channel: &str,
    thread_root: Option<&str>,
    author: Option<&str>,
) -> Result<Option<Value>, ()> {
    if read_ask_meta(meta).is_none() {
        return Ok(None);
    }
    let ask = &meta["ask"];
    let prompt = match ask.get("prompt") {
        None | Some(Value::Null) => {
            let stripped = sql().mention.replace_all(body, "");
            stripped
                .split('\n')
                .map(|l| l.trim_matches(js_space))
                .find(|l| !l.is_empty())
                .unwrap_or("")
                .to_owned()
        }
        Some(Value::String(p)) => p.clone(),
        Some(_) => return Err(()),
    };
    let prompt = js_slice(&prompt, PROMPT_MAX).ok_or(())?;
    let mut options = Vec::new();
    for o in ask["options"].as_array().into_iter().flatten() {
        let mut m = Map::new();
        m.insert("id".into(), o["id"].clone());
        m.insert("label".into(), o["label"].clone());
        if js_truthy(o.get("hint")) {
            m.insert("hint".into(), o["hint"].clone());
        }
        if js_truthy(o.get("recommended")) {
            m.insert("recommended".into(), Value::Bool(true));
        }
        options.push(Value::Object(m));
    }
    let mut item = json!({
        "rootId": root_id, "askerId": author, "channelId": channel, "threadRootId": thread_root,
        "prompt": prompt, "options": options,
    });
    // 옛 앱용 `link` 표지 — 에이전트가 준 값이 아니라 **원본 meta** 로 서버가 붙인다.
    if js_truthy(meta.get("permissionRequest")) || js_truthy(meta.get("mergeDenial")) {
        item["link"] = Value::Bool(true);
    }
    Ok(Some(item))
}

type RootRow = (Value, String, String, Option<String>, Option<String>);
type BundleRow = (Value, String, Option<String>, Option<String>, String);

enum Prepared {
    Items(Vec<Value>),
    Refused(&'static str, String),
    Handoff,
}

/// TS `prepareItems`(+ `checkAskMirror`). 하나라도 거절이면 아무것도 담지 않는다.
async fn prepare(read: &PgPool, caller: &str, roots: &[&str]) -> sqlx::Result<Prepared> {
    let mut items = Vec::with_capacity(roots.len());
    for root in roots {
        let row: Option<RootRow> = sqlx::query_as(sql().item_root.as_str())
            .bind(*root)
            .fetch_optional(read)
            .await?;
        let refuse = |c: &'static str| Ok(Prepared::Refused(c, (*root).to_owned()));
        let Some((meta, body, channel, thread_root, author)) = row else {
            return refuse("mirror_not_found");
        };
        let Some(ask) = read_ask_meta(&meta) else {
            return refuse("mirror_not_found");
        };
        // 담을 수 있는 원본 범위 — 부른 에이전트가 그 채널을 볼 수 있어야 한다.
        if !channel_visible(read, caller, &channel).await? {
            return refuse("mirror_not_found");
        }
        if js_truthy(meta["ask"].get("mirrorOf")) {
            return refuse("mirror_of_mirror");
        }
        if !ask.to_human() {
            return refuse("mirror_not_human");
        }
        if ask.answered || ask.closed {
            return refuse("mirror_resolved");
        }
        match item_from(
            root,
            &meta,
            &body,
            &channel,
            thread_root.as_deref(),
            author.as_deref(),
        ) {
            Ok(Some(item)) => items.push(item),
            Ok(None) => return refuse("mirror_not_found"),
            Err(()) => return Ok(Prepared::Handoff),
        }
    }
    Ok(Prepared::Items(items))
}

/// 넘길 원본이 하나라도 있나(닫힌 쪽 — 못 읽으면 넘긴다).
async fn any_ts_only(read: &PgPool, roots: &[&str]) -> sqlx::Result<bool> {
    for root in roots {
        let meta: Option<Value> = sqlx::query_scalar(
            "select meta from message where id = $1::uuid and deleted_at is null",
        )
        .bind(*root)
        .fetch_optional(read)
        .await?;
        if let Some(meta) = meta
            && TS_ONLY_MARKERS.iter().any(|k| meta.get(*k).is_some())
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 쓰기 전의 판정 — 읽기 풀로. (있던 줄, 새 줄 목록, 새로 담긴 원본 id) 또는 끝난 답.
async fn check(
    read: &PgPool,
    me: &str,
    a: &Args<'_>,
    bundle: &str,
) -> sqlx::Result<Result<(Vec<Value>, Vec<String>), Added>> {
    use Added::{Forbidden, Handoff, Refused};
    if !channel_visible(read, me, a.channel).await? {
        return Ok(Err(Forbidden));
    }
    if any_ts_only(read, &a.roots).await? {
        return Ok(Err(Handoff));
    }
    let row: Option<BundleRow> = sqlx::query_as(sql().read.as_str())
        .bind(bundle)
        .fetch_optional(read)
        .await?;
    let Some((meta, channel, thread_root, author, id)) = row else {
        return Ok(Err(Refused("bundle_not_found", None)));
    };
    // TS `readAskBundleMeta` — 줄은 고치지 않고 그대로 둔다(옛 사본의 모르는 칸도).
    let existing: Option<Vec<Value>> = (meta.get("kind").and_then(Value::as_str)
        == Some("askBundle"))
    .then(|| meta.get("askBundle").filter(|b| b.is_object()))
    .flatten()
    .and_then(|b| b.get("items")?.as_array().cloned())
    .filter(|items| {
        items.iter().all(|i| {
            i.get("rootId").is_some_and(Value::is_string)
                && i.get("options").is_some_and(Value::is_array)
        })
    });
    let Some(existing) = existing else {
        return Ok(Err(Refused("bundle_not_found", None)));
    };
    if author.as_deref() != Some(me) {
        return Ok(Err(Refused("bundle_not_yours", None)));
    }
    if channel != a.channel || thread_root.as_deref().unwrap_or(&id) != a.thread_root {
        return Ok(Err(Refused("bundle_other_thread", None)));
    }
    let prepared = match prepare(read, me, &a.roots).await? {
        Prepared::Items(i) => i,
        Prepared::Refused(c, r) => return Ok(Err(Refused(c, Some(r)))),
        Prepared::Handoff => return Ok(Err(Handoff)),
    };
    // TS `new Map(existing.map(i => [i.rootId, i]))` 뒤 `set` — 처음 자리를 지키고 값은 나중 것.
    let root_of = |v: &Value| v["rootId"].as_str().unwrap_or_default().to_owned();
    let mut merged: Vec<(String, Value)> = Vec::new();
    for item in existing.iter().chain(prepared.iter()) {
        let k = root_of(item);
        match merged.iter_mut().find(|(r, _)| *r == k) {
            Some(slot) => slot.1 = item.clone(),
            None => merged.push((k, item.clone())),
        }
    }
    if merged.len() > ASK_BUNDLE_MAX_ITEMS {
        return Ok(Err(Refused("bundle_full", None)));
    }
    let added: Vec<String> = prepared
        .iter()
        .map(root_of)
        .filter(|r| !existing.iter().any(|e| root_of(e) == *r))
        .collect();
    Ok(Ok((merged.into_iter().map(|(_, v)| v).collect(), added)))
}

/// 있던 묶음에 줄을 더한다. `Err` 는 쓰기를 시작한 뒤의 DB 오류다(그 tx 는 버려진다).
/// 쓰기 전 판정의 DB 오류는 `Ok(Handoff)` — 아무것도 쓰지 않았으니 TS 가 처음부터 다시 한다.
pub async fn add(
    read: &PgPool,
    write: &PgPool,
    me: &Account,
    a: &Args<'_>,
    cause: Option<&str>,
) -> sqlx::Result<Added> {
    let Some(bundle) = a.bundle else {
        return Ok(Added::Handoff);
    };
    let (items, added) = match check(read, &me.id, a, bundle).await {
        Ok(Ok(v)) => v,
        Ok(Err(r)) => return Ok(r),
        Err(_) => return Ok(Added::Handoff),
    };
    let mut tx = write.begin().await?;
    let updated: Option<String> = sqlx::query_scalar(sql().update.as_str())
        .bind(bundle)
        .bind(Value::Array(items).to_string())
        .fetch_optional(&mut *tx)
        .await?;
    let Some(bundle_id) = updated else {
        return Ok(Added::Refused("bundle_not_found", None));
    };
    announce_updated(&mut tx, &bundle_id).await?;
    // 묶음에 새로 담긴 원본 — 원 스레드의 🙋 가 바뀌므로 "다시 읽어라"(TS `announceBundledRoots`).
    for id in &added {
        announce_updated(&mut tx, id).await?;
    }
    // 묶음 푸시 — 새 줄이 생겼을 때만, 그 턴의 차례 주인에게(원인 헤더를 확인한 뒤).
    if !added.is_empty()
        && let Some(cause) = cause
    {
        let awaiting: Option<String> = sqlx::query_scalar(sql().gate.as_str())
            .bind(&me.id)
            .bind(cause)
            .bind(a.channel)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some(awaiting) = awaiting {
            sqlx::query(sql().push.as_str())
                .bind(&awaiting)
                .bind(&bundle_id)
                .bind(BUNDLE_PUSH_WINDOW_SEC)
                .execute(&mut *tx)
                .await?;
        }
    }
    let fresh = message_by_id(&mut *tx, &bundle_id).await?;
    tx.commit().await?;
    Ok(match fresh {
        Some(row) => Added::Bundle(row),
        None => Added::Refused("bundle_not_found", None),
    })
}

/// TS `bundlesHolding` — 이 원본을 줄로 담은(지우지 않은) 묶음 카드들.
pub const BUNDLES_HOLDING_SQL: &str = "select id::text from message
      where meta->>'kind' = 'askBundle'
        and deleted_at is null
        and meta->'askBundle'->'items' @> jsonb_build_array(jsonb_build_object('rootId', $1::text))";

/// TS `carryBundleItem` 의 묶음 줄 더하기 — 이미 담겼거나 상한이면 쓰지 않는다.
pub const CARRY_BUNDLE_ITEM_SQL: &str = "update message
            set meta = jsonb_set(meta::jsonb, '{askBundle,items}', (meta->'askBundle'->'items') || jsonb_build_array($2::jsonb))
          where id = $1::uuid
            and not (meta->'askBundle'->'items' @> jsonb_build_array(jsonb_build_object('rootId', $3::text)))
            and jsonb_array_length(meta->'askBundle'->'items') < $4
          returning id::text";

/// TS `carryBundleItem` — 대신된 옛 카드를 담은 묶음마다 새 카드를 줄로 더하고 `message.updated` 를 알린다.
/// 새 카드의 줄 사본을 같은 글자로 낼 수 없으면(프롬프트 200 UTF-16 경계가 서로게이트 쌍 가운데) 아무것도 쓰지 않는다 —
/// TS 도 그 경우 짝 없는 서로게이트가 jsonb 에서 거절돼 첫 쓰기에서 던지고 삼키므로 결과가 같다.
/// TS 처럼 오류는 부르는 쪽이 기록만 한다(옛 카드의 닫힘은 이미 기록됐다).
pub async fn carry_bundle_item(
    conn: &mut sqlx::PgConnection,
    old: &str,
    new_id: &str,
) -> sqlx::Result<()> {
    let bundles: Vec<String> = sqlx::query_scalar(BUNDLES_HOLDING_SQL)
        .bind(old)
        .fetch_all(&mut *conn)
        .await?;
    if bundles.is_empty() {
        return Ok(());
    }
    let row: Option<RootRow> = sqlx::query_as(sql().item_root.as_str())
        .bind(new_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some((meta, body, channel, thread_root, author)) = row else {
        return Ok(());
    };
    let Ok(Some(item)) = item_from(
        new_id,
        &meta,
        &body,
        &channel,
        thread_root.as_deref(),
        author.as_deref(),
    ) else {
        return Ok(());
    };
    let item = item.to_string();
    for bundle in &bundles {
        let updated: Option<String> = sqlx::query_scalar(CARRY_BUNDLE_ITEM_SQL)
            .bind(bundle)
            .bind(&item)
            .bind(new_id)
            .bind(ASK_BUNDLE_MAX_ITEMS as i32)
            .fetch_optional(&mut *conn)
            .await?;
        if let Some(id) = updated {
            announce_updated(&mut *conn, &id).await?;
        }
    }
    Ok(())
}

/// 거절 답의 JSON(TS `{ error: { code, message, rootId? } }`).
pub fn refusal_json(code: &'static str, root: Option<&str>) -> String {
    match root {
        Some(r) => format!(
            "{{\"error\":{{\"code\":{},\"message\":{},\"rootId\":{}}}}}",
            Value::from(code),
            Value::from(refusal_message(code)),
            Value::from(r)
        ),
        None => format!(
            "{{\"error\":{{\"code\":{},\"message\":{}}}}}",
            Value::from(code),
            Value::from(refusal_message(code))
        ),
    }
}

/// P6-4e — 새 묶음(`bundleId` 없음)의 쓰기 전 판정. TS 차례 그대로: 채널 가시성(`forbidden`) → `prepareItems`(줄마다 거울 검사)
/// → `bundle_full`. 넘길 원본(권한 거울)·같은 글자를 못 내는 사본은 `Err(Handoff)`. 읽기 풀만 쓴다.
pub async fn prepare_new(
    read: &PgPool,
    me: &str,
    a: &Args<'_>,
) -> sqlx::Result<Result<Vec<Value>, Added>> {
    use Added::{Forbidden, Handoff, Refused};
    if !channel_visible(read, me, a.channel).await? {
        return Ok(Err(Forbidden));
    }
    if any_ts_only(read, &a.roots).await? {
        return Ok(Err(Handoff));
    }
    let items = match prepare(read, me, &a.roots).await? {
        Prepared::Items(i) => i,
        Prepared::Refused(c, r) => return Ok(Err(Refused(c, Some(r)))),
        Prepared::Handoff => return Ok(Err(Handoff)),
    };
    if items.len() > ASK_BUNDLE_MAX_ITEMS {
        return Ok(Err(Refused("bundle_full", None)));
    }
    Ok(Ok(items))
}

/// P6-4e — 새 묶음 글이 커밋된 **뒤**(TS 도 `postMessage` 뒤): 담긴 원본마다 `message.updated`(TS `announceBundledRoots`),
/// 그 턴의 차례 주인이 이 글로 inbox 를 받지 않았으면 묶음 푸시(TS `pushBundle(message.id, notified)`). 한 tx.
pub async fn after_new(
    write: &PgPool,
    me: &str,
    channel: &str,
    bundle_id: &str,
    roots: &[&str],
    notified: &[String],
    cause: Option<&str>,
) -> sqlx::Result<()> {
    let mut tx = write.begin().await?;
    for id in roots {
        announce_updated(&mut tx, id).await?;
    }
    if let Some(cause) = cause {
        let awaiting: Option<String> = sqlx::query_scalar(sql().gate.as_str())
            .bind(me)
            .bind(cause)
            .bind(channel)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some(awaiting) = awaiting.filter(|a| !notified.iter().any(|n| n == a)) {
            sqlx::query(sql().push.as_str())
                .bind(&awaiting)
                .bind(bundle_id)
                .bind(BUNDLE_PUSH_WINDOW_SEC)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusals_follow_ts_source() {
        let shared = include_str!("../../../../packages/shared/src/index.ts");
        assert!(shared.contains("export const ASK_BUNDLE_MAX_ITEMS = 20;"));
        assert!(shared.contains("export const MAX_MESSAGE_BODY_CHARS = 8000;"));
        assert!(shared.contains("export const MODEL_ID_MAX = 120;"));
    }

    #[test]
    fn carry_follows_ts_source() {
        assert!(CARRY_BUNDLE_ITEM_SQL.contains("< $4"));
        assert!(BUNDLES_HOLDING_SQL.contains("deleted_at is null"));
    }

    #[test]
    fn slice_like_js() {
        assert_eq!(js_slice("abc", 2).as_deref(), Some("ab"));
        let s = format!("{}😀", "a".repeat(199));
        assert_eq!(js_slice(&s, 200), None, "서로게이트 가운데");
        let s = format!("{}😀", "a".repeat(198));
        assert_eq!(js_slice(&s, 200).as_deref(), Some(s.as_str()));
    }

    #[test]
    fn prompt_from_first_line() {
        let meta = json!({ "kind": "ask", "ask": { "options": [{ "id": "a", "label": "A", "hint": "" }, { "id": "b", "label": "B", "recommended": 1 }], "to": { "kind": "human" } } });
        let body = "<@3f1c2a8e-1b2c-4d5e-8f90-0123456789ab>\u{3000} \n\n  첫 줄 \n둘째";
        let item = item_from("r", &meta, body, "c", None, Some("x"))
            .unwrap()
            .unwrap();
        assert_eq!(item["prompt"], "첫 줄");
        assert_eq!(item["options"][0], json!({ "id": "a", "label": "A" }));
        assert_eq!(
            item["options"][1],
            json!({ "id": "b", "label": "B", "recommended": true })
        );
        assert!(item.get("link").is_none());
        let mut perm = meta.clone();
        perm["permissionRequest"] = json!({ "status": "pending" });
        assert_eq!(
            item_from("r", &perm, body, "c", None, None)
                .unwrap()
                .unwrap()["link"],
            true
        );
        let mut odd = meta;
        odd["ask"]["prompt"] = json!(3);
        assert!(item_from("r", &odd, body, "c", None, None).is_err());
    }

    #[test]
    fn args_follow_zod() {
        let u = "3f1c2a8e-1b2c-4d5e-8f90-0123456789ab";
        let ok = json!({ "channelId": u, "threadRootId": u, "body": "b", "items": [{ "mirrorOf": u }, { "mirrorOf": u }], "bundleId": u });
        let a = parse_args(&ok).unwrap();
        assert_eq!(a.roots.len(), 1, "중복은 한 번");
        let mut no_bundle = ok.clone();
        no_bundle.as_object_mut().unwrap().remove("bundleId");
        assert!(
            parse_args(&no_bundle).is_some_and(|a| a.bundle.is_none()),
            "새 묶음은 bundle 없이"
        );
        for (k, v) in [
            ("body", json!("")),
            ("items", json!([])),
            ("model", json!("")),
            ("bundleId", Value::Null),
        ] {
            let mut bad = ok.clone();
            bad[k] = v;
            assert!(parse_args(&bad).is_none(), "{k}");
        }
    }
}
