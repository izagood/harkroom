//! S5.4 — 보관소 잠그기 한 줄. TS `routes/authRoutes.ts` 의 `DELETE /auth/step-up` 과 `services/stepUp.ts` 의 `endStepUp` 을 옮긴다.
//!
//! - 순서는 TS 와 같다: `requireAccount`(401) → 사람·세션이 아니면 403 `session_required` → 창 기록이 남아 있던 세션만
//!   비우고 그때만 감사 `step_up.ended` → 204. **멱등**이다(이미 잠겼어도 204).
//! - 비밀번호가 필요 없는 줄이라 argon2·시도 상한(메모리 리미터)과 엮이지 않는다. 열기(`POST /auth/step-up`)는 TS 에 남긴다.
//! - 쓰기 권한은 [`STEP_UP_END_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use crate::auth::{RequireAccount, Via};
use crate::directory::{internal, json_err};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, record_audit};
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀에 있어야 하는 칸 권한 — homelab GRANT 와 같아야 한다. 감사 줄(`audit_log` INSERT)은 이미 있는 쓰기 코어 권한이다.
pub const STEP_UP_END_PRIVILEGES: &[(&str, &str)] = &[
    ("session.stepped_up_at", "UPDATE"),
    ("session.stepped_up_until", "UPDATE"),
];

#[derive(Clone)]
pub struct StepUpEndState {
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
}

/// `DELETE /auth/step-up`.
pub async fn end_step_up(State(st): State<Arc<StepUpEndState>>, req: Request) -> Response {
    let (_, RequireAccount(me, auth), parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let hash = match (me.kind.as_str(), auth.via, auth.credential_hash.as_deref()) {
        ("human", Some(Via::Session), Some(h)) => h.to_owned(),
        _ => {
            return json_err(
                StatusCode::FORBIDDEN,
                "session_required",
                "step-up is only for a signed-in person",
            );
        }
    };
    let ended = match sqlx::query(
        "update session set stepped_up_at = null, stepped_up_until = null \
          where token_hash = $1 and stepped_up_until is not null",
    )
    .bind(&hash)
    .execute(&st.write)
    .await
    {
        Ok(r) => r.rows_affected() > 0,
        Err(e) => return internal(e),
    };
    if ended {
        let ip = crate::writes_settings::ip_of(&parts, &st.trust);
        record_audit(
            &st.write,
            AuditEntry {
                action: "step_up.ended",
                actor_id: Some(&me.id),
                actor_handle: Some(&me.handle),
                target: None,
                ip: ip.as_deref(),
                detail: json!({}),
            },
        )
        .await;
    }
    StatusCode::NO_CONTENT.into_response()
}

pub fn routes(
    st: StepUpEndState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<StepUpEndState>>::new()
        .delete("/auth/step-up", end_step_up)
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
