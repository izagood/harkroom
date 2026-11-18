//! S5.4 AT7 — 들어오는 hook 두 개(`POST /hooks/github/:id`, `POST /hooks/generic/:id`). TS `routes/automationRoutes.ts` 의
//! hooks 범위와 `services/automationIngress.ts` 의 `loadIngressTarget`·검증을 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: (1) 경로 id 가 uuid 가 아니거나 수신이 꺼졌거나 없는 id → 404 `not_found`,
//!   (github 은 트리거가 github 이 아니어도 404), (2) 서명·키가 틀리면 401(`bad_signature`·`bad_key`),
//!   (3) github `ping` → 200 `{status:'pong'}`, (4) 본문이 JSON 이 아니면 400 `bad_json`.
//! - 서명은 **원문 바이트**로 검증한다(본문을 다시 직렬화하지 않는다). 비교는 상수 시간
//!   (`automation_ingress_verify::safe_equal`). 본문 상한은 전역 `bodyLimit` 과 같은 1MiB.
//! - **TS 로 넘기는 것**: 검증을 통과한 뒤의 필터(`matchGithub`·`genericVars`)와 회차 만들기(`enqueueRun` —
//!   디바운스 모으기·시간당 상한 일시정지)는 아직 TS 다. 원문 바이트를 그대로 넘기므로 TS 가 같은 판정을 다시 한다.
//!   `application/json` 이 아닌 content-type 도 fastify 파서 동작(415·문자열 본문)을 그대로 두려고 TS 로 넘긴다.
//! - 비밀(토큰 해시·봉인된 서명 키·열린 키)은 기록하지 않는다. [`IngressTarget`] 의 Debug 는 가린다.
use crate::core::automation_ingress_verify::{verify_bearer, verify_github_signature};
use crate::directory::{internal, json_err};
use crate::proxy::Upstream;
use crate::secrets::secret_box::SecretBox;
use axum::body::{Body, to_bytes};
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use sqlx::PgPool;
use std::fmt;
use std::net::SocketAddr;
use std::sync::Arc;

/// 읽기 풀이 이 줄에서 쓰는 칸. **새 GRANT**: `automation.ingress_token_hash`·`automation.ingress_secret_enc` 의 SELECT
/// (보안 검토 요청으로 따로 적는다 — 두 칸은 이 모듈의 [`TARGET_SQL`] 에서만 읽는다).
pub const PRIVILEGES: &[(&str, &str)] = &[
    ("automation.id", "SELECT"),
    ("automation.trigger", "SELECT"),
    ("automation.enabled", "SELECT"),
    ("automation.deleted_at", "SELECT"),
    ("automation.ingress_enabled_at", "SELECT"),
    ("automation.ingress_token_hash", "SELECT"),
    ("automation.ingress_secret_enc", "SELECT"),
];

/// TS `loadIngressTarget` — 수신이 **켜진** 자동화만.
pub(crate) const TARGET_SQL: &str = "select trigger->>'kind', ingress_token_hash, ingress_secret_enc \
     from automation where id = $1::uuid and deleted_at is null and ingress_enabled_at is not null";

const BODY_LIMIT: usize = 1024 * 1024;

struct IngressTarget {
    kind: Option<String>,
    token_hash: Option<String>,
    secret_enc: Option<String>,
}

impl fmt::Debug for IngressTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IngressTarget")
            .field("kind", &self.kind)
            .field(
                "token_hash",
                &self.token_hash.as_ref().map(|_| "<redacted>"),
            )
            .field(
                "secret_enc",
                &self.secret_enc.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

pub struct HooksState {
    read: PgPool,
    up: Upstream,
    secret_box: Option<SecretBox>,
}

impl fmt::Debug for HooksState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("HooksState(<redacted>)")
    }
}

impl HooksState {
    /// 서명 키 상자는 TS 처럼 `HARKROOM_SECRET_KEY` 에서 한 번 읽는다(없으면 github 서명은 늘 실패 → 401).
    pub fn new(read: PgPool, up: Upstream) -> Self {
        Self {
            read,
            up,
            secret_box: SecretBox::from_env(),
        }
    }
}

fn hook_not_found() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "not found")
}

/// TS `verifyGithubSignature` 전체 — 상자·암호문·헤더가 다 있고, 열린 키로 만든 HMAC 이 같을 때만.
fn github_ok(
    secret_box: Option<&SecretBox>,
    secret_enc: Option<&str>,
    raw: &[u8],
    sig: Option<&str>,
) -> bool {
    let (Some(b), Some(enc), Some(h)) = (secret_box, secret_enc, sig) else {
        return false;
    };
    if !h.starts_with("sha256=") {
        return false;
    }
    let Some(key) = b.open(enc) else {
        return false;
    };
    verify_github_signature(key.as_bytes(), raw, Some(h))
}

/// TS hooks 범위의 `parse` — 빈 본문은 `{}`, 깨진 JSON 은 None.
fn parse(raw: &[u8]) -> Option<Value> {
    if raw.is_empty() {
        return Some(Value::Object(Default::default()));
    }
    serde_json::from_slice(raw).ok()
}

/// content-type 이 있는데 `application/json` 이 아니면 fastify 의 다른 파서가 탄다 — 그대로 TS 에 맡긴다.
fn non_json_content(h: &HeaderMap) -> bool {
    h.get(header::CONTENT_TYPE).is_some_and(|v| {
        let s = v.to_str().unwrap_or("");
        let essence = s.split(';').next().unwrap_or("").trim();
        !essence.eq_ignore_ascii_case("application/json")
    })
}

fn header_str<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    h.get(name).and_then(|v| v.to_str().ok())
}

async fn load(read: &PgPool, id: &str) -> Result<Option<IngressTarget>, sqlx::Error> {
    let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(TARGET_SQL)
        .bind(id)
        .fetch_optional(read)
        .await?;
    Ok(row.map(|(kind, token_hash, secret_enc)| IngressTarget {
        kind,
        token_hash,
        secret_enc,
    }))
}

#[derive(Clone, Copy)]
enum Hook {
    Github,
    Generic,
}

async fn handle(
    st: Arc<HooksState>,
    peer: SocketAddr,
    id: String,
    req: Request,
    hook: Hook,
) -> Response {
    let (parts, body) = req.into_parts();
    let bytes = match to_bytes(body, BODY_LIMIT).await {
        Ok(b) => b,
        Err(_) => {
            return json_err(
                StatusCode::PAYLOAD_TOO_LARGE,
                "fst_err_ctp_body_too_large",
                "Request body is too large",
            );
        }
    };
    let to_ts = |parts, bytes| {
        crate::proxy::forward(
            State(st.up.clone()),
            ConnectInfo(peer),
            Request::from_parts(parts, Body::from(bytes)),
        )
    };
    if non_json_content(&parts.headers) {
        return to_ts(parts, bytes).await;
    }
    if !crate::lists::is_zod_uuid(&id) {
        return hook_not_found();
    }
    let target = match load(&st.read, &id).await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    let Some(target) = target else {
        return hook_not_found();
    };
    match hook {
        Hook::Github => {
            if target.kind.as_deref() != Some("github") {
                return hook_not_found();
            }
            let sig = header_str(&parts.headers, "x-hub-signature-256");
            if !github_ok(
                st.secret_box.as_ref(),
                target.secret_enc.as_deref(),
                &bytes,
                sig,
            ) {
                return json_err(
                    StatusCode::UNAUTHORIZED,
                    "bad_signature",
                    "signature does not match",
                );
            }
            if header_str(&parts.headers, "x-github-event") == Some("ping") {
                return (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
                    r#"{"status":"pong"}"#,
                )
                    .into_response();
            }
            if !matches!(parse(&bytes), Some(Value::Object(_) | Value::Array(_))) {
                return json_err(StatusCode::BAD_REQUEST, "bad_json", "body is not JSON");
            }
        }
        Hook::Generic => {
            let auth = header_str(&parts.headers, "authorization");
            if !verify_bearer(target.token_hash.as_deref(), auth) {
                return json_err(StatusCode::UNAUTHORIZED, "bad_key", "key does not match");
            }
            if parse(&bytes).is_none() {
                return json_err(StatusCode::BAD_REQUEST, "bad_json", "body is not JSON");
            }
        }
    }
    // 필터·회차는 아직 TS(모듈 머리말).
    to_ts(parts, bytes).await
}

pub async fn github(
    State(st): State<Arc<HooksState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    handle(st, peer, id, req, Hook::Github).await
}

pub async fn generic(
    State(st): State<Arc<HooksState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    handle(st, peer, id, req, Hook::Generic).await
}

/// 로그인 없는 표면 — auth 층을 걸지 않는다(TS 도 `requireAccount` 가 없다).
pub fn routes(st: HooksState, cors: Arc<crate::cors::Cors>) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<HooksState>>::new()
        .post("/hooks/github/{id}", github)
        .post("/hooks/generic/{id}", generic)
        .map(|r| {
            r.layer(axum::middleware::from_fn_with_state(
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
    use ring::hmac;

    const KEY: &str = "hkhook_test-key";

    fn sealed() -> (SecretBox, String) {
        let b = SecretBox::new(Some("unit-test-master")).expect("box");
        let enc = b.seal(KEY);
        (b, enc)
    }

    fn sig(body: &[u8]) -> String {
        let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, KEY.as_bytes()), body);
        format!("sha256={}", hex::encode(tag.as_ref()))
    }

    #[test]
    fn good_signature_over_raw_bytes() {
        let (b, enc) = sealed();
        let body = br#"{"a": 1}"#;
        assert!(github_ok(Some(&b), Some(&enc), body, Some(&sig(body))));
    }

    #[test]
    fn bad_signature() {
        let (b, enc) = sealed();
        let body = br#"{"a": 1}"#;
        // 같은 JSON 을 다시 직렬화한 바이트로는 맞지 않는다.
        assert!(!github_ok(
            Some(&b),
            Some(&enc),
            body,
            Some(&sig(br#"{"a":1}"#))
        ));
        assert!(!github_ok(Some(&b), Some(&enc), body, Some("sha256=00")));
        let mut s = sig(body);
        s.replace_range(7..8, if s.as_bytes()[7] == b'a' { "b" } else { "a" });
        assert!(!github_ok(Some(&b), Some(&enc), body, Some(&s)));
        // 다른 키로 봉인한 것 · 접두사 없음
        let other = SecretBox::new(Some("other-master")).expect("box");
        assert!(!github_ok(Some(&other), Some(&enc), body, Some(&sig(body))));
        assert!(!github_ok(
            Some(&b),
            Some(&enc),
            body,
            Some(&sig(body)[7..])
        ));
    }

    #[test]
    fn missing_header_box_or_secret() {
        let (b, enc) = sealed();
        let body = b"{}";
        assert!(!github_ok(Some(&b), Some(&enc), body, None));
        assert!(!github_ok(None, Some(&enc), body, Some(&sig(body))));
        assert!(!github_ok(Some(&b), None, body, Some(&sig(body))));
    }

    #[test]
    fn parse_matches_ts() {
        assert_eq!(parse(b""), Some(serde_json::json!({})));
        assert_eq!(parse(b"null"), Some(Value::Null));
        assert!(parse(b"{nope").is_none());
    }

    #[test]
    fn debug_redacts_secrets() {
        let t = IngressTarget {
            kind: Some("github".into()),
            token_hash: Some("deadbeef".into()),
            secret_enc: Some("v1.secret".into()),
        };
        let s = format!("{t:?}");
        assert!(!s.contains("deadbeef") && !s.contains("v1.secret"), "{s}");
    }

    #[test]
    fn secret_columns_listed() {
        assert!(PRIVILEGES.contains(&("automation.ingress_token_hash", "SELECT")));
        assert!(PRIVILEGES.contains(&("automation.ingress_secret_enc", "SELECT")));
    }
}
