//! S5.3 C3b-2b — MCP `message.askBundleResolve`: 사람이 묶음 스레드에 **글로** 한 줄에 답했을 때 관리 에이전트가 그 줄을 닫는다.
//! TS `services/askBundles.ts` 의 `resolveBundleItem` 을 옮긴다.
//!
//! 에이전트가 사람의 결정을 지어내지 못하게 하는 자리다 — TS 와 같은 검사를 같은 차례로 한다:
//! - 묶음은 **부른 에이전트가 세운 것**이어야 한다(`bundle_not_yours`).
//! - 근거 글은 id 만 믿지 않고 **그 묶음 스레드(같은 채널, 뿌리 또는 답글)의 지우지 않은 사람 글**인지 DB 에서 찾는다
//!   (골든 `bundle_reply`). 없으면 `bundle_reply_invalid`.
//! - 그 글을 쓴 사람이 **원본에 답할 권리**가 있어야 한다 — 원본의 받는 사람(사람 앞이면 사람, 이름으로 정했으면 그 계정)이고
//!   원본 채널을 볼 수 있어야 한다. 아니면 `bundle_reply_invalid`.
//! - 원본은 **닫은 이름 = 그 글을 쓴 사람**으로 `replied` 닫힘(골든 `bundle_resolve`). 요지를 쓴 이름은 부른 에이전트.
//!
//! TS 로 넘기는 줄(닫힌 쪽): 원본을 C3b-1 [`super::ask::hand_to_ts`] 로 잰다 — 권한 요청·권한 거울·머지 거절·백스톱 표지, 권한
//! 요청 행의 카드, 못 읽는 모양·모르는 kind, 이상한 `mirrorOf`, 원본 없음 → `None`(읽은 바이트 그대로 TS 가 답한다).
//! 결정 카드(`link`·권한·머지 표지)는 그 전에 TS 와 같이 `bundle_item_link` 로 거절한다.
//!
//! 닫기·원본 `message.updated`·깨움·거울/묶음 맞추기는 한 트랜잭션이다. 쓰기를 시작한 뒤의 DB 오류는 TS 로 넘기지 않고
//! 고정 문장의 도구 오류로 답한다(security W1 — 넘기면 TS 가 같은 쓰기를 한 번 더 한다).
use super::ask::{hand_to_ts, read_ask_row};
use super::ask_sync::{announce_updated, sync_ask_mirrors, wake_asker};
use super::msg_read::{channel_visible, is_uuid, message_by_id};
use crate::auth::Account;
use serde_json::Value;
use sqlx::PgPool;
use std::sync::OnceLock;

const LABEL: &str = "askBundleResolve";

/// TS `ASK_BUNDLE_REFUSAL_MESSAGE` 의 이 도구가 쓰는 줄.
pub const REFUSALS: &[(&str, &str)] = &[
    ("bundle_not_found", "no such bundle card"),
    (
        "bundle_not_yours",
        "only the agent that posted the bundle can change it",
    ),
    (
        "bundle_item_not_found",
        "that card is not a row of this bundle",
    ),
    (
        "bundle_item_link",
        "a person decides a permission request or merge-denial card on its card or bundle row — an agent cannot close it",
    ),
    (
        "bundle_item_resolved",
        "that row is already answered or closed",
    ),
    (
        "bundle_reply_invalid",
        "replyMessageId must be a human message in this bundle thread, from someone who may answer the card",
    ),
    (
        "mirror_not_found",
        "no such choice request, or you cannot see its channel",
    ),
];

/// 거절 하나 — 도구 답의 `{ error: { code, message } }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refusal(pub &'static str);

impl Refusal {
    pub fn message(self) -> &'static str {
        REFUSALS
            .iter()
            .find(|(c, _)| *c == self.0)
            .map(|(_, m)| *m)
            .expect("refusal text")
    }
}

/// 결과 — 닫은 뒤의 묶음 글(JSON 글자) 또는 거절. `Handoff` 면 TS 가 답한다.
#[derive(Debug)]
pub enum Resolved {
    Bundle(String),
    Refused(Refusal),
    Handoff,
}

/// 묶음 행 — (meta, 채널, 스레드 뿌리, 작성자, id).
type BundleRow = (Value, String, Option<String>, Option<String>, String);

struct Sql {
    read: String,
    decision_card: String,
    reply: String,
    resolve: String,
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
            decision_card: format!(
                "select d.\"?column?\" from ({}) d",
                frag("bundle_decision_card")
            ),
            reply: format!(
                "select r.\"authorId\"::text from ({}) r",
                frag("bundle_reply")
            ),
            resolve: format!(
                "{}\n      returning id::text, author_id::text",
                frag("bundle_resolve")
            ),
        }
    })
}

/// JS 참·거짓(`if (item.link)`).
fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// TS shared `readAskBundleMeta` 의 줄 — (rootId, link). 못 알아보면 None.
fn bundle_items(meta: &Value) -> Option<Vec<(String, bool)>> {
    if meta.get("kind").and_then(Value::as_str) != Some("askBundle") {
        return None;
    }
    let items = meta
        .get("askBundle")
        .filter(|b| b.is_object())?
        .get("items")?
        .as_array()?;
    items
        .iter()
        .map(|i| {
            let root = i.get("rootId").and_then(Value::as_str)?;
            i.get("options").filter(|o| o.is_array())?;
            Some((root.to_owned(), js_truthy(i.get("link"))))
        })
        .collect()
}

/// JS `String.prototype.trim` 이 지우는 글자(WhiteSpace + LineTerminator). Rust `char::is_whitespace` 는 U+0085 도 지우고
/// U+FEFF 는 남기므로 따로 둔다.
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

/// `note: z.string().min(1).max(1000).optional()` — UTF-16 길이. 키가 있는데 모양이 틀리면 None(→ TS 의 검증 오류).
fn note_arg(args: &Value) -> Option<Option<&str>> {
    match args.get("note") {
        None => Some(None),
        Some(Value::String(s)) => {
            let n = s.encode_utf16().count();
            (1..=1000).contains(&n).then_some(Some(s.as_str()))
        }
        Some(_) => None,
    }
}

/// 인자 셋(`bundleId`·`rootId`·`replyMessageId`, zod uuid)과 `note`. 모양이 틀리면 None.
pub fn parse_args(args: &Value) -> Option<(&str, &str, &str, Option<&str>)> {
    let obj = args.as_object()?;
    let id = |k: &str| obj.get(k)?.as_str().filter(|s| is_uuid(s));
    Some((
        id("bundleId")?,
        id("rootId")?,
        id("replyMessageId")?,
        note_arg(args)?,
    ))
}

/// 쓰기 전의 판정 — 읽기 풀로. DB 오류면 `Err`(→ 부르는 쪽이 TS 로 넘긴다).
async fn check(
    read: &PgPool,
    caller: &str,
    bundle_id: &str,
    root_id: &str,
    reply_id: &str,
) -> sqlx::Result<Result<String, Resolved>> {
    use Resolved::{Handoff, Refused};
    let s = sql();
    let row: Option<BundleRow> = sqlx::query_as(s.read.as_str())
        .bind(bundle_id)
        .fetch_optional(read)
        .await?;
    let Some((meta, channel, thread_root, author, id)) = row else {
        return Ok(Err(Refused(Refusal("bundle_not_found"))));
    };
    let Some(items) = bundle_items(&meta) else {
        return Ok(Err(Refused(Refusal("bundle_not_found"))));
    };
    if author.as_deref() != Some(caller) {
        return Ok(Err(Refused(Refusal("bundle_not_yours"))));
    }
    let Some((_, link)) = items.iter().find(|(r, _)| r == root_id) else {
        return Ok(Err(Refused(Refusal("bundle_item_not_found"))));
    };
    let decision: Option<i32> = sqlx::query_scalar(s.decision_card.as_str())
        .bind(root_id)
        .fetch_optional(read)
        .await?;
    if *link || decision.is_some() {
        return Ok(Err(Refused(Refusal("bundle_item_link"))));
    }
    // 권한·머지·백스톱·모르는 kind 원본은 TS 가 정한다(C3b-1 과 같은 닫힌 판정).
    if hand_to_ts(read, root_id).await? {
        return Ok(Err(Handoff));
    }
    let bundle_root = thread_root.unwrap_or(id);
    let reply_author: Option<String> = sqlx::query_scalar(s.reply.as_str())
        .bind(reply_id)
        .bind(&channel)
        .bind(&bundle_root)
        .fetch_optional(read)
        .await?;
    let Some(reply_author) = reply_author else {
        return Ok(Err(Refused(Refusal("bundle_reply_invalid"))));
    };
    let mut conn = read.acquire().await?;
    let Some((ask, root_channel, _)) = read_ask_row(&mut conn, root_id).await? else {
        return Ok(Err(Refused(Refusal("mirror_not_found"))));
    };
    drop(conn);
    if ask.answered || ask.closed {
        return Ok(Err(Refused(Refusal("bundle_item_resolved"))));
    }
    // 글을 쓴 사람이 원본에 답할 수 있어야 그 글이 원본의 답이다.
    if !ask.addressed_to(&reply_author)
        || !channel_visible(read, &reply_author, &root_channel).await?
    {
        return Ok(Err(Refused(Refusal("bundle_reply_invalid"))));
    }
    Ok(Ok(reply_author))
}

/// `resolveBundleItem`. `Err` 는 쓰기를 시작한 뒤의 DB 오류다(그 tx 는 버려진다).
/// 쓰기 전 판정의 DB 오류는 `Ok(Handoff)` — 아무것도 쓰지 않았으니 TS 가 처음부터 다시 한다.
pub async fn resolve(
    read: &PgPool,
    write: &PgPool,
    me: &Account,
    bundle_id: &str,
    root_id: &str,
    reply_id: &str,
    note: Option<&str>,
) -> sqlx::Result<Resolved> {
    let reply_author = match check(read, &me.id, bundle_id, root_id, reply_id).await {
        Ok(Ok(a)) => a,
        Ok(Err(r)) => return Ok(r),
        Err(_) => return Ok(Resolved::Handoff),
    };
    // TS `(args.note ?? '').trim().slice(0, 1000)` — 스키마가 이미 1000 단위 안이라 자르기는 아무것도 안 한다.
    let note = note.unwrap_or("").trim_matches(js_space);
    let mut tx = write.begin().await?;
    let closed: Option<(String, Option<String>)> = sqlx::query_as(sql().resolve.as_str())
        .bind(root_id)
        .bind(&reply_author)
        .bind(reply_id)
        .bind(note)
        .bind(&me.id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((closed_id, asker)) = closed else {
        return Ok(Resolved::Refused(Refusal("bundle_item_resolved")));
    };
    announce_updated(&mut tx, &closed_id).await?;
    // 원 스레드에는 사람 글이 없으니 `thread_reply` 로 깨지 않는다 — 여기서 깨운다.
    wake_asker(
        &mut tx,
        LABEL,
        asker.as_deref(),
        &reply_author,
        &closed_id,
        "ask_closed",
    )
    .await;
    sync_ask_mirrors(&mut tx, LABEL, root_id).await?;
    let fresh = message_by_id(&mut *tx, bundle_id).await?;
    tx.commit().await?;
    Ok(match fresh {
        Some(row) => Resolved::Bundle(row),
        None => Resolved::Refused(Refusal("bundle_not_found")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 거절 문구를 TS 원본과 맞춘다.
    #[test]
    fn refusals_follow_ts_source() {
        let src = include_str!("../../../../packages/server/src/services/askBundles.ts");
        for (code, msg) in REFUSALS {
            let line = format!("  {code}: '{msg}',");
            assert!(src.contains(&line), "{line}");
        }
    }

    #[test]
    fn js_trim_set() {
        assert_eq!("\u{FEFF} a \u{3000}\n".trim_matches(js_space), "a");
        // NEL 은 JS trim 이 지우지 않는다.
        assert_eq!("\u{85}a".trim_matches(js_space), "\u{85}a");
    }

    #[test]
    fn args_follow_zod() {
        let u = "3f1c2a8e-1b2c-4d5e-8f90-0123456789ab";
        let ok = serde_json::json!({ "bundleId": u, "rootId": u, "replyMessageId": u });
        assert!(parse_args(&ok).is_some());
        let mut bad = ok.clone();
        bad["note"] = Value::from("");
        assert!(parse_args(&bad).is_none());
        bad["note"] = Value::from("x".repeat(1001));
        assert!(parse_args(&bad).is_none());
        bad["note"] = Value::from(1);
        assert!(parse_args(&bad).is_none());
        let mut miss = ok.clone();
        miss["rootId"] = Value::from("nope");
        assert!(parse_args(&miss).is_none());
    }
}
