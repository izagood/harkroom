//! MCP `message.ask` 의 거절 앞머리(TS `mcpPlugin.ts` `message.ask`). TS 순서 그대로: zod 인자 → `planStepId` 인데 스레드
//! 없음(`bad_request`) → 채널 가시성(`forbidden`) → 선택지 id 겹침(`duplicate_option`) → 예약 id(`reserved_option_id`)
//! → 추천 둘 이상(`multiple_recommended`) → 머지 거절 카드에 `to`·`mirrorOf`(`merge_denial_audience`). 모두 지나면 `None`
//! (→ TS). 그 뒤 스레드 안의 사람 앞 카드는 [`answer_plain`] 이 열린 카드 검사(`open_card_in_thread`, `keepOpen` 반영)를 하고,
//! 평범한 카드(사람 앞·원인 헤더 없음, 스레드 안팎)는 글 올리기 풀로 세운다 — 대상 찾기(`to`)·거울·대신하기(`supersedes`)·
//! 계획 단계·머지 거절·푸시는 아직 TS 몫이다. 인자가 zod 를 못 지나거나 DB 오류여도 `None`.
use super::tools::err;
use crate::auth::Account;
use crate::core::ask::{ASK_MAX_OPTIONS, ASK_MIN_OPTIONS, ASK_TEXT_OPTION_ID};
use crate::core::cause_link::MODEL_ID_MAX;
use crate::core::channels::is_uuid;
use crate::core::msg_edit::MAX_MESSAGE_BODY_CHARS;
use serde_json::{Map, Value};
use sqlx::PgPool;
use std::collections::HashSet;

fn len_ok(s: &str, max: usize) -> bool {
    (1..=max).contains(&s.encode_utf16().count())
}

/// zod `optional()` 칸 — 없으면 `Some(None)`, 있는데 `ok` 를 못 지나면 `None`.
fn opt<'a>(
    o: &'a Map<String, Value>,
    k: &str,
    ok: impl Fn(&Value) -> bool,
) -> Option<Option<&'a Value>> {
    match o.get(k) {
        None => Some(None),
        Some(v) if ok(v) => Some(Some(v)),
        _ => None,
    }
}

fn str_ok(max: usize) -> impl Fn(&Value) -> bool {
    move |v| v.as_str().is_some_and(|s| len_ok(s, max))
}

fn uuid_ok(v: &Value) -> bool {
    v.as_str().is_some_and(is_uuid)
}

/// `/^s[1-9][0-9]{0,3}$/`.
fn plan_step_ok(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        let b = s.as_bytes();
        b.len() >= 2
            && b.len() <= 5
            && b[0] == b's'
            && (b'1'..=b'9').contains(&b[1])
            && b[2..].iter().all(u8::is_ascii_digit)
    })
}

struct Args<'a> {
    channel: &'a str,
    thread: bool,
    /// (id, recommended)
    options: Vec<(&'a str, bool)>,
    to: bool,
    mirror_of: bool,
    merge_denial: bool,
    plan_step: bool,
}

fn parse(args: &Value) -> Option<Args<'_>> {
    let Value::Object(o) = args else { return None };
    let channel = o.get("channelId")?.as_str().filter(|s| is_uuid(s))?;
    if !len_ok(o.get("body")?.as_str()?, MAX_MESSAGE_BODY_CHARS) {
        return None;
    }
    let thread = opt(o, "threadRootId", uuid_ok)?.is_some();
    let raw = o.get("options")?.as_array()?;
    if !(ASK_MIN_OPTIONS..=ASK_MAX_OPTIONS).contains(&raw.len()) {
        return None;
    }
    let mut options = Vec::with_capacity(raw.len());
    for x in raw {
        let x = x.as_object()?;
        let id = x.get("id")?.as_str().filter(|s| len_ok(s, 64))?;
        if !str_ok(200)(x.get("label")?) {
            return None;
        }
        opt(x, "hint", str_ok(200))?;
        let rec = opt(x, "recommended", Value::is_boolean)?.and_then(Value::as_bool) == Some(true);
        options.push((id, rec));
    }
    opt(o, "irreversible", Value::is_boolean)?;
    let to = opt(o, "to", str_ok(64))?.is_some();
    opt(o, "prompt", str_ok(500))?;
    let mirror_of = opt(o, "mirrorOf", uuid_ok)?.is_some();
    opt(o, "supersedes", |v| {
        uuid_ok(v)
            || v.as_array()
                .is_some_and(|a| !a.is_empty() && a.iter().all(uuid_ok))
    })?;
    opt(o, "keepOpen", |v| {
        v.as_array()
            .is_some_and(|a| a.len() <= 50 && a.iter().all(uuid_ok))
    })?;
    let merge_denial = opt(o, "mergeDenialId", uuid_ok)?.is_some();
    let plan_step = opt(o, "planStepId", plan_step_ok)?.is_some();
    opt(o, "model", str_ok(MODEL_ID_MAX))?;
    Some(Args {
        channel,
        thread,
        options,
        to,
        mirror_of,
        merge_denial,
        plan_step,
    })
}

/// 채널 가시성 뒤의 거절(순서가 TS 와 같다).
fn option_refusal(a: &Args<'_>) -> Option<String> {
    let ids: HashSet<&str> = a.options.iter().map(|(id, _)| *id).collect();
    if ids.len() != a.options.len() {
        return Some(err("duplicate_option", "option ids must be unique"));
    }
    if ids.contains(ASK_TEXT_OPTION_ID) {
        return Some(err(
            "reserved_option_id",
            &format!("option id {ASK_TEXT_OPTION_ID} is reserved"),
        ));
    }
    if a.options.iter().filter(|(_, r)| *r).count() > 1 {
        return Some(err(
            "multiple_recommended",
            "mark at most one option as recommended",
        ));
    }
    if a.merge_denial && (a.to || a.mirror_of) {
        return Some(err(
            "merge_denial_audience",
            "a merge-denial card is addressed to humans; omit `to` and `mirrorOf`",
        ));
    }
    None
}

pub async fn answer(read: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let a = parse(args)?;
    if a.plan_step && !a.thread {
        return Some(err(
            "bad_request",
            "planStepId 는 threadRootId 와 함께 준다(그 스레드의 계획 단계)",
        ));
    }
    if !crate::core::channels::visible(read, &me.id, a.channel)
        .await
        .ok()?
    {
        return Some(err("forbidden", "not a member of this dm channel"));
    }
    option_refusal(&a)
}

/// 평범한 카드의 TS `AskMeta` — `{kind:'ask', ask:{options, to:{kind:'human'}, prompt?, irreversible?}}`. 칸 차례는 DB(jsonb)가 다시 짓는다.
fn plain_meta(o: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut options = Vec::new();
    for x in o.get("options")?.as_array()? {
        let x = x.as_object()?;
        let mut m = Map::new();
        m.insert("id".into(), x.get("id")?.clone());
        m.insert("label".into(), x.get("label")?.clone());
        if let Some(h) = x.get("hint") {
            m.insert("hint".into(), h.clone());
        }
        if x.get("recommended") == Some(&Value::Bool(true)) {
            m.insert("recommended".into(), Value::Bool(true));
        }
        options.push(Value::Object(m));
    }
    let mut ask = Map::new();
    ask.insert("options".into(), Value::Array(options));
    ask.insert("to".into(), serde_json::json!({ "kind": "human" }));
    if let Some(p) = o.get("prompt") {
        ask.insert("prompt".into(), p.clone());
    }
    if o.get("irreversible") == Some(&Value::Bool(true)) {
        ask.insert("irreversible".into(), Value::Bool(true));
    }
    let mut meta = Map::new();
    meta.insert("kind".into(), Value::from("ask"));
    meta.insert("ask".into(), Value::Object(ask));
    Some(meta)
}

/// Rust 가 세우는 카드 — 사람 앞(`to` 없음), 거울·머지 거절·supersedes·계획 단계 없음, 원인 헤더 없음(TS 의 사람 앞 푸시
/// `gateAwaitingAccount`→`enqueueAskPush` 는 원인이 있을 때만 쓴다). 스레드 안이면 열린 카드 검사([`open_card_refusal`])를 이미
/// 지났어야 한다 — `keepOpen` 은 그 검사에만 쓰인다. 그 밖은 `false`(→ TS).
fn plain(o: &Map<String, Value>, cause: Option<&str>) -> bool {
    cause.is_none()
        && [
            "to",
            "mirrorOf",
            "supersedes",
            "mergeDenialId",
            "planStepId",
        ]
        .iter()
        .all(|k| !o.contains_key(*k))
}

/// 열린 카드 검사를 Rust 가 할 수 있는 꼴 — TS 의 `audience.kind === 'human' && !mirrorOf && !mergeDenialId && threadRootId`.
/// `supersedes` 가 있으면 그 앞의 `checkAskSupersede` 가 아직 TS 몫이라 고르지 않는다(→ TS). 고르면 스레드 머리 id.
fn open_card_thread(o: &Map<String, Value>) -> Option<&str> {
    if ["to", "mirrorOf", "mergeDenialId", "supersedes"]
        .iter()
        .any(|k| o.contains_key(*k))
    {
        return None;
    }
    o.get("threadRootId")?.as_str()
}

/// TS `listOpenHumanAsks` — 이 작성자가 이 스레드(머리 포함)에 열어 둔 사람 앞 카드. 서버가 세운 카드·거울은 뺀다.
pub const OPEN_CARD_SQL: &str = "select id::text from message
      where channel_id = $2::uuid and (id = $3::uuid or thread_root_id = $3::uuid)
        and author_id = $1::uuid and deleted_at is null
        and meta->>'kind' = 'ask'
        and meta->'ask'->>'answeredWith' is null
        and meta->'ask'->>'closedAt' is null
        and meta->'ask'->'to'->>'kind' = 'human'
        and meta->'ask'->>'mirrorOf' is null
        and not (meta ? 'permissionRequest') and not (meta ? 'chainBackstop') and not (meta ? 'mergeDenial')
      order by seq";

/// [`OPEN_CARD_SQL`] 이 읽는 칸 — 읽기 풀의 기존 `message` SELECT 뿐이다(새 GRANT 없음).
pub const OPEN_CARD_READ_PRIVILEGES: &[(&str, &str)] = &[("message", "SELECT")];

/// TS `open_card_in_thread` 거절 — `supersedes`·`keepOpen` 에 밝히지 않은 열린 카드가 있으면 그 id 들을 싣는다.
fn open_card_refusal(open: Vec<String>, keep: &HashSet<&str>) -> Option<String> {
    let undeclared: Vec<String> = open
        .into_iter()
        .filter(|id| !keep.contains(id.as_str()))
        .collect();
    if undeclared.is_empty() {
        return None;
    }
    Some(super::respond::text_result(
        &serde_json::json!({ "error": {
            "code": "open_card_in_thread",
            "message": "you already have open card(s) in this thread — pass each id in `supersedes` (this card replaces or merges them) or in `keepOpen` (a separate decision that stays open)",
            "openCardIds": undeclared,
        } })
        .to_string(),
    ))
}

/// 거절 앞머리([`answer`])를 다 지난 카드 — 스레드 안이면 먼저 열린 카드 검사(`open_card_in_thread`, 읽기 풀)를 하고, 평범한
/// 카드면 세운다. 고를 수 없는 꼴·쓰기 풀 없음·DB 오류는 `None`(→ TS).
pub async fn answer_plain(
    read: &PgPool,
    st: Option<&crate::core::msg_post::PostState>,
    me: &Account,
    args: &Value,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    let a = parse(args)?;
    let o = args.as_object()?;
    if let Some(thread) = open_card_thread(o) {
        let open: Vec<String> = sqlx::query_scalar(OPEN_CARD_SQL)
            .bind(&me.id)
            .bind(a.channel)
            .bind(thread)
            .fetch_all(read)
            .await
            .ok()?;
        let keep: HashSet<&str> = o
            .get("keepOpen")
            .and_then(Value::as_array)
            .map(|v| v.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        if let Some(r) = open_card_refusal(open, &keep) {
            return Some(r);
        }
    }
    let st = st?;
    if !plain(o, cause) {
        return None;
    }
    let meta = plain_meta(o)?;
    let mut sub = Map::new();
    for k in ["channelId", "body", "threadRootId", "model"] {
        if let Some(v) = o.get(k) {
            sub.insert(k.into(), v.clone());
        }
    }
    super::msg_post::answer_ask(st, me, &Value::Object(sub), meta, cause, turn, operator).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const C: &str = "0b7f3f92-3fa6-494a-8ab3-76d0d2a6a1c0";

    fn ask(extra: Value) -> Value {
        let mut v = json!({ "channelId": C, "body": "b",
            "options": [{ "id": "a", "label": "A" }, { "id": "b", "label": "B", "hint": "h", "recommended": false }] });
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    }

    fn code(r: Option<String>) -> Option<String> {
        let v: Value = serde_json::from_str(&r?).ok()?;
        let inner: Value = serde_json::from_str(v.pointer("/content/0/text")?.as_str()?).ok()?;
        Some(inner.pointer("/error/code")?.as_str()?.to_owned())
    }

    #[test]
    fn parse_like_zod() {
        assert!(parse(&ask(json!({}))).is_some());
        assert!(
            parse(&ask(
                json!({ "supersedes": C, "keepOpen": [], "planStepId": "s1234" })
            ))
            .is_some()
        );
        assert!(parse(&ask(json!({ "supersedes": [C] }))).is_some());
        for bad in [
            json!({ "supersedes": [] }),
            json!({ "supersedes": "x" }),
            json!({ "planStepId": "s0" }),
            json!({ "planStepId": "s12345" }),
            json!({ "options": [{ "id": "a", "label": "A" }] }),
            json!({ "options": [{ "id": "", "label": "A" }, { "id": "b", "label": "B" }] }),
            json!({ "options": [{ "id": "a", "label": "A", "recommended": 1 }, { "id": "b", "label": "B" }] }),
            json!({ "to": "" }),
            json!({ "prompt": null }),
            json!({ "irreversible": "yes" }),
            json!({ "keepOpen": ["x"] }),
            json!({ "body": "" }),
            json!({ "model": "" }),
        ] {
            assert!(parse(&ask(bad.clone())).is_none(), "{bad}");
        }
    }

    #[test]
    fn plain_meta_like_ts() {
        let v = ask(json!({ "prompt": "p", "irreversible": false }));
        let m = plain_meta(v.as_object().unwrap()).unwrap();
        assert_eq!(
            Value::Object(m),
            json!({ "kind": "ask", "ask": { "options": [{ "id": "a", "label": "A" }, { "id": "b", "label": "B", "hint": "h" }],
                "to": { "kind": "human" }, "prompt": "p" } })
        );
        let o = ask(json!({}));
        assert!(plain(o.as_object().unwrap(), None));
        assert!(!plain(o.as_object().unwrap(), Some("c")));
        assert!(plain(
            ask(json!({ "threadRootId": C, "keepOpen": [C] }))
                .as_object()
                .unwrap(),
            None
        ));
        for k in [
            "to",
            "mirrorOf",
            "supersedes",
            "mergeDenialId",
            "planStepId",
        ] {
            assert!(
                !plain(ask(json!({ k: C })).as_object().unwrap(), None),
                "{k}"
            );
        }
    }

    #[test]
    fn open_card_check_only_for_human_thread_cards() {
        let t = |v: Value| open_card_thread(v.as_object().unwrap()).map(str::to_owned);
        assert_eq!(t(ask(json!({}))), None);
        assert_eq!(t(ask(json!({ "threadRootId": C }))).as_deref(), Some(C));
        assert_eq!(
            t(ask(
                json!({ "threadRootId": C, "keepOpen": [C], "planStepId": "s1" })
            ))
            .as_deref(),
            Some(C)
        );
        for k in ["to", "mirrorOf", "mergeDenialId", "supersedes"] {
            assert_eq!(t(ask(json!({ "threadRootId": C, k: C }))), None, "{k}");
        }
    }

    #[test]
    fn open_card_refusal_like_ts() {
        const D: &str = "1b7f3f92-3fa6-494a-8ab3-76d0d2a6a1c0";
        assert_eq!(open_card_refusal(vec![], &HashSet::new()), None);
        let keep: HashSet<&str> = [C].into_iter().collect();
        assert_eq!(open_card_refusal(vec![C.into()], &keep), None);
        let r = open_card_refusal(vec![C.into(), D.into()], &keep).unwrap();
        let v: Value = serde_json::from_str(&r).unwrap();
        let text = v.pointer("/content/0/text").unwrap().as_str().unwrap();
        assert!(text.starts_with(
            r#"{"error":{"code":"open_card_in_thread","message":"you already have open card(s)"#
        ));
        let inner: Value = serde_json::from_str(text).unwrap();
        assert_eq!(inner["error"]["openCardIds"], json!([D]));
    }

    #[test]
    fn open_card_sql_follows_ts_source() {
        let ts = include_str!("../../../../../packages/server/src/services/messages.ts");
        let norm = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        let body = norm(OPEN_CARD_SQL)
            .replace("select id::text from", "select id from")
            .replace("::uuid", "");
        assert!(norm(ts).contains(&body));
        assert_eq!(OPEN_CARD_READ_PRIVILEGES, &[("message", "SELECT")]);
    }

    #[test]
    fn option_refusals_in_ts_order() {
        let r = |v: Value| code(option_refusal(&parse(&v).unwrap()));
        assert_eq!(r(ask(json!({}))), None);
        assert_eq!(
            r(ask(
                json!({ "options": [{ "id": "a", "label": "A" }, { "id": "a", "label": "B" }] })
            ))
            .as_deref(),
            Some("duplicate_option")
        );
        assert_eq!(
            r(ask(json!({ "options": [{ "id": "__text__", "label": "A" }, { "id": "a", "label": "B" }] }))).as_deref(),
            Some("reserved_option_id")
        );
        assert_eq!(
            r(ask(json!({ "options": [{ "id": "a", "label": "A", "recommended": true }, { "id": "b", "label": "B", "recommended": true }] }))).as_deref(),
            Some("multiple_recommended")
        );
        assert_eq!(
            r(ask(json!({ "mergeDenialId": C, "to": "x" }))).as_deref(),
            Some("merge_denial_audience")
        );
        assert_eq!(
            r(ask(json!({ "mergeDenialId": C, "mirrorOf": C }))).as_deref(),
            Some("merge_denial_audience")
        );
        assert_eq!(r(ask(json!({ "mergeDenialId": C }))), None);
    }
}
