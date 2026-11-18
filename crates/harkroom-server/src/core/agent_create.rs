//! S5.4 — 에이전트 만들기 앞단. TS `routes/accountRoutes.ts` 의 `POST /accounts/agents` 를 옮기는 첫 조각.
//!
//! - 지금 Rust 가 하는 것: `requireCap('agent.create')` — 계정 없음 401 `unauthorized`, 능력 없음 403
//!   `forbidden` `agent.create 권한이 필요하다`. TS 도 preHandler 에서 같은 판정을 먼저 한다.
//! - 통과하면 요청을 그대로 TS 로 넘긴다(본문 zod·`validateScopeChange`·`createAgentAccount`·감사 `agent.created`·201).
//!   여기까지는 부작용이 없어 TS 가 다시 판정해도 결과가 같다.
//! - 남은 일: 본문 검사·이름 겹침 409·생성 트랜잭션(`withDefaults`·`upsertConfig`)·`getAgent` 응답 모양을 옮긴다.
use crate::auth::Auth;
use crate::proxy::Upstream;
use axum::extract::{ConnectInfo, Request, State};
use axum::response::Response;
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::Arc;

/// 능력 판정(`can`)이 읽는 것 — 읽기 풀이면 된다. 쓰기는 아직 TS 가 한다.
pub const AGENT_CREATE_PRIVILEGES: &[(&str, &str)] = &[];

pub struct AgentCreateState {
    pub pool: PgPool,
    pub up: Upstream,
}

/// `POST /accounts/agents`.
pub async fn post(
    State(st): State<Arc<AgentCreateState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let auth = req.extensions().get::<Auth>().cloned().unwrap_or_default();
    if let Err(r) = crate::perm::require_cap(&st.pool, &auth, "agent.create", None).await {
        return r;
    }
    crate::proxy::forward(State(st.up.clone()), ConnectInfo(peer), req).await
}

pub fn routes(
    st: AgentCreateState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AgentCreateState>>::new()
        .post("/accounts/agents", post)
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
