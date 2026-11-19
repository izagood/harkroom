//! P4-4 — 미리보기(아티팩트) 열람 두 줄. TS `routes/previewRoutes.ts` 와 `services/artifactPreview.ts` 를 옮긴다.
//!
//! - `POST /attachments/{id}/preview`(Bearer): 인증(401) → 경로 uuid(400) → 가시성(TS `resolveAttachmentFor` —
//!   없음 404 `not_found`, 그 밖의 거절 403 `forbidden`) → 아티팩트 버전에 걸린 HTML 이 아니면 404 `not_a_preview`
//!   → 5MB 넘으면 413 `too_large` → 60초 서명 토큰을 실은 경로(201).
//! - `GET /preview/{token}`(인증 헤더 없음 — 토큰이 자격): 토큰 꼴(1..=1024 글자, 아니면 400) → 서명·만료 → **열 때
//!   가시성을 다시 판정** → HTML·크기·버전 행 → 파일. 실패는 전부 같은 404(`no-store`) — 무엇이 틀렸는지 가르지 않는다.
//!   응답은 언제나 CSP `sandbox` 를 단다(첫 지시문 — 빼면 에이전트 스크립트가 서버 origin 에서 돈다. 시험이 지킨다).
//! - 토큰 바이트(첨부 16B | 계정 16B | 만료 초 u32 BE | HMAC-SHA256 앞 16B, base64url 무패딩 70자)·MAC 앞붙임
//!   (`harkroom-preview.v1\0`)·CSP 문장은 TS 와 한 글자도 다르지 않다 — 두 코어가 같은 키로 서로의 토큰을 연다.
//! - 서명 키는 DB 한 행(`preview_signing_key`)이고 처음 쓸 때 `insert … on conflict do nothing` 으로 만든다(쓰기 풀).
//!   프로세스 안에서 한 번만 읽고, 실패한 읽기는 캐시하지 않는다(TS 와 같다).
//! - 붙이는 조건: `HARKROOM_CORE=rust`·읽기 풀에 [`PREVIEW_READ_PRIVILEGES`]·쓰기 풀에 [`PREVIEW_WRITE_PRIVILEGES`]·
//!   첨부 저장소(`ATTACHMENT_ROOT`). 하나라도 없으면 두 줄은 TS 에 남는다.
use super::attachment_download::{TARGET_SQL, TargetRow, stream_file};
use super::attachment_store::{LocalStorage, StoreError};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::hmac;
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::OnceCell;

/// 미리보기로 열 수 있는 HTML 의 상한(TS `ARTIFACT_HTML_MAX_BYTES`).
pub const ARTIFACT_HTML_MAX_BYTES: i64 = 5 * 1024 * 1024;
/// 서명 URL 의 수명(TS `PREVIEW_TOKEN_TTL_MS`).
pub const PREVIEW_TOKEN_TTL_MS: i64 = 60_000;

/// 읽기 역할이 이 두 줄에 필요한 권한 — 첨부 다운로드와 같은 가시성 칸 + 아티팩트 버전 칸.
pub const PREVIEW_READ_PRIVILEGES: &[(&str, &str)] = &[
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
    ("artifact.id", "SELECT"),
    ("artifact.title", "SELECT"),
    ("artifact_version.artifact_id", "SELECT"),
    ("artifact_version.version", "SELECT"),
    ("artifact_version.attachment_id", "SELECT"),
    ("artifact_version.title", "SELECT"),
];

/// 쓰기 역할이 서명 키를 만들고 읽는 데 필요한 권한.
pub const PREVIEW_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("preview_signing_key", "INSERT"),
    ("preview_signing_key", "SELECT"),
];

const BODY_BYTES: usize = 16 + 16 + 4;
const MAC_BYTES: usize = 16;
const MAC_PREFIX: &[u8] = b"harkroom-preview.v1\0";

/// TS `PREVIEW_CSP` — 지시문 순서까지 같다. 넓히는 것은 격리면을 넓히는 것이다(security 검토).
pub const PREVIEW_CSP: &str = concat!(
    "sandbox allow-scripts allow-popups; ",
    "default-src 'none'; ",
    "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; ",
    "style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com; ",
    "font-src data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; ",
    "img-src data: blob:; ",
    "media-src data: blob:; ",
    "connect-src 'none'; ",
    "form-action 'none'; ",
    "base-uri 'none'; ",
    "frame-ancestors tauri://localhost http://tauri.localhost http://localhost:5173",
);

const VERSION_SQL: &str = "select v.artifact_id::text, v.version, coalesce(v.title, a.title), a.title, \
     (select max(v2.version) from artifact_version v2 where v2.artifact_id = v.artifact_id) \
     from artifact_version v join artifact a on a.id = v.artifact_id where v.attachment_id = $1::uuid";

type VersionRow = (String, i32, String, String, Option<i32>);

pub struct PreviewState {
    pub read: PgPool,
    pub write: PgPool,
    pub storage: LocalStorage,
    key: OnceCell<Vec<u8>>,
}

impl PreviewState {
    pub fn new(read: PgPool, write: PgPool, storage: LocalStorage) -> Self {
        Self {
            read,
            write,
            storage,
            key: OnceCell::new(),
        }
    }

    /// TS `createPreviewKeyReader` — 실패는 캐시하지 않는다(`get_or_try_init` 은 Err 면 비운 채로 둔다).
    async fn key(&self) -> Result<&[u8], sqlx::Error> {
        self.key
            .get_or_try_init(|| async {
                let mut fresh = [0u8; 32];
                getrandom::fill(&mut fresh).expect("os random");
                sqlx::query(
                    "insert into preview_signing_key (id, key) values (1, $1) on conflict (id) do nothing",
                )
                .bind(&fresh[..])
                .execute(&self.write)
                .await?;
                let (k,): (Vec<u8>,) =
                    sqlx::query_as("select key from preview_signing_key where id = 1")
                        .fetch_one(&self.write)
                        .await?;
                Ok(k)
            })
            .await
            .map(Vec::as_slice)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn uuid_bytes(id: &str) -> Option<[u8; 16]> {
    let hex: String = id.chars().filter(|&c| c != '-').collect();
    if hex.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

fn uuid_string(b: &[u8]) -> String {
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

fn mac(key: &[u8], body: &[u8]) -> [u8; MAC_BYTES] {
    let mut ctx = hmac::Context::with_key(&hmac::Key::new(hmac::HMAC_SHA256, key));
    ctx.update(MAC_PREFIX);
    ctx.update(body);
    let tag = ctx.sign();
    let mut out = [0u8; MAC_BYTES];
    out.copy_from_slice(&tag.as_ref()[..MAC_BYTES]);
    out
}

/// TS `signPreviewToken`. id 는 이미 uuid 로 걸러진 값이다(가시성 판정을 지난 첨부·계정).
pub fn sign_token(
    key: &[u8],
    attachment_id: &str,
    account_id: &str,
    now_ms: i64,
) -> Option<String> {
    let mut raw = [0u8; BODY_BYTES + MAC_BYTES];
    raw[..16].copy_from_slice(&uuid_bytes(attachment_id)?);
    raw[16..32].copy_from_slice(&uuid_bytes(account_id)?);
    // 초 단위로 올림(TS `Math.ceil`) — 내림하면 수명이 최대 1초 짧아진다.
    let exp = (now_ms + PREVIEW_TOKEN_TTL_MS + 999).div_euclid(1000) as u32;
    raw[32..36].copy_from_slice(&exp.to_be_bytes());
    let m = mac(key, &raw[..BODY_BYTES]);
    raw[BODY_BYTES..].copy_from_slice(&m);
    Some(URL_SAFE_NO_PAD.encode(raw))
}

/// TS `verifyPreviewToken` — 무엇이 틀렸는지는 돌려주지 않는다.
pub fn verify_token(key: &[u8], token: &str, now_ms: i64) -> Option<(String, String)> {
    if token.is_empty()
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    let raw = URL_SAFE_NO_PAD.decode(token).ok()?;
    if raw.len() != BODY_BYTES + MAC_BYTES {
        return None;
    }
    // 한 토큰에 한 표기만 받는다(남는 비트만 다른 표기 거절).
    if URL_SAFE_NO_PAD.encode(&raw) != token {
        return None;
    }
    let body = &raw[..BODY_BYTES];
    if !super::automation_ingress_verify::safe_equal(&raw[BODY_BYTES..], &mac(key, body)) {
        return None;
    }
    let exp = u32::from_be_bytes([body[32], body[33], body[34], body[35]]) as i64;
    if now_ms >= exp * 1000 {
        return None;
    }
    Some((uuid_string(&body[..16]), uuid_string(&body[16..32])))
}

fn is_html(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .eq_ignore_ascii_case("text/html")
}

/// 가시성을 지난 첨부.
struct Visible {
    id: String,
    content_type: String,
    size_bytes: i32,
    storage_key: String,
}

enum Denial {
    NotFound,
    Hidden,
}

/// TS `resolveAttachmentFor` — `attachment_download::download` 의 판정과 같은 갈래.
async fn resolve_for(
    pool: &PgPool,
    id: &str,
    me: &str,
) -> Result<Result<Visible, Denial>, sqlx::Error> {
    let row: Option<TargetRow> = sqlx::query_as(TARGET_SQL)
        .bind(id)
        .fetch_optional(pool)
        .await?;
    let Some((
        att_id,
        message_id,
        uploader_id,
        _,
        content_type,
        size_bytes,
        storage_key,
        ch,
        deleted,
    )) = row
    else {
        return Ok(Err(Denial::NotFound));
    };
    if message_id.is_some() && (ch.is_none() || deleted) {
        return Ok(Err(Denial::NotFound));
    }
    match ch {
        None => {
            if uploader_id.as_deref() != Some(me) {
                return Ok(Err(Denial::Hidden));
            }
        }
        Some(ch) => {
            if !super::channels::visible(pool, me, &ch).await? {
                return Ok(Err(Denial::Hidden));
            }
        }
    }
    Ok(Ok(Visible {
        id: att_id,
        content_type,
        size_bytes,
        storage_key,
    }))
}

async fn version_for(pool: &PgPool, id: &str) -> Result<Option<VersionRow>, sqlx::Error> {
    sqlx::query_as(VERSION_SQL)
        .bind(id)
        .fetch_optional(pool)
        .await
}

fn iso_ms(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

pub async fn issue(
    State(st): State<Arc<PreviewState>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if !crate::lists::is_zod_uuid(&id) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid uuid",
        );
    }
    let att = match resolve_for(&st.read, &id, &me.id).await {
        Ok(Ok(a)) => a,
        Ok(Err(Denial::NotFound)) => {
            return json_err(StatusCode::NOT_FOUND, "not_found", "no such attachment");
        }
        Ok(Err(Denial::Hidden)) => {
            return json_err(
                StatusCode::FORBIDDEN,
                "forbidden",
                "you cannot see this attachment",
            );
        }
        Err(e) => return internal(e),
    };
    let version = match version_for(&st.read, &id).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let Some((artifact_id, version, title, latest_title, latest)) =
        version.filter(|_| is_html(&att.content_type))
    else {
        return json_err(
            StatusCode::NOT_FOUND,
            "not_a_preview",
            "this attachment is not a preview",
        );
    };
    if i64::from(att.size_bytes) > ARTIFACT_HTML_MAX_BYTES {
        return json_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_large",
            "this preview is too large to open",
        );
    }
    let key = match st.key().await {
        Ok(k) => k,
        Err(e) => return internal(e),
    };
    let issued = now_ms();
    let Some(token) = sign_token(key, &att.id, &me.id, issued) else {
        return json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        );
    };
    let mut r = crate::directory::json_ok(
        json!({
            "path": format!("/preview/{token}"),
            "expiresAt": iso_ms(issued + PREVIEW_TOKEN_TTL_MS),
            "artifactId": artifact_id,
            "version": version,
            "latestVersion": latest,
            "title": title,
            "latestTitle": latest_title,
        })
        .to_string(),
    );
    *r.status_mut() = StatusCode::CREATED;
    r
}

fn preview_not_found() -> Response {
    let mut r = json_err(StatusCode::NOT_FOUND, "not_found", "no such preview");
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

pub async fn open(State(st): State<Arc<PreviewState>>, Path(token): Path<String>) -> Response {
    // zod `z.string().min(1).max(1024)` — 길이는 UTF-16 단위.
    let len = token.encode_utf16().count();
    if !(1..=1024).contains(&len) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid token",
        );
    }
    let key = match st.key().await {
        Ok(k) => k,
        Err(e) => return internal(e),
    };
    let Some((attachment_id, account_id)) = verify_token(key, &token, now_ms()) else {
        return preview_not_found();
    };
    let att = match resolve_for(&st.read, &attachment_id, &account_id).await {
        Ok(Ok(a)) => a,
        Ok(Err(_)) => return preview_not_found(),
        Err(e) => return internal(e),
    };
    if !is_html(&att.content_type) || i64::from(att.size_bytes) > ARTIFACT_HTML_MAX_BYTES {
        return preview_not_found();
    }
    match version_for(&st.read, &att.id).await {
        Ok(Some(_)) => {}
        Ok(None) => return preview_not_found(),
        Err(e) => return internal(e),
    }
    let file = match st.storage.read(&att.storage_key).await {
        Ok(f) => f,
        Err(StoreError::Missing { path, .. }) => {
            eprintln!(
                "preview {} row exists but file is missing at {}",
                att.id,
                path.display()
            );
            return preview_not_found();
        }
        Err(e) => {
            eprintln!("preview {}: storage read failed ({e})", att.id);
            return json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal error",
            );
        }
    };
    let mut r = Response::new(stream_file(file));
    let h = r.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(PREVIEW_CSP),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    // URL 에 토큰이 있다 — 페이지 안 링크를 눌러도 밖으로 새지 않게.
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=(), clipboard-read=()"),
    );
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(att.size_bytes));
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    r
}

pub fn routes(
    st: PreviewState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let st = Arc::new(st);
    // 발급 줄만 인증 미들웨어를 단다. 여는 줄은 인증 헤더 없이 온다(iframe·WebView) — 토큰이 자격이다.
    let issue_t = Table::<Arc<PreviewState>>::new()
        .post("/attachments/{id}/preview", issue)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            .layer(axum::middleware::from_fn_with_state(
                cors.clone(),
                crate::cors::layer,
            ))
        })
        .finish();
    let open_t = Table::<Arc<PreviewState>>::new()
        .get("/preview/{token}", open)
        .map(|r| {
            r.layer(axum::middleware::from_fn_with_state(
                cors,
                crate::cors::layer,
            ))
        })
        .finish();
    let mut http = issue_t.http;
    http.extend(open_t.http);
    let mut sockets = issue_t.sockets;
    sockets.extend(open_t.sockets);
    crate::route_table::Routes {
        router: issue_t
            .router
            .with_state(st.clone())
            .merge(open_t.router.with_state(st)),
        http,
        sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCRIPT_HOSTS: &str = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net";
    const KEY: [u8; 32] = [7u8; 32];
    const ATT: &str = "11111111-2222-4333-8444-555555555555";
    const ACC: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    #[test]
    fn csp_matches_ts_and_starts_with_sandbox() {
        assert!(PREVIEW_CSP.starts_with("sandbox allow-scripts allow-popups; "));
        assert!(!PREVIEW_CSP.contains("allow-same-origin"));
        assert!(PREVIEW_CSP.contains(&format!("script-src 'unsafe-inline' {SCRIPT_HOSTS}")));
        assert!(PREVIEW_CSP.contains("connect-src 'none'"));
    }

    #[test]
    fn token_round_trip_and_shape() {
        let t = sign_token(&KEY, ATT, ACC, 1_700_000_000_123).unwrap();
        assert_eq!(t.len(), 70);
        assert_eq!(
            verify_token(&KEY, &t, 1_700_000_000_123),
            Some((ATT.to_string(), ACC.to_string()))
        );
        // 만료: ceil((now+60000)/1000) 초부터 거절.
        assert!(verify_token(&KEY, &t, 1_700_000_060_999).is_some());
        assert!(verify_token(&KEY, &t, 1_700_000_061_000).is_none());
        // 다른 키·한 글자 바꿈·꼴 밖 글자는 거절.
        assert!(verify_token(&[8u8; 32], &t, 1_700_000_000_123).is_none());
        let mut bad = t.clone().into_bytes();
        bad[3] = if bad[3] == b'A' { b'B' } else { b'A' };
        assert!(
            verify_token(&KEY, std::str::from_utf8(&bad).unwrap(), 1_700_000_000_123).is_none()
        );
        assert!(verify_token(&KEY, &format!("{t}="), 1_700_000_000_123).is_none());
        assert!(verify_token(&KEY, "", 0).is_none());
    }

    #[test]
    fn token_matches_ts_bytes() {
        // 값은 TS `signPreviewToken(Buffer.alloc(32, 7), ATT, ACC, 1_700_000_000_123)` 로 뽑았다.
        assert_eq!(
            sign_token(&KEY, ATT, ACC, 1_700_000_000_123).unwrap(),
            TS_VECTOR
        );
    }

    const TS_VECTOR: &str =
        "ERERESIiQzOERFVVVVVVVaqqqqq7u0zMjd3u7u7u7u5lU_E9-ZE3bm1usk0c4Zip8raVBg";

    #[test]
    fn html_detection_like_ts() {
        assert!(is_html("text/html"));
        assert!(is_html(" Text/HTML ; charset=utf-8"));
        assert!(!is_html("application/xhtml+xml"));
        assert!(!is_html("text/plain"));
    }

    #[test]
    fn iso_like_js() {
        assert_eq!(iso_ms(1_700_000_060_123), "2023-11-14T22:14:20.123Z");
    }
}
