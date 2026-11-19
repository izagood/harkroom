//! MCP `attachment.fetch` 의 거절 갈래(TS `mcpPlugin.ts` `attachment.fetch` → `services/attachments.ts` `resolveAttachmentFor`).
//!
//! 판정은 `GET /attachments/{id}`([`crate::core::attachment_download`])와 같은 순서·같은 문장이다: 없음·지운 메시지·고아
//! → `not_found`(`no such attachment`) → 안 붙은 업로드는 올린 사람만(`forbidden` `not your upload`) → 붙은 것은 채널
//! 가시성(`forbidden` `not a member of this dm channel`). 통과하면 바이트도 Rust 가 싣는다 — 텍스트(UTF-8 판정·앞뒤 남기고
//! 자르기)·PDF(`resource` blob)·3MiB 이하 그림(`image`). **3MiB 넘는 그림 줄이기만 `None`**(→ TS), 저장소
//! (`ATTACHMENT_ROOT`)가 없거나 읽기 오류여도 `None`. 바이트 없이 답이 정해지는 갈래(큰 PDF·실을 수 없는 타입·상한 넘는 텍스트·32MiB 넘는 그림)는 Rust 가 답한다. 인자가 zod(`z.string().uuid()`)를 못 지나거나 DB 오류(권한 없음 포함)여도 `None`.
use super::tools::{err, uuid_arg};
use crate::auth::Account;
use serde_json::Value;
use sqlx::PgPool;

/// TS `findDownloadTarget` 중 판정에 쓰는 칸만.
const TARGET_SQL: &str = "select a.message_id::text, a.uploader_id::text, m.channel_id::text, (m.deleted_at is not null), \
     a.id::text, a.filename, a.content_type, a.size_bytes::int, a.storage_key \
     from attachment a left join message m on m.id = a.message_id where a.id = $1::uuid";

/// 이 갈래가 읽는 칸 — 읽기 풀에 없으면 질의가 실패해 TS 로 넘어간다.
pub const ATTACHMENT_FETCH_PRIVILEGES: &[(&str, &str)] = &[
    ("attachment.id", "SELECT"),
    ("attachment.message_id", "SELECT"),
    ("attachment.uploader_id", "SELECT"),
    ("attachment.filename", "SELECT"),
    ("attachment.content_type", "SELECT"),
    ("attachment.size_bytes", "SELECT"),
    ("attachment.storage_key", "SELECT"),
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
    String,
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
    let meta = (f.4, f.5, f.6, f.7);
    if is_text_type(&meta.2) && i64::from(meta.3) <= TEXT_READ_MAX_BYTES {
        return text_path(&meta, &f.8).await;
    }
    if let Some(r) = metadata_only(&meta) {
        return Some(r);
    }
    if is_pdf_type(&meta.2) {
        return pdf_path(&meta, &f.8).await;
    }
    if i64::from(meta.3) <= IMAGE_MAX_BYTES {
        return image_path(&meta, &f.8).await;
    }
    // 줄이기(3MiB 넘는 그림)는 아직 TS.
    None
}

/// TS `readAttachment` — `Ok(바이트)`, 또는 답이 정해진 거절(`Some(Err)`). 저장소가 없거나 읽기 오류면 `None`(→ TS).
async fn read_limited(m: &Meta, key: &str, limit: i64) -> Option<Result<Vec<u8>, String>> {
    use crate::core::attachment_store::StoreError;
    use std::io::Read;
    let file = match storage()?.read(key).await {
        Ok(f) => f,
        Err(StoreError::Missing { .. }) => {
            return Some(Err(err(
                "attachment_missing",
                "attachment file not found on the server",
            )));
        }
        Err(_) => return None,
    };
    let cap = limit as u64 + 1;
    let body = tokio::task::spawn_blocking(move || {
        let mut buf = Vec::new();
        file.take(cap).read_to_end(&mut buf).map(|_| buf)
    })
    .await
    .ok()?
    .ok()?;
    if body.len() as i64 > limit {
        return Some(Err(super::respond::text_result(&format!(
            "{{\"attachment\":{},\"note\":{},\"download\":{}}}",
            meta_json(m),
            Value::from(format!(
                "file is larger than its recorded size and exceeds {limit}B"
            )),
            Value::from(format!(
                "GET /attachments/{} (Authorization: Bearer $HARKROOM_PAT)",
                m.0
            ))
        ))));
    }
    Some(Ok(body))
}

fn b64(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(b)
}

/// TS PDF 갈래 — 머리가 `%PDF-` 가 아니면 메타데이터, 맞으면 글 한 줄 + `resource` blob.
async fn pdf_path(m: &Meta, key: &str) -> Option<String> {
    let body = match read_limited(m, key, PDF_MAX_BYTES).await? {
        Ok(b) => b,
        Err(r) => return Some(r),
    };
    Some(pdf_answer(m, &body))
}

fn pdf_answer(m: &Meta, body: &[u8]) -> String {
    let meta = meta_json(m);
    if !body.starts_with(b"%PDF-") {
        return super::respond::text_result(&format!(
            "{{\"attachment\":{meta},\"note\":\"labelled application/pdf but the bytes are not a PDF; bytes are not carried in this response\",\"download\":{}}}",
            Value::from(format!(
                "GET /attachments/{} (Authorization: Bearer $HARKROOM_PAT)",
                m.0
            ))
        ));
    }
    let text = format!(
        "{{\"attachment\":{meta},\"note\":\"PDF carried as an embedded resource below; if your client saved it to a file, open that file to read it\"}}"
    );
    format!(
        "{{\"content\":[{{\"type\":\"text\",\"text\":{}}},{{\"type\":\"resource\",\"resource\":{{\"uri\":{},\"mimeType\":\"application/pdf\",\"blob\":\"{}\"}}}}]}}",
        Value::from(text),
        Value::from(format!("harkroom://attachment/{}", m.0)),
        b64(body)
    )
}

/// TS 작은 그림 갈래(3MiB 이하) — 글 한 줄 + `image`.
async fn image_path(m: &Meta, key: &str) -> Option<String> {
    let body = match read_limited(m, key, IMAGE_MAX_BYTES).await? {
        Ok(b) => b,
        Err(r) => return Some(r),
    };
    Some(image_answer(m, &body))
}

fn image_answer(m: &Meta, body: &[u8]) -> String {
    let text = format!("{{\"attachment\":{}}}", meta_json(m));
    format!(
        "{{\"content\":[{{\"type\":\"text\",\"text\":{}}},{{\"type\":\"image\",\"data\":\"{}\",\"mimeType\":{}}}]}}",
        Value::from(text),
        b64(body),
        Value::from(m.2.as_str())
    )
}

/// TS `TEXT_MAX_BYTES` — 텍스트로 실을 상한(넘으면 앞뒤를 남기고 가운데를 버린다).
const TEXT_MAX_BYTES: usize = 256 * 1024;

fn meta_json(m: &Meta) -> String {
    format!(
        "{{\"id\":{},\"filename\":{},\"contentType\":{},\"sizeBytes\":{}}}",
        Value::from(m.0.as_str()),
        Value::from(m.1.as_str()),
        Value::from(m.2.as_str()),
        m.3
    )
}

/// 저장소 — `ATTACHMENT_ROOT` 가 없으면 `None`(→ TS, `attachment_store` 머리말의 fail-closed).
fn storage() -> Option<&'static crate::core::attachment_store::LocalStorage> {
    static S: std::sync::OnceLock<Option<crate::core::attachment_store::LocalStorage>> =
        std::sync::OnceLock::new();
    S.get_or_init(|| {
        crate::core::attachment_store::LocalStorage::from_env()
            .ok()
            .flatten()
    })
    .as_ref()
}

/// TS 텍스트 갈래(`readAttachment` → `decodeUtf8` → `truncateText`). 저장소가 없거나 읽기 오류(없음 제외)면 `None`(→ TS).
async fn text_path(m: &Meta, key: &str) -> Option<String> {
    let body = match read_limited(m, key, TEXT_READ_MAX_BYTES).await? {
        Ok(b) => b,
        Err(r) => return Some(r),
    };
    Some(super::respond::text_result(&text_answer(m, &body)))
}

/// 읽은 바이트로 TS 와 같은 글자를 짓는다(결과 `text` 안의 JSON).
fn text_answer(m: &Meta, body: &[u8]) -> String {
    let meta = meta_json(m);
    let download = Value::from(format!(
        "GET /attachments/{} (Authorization: Bearer $HARKROOM_PAT)",
        m.0
    ));
    let Ok(decoded) = std::str::from_utf8(body) else {
        return format!(
            "{{\"attachment\":{meta},\"note\":\"not valid UTF-8; bytes are not carried as text in this response\",\"download\":{download}}}"
        );
    };
    // `TextDecoder` 는 머리의 BOM 을 버린다.
    let decoded = decoded.strip_prefix('\u{feff}').unwrap_or(decoded);
    match truncate_text(decoded, TEXT_MAX_BYTES) {
        None => format!(
            "{{\"attachment\":{meta},\"text\":{}}}",
            Value::from(decoded)
        ),
        Some((text, dropped)) => format!(
            "{{\"attachment\":{meta},\"truncated\":{{\"droppedCharacters\":{dropped},\"limitBytes\":{TEXT_MAX_BYTES}}},\"download\":{download},\"text\":{}}}",
            Value::from(text)
        ),
    }
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// TS `truncateText` — 앞·뒤에서 UTF-8 로 `limit/2` 바이트 안에 드는 가장 긴 글자 조각(대리쌍은 가르지 않는다)을 남긴다.
/// 버린 양은 UTF-16 단위(JS `length`).
fn truncate_text(text: &str, limit: usize) -> Option<(String, usize)> {
    if text.len() <= limit {
        return None;
    }
    let half = limit / 2;
    let mut head_end = 0;
    for (i, c) in text.char_indices() {
        if i + c.len_utf8() > half {
            break;
        }
        head_end = i + c.len_utf8();
    }
    let mut tail_start = text.len();
    for (i, _) in text.char_indices().rev() {
        if text.len() - i > half {
            break;
        }
        tail_start = i;
    }
    let head = &text[..head_end];
    let tail = &text[tail_start..];
    let dropped = utf16_len(text) as i64 - utf16_len(head) as i64 - utf16_len(tail) as i64;
    if dropped <= 0 {
        return None;
    }
    let dropped = dropped as usize;
    Some((
        format!(
            "{head}\n\n… [{dropped} characters omitted — fetch the whole file over REST] …\n\n{tail}"
        ),
        dropped,
    ))
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
        let t: Value =
            serde_json::from_str(&text_answer(&m("text/plain", 3), b"\xef\xbb\xbfhi")).unwrap();
        assert_eq!(t["text"], "hi");
        let bad = text_answer(&m("text/plain", 1), b"\xff");
        assert!(bad.contains("not valid UTF-8"));
        let long = "가".repeat(10) + &"b".repeat(10);
        let (cut, dropped) = truncate_text(&long, 12).unwrap();
        assert_eq!(dropped, 20 - 2 - 6);
        assert!(cut.starts_with("가가\n\n… [12 characters omitted"));
        assert!(cut.ends_with("\n\nbbbbbb"));
        assert!(truncate_text("abc", 12).is_none());
        let pdf: Value =
            serde_json::from_str(&pdf_answer(&m("application/pdf", 6), b"%PDF-1")).unwrap();
        assert_eq!(pdf["content"][1]["resource"]["blob"], "JVBERi0x");
        assert_eq!(
            pdf["content"][1]["resource"]["uri"],
            "harkroom://attachment/a1"
        );
        assert!(pdf_answer(&m("application/pdf", 2), b"no").contains("not a PDF"));
        let img: Value = serde_json::from_str(&image_answer(&m("image/png", 2), b"ab")).unwrap();
        assert_eq!(img["content"][1]["data"], "YWI=");
        assert_eq!(
            img["content"][0]["text"],
            "{\"attachment\":{\"id\":\"a1\",\"filename\":\"f\",\"contentType\":\"image/png\",\"sizeBytes\":2}}"
        );
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
