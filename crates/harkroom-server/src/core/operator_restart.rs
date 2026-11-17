//! AC5 A3 — 재시작 줄(`POST /accounts/agents/{id}/restart`)을 Rust 오퍼레이터 코어로 옮긴다.
//! TS `accountRoutes.ts` restart 를 그대로 따른다.
//!
//! 오퍼레이터 코어가 `/operator` 소켓을 가져가면 TS 허브는 비어서, TS 의 재시작은 늘 409 `operator_offline` 이다
//! ([재시작] 버튼이 듣지 않는다). 쓰기는 감사 한 줄뿐이라 새 DB 권한은 없다.
//!
//! 순서(TS 와 같다): 권한(`agent.manage`, 대상 에이전트) → 경로 id 400 → 에이전트 404 → 멈춤 409 `stopped`
//! → 배정 409 `not_assigned` → 정의 `assign` 다시 밀기 → `agent.restart` → 못 보내면 409 `operator_offline` → 감사 → 202.
use super::operator::OperatorCore;
use super::operator_assign::DEFINITION_SQL;
use crate::auth::Auth;
use crate::directory::{internal, json_err, json_ok};
use crate::lists::is_zod_uuid;
use crate::perm::{Target, TargetKind, require_cap};
use crate::write::{AuditEntry, record_audit};
use crate::writes_settings::ip_of;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::json;
use std::sync::Arc;

macro_rules! db {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return internal(e),
        }
    };
}

/// `POST /accounts/agents/{id}/restart` — 배정은 그대로 두고 새 정의(`assign`)를 먼저 민 뒤 `agent.restart` 를 보낸다.
pub async fn restart(
    State(core): State<Arc<OperatorCore>>,
    Path(agent_id): Path<String>,
    req: Request,
) -> Response {
    let (parts, _) = req.into_parts();
    let auth = parts.extensions.get::<Auth>().cloned().unwrap_or_default();
    let target = Target {
        kind: TargetKind::Agent,
        id: &agent_id,
    };
    let me = match require_cap(&core.pool, &auth, "agent.manage", Some(target)).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_zod_uuid(&agent_id) {
        return json_err(StatusCode::BAD_REQUEST, "invalid_request", "id: invalid");
    }
    // TS `getAgent` 와 같은 대상: 지우지 않은 에이전트 계정. (handle, 멈춤 요청 여부, 배정된 오퍼레이터)
    let row: Option<(String, bool, Option<String>)> = db!(sqlx::query_as(
        "select a.handle, c.stop_requested_at is not null, asg.operator_id::text \
           from account a left join agent_config c on c.account_id = a.id \
           left join agent_assignment asg on asg.agent_id = a.id \
          where a.id = $1::uuid and a.kind = 'agent' and a.deleted_at is null"
    )
    .bind(&agent_id)
    .fetch_optional(&core.pool)
    .await);
    let Some((handle, stopped, operator)) = row else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such agent");
    };
    if stopped {
        return json_err(
            StatusCode::CONFLICT,
            "stopped",
            "멈춰 둔 에이전트다 — 먼저 실행(되돌리기)을 누른다",
        );
    }
    let Some(op) = operator else {
        return json_err(
            StatusCode::CONFLICT,
            "not_assigned",
            "배정된 오퍼레이터가 없다",
        );
    };
    // 새 정의를 먼저 보낸다 — 오퍼레이터는 마지막으로 받은 정의로 다시 띄운다(TS 주석).
    let definition: Option<String> = db!(sqlx::query_scalar(DEFINITION_SQL)
        .bind(&agent_id)
        .fetch_optional(&core.pool)
        .await);
    let pushed = match definition.and_then(|d| serde_json::from_str::<serde_json::Value>(&d).ok()) {
        Some(def) => core.hub.send(
            &op,
            &json!({ "type": "assign", "agentId": agent_id, "definition": def }),
        ),
        None => true,
    };
    let sent = pushed
        && core.hub.send(
            &op,
            &json!({ "type": "agent.restart", "agentId": agent_id }),
        );
    if !sent {
        return json_err(
            StatusCode::CONFLICT,
            "operator_offline",
            "그 오퍼레이터가 지금 붙어 있지 않다",
        );
    }
    record_audit(
        &core.write,
        AuditEntry {
            action: "agent.restart.requested",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&agent_id),
            ip: ip_of(&parts, &core.trust).as_deref(),
            detail: json!({ "handle": handle, "operatorId": op }),
        },
    )
    .await;
    let mut r = json_ok(json!({ "operatorId": op }).to_string());
    *r.status_mut() = StatusCode::ACCEPTED;
    r
}
