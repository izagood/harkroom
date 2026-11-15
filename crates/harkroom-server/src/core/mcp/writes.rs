//! C4b — Rust 가 답하는 MCP **쓰기** 도구. 첫 묶음은 `message.react`·`message.unreact`(REST 리액션 쓰기 C3a-1 의 본체를 같이 쓴다).
//!
//! 약속은 읽기와 같다 — TS 와 **같은 글자**, zod 가 그대로 받는 인자만, DB 오류·모르는 꼴은 TS 로(`None`). 거기에 셋을 더한다:
//! - 쓰기 전에 TS `/mcp/admit`(leakGuard → 백그라운드 회차 관문)을 이미 지났다([`super::route::serve`]). 회차에서 막힌 도구는 거기서
//!   도구 답 모양의 거절로 끝나고 여기까지 오지 않는다.
//! - 쓰기 풀은 그 줄의 권한이 다 있을 때만 있다(`main.rs` 의 `react_write`). 없으면 `None` — TS 가 답한다.
//! - 쓰기 중 DB 오류로 `None` 을 내면 TS 가 같은 요청을 다시 돈다. 리액션은 같은 결과로 수렴한다(`on conflict` · 없는 것 떼기도 성공).
use super::respond::minify;
use super::tools::{err, uuid_arg};
use crate::auth::Account;
use crate::core::msg_react::{
    AddOutcome, MAX_REACTIONS_PER_ACTOR, add_reaction, is_emoji, remove_reaction,
};
use serde_json::Value;
use sqlx::PgPool;

/// 이 묶음에서 Rust 가 답하는 쓰기 도구.
pub const SERVED: &[&str] = &[
    "message.react",
    "message.unreact",
    "inbox.read",
    "bg.claim",
    // C4b-ask — 묶음 카드 한 줄 닫기. 선택 카드 쓰기 풀(`ASK_PRIVILEGES`)이 있을 때만.
    "message.askBundleResolve",
];

/// `inbox.read`(C4b ④-a) 쓰기 역할의 권한 — 읽음 시각 칸 하나만 고친다. 없으면 `main.rs` 가 풀을 비워 TS 가 답한다.
pub const INBOX_READ_PRIVILEGES: &[(&str, &str)] = &[("inbox.read_at", "UPDATE")];

/// 도구 묶음마다의 쓰기 풀 — 그 묶음의 권한이 다 있을 때만 `Some`. 없는 묶음의 도구는 TS 가 답한다.
#[derive(Clone, Default)]
pub struct McpWrites {
    /// `message.react`·`unreact` — `msg_react::MESSAGE_REACTION_PRIVILEGES`.
    pub react: Option<PgPool>,
    /// `inbox.read` — [`INBOX_READ_PRIVILEGES`].
    pub inbox: Option<PgPool>,
    /// `bg.claim` — [`super::bg_claim::BG_CLAIM_PRIVILEGES`].
    pub bg: Option<PgPool>,
    /// `message.askBundleResolve` — C3b-1 `ASK_PRIVILEGES`.
    pub ask: Option<PgPool>,
}

/// JS `Number.MAX_SAFE_INTEGER` — 이 밖의 수는 TS 에서 값이 뭉개진다. Rust 는 같은 결과를 낼 수 없으니 TS 로 넘긴다.
const JS_SAFE_INT: i64 = 9_007_199_254_740_991;

/// TS `{ emoji }`·`{ ok: true }` 와 같은 글자.
fn ok_text(v: &str) -> String {
    super::respond::text_result(v)
}

/// 쓰기를 시작한 뒤의 DB 오류(security W1). 사유를 되비추지 않는 고정 문장이다.
fn internal() -> String {
    err("internal", "the write failed; it was not retried")
}

/// `emoji: z.string().min(1).max(32)` — UTF-16 길이.
fn emoji_arg(args: &Value) -> Option<&str> {
    args.get("emoji")?.as_str().filter(|e| {
        let n = e.encode_utf16().count();
        (1..=32).contains(&n)
    })
}

pub async fn answer(
    read: &PgPool,
    writes: &McpWrites,
    me: &Account,
    tool: &str,
    args: &Value,
    runner: bool,
) -> Option<Option<String>> {
    if !SERVED.contains(&tool) {
        return None;
    }
    if tool == "bg.claim" {
        // 러너가 아니면(`runner_only`) TS 가 답한다. 켜짐은 `route::serve` 가 admit 값으로 이미 걸렀다.
        let Some(write) = writes.bg.as_ref().filter(|_| runner) else {
            return Some(None);
        };
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis() as i64;
        return Some(super::bg_claim::claim(read, write, &me.id, now_ms).await);
    }
    if tool == "inbox.read" {
        let Some(write) = writes.inbox.as_ref() else {
            return Some(None);
        };
        return Some(inbox_read(write, me, args).await);
    }
    if tool == "message.askBundleResolve" {
        let Some(write) = writes.ask.as_ref() else {
            return Some(None);
        };
        return Some(bundle_resolve(read, write, me, args).await);
    }
    let Some(write) = writes.react.as_ref() else {
        return Some(None);
    };
    Some(react(read, write, me, tool, args).await)
}

/// `ids: z.array(z.number().int()).min(1).max(200)` 중 Rust 가 같은 값으로 읽는 것 — JSON 정수이고 JS 안전 범위 안.
/// `1.0` 같은 실수 꼴·안전 범위 밖·다른 꼴은 `None`(TS 로 — zod 가 받든 거절하든 TS 의 답이 정본이다).
fn inbox_ids(args: &Value) -> Option<Vec<i64>> {
    let a = args.get("ids")?.as_array()?;
    if !(1..=200).contains(&a.len()) {
        return None;
    }
    a.iter()
        .map(|v| {
            v.as_i64()
                .filter(|n| (-JS_SAFE_INT..=JS_SAFE_INT).contains(n))
        })
        .collect()
}

/// TS `markInboxRead` — 자기 inbox 의 아직 안 읽은 항목만 읽음으로. 같은 요청을 두 번 돌아도 두 번째는 0 이라 결과가 수렴하지만,
/// 답의 `read` 수가 달라지므로 쓰기 오류는 TS 로 넘기지 않고 `internal` 로 답한다(security W1).
async fn inbox_read(write: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let ids = inbox_ids(args)?;
    Some(
        match sqlx::query(
            "update inbox set read_at = now() where account_id = $1::uuid and id = any($2) and read_at is null",
        )
        .bind(&me.id)
        .bind(&ids)
        .execute(write)
        .await
        {
            Ok(r) => ok_text(&format!("{{\"read\":{}}}", r.rows_affected())),
            Err(_) => internal(),
        },
    )
}

/// `note: z.string().min(1).max(1000).optional()` — UTF-16 길이. 칸이 있는데 꼴이 틀리면 zod 오류라 TS 로(`Err`).
fn note_arg(args: &Value) -> Result<Option<&str>, ()> {
    match args.get("note") {
        None => Ok(None),
        Some(v) => v
            .as_str()
            .filter(|s| (1..=1000).contains(&s.encode_utf16().count()))
            .map(Some)
            .ok_or(()),
    }
}

/// `message.askBundleResolve` — TS `resolveBundleItem`([`crate::core::ask_bundle_resolve`]).
async fn bundle_resolve(
    read: &PgPool,
    write: &PgPool,
    me: &Account,
    args: &Value,
) -> Option<String> {
    use crate::core::ask_bundle_resolve::{Resolved, refusal_message, resolve};
    let bundle = uuid_arg(args, "bundleId")?;
    let root = uuid_arg(args, "rootId")?;
    let reply = uuid_arg(args, "replyMessageId")?;
    let note = note_arg(args).ok()?;
    match resolve(read, write, &me.id, bundle, root, reply, note)
        .await
        .ok()?
    {
        Resolved::Refused(code) => Some(err(code, refusal_message(code))),
        Resolved::Bundle(row) => {
            // 행은 Postgres `json` 글자 — 공백만 지운다(읽기 도구와 같다). meta 의 수 표기가 JS 와 갈릴 수 있으면 `jsonb_as_js` 가 None
            // 이지만, 쓰기는 이미 끝났으니 TS 로 넘기지 않고 공백만 지운 글자로 답한다(묶음 meta 에는 수가 없다).
            let row = minify(&row);
            let row = super::reads2::jsonb_as_js(&row).unwrap_or(row);
            Some(ok_text(&format!("{{\"message\":{row}}}")))
        }
        Resolved::Failed => Some(internal()),
        // 원본을 Rust 가 정하지 않는다(권한 거울·백스톱 등) — 쓰기 전이라 TS 가 답한다.
        Resolved::Handoff => None,
    }
}

async fn react(
    read: &PgPool,
    write: &PgPool,
    me: &Account,
    tool: &str,
    args: &Value,
) -> Option<String> {
    let channel = uuid_arg(args, "channelId")?;
    let message = uuid_arg(args, "messageId")?;
    let emoji = emoji_arg(args)?;
    if tool == "message.react" && !is_emoji(emoji) {
        return Some(err("bad_request", "a reaction must be a single emoji"));
    }
    if !crate::core::channels::visible(read, &me.id, channel)
        .await
        .ok()?
    {
        return Some(err("forbidden", "not a member of this dm channel"));
    }
    // 여기부터 쓰기다(security W1) — 오류가 나도 TS 로 넘기지 않는다(넘기면 TS 가 같은 쓰기를 한 번 더 한다). 도구 오류로 답한다.
    if tool == "message.unreact" {
        return Some(
            match remove_reaction(read, write, &me.id, channel, message, emoji).await {
                Ok(()) => ok_text("{\"ok\":true}"),
                Err(_) => internal(),
            },
        );
    }
    let added = match add_reaction(read, write, &me.id, channel, message, emoji).await {
        Ok(v) => v,
        Err(_) => return Some(internal()),
    };
    match added {
        AddOutcome::Added => Some(ok_text(&format!("{{\"emoji\":{}}}", Value::from(emoji)))),
        AddOutcome::NotFound => Some(err("not_found", "no such message in this channel")),
        AddOutcome::TooMany => Some(err(
            "too_many_reactions",
            &format!("at most {MAX_REACTIONS_PER_ACTOR} reactions per message"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn served_are_writes_in_registry() {
        for n in SERVED {
            let s = super::super::find(n).expect(n);
            assert_eq!(s.access, super::super::Access::Write, "{n}");
        }
    }

    #[test]
    fn inbox_ids_takes_safe_integers_only() {
        use serde_json::json;
        assert_eq!(inbox_ids(&json!({"ids": [1, 2]})), Some(vec![1, 2]));
        assert_eq!(
            inbox_ids(&json!({"ids": [-9_007_199_254_740_991_i64]})),
            Some(vec![-JS_SAFE_INT])
        );
        assert_eq!(inbox_ids(&json!({"ids": []})), None);
        assert_eq!(inbox_ids(&json!({"ids": [1.0]})), None);
        assert_eq!(
            inbox_ids(&json!({"ids": [9_007_199_254_740_992_i64]})),
            None
        );
        assert_eq!(inbox_ids(&json!({"ids": ["1"]})), None);
        assert_eq!(inbox_ids(&json!({"ids": vec![1; 201]})), None);
        assert_eq!(inbox_ids(&json!({})), None);
    }

    #[test]
    fn inbox_sql_follows_ts_source() {
        let svc = include_str!("../../../../../packages/server/src/services/messages.ts");
        assert!(svc.contains(
            "`update inbox set read_at = now() where account_id = $1 and id = any($2) and read_at is null`,"
        ));
    }

    /// 거절 문구·답 모양을 TS 원본과 맞춘다.
    #[test]
    fn texts_follow_ts_source() {
        let mcp = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        for want in [
            "return jsonResult({ error: { code: 'bad_request', message: 'a reaction must be a single emoji' } });",
            "return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });",
            "return jsonResult({ error: { code: 'not_found', message: 'no such message in this channel' } });",
            "error: { code: 'too_many_reactions', message: `at most ${MAX_REACTIONS_PER_ACTOR} reactions per message` },",
            "return jsonResult({ emoji });",
            "if (removed === 'status_kept') return jsonResult({ ok: true });",
            "emoji: z.string().min(1).max(32),",
            "inputSchema: { ids: z.array(z.number().int()).min(1).max(200) },",
            "return jsonResult({ read });",
        ] {
            assert!(mcp.contains(want), "{want}");
        }
    }
}
