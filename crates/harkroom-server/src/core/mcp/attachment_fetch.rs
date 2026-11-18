//! MCP `attachment.fetch` 의 거절 갈래(TS `mcpPlugin.ts` `attachment.fetch` → `services/attachments.ts` `resolveAttachmentFor`).
//!
//! 판정은 `GET /attachments/{id}`([`crate::core::attachment_download`])와 같은 순서·같은 문장이다: 없음·지운 메시지·고아
//! → `not_found`(`no such attachment`) → 안 붙은 업로드는 올린 사람만(`forbidden` `not your upload`) → 붙은 것은 채널
//! 가시성(`forbidden` `not a member of this dm channel`). **통과하면 `None`**(→ TS) — 바이트 싣기(이미지 줄이기·텍스트
//! 자르기·PDF)는 아직 TS 몫이다. 인자가 zod(`z.string().uuid()`)를 못 지나거나 DB 오류(권한 없음 포함)여도 `None`.
use super::tools::{err, uuid_arg};
use crate::auth::Account;
use serde_json::Value;
use sqlx::PgPool;

/// TS `findDownloadTarget` 중 판정에 쓰는 칸만.
const TARGET_SQL: &str = "select a.message_id::text, a.uploader_id::text, m.channel_id::text, (m.deleted_at is not null) \
     from attachment a left join message m on m.id = a.message_id where a.id = $1::uuid";

/// 이 갈래가 읽는 칸 — 읽기 풀에 없으면 질의가 실패해 TS 로 넘어간다.
pub const ATTACHMENT_FETCH_PRIVILEGES: &[(&str, &str)] = &[
    ("attachment.id", "SELECT"),
    ("attachment.message_id", "SELECT"),
    ("attachment.uploader_id", "SELECT"),
    ("message.id", "SELECT"),
    ("message.channel_id", "SELECT"),
    ("message.deleted_at", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
];

type Row = (Option<String>, Option<String>, Option<String>, bool);

/// 거절이면 그 답, 아니면 `None`.
fn refusal(row: Option<&Row>, me: &str) -> Result<Option<String>, &'static str> {
    let Some((message_id, uploader_id, channel_id, deleted)) = row else {
        return Ok(Some(err("not_found", "no such attachment")));
    };
    if message_id.is_some() && (channel_id.is_none() || *deleted) {
        return Ok(Some(err("not_found", "no such attachment")));
    }
    if message_id.is_none() {
        if uploader_id.as_deref() != Some(me) {
            return Ok(Some(err("forbidden", "not your upload")));
        }
        return Ok(None);
    }
    // 붙은 첨부 — 채널 가시성은 부른 쪽이 본다.
    Err("visible")
}

pub async fn answer(pool: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let id = uuid_arg(args, "attachmentId")?;
    let row: Option<Row> = sqlx::query_as(TARGET_SQL)
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()?;
    match refusal(row.as_ref(), &me.id) {
        Ok(r) => r,
        Err(_) => {
            let ch = row.as_ref()?.2.as_deref()?;
            if crate::core::channels::visible(pool, &me.id, ch)
                .await
                .ok()?
            {
                None
            } else {
                Some(err("forbidden", "not a member of this dm channel"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(r: Result<Option<String>, &'static str>) -> Option<String> {
        let t = r.ok()??;
        let v: Value = serde_json::from_str(&t).ok()?;
        let inner: Value = serde_json::from_str(v.pointer("/content/0/text")?.as_str()?).ok()?;
        Some(format!(
            "{}:{}",
            inner.pointer("/error/code")?.as_str()?,
            inner.pointer("/error/message")?.as_str()?
        ))
    }

    #[test]
    fn refusals_like_ts() {
        let s = |v: &str| Some(v.to_owned());
        assert_eq!(
            code(refusal(None, "me")).as_deref(),
            Some("not_found:no such attachment")
        );
        // 붙은 첨부인데 메시지가 지워졌거나 채널이 없으면 없는 것.
        let deleted = (s("m"), s("me"), s("c"), true);
        assert_eq!(
            code(refusal(Some(&deleted), "me")).as_deref(),
            Some("not_found:no such attachment")
        );
        let orphan = (s("m"), s("me"), None, false);
        assert_eq!(
            code(refusal(Some(&orphan), "me")).as_deref(),
            Some("not_found:no such attachment")
        );
        let others = (None, s("other"), None, false);
        assert_eq!(
            code(refusal(Some(&others), "me")).as_deref(),
            Some("forbidden:not your upload")
        );
        let mine = (None, s("me"), None, false);
        assert_eq!(refusal(Some(&mine), "me"), Ok(None));
        let attached = (s("m"), s("x"), s("c"), false);
        assert_eq!(refusal(Some(&attached), "me"), Err("visible"));
    }
}
