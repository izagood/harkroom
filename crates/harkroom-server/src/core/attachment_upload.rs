//! S5.4 — 첨부 올리기(`POST /uploads`). TS `routes/attachmentRoutes.ts` 의 그 줄과 `services/attachments.ts`
//! (`recordUpload`·`displayName`), `storage/local.ts`(`write`)를 옮긴다.
//!
//! - 순서(TS 와 같다): 주소 단위 상한 `upload:{ip}`(429, TS `LIMITED_ROUTES` — 에이전트 요청을 TS 로 넘기기 전에도 센다) → 인증(401) → 첫 **파일** 파트(없으면 400 `bad_request` `expected a file part`) → 저장소에 먼저 쓰기
//!   (제한 `ATTACHMENT_MAX_BYTES`, 기본 25MiB — 넘으면 413 `too_large` `file exceeds the size limit`; TS 는 multipart 파서가
//!   같은 값에서 잘라 `truncated` 갈래로 같은 문장을 낸다) → 행 넣기(실패하면 파일을 지우고 500) → 201
//!   `{ id, filename, contentType, sizeBytes }`.
//! - 내용 판별·허용 목록·미리보기 생성은 TS 에도 없다. 타입은 파트의 `Content-Type` 그대로(busboy 처럼 매개변수를 떼고
//!   소문자 `type/subtype`, 없으면 busboy 기본 `text/plain`) — 믿지 않고 저장만 하며 내려줄 때 무력화한다.
//! - **TS 로 넘기는 요청**(본문을 읽기 전에 판정, 그대로 `proxy::forward`):
//!   - 에이전트의 업로드 — TS 는 비밀 값 유출 검사(`leakGuard.findInBytes`)와 거절 기록을 한다. 그 DB 읽기·기록은 아직 Rust 에 없다.
//!   - `multipart/` 가 아니거나 boundary 가 없는 요청 — TS(@fastify/multipart)의 오류 응답을 그대로 받게 한다.
//! - 저장소(`ATTACHMENT_ROOT`)가 없거나 [`UPLOAD_PRIVILEGES`](쓰기 풀)가 모자라면 `main.rs` 가 이 줄을 붙이지 않는다 — TS.
use super::attachment_store::{LocalStorage, WriteError};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use axum::body::Body;
use axum::extract::{ConnectInfo, FromRequest, FromRequestParts, Multipart, State};
use axum::http::{Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::Arc;

/// 쓰기 역할이 이 줄에 필요한 권한(`insert … returning id, filename, content_type, size_bytes`).
pub const UPLOAD_PRIVILEGES: &[(&str, &str)] = &[
    ("attachment.uploader_id", "INSERT"),
    ("attachment.filename", "INSERT"),
    ("attachment.content_type", "INSERT"),
    ("attachment.size_bytes", "INSERT"),
    ("attachment.storage_key", "INSERT"),
    ("attachment.id", "SELECT"),
    ("attachment.filename", "SELECT"),
    ("attachment.content_type", "SELECT"),
    ("attachment.size_bytes", "SELECT"),
];

/// TS `recordUpload` 의 문장(응답에 쓰는 칸만 돌려받는다).
const INSERT_SQL: &str = "insert into attachment (uploader_id, filename, content_type, size_bytes, storage_key) \
     values ($1::uuid, $2, $3, $4::bigint, $5) \
     returning id::text, filename, content_type, size_bytes::int";

/// TS `DEFAULT_MAX_ATTACHMENT_BYTES`.
pub const DEFAULT_MAX_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Clone)]
pub struct UploadState {
    pub write: PgPool,
    pub storage: LocalStorage,
    pub max_bytes: u64,
    pub up: crate::proxy::Upstream,
    /// 주소 단위 상한 `upload:{ip}`([`crate::rate_limit::UPLOAD`]) — 다른 주소 단위 줄과 같은 리미터를 나눠 쓴다.
    pub limiter: Arc<crate::rate_limit::RateLimiter>,
    pub trust: Arc<crate::trust_proxy::TrustProxy>,
}

/// `ATTACHMENT_MAX_BYTES` — 없으면 기본값. 음이 아닌 정수가 아니면 `None`(TS `Number(...)` 의 NaN·소수 갈래는 옮기지 않는다 → TS).
pub fn max_bytes_from_env() -> Option<u64> {
    match std::env::var("ATTACHMENT_MAX_BYTES") {
        Err(_) => Some(DEFAULT_MAX_BYTES),
        Ok(v) => v.trim().parse::<u64>().ok(),
    }
}

/// TS `displayName` — 경로를 떼고(역슬래시도 구분자), 제어문자(U+0000–U+001F, U+007F)를 지우고, 앞뒤 공백을 자르고,
/// 비었거나 `.`·`..` 이면 `file`, 아니면 UTF-16 255 칸까지.
pub fn display_name(raw: &str) -> String {
    let unified = raw.replace('\\', "/");
    // Node `path.basename`: 끝의 `/` 들을 무시한 마지막 성분.
    let trimmed = unified.trim_end_matches('/');
    let base = trimmed.rsplit('/').next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|&c| (c as u32) >= 0x20 && (c as u32) != 0x7f)
        .collect();
    let name = js_trim(&cleaned);
    if name.is_empty() || name == "." || name == ".." {
        return "file".to_string();
    }
    // JS `slice(0, 255)` 는 UTF-16 칸 — 서로게이트 쌍을 자르면 외톨이 반쪽이 남는다. Rust 문자열은 그것을 못 담으므로
    // 그 글자는 U+FFFD 로 둔다(Postgres 에 들어가는 UTF-8 변환이 Node 에서도 같은 치환을 한다).
    let mut out = String::new();
    let mut units = 0usize;
    for c in name.chars() {
        let n = c.len_utf16();
        if units + n > 255 {
            if units < 255 {
                out.push('\u{FFFD}');
            }
            break;
        }
        units += n;
        out.push(c);
    }
    out
}

/// JS `String.prototype.trim` 의 공백(제어문자는 이미 지웠다).
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}')
}

/// busboy 의 `mimeType` — 매개변수를 뗀 소문자 `type/subtype`, 없거나 못 읽으면 `text/plain`.
pub fn part_mime(raw: Option<&str>) -> String {
    let Some(raw) = raw else {
        return "text/plain".to_string();
    };
    let essence = raw.split(';').next().unwrap_or("").trim();
    match essence.split_once('/') {
        Some((t, s)) if !t.trim().is_empty() && !s.trim().is_empty() => {
            format!("{}/{}", t.trim(), s.trim()).to_ascii_lowercase()
        }
        _ => "text/plain".to_string(),
    }
}

fn is_multipart_with_boundary(req: &Request<Body>) -> bool {
    let Some(ct) = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let l = ct.to_ascii_lowercase();
    l.starts_with("multipart/form-data") && l.contains("boundary=")
}

/// 첫 파일 앞에 올 수 있는 일반 필드 수 상한.
pub const MAX_FIELDS: usize = 1000;

fn too_large() -> Response {
    json_err(
        StatusCode::PAYLOAD_TOO_LARGE,
        "too_large",
        "file exceeds the size limit",
    )
}

fn internal_plain() -> Response {
    json_err(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "internal error",
    )
}

pub async fn upload(
    State(st): State<Arc<UploadState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request<Body>,
) -> Response {
    let (mut parts, body) = req.into_parts();
    // TS `LIMITED_ROUTES` onRequest 훅 — 인증·본문·TS 로 넘기기보다 먼저 센다.
    let ip = crate::trust_proxy::request_ip(&parts, &st.trust).unwrap_or_default();
    let verdict = st
        .limiter
        .hit(&format!("upload:{ip}"), crate::rate_limit::UPLOAD);
    if !verdict.allowed {
        return crate::rate_limit::too_many(verdict, false);
    }
    let me = match RequireAccount::from_request_parts(&mut parts, &()).await {
        Ok(RequireAccount(me, _)) => me,
        Err(r) => return r,
    };
    let req = Request::from_parts(parts, body);
    if me.kind == "agent" || !is_multipart_with_boundary(&req) {
        return crate::proxy::forward(State(st.up.clone()), ConnectInfo(peer), req).await;
    }
    let mut mp = match Multipart::from_request(req, &()).await {
        Ok(m) => m,
        Err(e) => return e.into_response(),
    };
    // 첫 파일 파트(TS `req.file()`) — 앞의 일반 필드는 건너뛴다. 건너뛰는 필드는 조각째 읽어 버린다(한 필드를 통째로
    // 메모리에 쌓지 않는다 — busboy `fieldSize` 1MiB 를 넘는 값을 잘라 버리는 것과 결과가 같다). 개수는
    // [`MAX_FIELDS`] 까지 — 넘으면 @fastify/multipart `FieldsLimitError` 처럼 413.
    let mut fields = 0usize;
    let mut field = loop {
        match mp.next_field().await {
            Ok(Some(f)) if f.file_name().is_some() => break f,
            Ok(Some(mut f)) => {
                fields += 1;
                if fields > MAX_FIELDS {
                    return json_err(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "fst_fields_limit",
                        "reach fields limit",
                    );
                }
                loop {
                    match f.chunk().await {
                        Ok(Some(_)) => {}
                        Ok(None) => break,
                        Err(e) => return e.into_response(),
                    }
                }
            }
            Ok(None) => {
                return json_err(
                    StatusCode::BAD_REQUEST,
                    "bad_request",
                    "expected a file part",
                );
            }
            Err(e) => return e.into_response(),
        }
    };
    let filename = field.file_name().unwrap_or_default().to_string();
    let content_type = part_mime(
        field
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
    );

    // 파일을 먼저 쓰고 행을 나중에 만든다(TS 와 같다 — 실패하면 남는 것은 고아 파일이지 깨진 첨부가 아니다).
    let mut w = match st.storage.begin_write(st.max_bytes).await {
        Ok(w) => w,
        Err(e) => {
            eprintln!("upload: storage open failed ({e})");
            return internal_plain();
        }
    };
    loop {
        match field.chunk().await {
            Ok(Some(c)) => match w.append(c).await {
                Ok(()) => {}
                Err(WriteError::TooLarge) => return too_large(),
                Err(WriteError::Store(e)) => {
                    eprintln!("upload: storage write failed ({e})");
                    return internal_plain();
                }
            },
            Ok(None) => break,
            Err(e) => {
                w.abort().await;
                return e.into_response();
            }
        }
    }
    let stored = match w.commit().await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("upload: storage commit failed ({e})");
            return internal_plain();
        }
    };

    let row: Result<(String, String, String, i32), sqlx::Error> = sqlx::query_as(INSERT_SQL)
        .bind(&me.id)
        .bind(display_name(&filename))
        .bind(&content_type)
        .bind(stored.bytes as i64)
        .bind(&stored.key)
        .fetch_one(&st.write)
        .await;
    match row {
        Ok((id, filename, content_type, size_bytes)) => (
            StatusCode::CREATED,
            [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
            serde_json::json!({
                "id": id, "filename": filename, "contentType": content_type, "sizeBytes": size_bytes,
            })
            .to_string(),
        )
            .into_response(),
        Err(e) => {
            // 행을 만들지 못했으면 파일은 아무도 가리키지 않는다 — 지금 지운다.
            let _ = st.storage.remove(&stored.key).await;
            internal(e)
        }
    }
}

pub fn routes(
    st: UploadState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<UploadState>>::new()
        .post("/uploads", upload)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            // 전체 본문 제한은 두지 않는다(TS 도 파일 크기만 본다) — 파일 제한은 흐르는 중에 끊는다.
            .layer(axum::extract::DefaultBodyLimit::disable())
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
    fn display_name_matches_ts() {
        assert_eq!(display_name("a.txt"), "a.txt");
        assert_eq!(display_name("C:\\Users\\x\\b.png"), "b.png");
        assert_eq!(display_name("/etc/passwd"), "passwd");
        assert_eq!(display_name("dir/"), "dir");
        assert_eq!(display_name("a\nb\r.txt"), "ab.txt");
        assert_eq!(display_name("  sp ace  "), "sp ace");
        assert_eq!(display_name(""), "file");
        assert_eq!(display_name(".."), "file");
        assert_eq!(display_name("x/."), "file");
        assert_eq!(display_name("\u{7f}\u{1}"), "file");
        let long = "가".repeat(300);
        assert_eq!(display_name(&long).chars().count(), 255);
        let emoji = "😀".repeat(200);
        let d = display_name(&emoji);
        assert_eq!(d.encode_utf16().count(), 255);
        assert!(d.ends_with('\u{FFFD}'));
    }

    #[test]
    fn part_mime_is_busboy_like() {
        assert_eq!(part_mime(None), "text/plain");
        assert_eq!(part_mime(Some("Image/PNG; x=1")), "image/png");
        assert_eq!(part_mime(Some("garbage")), "text/plain");
        assert_eq!(
            part_mime(Some("application/octet-stream")),
            "application/octet-stream"
        );
    }

    #[tokio::test]
    async fn upload_ip_limit_triggers_before_auth() {
        let dir = std::env::temp_dir().join(format!("hr-upload-rl-{}", std::process::id()));
        let st = test_state(&dir);
        let req = |ip: [u8; 4]| {
            let peer = SocketAddr::from((ip, 4000));
            let mut r = Request::post("/uploads").body(Body::empty()).unwrap();
            r.extensions_mut().insert(ConnectInfo(peer));
            (peer, r)
        };
        for _ in 0..crate::rate_limit::UPLOAD.max {
            let (peer, r) = req([10, 0, 0, 1]);
            let res = upload(State(st.clone()), ConnectInfo(peer), r).await;
            assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        }
        let (peer, r) = req([10, 0, 0, 1]);
        let res = upload(State(st.clone()), ConnectInfo(peer), r).await;
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(res.headers().contains_key(header::RETRY_AFTER));
        let body = axum::body::to_bytes(res.into_body(), 4096).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["error"]["code"], "rate_limited");
        assert_eq!(v["error"]["message"], "too many attempts, try again later");
        // 다른 주소는 따로 센다.
        let (peer, r) = req([10, 0, 0, 2]);
        let res = upload(State(st.clone()), ConnectInfo(peer), r).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn test_state(dir: &std::path::Path) -> Arc<UploadState> {
        Arc::new(UploadState {
            write: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://x@127.0.0.1:1/x")
                .unwrap(),
            storage: LocalStorage::new(dir).unwrap(),
            max_bytes: DEFAULT_MAX_BYTES,
            up: crate::proxy::Upstream::new("http://127.0.0.1:1"),
            limiter: Arc::new(crate::rate_limit::RateLimiter::default()),
            trust: Arc::new(crate::trust_proxy::TrustProxy::None),
        })
    }

    #[tokio::test]
    async fn too_many_fields_before_file_is_413() {
        let dir = std::env::temp_dir().join(format!("hr-upload-fl-{}", std::process::id()));
        let st = test_state(&dir);
        let mut body = String::new();
        for i in 0..=MAX_FIELDS {
            body.push_str(&format!(
                "--B\r\nContent-Disposition: form-data; name=\"f{i}\"\r\n\r\nv\r\n"
            ));
        }
        body.push_str("--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\n\r\nhi\r\n--B--\r\n");
        let peer = SocketAddr::from(([10, 0, 0, 3], 4000));
        let mut r = Request::post("/uploads")
            .header(header::CONTENT_TYPE, "multipart/form-data; boundary=B")
            .body(Body::from(body))
            .unwrap();
        r.extensions_mut().insert(ConnectInfo(peer));
        r.extensions_mut().insert(crate::auth::Auth {
            account: Some(crate::auth::Account {
                id: "00000000-0000-0000-0000-000000000001".into(),
                handle: "h".into(),
                display_name: "h".into(),
                kind: "human".into(),
                is_admin: false,
                role: "member".into(),
                status: "active".into(),
                status_text: None,
                avatar_attachment_id: None,
            }),
            ..Default::default()
        });
        let res = upload(State(st), ConnectInfo(peer), r).await;
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn max_bytes_default() {
        assert_eq!(DEFAULT_MAX_BYTES, 26_214_400);
    }

    #[test]
    fn privileges_cover_insert_columns() {
        for c in [
            "uploader_id",
            "filename",
            "content_type",
            "size_bytes",
            "storage_key",
        ] {
            assert!(
                UPLOAD_PRIVILEGES.contains(&(format!("attachment.{c}").as_str(), "INSERT")),
                "{c}"
            );
        }
    }
}
