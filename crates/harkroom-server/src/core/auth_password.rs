//! S5.4 — 자기 비밀번호 바꾸기. TS `routes/authRoutes.ts` 의 `POST /auth/password` 를 옮긴다.
//!
//! - 순서는 TS 와 같다: `requireAccount`(401) → 본문 `{currentPassword: string, newPassword: 8..=128}` 아니면 400
//!   `invalid_request` → 사람 계정 아니면 400 `invalid_account` → 현재 해시 검증 실패면 감사 `password.changed
//!   {success:false, reason:current_password_mismatch}` + 401 `invalid_credentials` → 새 해시로 바꾸기 → 지금 세션
//!   빼고 세션 삭제 → 감사 `password.changed {otherSessionsInvalidated:true}` → 204.
//! - 알려진 차이: zod 실패의 `message` 는 TS 가 zod issue JSON 이다 — 여기서는 `"body"`(다른 포트와 같은 관례).
//! - 쓰기 권한은 [`AUTH_PASSWORD_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use crate::auth::Auth;
use crate::directory::{internal, json_err};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, read_body, record_audit};
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;

/// shared `PASSWORD_MIN_LENGTH`·`PASSWORD_MAX_LENGTH`.
const PASSWORD_MIN: usize = 8;
const PASSWORD_MAX: usize = 128;

/// `grant select (id, password_hash), update (password_hash) on account`,
/// `grant select (account_id, token_hash), delete on session`,
/// `grant insert (action, actor_id, actor_handle, target, ip, detail) on audit_log`.
pub const AUTH_PASSWORD_PRIVILEGES: &[(&str, &str)] = &[
    ("account.id", "SELECT"),
    ("account.password_hash", "SELECT"),
    ("account.password_hash", "UPDATE"),
    ("session.account_id", "SELECT"),
    ("session.token_hash", "SELECT"),
    ("session", "DELETE"),
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.actor_handle", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.ip", "INSERT"),
    ("audit_log.detail", "INSERT"),
];

pub struct AuthPasswordState {
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
}

/// zod `{currentPassword: z.string(), newPassword: min(8).max(128)}.parse(req.body)`.
fn parse_body(body: Body) -> Option<(String, String)> {
    let Body::Json(Value::Object(mut m)) = body else {
        return None;
    };
    let current = match m.remove("currentPassword") {
        Some(Value::String(s)) => s,
        _ => return None,
    };
    let new = match m.remove("newPassword") {
        Some(Value::String(s))
            if (PASSWORD_MIN..=PASSWORD_MAX).contains(&crate::writes_settings::js_len(&s)) =>
        {
            s
        }
        _ => return None,
    };
    Some((current, new))
}

/// `POST /auth/password`.
pub async fn change(State(st): State<Arc<AuthPasswordState>>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let auth = parts.extensions.get::<Auth>().cloned().unwrap_or_default();
    let Some(account) = auth.account.clone() else {
        return json_err(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "authentication required",
        );
    };
    let body = match read_body(&parts.headers, body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let Some((current, new_password)) = parse_body(body) else {
        return json_err(StatusCode::BAD_REQUEST, "invalid_request", "body");
    };
    if account.kind != "human" {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_account",
            "password change is only for human accounts",
        );
    }
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    let hash: Option<Option<String>> =
        match sqlx::query_scalar("select password_hash from account where id = $1::uuid")
            .bind(&account.id)
            .fetch_optional(&st.write)
            .await
        {
            Ok(v) => v,
            Err(e) => return internal(e),
        };
    let ok = match hash.flatten() {
        Some(h) => crate::password::verify_async(h, current).await,
        None => false,
    };
    if !ok {
        record_audit(
            &st.write,
            AuditEntry {
                action: "password.changed",
                actor_id: Some(&account.id),
                actor_handle: Some(&account.handle),
                target: None,
                ip: ip.as_deref(),
                detail: json!({ "success": false, "reason": "current_password_mismatch" }),
            },
        )
        .await;
        return json_err(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "wrong current password",
        );
    }
    let new_hash = crate::password::hash_async(new_password).await;
    if let Err(e) = sqlx::query("update account set password_hash = $1 where id = $2::uuid")
        .bind(&new_hash)
        .bind(&account.id)
        .execute(&st.write)
        .await
    {
        return internal(e);
    }
    // TS: `token_hash != $2` — 자격이 없으면(null) SQL 비교가 null 이라 아무 줄도 지우지 않는다. 같은 결과를 낸다.
    if let Err(e) =
        sqlx::query("delete from session where account_id = $1::uuid and token_hash != $2")
            .bind(&account.id)
            .bind(auth.credential_hash.as_deref())
            .execute(&st.write)
            .await
    {
        return internal(e);
    }
    record_audit(
        &st.write,
        AuditEntry {
            action: "password.changed",
            actor_id: Some(&account.id),
            actor_handle: Some(&account.handle),
            target: None,
            ip: ip.as_deref(),
            detail: json!({ "otherSessionsInvalidated": true }),
        },
    )
    .await;
    StatusCode::NO_CONTENT.into_response()
}

pub fn routes(
    st: AuthPasswordState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AuthPasswordState>>::new()
        .post("/auth/password", change)
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
    use super::parse_body;
    use crate::write::Body;
    use serde_json::json;

    #[test]
    fn body_follows_zod_rules() {
        let p = |v| parse_body(Body::Json(v));
        assert!(p(json!({"currentPassword": "", "newPassword": "12345678"})).is_some());
        assert!(p(json!({"currentPassword": "x", "newPassword": "1234567"})).is_none());
        assert!(p(json!({"currentPassword": "x", "newPassword": "a".repeat(129)})).is_none());
        assert!(p(json!({"newPassword": "12345678"})).is_none());
        assert!(p(json!({"currentPassword": 1, "newPassword": "12345678"})).is_none());
    }
}
