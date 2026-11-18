//! MCP `artifact.publish` 의 거절 앞머리(TS `mcpPlugin.ts` `artifact.publish`). TS 순서 그대로: zod 인자 → 채널 가시성
//! (`forbidden` `not a member of this dm channel`) → `html`·`attachmentId` 중 꼭 하나(`bad_request`). 둘 다 지나면 `None`
//! (→ TS) — 업로드 행·저장소 쓰기·글·아티팩트 판은 아직 TS 몫이다. 인자가 zod 를 못 지나거나 DB 오류여도 `None`.
//! 읽기만 한다(채널 가시성 — `channel`·`channel_member` SELECT).
use super::tools::err;
use crate::auth::Account;
use crate::core::cause_link::{MODEL_ID_MAX, js_trim_char};
use crate::core::channels::is_uuid;
use crate::core::msg_edit::MAX_MESSAGE_BODY_CHARS;
use serde_json::{Map, Value};
use sqlx::PgPool;

fn utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// zod `optional()` 칸 — 없으면 `Some(None)`, 있는데 `ok` 를 못 지나면 `None`.
fn opt<'a>(
    o: &'a Map<String, Value>,
    k: &str,
    ok: impl Fn(&str) -> bool,
) -> Option<Option<&'a str>> {
    match o.get(k) {
        None => Some(None),
        Some(Value::String(s)) if ok(s) => Some(Some(s)),
        _ => None,
    }
}

/// `z.string().trim().min(1).max(n)` — 다듬은 뒤 UTF-16 길이.
fn trimmed_len_ok(s: &str, max: usize) -> bool {
    let n = utf16(s.trim_matches(js_trim_char));
    (1..=max).contains(&n)
}

/// zod 를 지나면 `(channelId, html 있음, attachmentId 있음)`.
fn parse(args: &Value) -> Option<(&str, bool, bool)> {
    let Value::Object(o) = args else { return None };
    let channel = o.get("channelId")?.as_str().filter(|s| is_uuid(s))?;
    opt(o, "threadRootId", is_uuid)?;
    if !trimmed_len_ok(o.get("title")?.as_str()?, 200) {
        return None;
    }
    let body = utf16(o.get("body")?.as_str()?);
    if body == 0 || body > MAX_MESSAGE_BODY_CHARS {
        return None;
    }
    let html = opt(o, "html", |s| !s.is_empty())?;
    let attachment = opt(o, "attachmentId", is_uuid)?;
    opt(o, "coverAttachmentId", is_uuid)?;
    opt(o, "artifactId", is_uuid)?;
    opt(o, "summary", |s| trimmed_len_ok(s, 500))?;
    opt(o, "model", |s| (1..=MODEL_ID_MAX).contains(&utf16(s)))?;
    Some((channel, html.is_some(), attachment.is_some()))
}

pub async fn answer(read: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let (channel, html, attachment) = parse(args)?;
    if !crate::core::channels::visible(read, &me.id, channel)
        .await
        .ok()?
    {
        return Some(err("forbidden", "not a member of this dm channel"));
    }
    if html == attachment {
        return Some(err(
            "bad_request",
            "give exactly one of html or attachmentId",
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const C: &str = "0b7f3f92-3fa6-494a-8ab3-76d0d2a6a1c0";

    #[test]
    fn parse_like_zod() {
        let base = json!({ "channelId": C, "title": " t ", "body": "b", "extra": 1 });
        assert_eq!(parse(&base), Some((C, false, false)));
        let both =
            json!({ "channelId": C, "title": "t", "body": "b", "html": "<p>", "attachmentId": C });
        assert_eq!(parse(&both), Some((C, true, true)));
        let one = json!({ "channelId": C, "title": "t", "body": "b", "html": "<p>" });
        assert_eq!(parse(&one), Some((C, true, false)));
        for bad in [
            json!({ "channelId": C, "title": "\u{3000} ", "body": "b" }),
            json!({ "channelId": C, "title": "t".repeat(201), "body": "b" }),
            json!({ "channelId": C, "title": "t", "body": "" }),
            json!({ "channelId": C, "title": "t", "body": "b", "html": "" }),
            json!({ "channelId": C, "title": "t", "body": "b", "html": null }),
            json!({ "channelId": C, "title": "t", "body": "b", "attachmentId": "x" }),
            json!({ "channelId": C, "title": "t", "body": "b", "artifactId": "x" }),
            json!({ "channelId": C, "title": "t", "body": "b", "coverAttachmentId": 1 }),
            json!({ "channelId": C, "title": "t", "body": "b", "summary": " " }),
            json!({ "channelId": C, "title": "t", "body": "b", "model": "" }),
            json!({ "channelId": C, "title": "t", "body": "b", "threadRootId": "x" }),
            json!({ "channelId": "x", "title": "t", "body": "b" }),
            json!({ "channelId": C, "body": "b" }),
            json!([]),
        ] {
            assert!(parse(&bad).is_none(), "{bad}");
        }
    }
}
