//! S5.4 — `GET /agent/config`(TS `accountRoutes.ts`). 러너가 자기 정의(AgentView)를 읽는 자리.
//!
//! 순서(TS 와 같다): `requireAccount`(401) → 에이전트가 아니면 403 `agent_only` → `getAgent`(없거나 지웠으면 404
//! `not_found`) → 종료 요청이 있고 아직 수령 전이면 `ackAgentStop`(수령 시각을 찍고 응답의 `stopAckedAt` 에 싣는다) → AgentView.
//! 뷰는 `operator_stop.rs` 의 같은 SQL 을 쓴다(운영자 목록과 러너가 **같은 뷰**를 본다 — TS 주석).
//! 권한은 [`AGENT_CONFIG_PRIVILEGES`](쓰기 풀) — 없으면 `main.rs` 가 붙이지 않아 TS 에 남는다.
//! 새 운영 GRANT: `grant update (stop_acked_at) on agent_config`. TS 의 수령 로그(`runner picked up stop request`)는 stderr 로 남긴다.
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀에 있어야 하는 권한(뷰를 읽는 표 + 수령 칸).
pub const AGENT_CONFIG_PRIVILEGES: &[(&str, &str)] = &[
    ("account", "SELECT"),
    ("agent_config", "SELECT"),
    ("agent_config.stop_acked_at", "UPDATE"),
    ("agent_runner_version", "SELECT"),
    ("agent_assignment", "SELECT"),
    ("agent_invoker", "SELECT"),
    ("agent_owner_delegate", "SELECT"),
    ("agent_mcp_server", "SELECT"),
];

#[derive(Clone)]
pub struct AgentConfigState {
    pub read: PgPool,
    pub write: PgPool,
}

/// TS `ackAgentStop`.
const ACK_SQL: &str = concat!(
    "update agent_config set stop_acked_at = now() \
      where account_id = $1::uuid and stop_requested_at is not null and stop_acked_at is null \
      returning ",
    crate::iso!("stop_acked_at")
);

/// pg `json_build_object(...)::text` 의 `"stopAckedAt" : null` 을 수령 시각으로 바꾼다(TS 가 `self.stopAckedAt` 을
/// 덮어쓰는 것과 같다 — 키 자리는 그대로).
fn with_acked(view: &str, at: &str) -> String {
    view.replacen(
        "\"stopAckedAt\" : null",
        &format!("\"stopAckedAt\" : {}", serde_json::Value::from(at)),
        1,
    )
}

fn acked_is_null(view: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(view)
        .ok()
        .is_some_and(|v| v.get("stopAckedAt").is_some_and(|a| a.is_null()))
}

pub async fn config(
    State(st): State<Arc<AgentConfigState>>,
    RequireAccount(me, _auth): RequireAccount,
) -> Response {
    if me.kind != "agent" {
        return json_err(StatusCode::FORBIDDEN, "agent_only", "agents only");
    }
    let (mut view, stop_requested) = match super::operator_stop::agent_view(&st.read, &me.id).await
    {
        Ok(Some(v)) => v,
        Ok(None) => return json_err(StatusCode::NOT_FOUND, "not_found", "no such agent"),
        Err(e) => return internal(e),
    };
    if stop_requested.is_some() && acked_is_null(&view) {
        match sqlx::query_scalar::<_, String>(ACK_SQL)
            .bind(&me.id)
            .fetch_optional(&st.write)
            .await
        {
            Ok(Some(at)) => {
                view = with_acked(&view, &at);
                eprintln!(
                    "runner picked up stop request agentId={} handle={}",
                    me.id, me.handle
                );
            }
            Ok(None) => {}
            Err(e) => return internal(e),
        }
    }
    (
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        view,
    )
        .into_response()
}

pub fn routes(
    st: AgentConfigState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AgentConfigState>>::new()
        .get("/agent/config", config)
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
    fn ack_replaces_only_stop_acked() {
        let v = r#"{"id" : "a", "stopRequestedAt" : "2026-01-01T00:00:00.000Z", "stopAckedAt" : null, "lastTurnAt" : null}"#;
        assert!(acked_is_null(v));
        let out = with_acked(v, "2026-01-02T00:00:00.000Z");
        assert_eq!(
            out,
            r#"{"id" : "a", "stopRequestedAt" : "2026-01-01T00:00:00.000Z", "stopAckedAt" : "2026-01-02T00:00:00.000Z", "lastTurnAt" : null}"#
        );
        assert!(!acked_is_null(&out));
    }
}
