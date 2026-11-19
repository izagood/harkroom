//! AC5 A2 — 멈추기 줄(`POST /accounts/agents/{id}/stop`·`.../stop/undo`)을 Rust 오퍼레이터 코어로 옮긴다.
//! TS `accountRoutes.ts`(stop·stop/undo)와 `services/agents.ts`(`requestAgentStop`·`undoAgentStopRequest`)를 그대로 따른다.
//!
//! 오퍼레이터 코어가 `/operator` 소켓을 가져가면 TS 허브는 비어서, TS 의 멈추기는 DB 만 바꾸고 `unassign{drain}` 은
//! 아무에게도 가지 않는다(멈추기가 재시작이 된다). 그래서 AC5 안전판이 이 두 줄을 503 으로 막아 두었고, 이 판이 Rust 로 옮긴다.
//!
//! 순서(TS 와 같다): 권한(`agent.manage`, 대상 에이전트) → 경로 id 400 → 에이전트 확인 404 → 쓰기 → 감사 → 프레임 → AgentView.
use super::operator::OperatorCore;
use super::operator_assign::DEFINITION_SQL;
use crate::auth::Auth;
use crate::directory::{internal, json_err};
use crate::lists::is_zod_uuid;
use crate::perm::{Target, TargetKind, require_cap};
use crate::write::{AuditEntry, record_audit};
use crate::writes_settings::ip_of;
use axum::extract::{Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::sync::Arc;

/// TS `services/agents.ts` `COLS` 를 한 json 으로 접는다. 최상위 시각은 TS 가 `Date` 를 JSON 으로 옮기는
/// 꼴(`toISOString`, ms·Z)로 맞추고, `assignment` 안 시각은 TS 도 pg 의 json 그대로 넘기므로 같은 `json_build_object` 를 쓴다.
/// AgentView 한 행을 접는 `json_build_object(...)` — 상세(`AGENT_VIEW_SQL`)와 목록(`GET /accounts/agents`)이 같은 칸을 쓴다.
/// 별칭 `a`(account)·`c`(agent_config)·`v`(agent_runner_version)·`asg`(agent_assignment) 를 기대한다.
macro_rules! agent_view_json {
    () => {
        concat!(
            "json_build_object(\
       'id', a.id, 'handle', a.handle, 'displayName', a.display_name, 'kind', a.kind, 'isAdmin', a.is_admin, \
       'role', a.role, \
       'instructions', coalesce(c.instructions, ''), \
       'harness', coalesce(c.harness, 'claude-code'), \
       'model', c.model, 'effort', c.effort, 'workingDir', c.working_dir, \
       'mentionPermission', coalesce(c.mention_permission, 'auto'), \
       'ownerAccountId', c.owner_account_id, \
       'invokeScope', coalesce(c.invoke_scope, 'community'), \
       'credentialScope', coalesce(c.credential_scope, 'none'), \
       'invokers', coalesce((select json_agg(i.account_id order by i.account_id) from agent_invoker i where i.agent_id = a.id), '[]'::json), \
       'delegates', coalesce((select json_agg(d.delegate_id order by d.delegate_id) from agent_owner_delegate d where d.agent_id = a.id), '[]'::json), \
       'trustSiblings', coalesce(c.trust_siblings, true), \
       'userDecide', coalesce(c.user_decide, true), \
       'requiresMacos', coalesce(c.requires_macos, false), \
       'chromeEnabled', coalesce(c.chrome_enabled, false), \
       'mcpServers', coalesce((select json_agg(m.name order by m.name) from agent_mcp_server m where m.agent_id = a.id), '[]'::json), \
       'disabled', a.disabled_at is not null, \
       'deleted', a.deleted_at is not null, \
       'status', a.status, 'statusText', a.status_text, \
       'avatarAttachmentId', a.avatar_attachment_id, \
       'runnerVersion', v.version, \
       'stopRequestedAt', ",
    crate::iso!("c.stop_requested_at"),
    ", 'stopAckedAt', ",
    crate::iso!("c.stop_acked_at"),
    ", 'lastTurnAt', ",
    crate::iso!("c.last_turn_at"),
    ", 'assignment', case when asg.agent_id is null then null \
         else json_build_object('agentId', asg.agent_id, 'operatorId', asg.operator_id, \
                                'assignedBy', asg.assigned_by, 'assignedAt', asg.assigned_at) end\
     )"
        )
    };
}

const AGENT_VIEW_SQL: &str = concat!(
    "select ",
    agent_view_json!(),
    "::text, ",
    crate::iso!("c.stop_requested_at"),
    " from account a left join agent_config c on c.account_id = a.id \
       left join agent_runner_version v on v.account_id = a.id \
       left join agent_assignment asg on asg.agent_id = a.id \
     where a.id = $1::uuid and a.kind = 'agent' and a.deleted_at is null"
);

/// TS `listAgents` — admin 은 전부, 비admin 은 자기가 소유한 것만(SQL 에서 거른다). `order by a.handle`.
const AGENT_LIST_SQL: &str = concat!(
    "select a.id::text, ",
    agent_view_json!(),
    "::text from account a left join agent_config c on c.account_id = a.id \
       left join agent_runner_version v on v.account_id = a.id \
       left join agent_assignment asg on asg.agent_id = a.id \
     where a.kind = 'agent' and a.deleted_at is null \
       and ($1::uuid is null or c.owner_account_id = $1::uuid) \
     order by a.handle"
);

macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(r) => return r,
        }
    };
}
macro_rules! db {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return internal(e),
        }
    };
}

/// (AgentView json, 그 행의 `stopRequestedAt`). 없거나 지운 에이전트·사람 계정이면 None.
pub(super) async fn agent_view(
    pool: &sqlx::PgPool,
    id: &str,
) -> Result<Option<(String, Option<String>)>, sqlx::Error> {
    sqlx::query_as(AGENT_VIEW_SQL)
        .bind(id)
        .fetch_optional(pool)
        .await
}

async fn operator_of(pool: &sqlx::PgPool, id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("select operator_id::text from agent_assignment where agent_id = $1::uuid")
        .bind(id)
        .fetch_optional(pool)
        .await
}

fn not_found() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such agent")
}

fn json_text(body: String) -> Response {
    (
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response()
}

fn handle_of(view: &str) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(view)
        .ok()
        .and_then(|v| v.get("handle").cloned())
        .unwrap_or(serde_json::Value::Null)
}

/// `GET /accounts/agents` — TS `accountRoutes.ts`. `requireAccount`(401) → `listAgents` → 각 행 끝에 `runnerRefusal`
/// (허브의 `refusalOf`, 없으면 null). TS 의 `{ ...a, runnerRefusal }` 처럼 그 키가 **마지막**이다. 이 줄은 오퍼레이터 코어와
/// 함께만 선다 — 거절 사유는 `/operator` 소켓을 가진 프로세스의 허브에만 있다.
pub async fn list_agents(
    State(core): State<Arc<OperatorCore>>,
    crate::auth::RequireAccount(me, _): crate::auth::RequireAccount,
) -> Response {
    let owner = (!me.is_admin).then_some(me.id.as_str());
    let rows: Vec<(String, String)> = db!(sqlx::query_as(AGENT_LIST_SQL)
        .bind(owner)
        .fetch_all(&core.pool)
        .await);
    let mut out = String::from("{\"agents\":[");
    for (i, (id, view)) in rows.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let refusal = core.hub.refusal_of(id).unwrap_or(serde_json::Value::Null);
        // json_build_object 는 늘 `}` 로 끝난다 — 그 앞에 마지막 키를 붙인다.
        out.push_str(view.trim_end().strip_suffix('}').unwrap_or(view));
        out.push_str(",\"runnerRefusal\":");
        out.push_str(&refusal.to_string());
        out.push('}');
    }
    out.push_str("]}");
    json_text(out)
}

/// `POST /accounts/agents/{id}/stop` — TS `requestAgentStop` + 감사 `agent.stop.requested` + 배정된 오퍼레이터에 `unassign{drain}`.
/// 배정 행은 남긴다(되돌리면 같은 곳에 다시 민다).
pub async fn stop(
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
    let me = tri!(require_cap(&core.pool, &auth, "agent.manage", Some(target)).await);
    if !is_zod_uuid(&agent_id) {
        return json_err(StatusCode::BAD_REQUEST, "invalid_request", "id: invalid");
    }
    // 대상 확인이 먼저다 — 사람 계정에 upsert 하면 조용히 성공해 사람에게 종료 요청이 달린다(TS 주석).
    if db!(agent_view(&core.pool, &agent_id).await).is_none() {
        return not_found();
    }
    db!(sqlx::query(
        "insert into agent_config (account_id, stop_requested_at, stop_requested_by) \
         values ($1::uuid, now(), $2::uuid) \
         on conflict (account_id) do update set \
           stop_requested_at = now(), stop_requested_by = $2::uuid, stop_acked_at = null, updated_at = now()"
    )
    .bind(&agent_id)
    .bind(&me.id)
    .execute(&core.write)
    .await);
    let Some((view, _)) = db!(agent_view(&core.pool, &agent_id).await) else {
        return not_found();
    };
    record_audit(
        &core.write,
        AuditEntry {
            action: "agent.stop.requested",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&agent_id),
            ip: ip_of(&parts, &core.trust).as_deref(),
            detail: json!({ "handle": handle_of(&view) }),
        },
    )
    .await;
    if let Some(op) = db!(operator_of(&core.pool, &agent_id).await) {
        core.hub.send(
            &op,
            &json!({ "type": "unassign", "agentId": agent_id, "drain": true }),
        );
    }
    json_text(view)
}

/// `POST /accounts/agents/{id}/stop/undo` — TS `undoAgentStopRequest`. 요청이 없었으면 아무것도 쓰지 않고 감사도 남기지 않은 채
/// AgentView 를 200 으로 준다. 있었으면 감사 `agent.stop.undone` 뒤 배정된 오퍼레이터에 정의를 다시 민다(`assign`).
pub async fn stop_undo(
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
    let me = tri!(require_cap(&core.pool, &auth, "agent.manage", Some(target)).await);
    if !is_zod_uuid(&agent_id) {
        return json_err(StatusCode::BAD_REQUEST, "invalid_request", "id: invalid");
    }
    // 되돌린 뒤에는 정의에서 사라지므로 먼저 읽는다(감사에 "무엇을 되돌렸나"를 남길 마지막 순간).
    let Some((_, before_stop)) = db!(agent_view(&core.pool, &agent_id).await) else {
        return not_found();
    };
    db!(sqlx::query(
        "update agent_config set stop_requested_at = null, stop_acked_at = null, \
           stop_requested_by = $2::uuid, updated_at = now() \
         where account_id = $1::uuid and stop_requested_at is not null"
    )
    .bind(&agent_id)
    .bind(&me.id)
    .execute(&core.write)
    .await);
    let Some((view, _)) = db!(agent_view(&core.pool, &agent_id).await) else {
        return not_found();
    };
    if let Some(at) = before_stop {
        record_audit(
            &core.write,
            AuditEntry {
                action: "agent.stop.undone",
                actor_id: Some(&me.id),
                actor_handle: Some(&me.handle),
                target: Some(&agent_id),
                ip: ip_of(&parts, &core.trust).as_deref(),
                detail: json!({ "handle": handle_of(&view), "stopRequestedAt": at }),
            },
        )
        .await;
        if let Some(op) = db!(operator_of(&core.pool, &agent_id).await) {
            let definition: Option<String> = db!(sqlx::query_scalar(DEFINITION_SQL)
                .bind(&agent_id)
                .fetch_optional(&core.pool)
                .await);
            if let Some(def) =
                definition.and_then(|d| serde_json::from_str::<serde_json::Value>(&d).ok())
            {
                core.hub.send(
                    &op,
                    &json!({ "type": "assign", "agentId": agent_id, "definition": def }),
                );
            }
        }
    }
    json_text(view)
}
