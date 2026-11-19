//! P4 — 에이전트 부를 사람 명단·대리 호출자 명단. TS `routes/accountRoutes.ts` 의
//! `PUT|DELETE /accounts/agents/:id/invokers/:accountId`·`PUT|DELETE /accounts/agents/:id/delegates/:agentId`
//! (→ `services/agents.ts` `setInvoker`·`setDelegate`, `services/invokeGate.ts` `isEligibleDelegate`)를 옮긴다.
//!
//! - 순서는 TS 그대로: 본문 규칙(fastify — 415·깨진 JSON 400) → 인증 401 → `requireOwnerOrAdmin('id')`
//!   ([`check_owner_or_admin`] — 403·404) → 경로 둘 다 uuid 아니면 400 `invalid_request`.
//!   - invokers: 대상 계정 없음 404 `no such account` → 넣기(멱등)·빼기 → 뷰 없음 404 `no such agent` → 감사 → 200 AgentView.
//!   - delegates: (PUT 만) 에이전트 없음 404 → 조건 (a)(b)(c) 어긋남 400 `delegate_not_eligible` → 넣기·빼기 → 뷰 404 → 감사 → 200.
//! - 감사(`agent.invoker.added|removed`·`agent.delegate.added|removed`)는 TS `actorOf(req)` + 요청 ip 그대로다.
//! - 알려진 차이: 경로 zod 실패의 `message` 는 TS 가 zod issue JSON 이다 — 여기서는 `"params: invalid"`.
//! - fail-closed: 쓰기 풀에 [`AGENT_INVOKERS_PRIVILEGES`] 가 다 있을 때만 `main.rs` 가 붙인다 — 아니면 TS 에 남는다.
use super::relay_routes::{Verdict, check_owner_or_admin};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, record_audit};
use axum::extract::{Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀에 있어야 하는 권한. `agent_invoker`·`agent_owner_delegate` 의 INSERT 가 새 운영 GRANT 다(모듈 끝 주석).
pub const AGENT_INVOKERS_PRIVILEGES: &[(&str, &str)] = &[
    ("agent_invoker", "INSERT"),
    ("agent_invoker", "DELETE"),
    ("agent_owner_delegate", "INSERT"),
    ("agent_owner_delegate", "DELETE"),
    // `requireOwnerOrAdmin`·대상 판정·`isEligibleDelegate`·`getAgent` 뷰(`operator_stop::agent_view`).
    ("account", "SELECT"),
    ("agent_config", "SELECT"),
    ("agent_runner_version", "SELECT"),
    ("agent_assignment", "SELECT"),
    ("agent_invoker", "SELECT"),
    ("agent_owner_delegate", "SELECT"),
    ("agent_mcp_server", "SELECT"),
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.actor_handle", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.ip", "INSERT"),
    ("audit_log.detail", "INSERT"),
];

pub struct AgentInvokersState {
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
}

/// 명단 종류 — 표·문장·감사 이름이 갈린다.
#[derive(Clone, Copy, PartialEq, Debug)]
enum List {
    Invoker,
    Delegate,
}

impl List {
    fn sql(self, present: bool) -> &'static str {
        match (self, present) {
            (List::Invoker, true) => {
                "insert into agent_invoker (agent_id, account_id) values ($1::uuid, $2::uuid) on conflict do nothing"
            }
            (List::Invoker, false) => {
                "delete from agent_invoker where agent_id = $1::uuid and account_id = $2::uuid"
            }
            (List::Delegate, true) => {
                "insert into agent_owner_delegate (agent_id, delegate_id) values ($1::uuid, $2::uuid) on conflict do nothing"
            }
            (List::Delegate, false) => {
                "delete from agent_owner_delegate where agent_id = $1::uuid and delegate_id = $2::uuid"
            }
        }
    }
    fn action(self, present: bool) -> &'static str {
        match (self, present) {
            (List::Invoker, true) => "agent.invoker.added",
            (List::Invoker, false) => "agent.invoker.removed",
            (List::Delegate, true) => "agent.delegate.added",
            (List::Delegate, false) => "agent.delegate.removed",
        }
    }
    fn detail_key(self) -> &'static str {
        match self {
            List::Invoker => "accountId",
            List::Delegate => "agentId",
        }
    }
}

const NOT_ELIGIBLE: &str = "대리 호출자는 같은 소유자의 에이전트이고, 그 에이전트도 소유자 전용(invokeScope=owner)이어야 한다";

/// TS 대상 판정(PUT delegates) — 지우지 않은 에이전트와 그 소유자.
const DELEGATE_TARGET_SQL: &str =
    "select c.owner_account_id::text from account a left join agent_config c on c.account_id = a.id
              where a.id = $1::uuid and a.kind = 'agent' and a.deleted_at is null";

macro_rules! db {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return internal(e),
        }
    };
}

async fn handle(
    st: &AgentInvokersState,
    me: &crate::auth::Account,
    id: &str,
    other: &str,
    req: Request,
    list: List,
    present: bool,
) -> Response {
    let (parts, body) = req.into_parts();
    // 본문은 쓰지 않지만 fastify 본문 규칙(415·깨진 JSON 400)은 preHandler 보다 먼저 지난다.
    if let Err(r) = super::ask::read_bytes(&parts.headers, body).await {
        return r;
    }
    match db!(check_owner_or_admin(&st.write, me, id).await) {
        Verdict::Owner | Verdict::Admin => {}
        Verdict::Refused(s, c, m) => return json_err(s, c, m),
    }
    if !crate::lists::is_zod_uuid(id) || !crate::lists::is_zod_uuid(other) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    match list {
        List::Invoker => {
            let found: Option<i32> = db!(sqlx::query_scalar(
                "select 1 from account where id = $1::uuid"
            )
            .bind(other)
            .fetch_optional(&st.write)
            .await);
            if found.is_none() {
                return json_err(StatusCode::NOT_FOUND, "not_found", "no such account");
            }
        }
        List::Delegate if present => {
            let owner: Option<Option<String>> = db!(sqlx::query_scalar(DELEGATE_TARGET_SQL)
                .bind(id)
                .fetch_optional(&st.write)
                .await);
            let Some(owner) = owner else {
                return json_err(StatusCode::NOT_FOUND, "not_found", "no such agent");
            };
            let mut conn = db!(st.write.acquire().await);
            let ok = db!(super::invoke_gate::is_eligible_delegate(
                &mut conn,
                id,
                owner.as_deref(),
                other,
                false
            )
            .await);
            if !ok {
                return json_err(
                    StatusCode::BAD_REQUEST,
                    "delegate_not_eligible",
                    NOT_ELIGIBLE,
                );
            }
        }
        List::Delegate => {}
    }
    db!(sqlx::query(list.sql(present))
        .bind(id)
        .bind(other)
        .execute(&st.write)
        .await);
    let Some((view, _)) = db!(super::operator_stop::agent_view(&st.write, id).await) else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such agent");
    };
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: list.action(present),
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(id),
            ip: ip.as_deref(),
            detail: json!({ list.detail_key(): other }),
        },
    )
    .await;
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        view,
    )
        .into_response()
}

type St = State<Arc<AgentInvokersState>>;

pub async fn put_invoker(
    State(st): St,
    RequireAccount(me, _): RequireAccount,
    Path((id, other)): Path<(String, String)>,
    req: Request,
) -> Response {
    handle(&st, &me, &id, &other, req, List::Invoker, true).await
}

pub async fn delete_invoker(
    State(st): St,
    RequireAccount(me, _): RequireAccount,
    Path((id, other)): Path<(String, String)>,
    req: Request,
) -> Response {
    handle(&st, &me, &id, &other, req, List::Invoker, false).await
}

pub async fn put_delegate(
    State(st): St,
    RequireAccount(me, _): RequireAccount,
    Path((id, other)): Path<(String, String)>,
    req: Request,
) -> Response {
    handle(&st, &me, &id, &other, req, List::Delegate, true).await
}

pub async fn delete_delegate(
    State(st): St,
    RequireAccount(me, _): RequireAccount,
    Path((id, other)): Path<(String, String)>,
    req: Request,
) -> Response {
    handle(&st, &me, &id, &other, req, List::Delegate, false).await
}

/// 코어 라우터에 합칠 줄(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    st: AgentInvokersState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AgentInvokersState>>::new()
        .put("/accounts/agents/{id}/invokers/{accountId}", put_invoker)
        .delete("/accounts/agents/{id}/invokers/{accountId}", delete_invoker)
        .put("/accounts/agents/{id}/delegates/{agentId}", put_delegate)
        .delete("/accounts/agents/{id}/delegates/{agentId}", delete_delegate)
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
    fn sql_and_audit_follow_ts() {
        assert!(
            List::Invoker
                .sql(true)
                .starts_with("insert into agent_invoker")
        );
        assert!(List::Invoker.sql(true).ends_with("on conflict do nothing"));
        assert!(
            List::Invoker
                .sql(false)
                .starts_with("delete from agent_invoker")
        );
        assert!(
            List::Delegate
                .sql(true)
                .starts_with("insert into agent_owner_delegate")
        );
        assert!(List::Delegate.sql(false).contains("delegate_id = $2::uuid"));
        assert_eq!(List::Invoker.action(true), "agent.invoker.added");
        assert_eq!(List::Delegate.action(false), "agent.delegate.removed");
        assert_eq!(List::Invoker.detail_key(), "accountId");
        assert_eq!(List::Delegate.detail_key(), "agentId");
    }

    #[test]
    fn four_lines() {
        let mut got = routes_table_http();
        got.sort();
        assert_eq!(
            got,
            vec![
                "DELETE /accounts/agents/{id}/delegates/{agentId}",
                "DELETE /accounts/agents/{id}/invokers/{accountId}",
                "PUT /accounts/agents/{id}/delegates/{agentId}",
                "PUT /accounts/agents/{id}/invokers/{accountId}",
            ]
        );
    }

    fn routes_table_http() -> Vec<String> {
        crate::route_table::Table::<Arc<AgentInvokersState>>::new()
            .put("/accounts/agents/{id}/invokers/{accountId}", put_invoker)
            .delete("/accounts/agents/{id}/invokers/{accountId}", delete_invoker)
            .put("/accounts/agents/{id}/delegates/{agentId}", put_delegate)
            .delete("/accounts/agents/{id}/delegates/{agentId}", delete_delegate)
            .finish()
            .http
    }
}

// 새 운영 GRANT(쓰기 역할): `grant insert, delete on agent_invoker, agent_owner_delegate` — 이미 있으면 그대로다.
