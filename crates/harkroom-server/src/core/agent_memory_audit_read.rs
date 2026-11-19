//! S5.4 — 사람 화면의 기억 정리 후보 한 줄. TS `routes/accountRoutes.ts` 의 `GET /accounts/agents/:id/memory/audit` 를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireOwnerOrAdmin('id')`(401·403·404) → 경로 zod(400) → 에이전트인가(404, 지운 에이전트도 대상).
//!   문지기는 [`super::agent_memory_read`] 와 같은 것이다.
//! - 판정은 MCP `memory.audit` 와 **같은 함수**([`super::mcp::mem_audit::audit_for`])다. 목록 상한만 TS `AUDIT_HUMAN_LIST_CAP`
//!   (= `MAX_MEMORY_ITEMS_PER_ACCOUNT`)로 다르다. 판정은 늘 Rust 하나다(TS 로 넘기지 않는다).
//! - **읽기만 한다.** 필요한 SELECT 는 [`AGENT_MEMORY_AUDIT_READ_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use super::agent_memory_read::{gate, max_param_length};
use super::mcp::mem_audit::audit_for;
use super::mcp::mem_body::MAX_ITEMS;
use crate::auth::RequireAccount;
use crate::directory::{internal, json_ok};
use crate::proxy::Upstream;
use axum::extract::{Path, State};
use axum::response::Response;
use sqlx::PgPool;
use std::sync::Arc;

/// 읽기 풀에 있어야 하는 권한. `account`·`agent_config` 는 인가와 에이전트 판정이 읽는다.
pub const AGENT_MEMORY_AUDIT_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("account", "SELECT"),
    ("agent_config", "SELECT"),
    ("agent_memory", "SELECT"),
];

/// TS `AUDIT_HUMAN_LIST_CAP = MAX_MEMORY_ITEMS_PER_ACCOUNT`.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
const HUMAN_LIST_CAP: usize = MAX_ITEMS as usize;

pub struct AuditReadState {
    pub read: PgPool,
    pub up: Upstream,
}

pub async fn audit(
    State(st): State<Arc<AuditReadState>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = gate(&st.read, &me, &id, None, false).await {
        return r;
    }
    match audit_for(&st.read, &id, &[], HUMAN_LIST_CAP).await {
        Ok(a) => json_ok(format!("{{\"audit\":{a}}}")),
        Err(e) => internal(e),
    }
}

pub fn routes(
    st: AuditReadState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AuditReadState>>::new()
        .get("/accounts/agents/{id}/memory/audit", audit)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            // 인증보다 먼저(바깥) — fastify 는 414 를 라우트를 찾는 단계에서 낸다.
            .route_layer(axum::middleware::from_fn(max_param_length))
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
