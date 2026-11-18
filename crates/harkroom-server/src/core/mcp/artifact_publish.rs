//! MCP `artifact.publish` 의 거절 앞머리(TS `mcpPlugin.ts` `artifact.publish`). TS 순서 그대로: zod 인자 → 채널 가시성
//! (`forbidden` `not a member of this dm channel`) → `html`·`attachmentId` 중 꼭 하나(`bad_request`). 둘 다 지나면 `None`
//! (→ TS). 쓰기 상태([`ArtifactWrite`])가 있으면 [`publish`] 가 새 안(`html` 만, `artifactId`·표지 없음) 게시까지 맡는다 — 그 밖의
//! 모양은 여전히 TS 몫이다. 인자가 zod 를 못 지나거나 DB 오류여도 `None`.
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

/// TS `ARTIFACT_PUBLISH_ARG_MAX_BYTES` — `html` 인자 상한(2MB).
pub const ARTIFACT_PUBLISH_ARG_MAX_BYTES: usize = 2 * 1024 * 1024;

/// TS `slugFilename` — 파일 이름에 못 쓰는 글자를 띄어쓰기로, 다듬고, 공백 묶음을 `-` 로, 80 UTF-16 단위까지. 비면 `preview`. 자른 자리가 서로게이트 쌍을 가르면 `None`(→ TS).
pub fn slug_filename(title: &str) -> Option<String> {
    let mut spaced = String::with_capacity(title.len());
    let mut in_bad = false;
    for c in title.chars() {
        let bad =
            matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20;
        if bad {
            if !in_bad {
                spaced.push(' ');
            }
        } else {
            spaced.push(c);
        }
        in_bad = bad;
    }
    // JS `\s+` 와 `trim()` 은 같은 공백 집합이다(`js_trim_char`).
    let mut out = String::new();
    let mut ws = false;
    for c in spaced.trim_matches(js_trim_char).chars() {
        if js_trim_char(c) {
            ws = true;
        } else {
            if ws {
                out.push('-');
            }
            ws = false;
            out.push(c);
        }
    }
    // JS `.slice(0, 80)` — UTF-16 단위로 자른다. 서로게이트 쌍이 갈리면 JS 는 외짝을 남기는데 Rust 글자로는 못 쓴다 → `None`.
    let units: Vec<u16> = out.encode_utf16().take(80).collect();
    let cut = String::from_utf16(&units).ok()?;
    Some(if cut.is_empty() {
        "preview".to_owned()
    } else {
        cut
    })
}

/// 새 안 게시에 쓰는 것 — 글 쓰기 상태와 첨부 저장소. `main.rs` 가 [`super::artifact_write::ARTIFACT_PUBLISH_PRIVILEGES`]·
/// `attachment_upload::UPLOAD_PRIVILEGES`·[`ARTIFACT_UPLOAD_CLEANUP_PRIVILEGES`] 를 다 확인했을 때만 만든다.
pub struct ArtifactWrite {
    pub post: std::sync::Arc<crate::core::msg_post::PostState>,
    pub storage: crate::core::attachment_store::LocalStorage,
}

/// 게시가 안 됐을 때 이 도구가 만든 업로드를 지우는 칸(TS `delete from attachment where id = $1 and message_id is null`).
pub const ARTIFACT_UPLOAD_CLEANUP_PRIVILEGES: &[(&str, &str)] = &[
    ("attachment", "DELETE"),
    ("attachment.message_id", "SELECT"),
];

const UPLOAD_SQL: &str = "insert into attachment (uploader_id, filename, content_type, size_bytes, storage_key) \
     values ($1::uuid, $2, 'text/html', $3::bigint, $4) returning id::text";
const CLEANUP_SQL: &str = "delete from attachment where id = $1::uuid and message_id is null";

/// 이 판이 게시까지 맡는 모양 — `html` 있음, `attachmentId`·`artifactId`·`coverAttachmentId` 없음. 그 밖은 `None`(→ TS).
/// 돌려주는 것: `(channelId, html, title(다듬은), body, threadRootId, summary(다듬은), model(다듬은))`.
#[allow(clippy::type_complexity)]
fn new_html_shape(
    args: &Value,
) -> Option<(
    &str,
    &str,
    String,
    &str,
    Option<&str>,
    Option<String>,
    Option<String>,
)> {
    let o = args.as_object()?;
    if ["attachmentId", "artifactId", "coverAttachmentId"]
        .iter()
        .any(|k| o.contains_key(*k))
    {
        return None;
    }
    let s = |k: &str| o.get(k).and_then(Value::as_str);
    let model = match s("model") {
        None => None,
        Some(m) => crate::core::cause_link::trimmed_model(m)?,
    };
    Some((
        s("channelId")?,
        s("html")?,
        s("title")?.trim_matches(js_trim_char).to_owned(),
        s("body")?,
        s("threadRootId"),
        s("summary").map(|x| x.trim_matches(js_trim_char).to_owned()),
        model,
    ))
}

/// 새 안(v1) 게시까지 Rust 가 답한다. 거절 앞머리([`answer`])를 먼저 돌고, 그 뒤 [`new_html_shape`] 만 받는다(그 밖은 `None` → TS).
/// TS 순서: `html` 크기(`too_large`) → 저장소 쓰기 → 업로드 행 → `postMessage`(+ 훅) → 실패면 업로드를 지운다.
pub async fn publish(
    aw: &ArtifactWrite,
    me: &Account,
    args: &Value,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    if let Some(r) = answer(&aw.post.read, me, args).await {
        return Some(r);
    }
    let (channel, html, title, body, root, summary, model) = new_html_shape(args)?;
    if html.len() > ARTIFACT_PUBLISH_ARG_MAX_BYTES {
        return Some(err(
            "too_large",
            "html exceeds 2MB — write it to a file and use attachment.upload",
        ));
    }
    let filename = format!("{}.html", slug_filename(&title)?);
    let mut w = aw.storage.begin_write(u64::MAX).await.ok()?;
    if w.append(bytes::Bytes::copy_from_slice(html.as_bytes()))
        .await
        .is_err()
    {
        w.abort().await;
        return None;
    }
    let stored = w.commit().await.ok()?;
    let row: Result<(String,), _> = sqlx::query_as(UPLOAD_SQL)
        .bind(&me.id)
        .bind(&filename)
        .bind(stored.bytes as i64)
        .bind(&stored.key)
        .fetch_one(&aw.post.write)
        .await;
    let Ok((upload,)) = row else {
        let _ = aw.storage.remove(&stored.key).await;
        return None;
    };
    let hook = super::artifact_write::NewArtifact::new(
        channel.to_owned(),
        me.id.clone(),
        title,
        upload.clone(),
        summary,
    );
    let post_body = crate::core::msg_post::PostBody {
        body: body.to_owned(),
        attachment_ids: vec![upload.clone()],
        thread_root: root.map(str::to_owned),
        also_in_channel: false,
    };
    let out = super::msg_post::answer_artifact(
        &aw.post, me, channel, post_body, model, &hook, cause, turn, operator,
    )
    .await;
    // 글이 안 생겼으면(거절·TS 로 넘김·재생) 이 업로드는 아무도 가리키지 않는다 — 지운다. 붙었으면 `message_id` 가 있어 지워지지 않는다.
    if hook.published().is_none() || out.is_none() {
        let gone = sqlx::query(CLEANUP_SQL)
            .bind(&upload)
            .execute(&aw.post.write)
            .await
            .is_ok_and(|r| r.rows_affected() == 1);
        if gone {
            let _ = aw.storage.remove(&stored.key).await;
        }
    }
    out
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

    #[test]
    fn slug_like_ts() {
        let f = |t: &str| slug_filename(t).unwrap();
        assert_eq!(f("Design  A"), "Design-A");
        assert_eq!(f("a/b:c"), "a-b-c");
        assert_eq!(f("a//b"), "a-b");
        assert_eq!(f(" <x> "), "x");
        assert_eq!(f("???"), "preview");
        assert_eq!(f("a\tb\u{3000}c"), "a-b-c");
        assert_eq!(f("시안 A"), "시안-A");
        assert_eq!(f(&"x".repeat(100)), "x".repeat(80));
        // 80 번째 단위가 서로게이트 쌍을 가르면 TS 로.
        assert_eq!(slug_filename(&format!("{}😀", "x".repeat(79))), None);
        assert_eq!(
            f(&format!("{}😀", "x".repeat(78))),
            format!("{}😀", "x".repeat(78))
        );
    }

    #[test]
    fn only_new_html_shape_is_published_here() {
        let one =
            json!({ "channelId": C, "title": " t ", "body": "b", "html": "<p>", "summary": " s " });
        let (ch, html, title, body, root, summary, model) = new_html_shape(&one).unwrap();
        assert_eq!(
            (ch, html, title.as_str(), body, root),
            (C, "<p>", "t", "b", None)
        );
        assert_eq!((summary.as_deref(), model), (Some("s"), None));
        for k in ["artifactId", "coverAttachmentId", "attachmentId"] {
            let mut v = one.clone();
            v[k] = json!(C);
            assert!(new_html_shape(&v).is_none(), "{k}");
        }
        assert!(new_html_shape(&json!({ "channelId": C, "title": "t", "body": "b" })).is_none());
    }

    #[test]
    fn upload_and_cleanup_sql_match_ts() {
        assert!(UPLOAD_SQL.contains("'text/html'"));
        assert!(CLEANUP_SQL.ends_with("message_id is null"));
        assert_eq!(ARTIFACT_PUBLISH_ARG_MAX_BYTES, 2 * 1024 * 1024);
    }
}
