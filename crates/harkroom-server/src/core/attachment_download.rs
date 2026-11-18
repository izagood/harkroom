//! S5.4 결정 3 — 첨부 내려받기(`GET /attachments/{id}`). TS `routes/attachmentRoutes.ts` 의 그 줄과
//! `services/attachments.ts`(`findDownloadTarget`·`resolveAttachmentFor`)를 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다): 인증(401) → 경로 id(400) → 행 찾기(없음·지운 메시지·고아 → 404 `no such attachment`)
//!   → 메시지에 안 붙은 업로드는 올린 사람만(403 `not your upload`), 붙은 것은 채널 가시성 그대로(403
//!   `not a member of this dm channel`) → 저장소에서 읽기(파일 없음 → 404 `attachment_missing`, 경로는 로그에만).
//! - 헤더: `x-content-type-options: nosniff`, `content-disposition: attachment; filename="…"; filename*=UTF-8''…`(언제나
//!   attachment — inline 예외 없음), `content-length`(행의 `size_bytes`), `content-type`(SVG·HTML·XHTML 은
//!   `application/octet-stream` 으로 무력화).
//! - 바이트는 64KiB 조각으로 흘려보낸다(통째로 메모리에 올리지 않는다). 도중 읽기 오류는 본문 오류(연결 끊김) — TS 스트림과 같다.
//! - 저장소가 없으면(`ATTACHMENT_ROOT` 미설정) `main.rs` 가 이 줄을 붙이지 않는다 — TS 에 남는다.
//!   권한은 [`DOWNLOAD_PRIVILEGES`](읽기 풀) — 없으면 역시 TS.
use super::attachment_store::{LocalStorage, StoreError};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use axum::body::{Body as AxBody, HttpBody};
use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use bytes::Bytes;
use hyper::body::Frame;
use sqlx::PgPool;
use std::io::Read;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::sync::mpsc;

/// 읽기 역할이 이 줄에 필요한 권한. 가시성 술어(`channelVisibleSql`)가 `channel`·`channel_member` 를 본다.
pub const DOWNLOAD_PRIVILEGES: &[(&str, &str)] = &[
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

/// TS `findDownloadTarget` 의 문장(칸은 `COLS` + 채널·지움).
const TARGET_SQL: &str = "select a.id::text, a.message_id::text, a.uploader_id::text, a.filename, \
     a.content_type, a.size_bytes::int, a.storage_key, m.channel_id::text, (m.deleted_at is not null) \
     from attachment a left join message m on m.id = a.message_id where a.id = $1::uuid";

/// 절대 inline 으로 내주지 않는 타입(TS `NEVER_INLINE`).
const NEVER_INLINE: &[&str] = &["image/svg+xml", "text/html", "application/xhtml+xml"];

const CHUNK: usize = 64 * 1024;

type TargetRow = (
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    i32,
    String,
    Option<String>,
    bool,
);

#[derive(Clone)]
pub struct DownloadState {
    pub read: PgPool,
    pub storage: LocalStorage,
}

/// JS `encodeURIComponent` — 남기는 글자: 영숫자와 `-_.!~*'()`. 나머지는 UTF-8 바이트를 대문자 %XX 로.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// TS `dispositionFor` — ASCII 로 좁힌 이름과 UTF-8 원본(RFC 6266). JS 정규식은 UTF-16 단위로 바꾸므로
/// BMP 밖 글자 하나는 `_` 둘이 된다.
pub fn disposition_for(filename: &str) -> String {
    let mut ascii = String::with_capacity(filename.len());
    for c in filename.chars() {
        if ('\x20'..='\x7e').contains(&c) {
            ascii.push(if c == '"' || c == '\\' { '_' } else { c });
        } else {
            for _ in 0..c.len_utf16() {
                ascii.push('_');
            }
        }
    }
    format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
        encode_uri_component(filename)
    )
}

/// 내려줄 타입 — SVG·HTML·XHTML 은 무력화.
pub fn served_type(content_type: &str) -> &str {
    if NEVER_INLINE.contains(&content_type) {
        "application/octet-stream"
    } else {
        content_type
    }
}

/// 파일을 조각으로 흘려보내는 본문.
struct FileBody(mpsc::Receiver<std::io::Result<Bytes>>);

impl HttpBody for FileBody {
    type Data = Bytes;
    type Error = std::io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, std::io::Error>>> {
        self.0.poll_recv(cx).map(|o| o.map(|r| r.map(Frame::data)))
    }
}

pub(crate) fn stream_file(mut f: std::fs::File) -> AxBody {
    let (tx, rx) = mpsc::channel(4);
    tokio::task::spawn_blocking(move || {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match f.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx
                        .blocking_send(Ok(Bytes::copy_from_slice(&buf[..n])))
                        .is_err()
                    {
                        break; // 받는 쪽이 끊었다.
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => {
                    let _ = tx.blocking_send(Err(e));
                    break;
                }
            }
        }
    });
    AxBody::new(FileBody(rx))
}

pub async fn download(
    State(st): State<Arc<DownloadState>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if !crate::lists::is_zod_uuid(&id) {
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다(`channel_files.rs` 와 같다).
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid uuid",
        );
    }
    let row: Option<TargetRow> = match sqlx::query_as(TARGET_SQL)
        .bind(&id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some((
        att_id,
        message_id,
        uploader_id,
        filename,
        content_type,
        size_bytes,
        storage_key,
        channel_id,
        deleted,
    )) = row
    else {
        return not_found();
    };
    // TS `findDownloadTarget`: 붙은 첨부인데 메시지가 없거나 지워졌으면 없는 것.
    if message_id.is_some() && (channel_id.is_none() || deleted) {
        return not_found();
    }
    match (&message_id, &channel_id) {
        (None, _) => {
            if uploader_id.as_deref() != Some(me.id.as_str()) {
                return json_err(StatusCode::FORBIDDEN, "forbidden", "not your upload");
            }
        }
        (Some(_), Some(ch)) => match super::channels::visible(&st.read, &me.id, ch).await {
            Ok(true) => {}
            Ok(false) => {
                return json_err(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    "not a member of this dm channel",
                );
            }
            Err(e) => return internal(e),
        },
        (Some(_), None) => return not_found(),
    }
    let file = match st.storage.read(&storage_key).await {
        Ok(f) => f,
        Err(StoreError::Missing { path, .. }) => {
            eprintln!(
                "attachment {att_id} row exists but file is missing at {}",
                path.display()
            );
            return json_err(
                StatusCode::NOT_FOUND,
                "attachment_missing",
                "attachment file not found on the server",
            );
        }
        Err(e) => {
            eprintln!("attachment {att_id}: storage read failed ({e})");
            return internal_plain();
        }
    };
    let Ok(ct) = HeaderValue::from_str(served_type(&content_type)) else {
        // Node 도 헤더에 못 싣는 글자면 던진다(500).
        return internal_plain();
    };
    let Ok(disp) = HeaderValue::from_str(&disposition_for(&filename)) else {
        return internal_plain();
    };
    let mut r = Response::new(stream_file(file));
    let h = r.headers_mut();
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(header::CONTENT_DISPOSITION, disp);
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(size_bytes));
    h.insert(header::CONTENT_TYPE, ct);
    r
}

fn not_found() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such attachment")
}

fn internal_plain() -> Response {
    json_err(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "internal error",
    )
}

pub fn routes(
    st: DownloadState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<DownloadState>>::new()
        .get("/attachments/{id}", download)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            .layer(axum::middleware::from_fn_with_state(
                cors,
                crate::cors::layer,
            ))
        })
        .finish();
    crate::route_table::Routes {
        router: t.router.with_state(Arc::new(st)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disposition_matches_ts() {
        assert_eq!(
            disposition_for("a b.txt"),
            "attachment; filename=\"a b.txt\"; filename*=UTF-8''a%20b.txt"
        );
        assert_eq!(
            disposition_for("q\"x\\y.png"),
            "attachment; filename=\"q_x_y.png\"; filename*=UTF-8''q%22x%5Cy.png"
        );
        // 한글 두 자 → `_` 둘, 이모지(서로게이트 쌍) → `_` 둘.
        assert_eq!(
            disposition_for("가나.md"),
            "attachment; filename=\"__.md\"; filename*=UTF-8''%EA%B0%80%EB%82%98.md"
        );
        assert_eq!(
            disposition_for("😀"),
            "attachment; filename=\"__\"; filename*=UTF-8''%F0%9F%98%80"
        );
        assert_eq!(
            disposition_for("(it's)!~*-_."),
            "attachment; filename=\"(it's)!~*-_.\"; filename*=UTF-8''(it's)!~*-_."
        );
        assert_eq!(
            disposition_for("a\tb"),
            "attachment; filename=\"a_b\"; filename*=UTF-8''a%09b"
        );
    }

    #[test]
    fn never_inline_types_are_neutralized() {
        assert_eq!(served_type("image/svg+xml"), "application/octet-stream");
        assert_eq!(served_type("text/html"), "application/octet-stream");
        assert_eq!(
            served_type("application/xhtml+xml"),
            "application/octet-stream"
        );
        assert_eq!(served_type("image/png"), "image/png");
        // TS 는 정확히 같은 글자만 막는다(매개변수가 붙으면 그대로).
        assert_eq!(
            served_type("text/html; charset=utf-8"),
            "text/html; charset=utf-8"
        );
    }

    #[tokio::test]
    async fn file_body_streams_all_bytes() {
        use http_body_util::BodyExt;
        let dir = std::env::temp_dir().join(format!("hr-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("f");
        let data: Vec<u8> = (0..(CHUNK * 2 + 17)).map(|i| (i % 251) as u8).collect();
        std::fs::write(&p, &data).unwrap();
        let body = stream_file(std::fs::File::open(&p).unwrap());
        let got = body.collect().await.unwrap().to_bytes();
        assert_eq!(got.as_ref(), data.as_slice());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
