//! C4b — Rust 가 답하는 MCP **쓰기** 도구. 첫 묶음은 `message.react`·`message.unreact`(REST 리액션 쓰기 C3a-1 의 본체를 같이 쓴다).
//!
//! 약속은 읽기와 같다 — TS 와 **같은 글자**, zod 가 그대로 받는 인자만, DB 오류·모르는 꼴은 TS 로(`None`). 거기에 셋을 더한다:
//! - 쓰기 전에 TS `/mcp/admit`(leakGuard → 백그라운드 회차 관문)을 이미 지났다([`super::route::serve`]). 회차에서 막힌 도구는 거기서
//!   도구 답 모양의 거절로 끝나고 여기까지 오지 않는다.
//! - 쓰기 풀은 그 줄의 권한이 다 있을 때만 있다(`main.rs` 의 `react_write`). 없으면 `None` — TS 가 답한다.
//! - 쓰기 중 DB 오류로 `None` 을 내면 TS 가 같은 요청을 다시 돈다. 리액션은 같은 결과로 수렴한다(`on conflict` · 없는 것 떼기도 성공).
use super::tools::{err, uuid_arg};
use crate::auth::Account;
use crate::core::msg_react::{
    AddOutcome, MAX_REACTIONS_PER_ACTOR, add_reaction, is_emoji, remove_reaction,
};
use serde_json::Value;
use sqlx::PgPool;

/// 이 묶음에서 Rust 가 답하는 쓰기 도구.
pub const SERVED: &[&str] = &["message.react", "message.unreact"];

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
    write: Option<&PgPool>,
    me: &Account,
    tool: &str,
    args: &Value,
) -> Option<Option<String>> {
    if !SERVED.contains(&tool) {
        return None;
    }
    let Some(write) = write else {
        return Some(None);
    };
    Some(react(read, write, me, tool, args).await)
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
        ] {
            assert!(mcp.contains(want), "{want}");
        }
    }
}
