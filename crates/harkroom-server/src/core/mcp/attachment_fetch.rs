//! MCP `attachment.fetch` 의 거절 갈래(TS `mcpPlugin.ts` `attachment.fetch` → `services/attachments.ts` `resolveAttachmentFor`).
//!
//! 판정은 `GET /attachments/{id}`([`crate::core::attachment_download`])와 같은 순서·같은 문장이다: 없음·지운 메시지·고아
//! → `not_found`(`no such attachment`) → 안 붙은 업로드는 올린 사람만(`forbidden` `not your upload`) → 붙은 것은 채널
//! 가시성(`forbidden` `not a member of this dm channel`). **통과하면 `None`**(→ TS) — 바이트 싣기(이미지 줄이기·텍스트
//! 자르기·PDF)는 아직 TS 몫이다. 바이트 없이 답이 정해지는 갈래(큰 PDF·실을 수 없는 타입·상한 넘는 텍스트·32MiB 넘는 그림)는 Rust 가 답한다. 인자가 zod(`z.string().uuid()`)를 못 지나거나 DB 오류(권한 없음 포함)여도 `None`.
use super::tools::{err, uuid_arg};
use crate::auth::Account;
use serde_json::Value;
use sqlx::PgPool;

/// TS `findDownloadTarget` 중 판정에 쓰는 칸만.
const TARGET_SQL: &str = "select a.message_id::text, a.uploader_id::text, m.channel_id::text, (m.deleted_at is not null), \
     a.id::text, a.filename, a.content_type, a.size_bytes::int \
     from attachment a left join message m on m.id = a.message_id where a.id = $1::uuid";

/// 이 갈래가 읽는 칸 — 읽기 풀에 없으면 질의가 실패해 TS 로 넘어간다.
pub const ATTACHMENT_FETCH_PRIVILEGES: &[(&str, &str)] = &[
    ("attachment.id", "SELECT"),
    ("attachment.message_id", "SELECT"),
    ("attachment.uploader_id", "SELECT"),
    ("attachment.filename", "SELECT"),
    ("attachment.content_type", "SELECT"),
    ("attachment.size_bytes", "SELECT"),
    ("message.id", "SELECT"),
    ("message.channel_id", "SELECT"),
    ("message.deleted_at", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
];

type Row = (Option<String>, Option<String>, Option<String>, bool);
/// 통과한 첨부의 메타(TS `{ id, filename, contentType, sizeBytes }`).
type Meta = (String, String, String, i32);
type FullRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
    String,
    String,
    String,
    i32,
);

/// TS `IMAGE_TYPES`·`IMAGE_MAX_BYTES`·`TEXT_READ_MAX_BYTES`·`PDF_MAX_BYTES`·`DOWNSCALE_READ_MAX_BYTES`.
const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const IMAGE_MAX_BYTES: i64 = 3 * 1024 * 1024;
const TEXT_READ_MAX_BYTES: i64 = 4 * 1024 * 1024;
const PDF_MAX_BYTES: i64 = 8 * 1024 * 1024;
const DOWNSCALE_READ_MAX_BYTES: i64 = 32 * 1024 * 1024;
const DOWNLOAD_TAIL: &str = " (Authorization: Bearer $HARKROOM_PAT) — needs shell/HTTP access; if you have neither, say so and ask the human instead of guessing";

/// TS `isTextType`.
fn is_text_type(ct: &str) -> bool {
    let t = ct.split(';').next().unwrap_or("").trim().to_lowercase();
    if t.starts_with("text/") {
        return true;
    }
    if !t.starts_with("application/") {
        return false;
    }
    t == "application/json" || t == "application/xml" || t.ends_with("+json") || t.ends_with("+xml")
}

/// TS `isPdfType`.
fn is_pdf_type(ct: &str) -> bool {
    ct.split(';').next().unwrap_or("").trim().to_lowercase() == "application/pdf"
}

/// 바이트를 읽지 않고 답이 정해지는 갈래(큰 PDF·실을 수 없는 타입·읽기 상한을 넘는 것)만 답한다. 바이트를 싣는 갈래
/// (텍스트·PDF·그림·줄이기)는 `None`(→ TS).
fn metadata_only(m: &Meta) -> Option<String> {
    let (id, filename, ct, size) = m;
    let size = i64::from(*size);
    if is_text_type(ct) && size <= TEXT_READ_MAX_BYTES {
        return None;
    }
    let meta = format!(
        "{{\"id\":{},\"filename\":{},\"contentType\":{},\"sizeBytes\":{}}}",
        Value::from(id.as_str()),
        Value::from(filename.as_str()),
        Value::from(ct.as_str()),
        size
    );
    let download = Value::from(format!("GET /attachments/{id}{DOWNLOAD_TAIL}"));
    let note = if is_pdf_type(ct) {
        if size <= PDF_MAX_BYTES {
            return None;
        }
        format!(
            "PDF too large to carry in this response ({size}B > {PDF_MAX_BYTES}B); ask the human for the pages you need, or download"
        )
    } else {
        let image = IMAGE_TYPES.contains(&ct.as_str());
        if image && size <= DOWNSCALE_READ_MAX_BYTES {
            return None;
        }
        if is_text_type(ct) {
            format!("too large to inline as text ({size}B > {TEXT_READ_MAX_BYTES}B)")
        } else if size > IMAGE_MAX_BYTES {
            format!("too large to inline ({size}B > {IMAGE_MAX_BYTES}B)")
        } else {
            "not an inlineable image type; bytes are not carried in this response".to_owned()
        }
    };
    Some(super::respond::text_result(&format!(
        "{{\"attachment\":{meta},\"note\":{},\"download\":{download}}}",
        Value::from(note)
    )))
}

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
    let full: Option<FullRow> = sqlx::query_as(TARGET_SQL)
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()?;
    let row: Option<Row> = full
        .as_ref()
        .map(|f| (f.0.clone(), f.1.clone(), f.2.clone(), f.3));
    match refusal(row.as_ref(), &me.id) {
        Ok(Some(r)) => return Some(r),
        Ok(None) => {}
        Err(_) => {
            let ch = row.as_ref()?.2.as_deref()?;
            if !crate::core::channels::visible(pool, &me.id, ch)
                .await
                .ok()?
            {
                return Some(err("forbidden", "not a member of this dm channel"));
            }
        }
    }
    let f = full?;
    metadata_only(&(f.4, f.5, f.6, f.7))
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

    fn inner(m: &Meta) -> Option<Value> {
        let t = metadata_only(m)?;
        let v: Value = serde_json::from_str(&t).ok()?;
        serde_json::from_str(v.pointer("/content/0/text")?.as_str()?).ok()
    }

    #[test]
    fn metadata_branches_like_ts() {
        let m = |ct: &str, n: i32| ("a1".to_owned(), "f".to_owned(), ct.to_owned(), n);
        // 바이트를 싣는 갈래는 TS.
        assert!(metadata_only(&m("text/plain", 10)).is_none());
        assert!(metadata_only(&m("application/pdf", 10)).is_none());
        assert!(metadata_only(&m("image/png", 10)).is_none());
        assert!(metadata_only(&m("image/png", 20 * 1024 * 1024)).is_none());
        let zip = metadata_only(&m("application/zip", 5)).unwrap();
        let v: Value = serde_json::from_str(&zip).unwrap();
        assert_eq!(
            v.pointer("/content/0/text").unwrap().as_str().unwrap(),
            "{\"attachment\":{\"id\":\"a1\",\"filename\":\"f\",\"contentType\":\"application/zip\",\"sizeBytes\":5},\"note\":\"not an inlineable image type; bytes are not carried in this response\",\"download\":\"GET /attachments/a1 (Authorization: Bearer $HARKROOM_PAT) — needs shell/HTTP access; if you have neither, say so and ask the human instead of guessing\"}"
        );
        let pdf = inner(&m("application/pdf", 9 * 1024 * 1024)).unwrap();
        assert_eq!(
            pdf["note"],
            "PDF too large to carry in this response (9437184B > 8388608B); ask the human for the pages you need, or download"
        );
        let txt = inner(&m("text/plain; charset=utf-8", 5 * 1024 * 1024)).unwrap();
        assert_eq!(
            txt["note"],
            "too large to inline as text (5242880B > 4194304B)"
        );
        let big = inner(&m("image/png", 40 * 1024 * 1024)).unwrap();
        assert_eq!(big["note"], "too large to inline (41943040B > 3145728B)");
    }
}
