//! S5.4 — 역할 바꾸기. TS `routes/grantRoutes.ts` 의 `PUT /accounts/:id/role` 을 옮긴다.
//!
//! - 순서는 TS 와 같다: `requireAdmin`(계정이 없어도 403 `forbidden` `admin required` — 401 이 아니다) → 경로 zod(400)
//!   → 본문 `{role: owner|admin|member|guest}` 아니면 400 `bad_request` → `owner` 로는 400 → 대상 없음 404 → 대상이 owner 면 400
//!   → admin 임명·해제는 owner 만(403) → `role`·`is_admin` 갱신 → 감사 `role.changed {role, previous}` → `grant.changed` → 200 `{role}`.
//! - 알려진 차이: zod 실패의 `message` 는 TS 가 zod issue JSON 이다 — 여기서는 `"body"`.
//! - 쓰기 권한은 [`ACCOUNT_ROLE_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use crate::auth::Auth;
use crate::directory::{internal, json_err, json_ok};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, emit_event, read_body, record_audit};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;

/// shared `ROLES`.
const ROLES: &[&str] = &["owner", "admin", "member", "guest"];

/// `grant select (id, role), update (role, is_admin) on account`,
/// `grant insert (action, actor_id, actor_handle, target, ip, detail) on audit_log` (+ 이벤트 outbox).
pub const ACCOUNT_ROLE_PRIVILEGES: &[(&str, &str)] = &[
    ("account.id", "SELECT"),
    ("account.role", "SELECT"),
    ("account.role", "UPDATE"),
    ("account.is_admin", "UPDATE"),
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.actor_handle", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.ip", "INSERT"),
    ("audit_log.detail", "INSERT"),
];

pub struct AccountRoleState {
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
}

/// zod `{role: z.enum(ROLES)}.safeParse(req.body ?? {})`.
fn parse_role(body: Body) -> Option<String> {
    let m = match body {
        Body::Json(Value::Object(m)) => m,
        _ => return None,
    };
    match m.get("role") {
        Some(Value::String(r)) if ROLES.contains(&r.as_str()) => Some(r.clone()),
        _ => None,
    }
}

/// 역할 판정 — None 이면 지나간다.
fn refusal(
    actor_role: &str,
    role: &str,
    current: &str,
) -> Option<(StatusCode, &'static str, &'static str)> {
    if current == "owner" {
        return Some((
            StatusCode::BAD_REQUEST,
            "bad_request",
            "owner 의 역할은 바꿀 수 없다",
        ));
    }
    if (role == "admin" || current == "admin") && actor_role != "owner" {
        return Some((
            StatusCode::FORBIDDEN,
            "forbidden",
            "admin 임명·해제는 owner 만 한다",
        ));
    }
    None
}

/// `PUT /accounts/{id}/role`.
pub async fn put_role(
    State(st): State<Arc<AccountRoleState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let auth = parts.extensions.get::<Auth>().cloned().unwrap_or_default();
    let Some(actor) = auth.account.filter(|a| a.is_admin) else {
        return json_err(StatusCode::FORBIDDEN, "forbidden", "admin required");
    };
    if !crate::lists::is_zod_uuid(&id) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    let body = match read_body(&parts.headers, body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let Some(role) = parse_role(body) else {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", "body");
    };
    if role == "owner" {
        return json_err(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "owner 는 이 라우트로 정하지 않는다",
        );
    }
    let current: Option<String> =
        match sqlx::query_scalar("select role from account where id = $1::uuid")
            .bind(&id)
            .fetch_optional(&st.write)
            .await
        {
            Ok(v) => v,
            Err(e) => return internal(e),
        };
    let Some(current) = current else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "그런 계정이 없다");
    };
    if let Some((s, c, m)) = refusal(&actor.role, &role, &current) {
        return json_err(s, c, m);
    }
    if let Err(e) = sqlx::query(
        "update account set role = $2, is_admin = ($2 in ('owner','admin')) where id = $1::uuid",
    )
    .bind(&id)
    .bind(&role)
    .execute(&st.write)
    .await
    {
        return internal(e);
    }
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "role.changed",
            actor_id: Some(&actor.id),
            actor_handle: Some(&actor.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: json!({ "role": role, "previous": current }),
        },
    )
    .await;
    let ev = json!({ "type": "grant.changed", "accountId": id, "audience": "all" });
    match st.write.acquire().await {
        Ok(mut conn) => {
            if let Err(e) = emit_event(&mut conn, &ev).await {
                eprintln!(
                    "front: role.changed event failed: {}",
                    e.as_database_error().map_or("io", |_| "db")
                );
            }
        }
        Err(e) => eprintln!(
            "front: role.changed event failed: {}",
            e.as_database_error().map_or("io", |_| "db")
        ),
    }
    json_ok(json!({ "role": role }).to_string())
}

pub fn routes(
    st: AccountRoleState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AccountRoleState>>::new()
        .put("/accounts/{id}/role", put_role)
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
    fn role_body_is_enum() {
        assert_eq!(
            parse_role(Body::Json(json!({"role": "member"}))).as_deref(),
            Some("member")
        );
        assert!(parse_role(Body::Json(json!({"role": "root"}))).is_none());
        assert!(parse_role(Body::Json(json!({}))).is_none());
    }

    #[test]
    fn refusals_follow_ts_order() {
        assert_eq!(
            refusal("owner", "member", "owner").map(|x| x.0),
            Some(StatusCode::BAD_REQUEST)
        );
        assert_eq!(
            refusal("admin", "admin", "member").map(|x| x.0),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            refusal("admin", "member", "admin").map(|x| x.0),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(refusal("owner", "admin", "member"), None);
        assert_eq!(refusal("admin", "guest", "member"), None);
    }
}
