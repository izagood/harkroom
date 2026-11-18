//! MCP `artifact.publish` 의 거절 앞머리(TS `mcpPlugin.ts` `artifact.publish`). TS 순서 그대로: zod 인자 → 채널 가시성
//! (`forbidden` `not a member of this dm channel`) → `html`·`attachmentId` 중 꼭 하나(`bad_request`). 둘 다 지나면 `None`
//! (→ TS). 쓰기 상태([`ArtifactWrite`])가 있으면 [`publish`] 가 게시까지 맡는다 — `html` 글자·미리 올린 `attachmentId` 둘 다,
//! 고쳐 올리기(`artifactId`)는 [`ArtifactWrite::revise`], 표지(`coverAttachmentId`)는 [`ArtifactWrite::cover`] 가 켜졌을 때만.
//! 꺼진 모양은 여전히 TS 몫이다. 인자가 zod 를 못 지나거나 DB 오류여도 `None`.
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
    /// [`super::artifact_write::ARTIFACT_REVISE_PRIVILEGES`] 가 다 있으면 `artifactId`(고쳐 올리기)도 맡는다.
    pub revise: bool,
    /// [`super::artifact_write::ARTIFACT_COVER_PRIVILEGES`] 가 다 있으면 `coverAttachmentId`(표지)도 맡는다.
    pub cover: bool,
}

/// 게시가 안 됐을 때 이 도구가 만든 업로드를 지우는 칸(TS `delete from attachment where id = $1 and message_id is null`).
pub const ARTIFACT_UPLOAD_CLEANUP_PRIVILEGES: &[(&str, &str)] = &[
    ("attachment", "DELETE"),
    ("attachment.message_id", "SELECT"),
];

const UPLOAD_SQL: &str = "insert into attachment (uploader_id, filename, content_type, size_bytes, storage_key) \
     values ($1::uuid, $2, 'text/html', $3::bigint, $4) returning id::text";
const CLEANUP_SQL: &str = "delete from attachment where id = $1::uuid and message_id is null";

/// 페이지 출처 — `html` 글자(이 도구가 업로드 행을 만든다) 또는 미리 올린 `attachmentId`.
#[derive(Debug, PartialEq, Eq)]
enum Page<'a> {
    Html(&'a str),
    Attachment(&'a str),
}

/// 이 판이 게시까지 맡는 모양(인자는 [`parse`] 를 지난 뒤다).
#[derive(Debug, PartialEq, Eq)]
struct Shape<'a> {
    channel: &'a str,
    page: Page<'a>,
    /// zod `trim()` 을 지난 제목.
    title: String,
    body: &'a str,
    root: Option<&'a str>,
    summary: Option<String>,
    model: Option<String>,
    artifact: Option<&'a str>,
    cover: Option<&'a str>,
}

/// 게시까지 맡는 모양을 고른다. `artifactId` 는 `revise`, `coverAttachmentId` 는 `cover` 가 꺼져 있으면 `None`(→ TS).
fn shape(args: &Value, revise: bool, cover: bool) -> Option<Shape<'_>> {
    let o = args.as_object()?;
    let s = |k: &str| o.get(k).and_then(Value::as_str);
    let artifact = s("artifactId");
    let cover_id = s("coverAttachmentId");
    if (artifact.is_some() && !revise) || (cover_id.is_some() && !cover) {
        return None;
    }
    let page = match (s("html"), s("attachmentId")) {
        (Some(h), None) => Page::Html(h),
        (None, Some(a)) => Page::Attachment(a),
        _ => return None,
    };
    let model = match s("model") {
        None => None,
        Some(m) => crate::core::cause_link::trimmed_model(m)?,
    };
    Some(Shape {
        channel: s("channelId")?,
        page,
        title: s("title")?.trim_matches(js_trim_char).to_owned(),
        body: s("body")?,
        root: s("threadRootId"),
        summary: s("summary").map(|x| x.trim_matches(js_trim_char).to_owned()),
        model,
        artifact,
        cover: cover_id,
    })
}

/// 게시까지 Rust 가 답한다. 거절 앞머리([`answer`])를 먼저 돌고, 그 뒤 [`shape`] 가 고른 모양만 받는다(그 밖은 `None` → TS).
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
    let sh = shape(args, aw.revise, aw.cover)?;
    // html 글자로 받았으면 먼저 업로드 행으로 만든다(TS 와 같은 길). `uploaded` 는 실패 때 지울 `(id, 저장 키)`.
    let (html_id, uploaded) = match sh.page {
        Page::Attachment(a) => (a.to_owned(), None),
        Page::Html(html) => {
            if html.len() > ARTIFACT_PUBLISH_ARG_MAX_BYTES {
                return Some(err(
                    "too_large",
                    "html exceeds 2MB — write it to a file and use attachment.upload",
                ));
            }
            let filename = format!("{}.html", slug_filename(&sh.title)?);
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
            (upload.clone(), Some((upload, stored.key)))
        }
    };
    let hook = super::artifact_write::NewArtifact::new(
        sh.channel.to_owned(),
        me.id.clone(),
        sh.title,
        html_id.clone(),
        sh.summary,
    )
    .with(sh.artifact.map(str::to_owned), sh.cover.map(str::to_owned));
    let mut attachment_ids = vec![html_id];
    attachment_ids.extend(sh.cover.map(str::to_owned));
    let post_body = crate::core::msg_post::PostBody {
        body: sh.body.to_owned(),
        attachment_ids,
        thread_root: sh.root.map(str::to_owned),
        also_in_channel: false,
    };
    let out = super::msg_post::answer_artifact(
        &aw.post, me, sh.channel, post_body, sh.model, &hook, cause, turn, operator,
    )
    .await;
    // 글이 안 생겼으면(거절·TS 로 넘김·재생) 이 도구가 만든 업로드는 아무도 가리키지 않는다 — 지운다. 붙었으면 `message_id` 가 있어
    // 지워지지 않는다. 미리 올린 `attachmentId` 는 부른 쪽 것이라 건드리지 않는다(TS 와 같다).
    if let Some((upload, key)) = uploaded
        && (hook.published().is_none() || out.is_none())
    {
        let gone = sqlx::query(CLEANUP_SQL)
            .bind(&upload)
            .execute(&aw.post.write)
            .await
            .is_ok_and(|r| r.rows_affected() == 1);
        if gone {
            let _ = aw.storage.remove(&key).await;
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
    fn shapes_published_here() {
        let one =
            json!({ "channelId": C, "title": " t ", "body": "b", "html": "<p>", "summary": " s " });
        let sh = shape(&one, false, false).unwrap();
        assert_eq!(
            (sh.channel, &sh.page, sh.title.as_str(), sh.body, sh.root),
            (C, &Page::Html("<p>"), "t", "b", None)
        );
        assert_eq!((sh.summary.as_deref(), sh.model), (Some("s"), None));
        assert_eq!((sh.artifact, sh.cover), (None, None));
        // 미리 올린 페이지.
        let att = json!({ "channelId": C, "title": "t", "body": "b", "attachmentId": C });
        assert_eq!(shape(&att, false, false).unwrap().page, Page::Attachment(C));
        // 고쳐 올리기·표지는 켜졌을 때만.
        let mut rev = one.clone();
        rev["artifactId"] = json!(C);
        assert!(shape(&rev, false, true).is_none());
        assert_eq!(shape(&rev, true, false).unwrap().artifact, Some(C));
        let mut cov = one.clone();
        cov["coverAttachmentId"] = json!(C);
        assert!(shape(&cov, true, false).is_none());
        assert_eq!(shape(&cov, false, true).unwrap().cover, Some(C));
        // 둘 다/둘 다 없음은 앞머리가 거절한다 — 여기선 맡지 않는다.
        let mut both = one.clone();
        both["attachmentId"] = json!(C);
        assert!(shape(&both, true, true).is_none());
        assert!(
            shape(
                &json!({ "channelId": C, "title": "t", "body": "b" }),
                true,
                true
            )
            .is_none()
        );
    }

    #[test]
    fn upload_and_cleanup_sql_match_ts() {
        assert!(UPLOAD_SQL.contains("'text/html'"));
        assert!(CLEANUP_SQL.ends_with("message_id is null"));
        assert_eq!(ARTIFACT_PUBLISH_ARG_MAX_BYTES, 2 * 1024 * 1024);
    }
}
