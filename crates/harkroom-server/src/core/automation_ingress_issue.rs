//! S5.4 AT8 — 수신 켜기 / 키 다시 받기(`POST /automations/:id/ingress`). TS `routes/automationRoutes.ts` 의 같은 줄과
//! `services/automationIngress.ts::issueIngress` 를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireAccount`(401) → 본문 해석(fastify 400·415) → 에이전트 403 `agents_cannot_automate` →
//!   경로 id(400 `invalid_request`) → 내 것이 아니거나 지운 것은 404 → 승인 전 409 `not_approved` →
//!   일정 트리거 400 `schedule_has_no_ingress` → github 인데 `HARKROOM_SECRET_KEY` 없음 409 `needs_secret_key` →
//!   UPDATE(행이 없으면 404) → 201 `{ingress:{key, githubPath, genericPath}}`.
//! - **키 원문은 이 응답에만 있다.** 저장은 sha256 해시와(상자가 있으면) 봉인문. 기록하지 않는다.
//! - 권한: 읽기 풀은 소유 확인 칸만, 쓰기 풀은 [`super::automations_write::AUTOMATIONS_WRITE_PRIVILEGES`]
//!   (수신 칸 UPDATE 만 — 비밀 칸 SELECT 없음, 새 GRANT 없음). [`PRIVILEGES`] 가 이 줄의 전체 목록이다.
use crate::auth::RequireAccount;
use crate::core::automation_ingress_verify::hash_ingress_key;
use crate::directory::{internal, json_err};
use crate::secrets::secret_box::SecretBox;
use axum::body::to_bytes;
use axum::extract::{Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sqlx::PgPool;
use std::fmt;
use std::sync::Arc;
use zeroize::Zeroizing;

/// 쓰기 풀 권한(소유 확인 SELECT 는 읽기 풀이 하지만 같은 칸이라 함께 적는다).
pub const PRIVILEGES: &[(&str, &str)] = &[
    ("automation.id", "SELECT"),
    ("automation.owner_id", "SELECT"),
    ("automation.deleted_at", "SELECT"),
    ("automation.ingress_enabled_at", "UPDATE"),
    ("automation.ingress_token_hash", "UPDATE"),
    ("automation.ingress_secret_enc", "UPDATE"),
    ("automation.updated_at", "UPDATE"),
];

pub const INGRESS_KEY_PREFIX: &str = "hkhook_";

const OWNED_SQL: &str = "select a.trigger->>'kind', a.approved_at is not null from automation a \
     where a.id = $1::uuid and a.owner_id = $2::uuid and a.deleted_at is null";

/// TS `issueIngress` 의 UPDATE 그대로.
const ISSUE_SQL: &str = "update automation set ingress_enabled_at = now(), ingress_token_hash = $3, ingress_secret_enc = $4, updated_at = now() \
     where id = $1::uuid and owner_id = $2::uuid and deleted_at is null returning id::text";

const BODY_LIMIT: usize = 1024 * 1024;

pub struct IssueState {
    read: PgPool,
    write: PgPool,
    secret_box: Option<SecretBox>,
}

impl fmt::Debug for IssueState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("IssueState(<redacted>)")
    }
}

impl IssueState {
    pub fn new(read: PgPool, write: PgPool) -> Self {
        Self {
            read,
            write,
            secret_box: SecretBox::from_env(),
        }
    }
}

/// TS `INGRESS_KEY_PREFIX + randomBytes(24).toString('base64url')`.
fn new_key() -> Zeroizing<String> {
    let mut raw = Zeroizing::new([0u8; 24]);
    getrandom::fill(&mut raw[..]).expect("os random");
    Zeroizing::new(format!(
        "{INGRESS_KEY_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(&raw[..])
    ))
}

/// 일정 → 400, github 에 상자 없음 → 409. TS 순서 그대로.
fn precheck(kind: Option<&str>, has_box: bool) -> Option<Response> {
    if kind == Some("schedule") {
        return Some(json_err(
            StatusCode::BAD_REQUEST,
            "schedule_has_no_ingress",
            "schedule automations do not receive events",
        ));
    }
    if kind == Some("github") && !has_box {
        return Some(json_err(
            StatusCode::CONFLICT,
            "needs_secret_key",
            "HARKROOM_SECRET_KEY is not set on the server; GitHub signatures cannot be verified",
        ));
    }
    None
}

/// 응답 본문 — 키 순서는 TS 객체(`key`, `githubPath`, `genericPath`)와 같다.
fn issued_body(key: &str, id: &str, github: bool) -> String {
    let gh = if github {
        serde_json::to_string(&format!("/hooks/github/{id}")).expect("string")
    } else {
        "null".to_owned()
    };
    format!(
        "{{\"ingress\":{{\"key\":{},\"githubPath\":{gh},\"genericPath\":{}}}}}",
        serde_json::to_string(key).expect("string"),
        serde_json::to_string(&format!("/hooks/generic/{id}")).expect("string"),
    )
}

pub async fn issue_ingress(
    State(st): State<Arc<IssueState>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (parts, raw) = req.into_parts();
    let bytes = match to_bytes(raw, BODY_LIMIT).await {
        Ok(b) => b,
        Err(_) => {
            return json_err(
                StatusCode::PAYLOAD_TOO_LARGE,
                "fst_err_ctp_body_too_large",
                "Request body is too large",
            );
        }
    };
    if let Err(r) = crate::write::fastify_body(&parts.headers, &bytes) {
        return r;
    }
    if me.kind == "agent" {
        return json_err(
            StatusCode::FORBIDDEN,
            "agents_cannot_automate",
            "agents cannot create or change automations",
        );
    }
    if !crate::lists::is_zod_uuid(&id) {
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    let owned: Option<(Option<String>, bool)> = match sqlx::query_as(OWNED_SQL)
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some((kind, approved)) = owned else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "automation not found");
    };
    if !approved {
        return json_err(
            StatusCode::CONFLICT,
            "not_approved",
            "approve the proposal first",
        );
    }
    if let Some(r) = precheck(kind.as_deref(), st.secret_box.is_some()) {
        return r;
    }
    let key = new_key();
    let sealed = st.secret_box.as_ref().map(|b| b.seal(key.as_str()));
    match sqlx::query_scalar::<_, String>(ISSUE_SQL)
        .bind(&id)
        .bind(&me.id)
        .bind(hash_ingress_key(key.as_str()))
        .bind(sealed)
        .fetch_optional(&st.write)
        .await
    {
        Ok(Some(_)) => (
            StatusCode::CREATED,
            [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
            issued_body(key.as_str(), &id, kind.as_deref() == Some("github")),
        )
            .into_response(),
        Ok(None) => json_err(StatusCode::NOT_FOUND, "not_found", "automation not found"),
        Err(e) => internal(e),
    }
}

pub fn routes(
    st: IssueState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<IssueState>>::new()
        .post("/automations/{id}/ingress", issue_ingress)
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
    fn key_shape_matches_ts() {
        let a = new_key();
        let b = new_key();
        assert!(a.starts_with(INGRESS_KEY_PREFIX));
        // 24 바이트 base64url(패딩 없음) = 32 글자.
        assert_eq!(a.len(), INGRESS_KEY_PREFIX.len() + 32);
        assert!(
            a[7..]
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        );
        assert_ne!(a.as_str(), b.as_str());
    }

    #[test]
    fn precheck_order() {
        assert_eq!(
            precheck(Some("schedule"), false).unwrap().status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            precheck(Some("schedule"), true).unwrap().status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            precheck(Some("github"), false).unwrap().status(),
            StatusCode::CONFLICT
        );
        assert!(precheck(Some("github"), true).is_none());
        assert!(precheck(Some("webhook"), false).is_none());
    }

    #[test]
    fn body_shape() {
        let id = "00000000-0000-4000-8000-000000000000";
        assert_eq!(
            issued_body("hkhook_x", id, true),
            format!(
                r#"{{"ingress":{{"key":"hkhook_x","githubPath":"/hooks/github/{id}","genericPath":"/hooks/generic/{id}"}}}}"#
            )
        );
        assert!(issued_body("hkhook_x", id, false).contains(r#""githubPath":null"#));
    }

    #[test]
    fn sealed_key_opens_and_hash_matches() {
        let b = SecretBox::new(Some("unit-test-master")).expect("box");
        let key = new_key();
        let enc = b.seal(key.as_str());
        assert_eq!(b.open(&enc).expect("open").as_str(), key.as_str());
        assert!(crate::core::automation_ingress_verify::verify_bearer(
            Some(&hash_ingress_key(key.as_str())),
            Some(&format!("Bearer {}", key.as_str())),
        ));
    }

    #[test]
    fn sql_never_selects_secrets() {
        assert!(!OWNED_SQL.contains("ingress_"));
        assert!(!ISSUE_SQL.contains("returning ingress") && !ISSUE_SQL.contains("returning *"));
    }
}
