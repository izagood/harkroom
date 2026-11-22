//! 오퍼레이터가 붙을 때(hello) 그 오퍼레이터의 배정을 전부 다시 민다(AC5 A1, TS `routes/assignmentRoutes.ts` 의 `hub.onFrame`).
//!
//! 서버는 끊기면 잊고 오퍼레이터는 재접속마다 처음부터다 — 이 재전송이 없으면 서버가 재시작한 뒤 아무도 러너를 띄우지 않는다.
//! 오퍼레이터 코어가 이 프로세스로 오면 hello 는 이 허브로만 오므로(TS 허브는 비어 있다) 여기서 답해야 한다.
//!
//! - 종료 요청(`agent_config.stop_requested_at`)이 걸린 에이전트는 밀지 않는다 — 밀면 붙을 때마다 멈춘 러너가 살아난다.
//! - 묶음 끝의 `assign.synced{agentIds}` 에는 실제로 보낸 것만 싣는다. 오퍼레이터는 이 목록에 없는 **채택한** 러너만 회수한다.
//!   조회가 실패하면 `assign.synced` 를 보내지 않는다 — 오퍼레이터는 회수하지 않는다(안 죽이는 쪽, TS 와 같음).
//! - hello 를 놓친 경우: 프레임 구독(broadcast)이 밀려 `Lagged` 가 나면 어느 hello 가 빠졌는지 알 수 없다. 그래서 그때는 **지금
//!   붙어 있는 오퍼레이터 전부**에 다시 민다. 재전송은 같은 목록을 다시 보내는 것이라 겹쳐도 해가 없다(assign 은 같은 정의로
//!   덮어쓰고, synced 는 매번 전체 목록이다).
use super::operator::OperatorCore;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::broadcast;

/// TS `definitionFor` 와 같은 칸(배정과 함께 내려주는 정의 — 머신 값은 없다). 에이전트가 아닌 행은 빠진다.
const RESYNC_SQL: &str = "select a.agent_id::text, json_build_object(\
       'agentId', ac.id, 'handle', ac.handle, 'harness', coalesce(c.harness, 'claude-code'), \
       'instructions', coalesce(c.instructions, ''), 'model', c.model, 'effort', c.effort, \
       'mentionPermission', coalesce(c.mention_permission, 'auto'), \
       'workingDirDefault', c.working_dir, 'ownerAccountId', c.owner_account_id, \
       'credentialScope', coalesce(c.credential_scope, 'none'), \
       'mcpServers', coalesce((select json_agg(m.name order by m.name) from agent_mcp_server m where m.agent_id = ac.id), '[]'::json)\
     )::text \
     from agent_assignment a \
     join account ac on ac.id = a.agent_id and ac.kind = 'agent' \
     left join agent_config c on c.account_id = a.agent_id \
     where a.operator_id = $1::uuid and c.stop_requested_at is null \
     order by a.assigned_at, a.agent_id";

pub(super) fn spawn_resync(core: Arc<OperatorCore>) {
    let mut frames = core.hub.subscribe_frames();
    tokio::spawn(async move {
        loop {
            let targets = match frames.recv().await {
                Ok((operator_id, frame)) => {
                    if frame.get("type").and_then(Value::as_str) != Some("hello") {
                        continue;
                    }
                    vec![operator_id]
                }
                // 놓친 hello 를 알 수 없다 — 붙어 있는 오퍼레이터 전부에 다시 민다.
                Err(broadcast::error::RecvError::Lagged(_)) => core.hub.online_ids(),
                Err(broadcast::error::RecvError::Closed) => break,
            };
            for operator_id in targets {
                tokio::spawn(resync(core.clone(), operator_id));
            }
        }
    });
}

/// 한 오퍼레이터의 배정 전부 → `assign` 여러 개 → `assign.synced`.
async fn resync(core: Arc<OperatorCore>, operator_id: String) {
    let rows: Vec<(String, String)> = match sqlx::query_as(RESYNC_SQL)
        .bind(&operator_id)
        .fetch_all(&core.pool)
        .await
    {
        Ok(r) => r,
        Err(_) => {
            // 다음 hello 가 다시 한다. synced 를 보내지 않으므로 오퍼레이터는 회수하지 않는다.
            eprintln!("core: operator assignment resync failed");
            return;
        }
    };
    let mut sent = Vec::with_capacity(rows.len());
    for (agent_id, definition) in rows {
        let Ok(definition) = serde_json::from_str::<Value>(&definition) else {
            continue;
        };
        core.hub.send(
            &operator_id,
            &json!({ "type": "assign", "agentId": agent_id, "definition": definition }),
        );
        sent.push(agent_id);
    }
    core.hub.send(
        &operator_id,
        &json!({ "type": "assign.synced", "agentIds": sent }),
    );
}

// ── 배정 줄(AC5 A1b, TS `assignmentRoutes.ts` 의 PUT·DELETE `/accounts/agents/:id/assignment`) ──
//
// 배정은 양쪽의 동의다: 서버 쪽에서 고르고(소유자/관리자) ∧ 오퍼레이터가 그 에이전트를 능력으로 등록했어야 한다.
// 재배정은 이전 오퍼레이터에 `unassign{drain:true}` → 새 오퍼레이터에 `assign` 순서다(같은 에이전트를 두 곳이 동시에 돌리지 않는다).
// 판정 순서는 TS 와 같다 — PUT: 인증(401) → 경로 id(400) → 본문(400) → 오퍼레이터(404) → 권한(403) → 능력(409) → 정의(404)
// → 하네스(409) → 개인 자격증명(403) → 쓰기. DELETE: 권한(`agent.manage`, 대상 에이전트) → 배정(404) → 지우기.

use crate::auth::Auth;
use crate::directory::{internal, json_err};
use crate::lists::is_zod_uuid;
use crate::perm::{Target, TargetKind, can, require_cap};
use crate::write::{AuditEntry, Body, read_body, record_audit};
use crate::writes_settings::ip_of;
use axum::extract::{Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};

pub(super) const DEFINITION_SQL: &str = "select json_build_object(\
       'agentId', ac.id, 'handle', ac.handle, 'harness', coalesce(c.harness, 'claude-code'), \
       'instructions', coalesce(c.instructions, ''), 'model', c.model, 'effort', c.effort, \
       'mentionPermission', coalesce(c.mention_permission, 'auto'), \
       'workingDirDefault', c.working_dir, 'ownerAccountId', c.owner_account_id, \
       'credentialScope', coalesce(c.credential_scope, 'none'), \
       'mcpServers', coalesce((select json_agg(m.name order by m.name) from agent_mcp_server m where m.agent_id = ac.id), '[]'::json)\
     )::text \
     from account ac left join agent_config c on c.account_id = ac.id \
     where ac.id = $1::uuid and ac.kind = 'agent'";

const ASSIGNMENT_SQL: &str = concat!(
    "select json_build_object('agentId', agent_id, 'operatorId', operator_id, 'assignedBy', assigned_by, 'assignedAt', ",
    crate::iso!("assigned_at"),
    ")::text from agent_assignment where agent_id = $1::uuid"
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

fn err(status: StatusCode, code: &str, msg: &str) -> Response {
    json_err(status, code, msg)
}

fn json_text(body: String) -> Response {
    (
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response()
}

async fn assignment_of(pool: &sqlx::PgPool, agent_id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(ASSIGNMENT_SQL)
        .bind(agent_id)
        .fetch_optional(pool)
        .await
}

async fn stop_requested(pool: &sqlx::PgPool, agent_id: &str) -> Result<bool, sqlx::Error> {
    let hit: Option<i32> = sqlx::query_scalar(
        "select 1 from agent_config where account_id = $1::uuid and stop_requested_at is not null",
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await?;
    Ok(hit.is_some())
}

/// 하네스 능력: 오퍼레이터가 그 하네스를 **없다고 말했을 때만** 거절한다(말하지 않았으면 모른다 — 옛 오퍼레이터·빈 표).
fn harness_missing(caps: &Value, harness: &str) -> bool {
    caps.get("harnesses")
        .and_then(|h| h.get(harness))
        .and_then(|h| h.get("installed"))
        .and_then(Value::as_bool)
        == Some(false)
}

fn capable(caps: &Value, agent_id: &str) -> bool {
    caps.get("agentIds")
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(agent_id)))
}

/// `PUT /accounts/agents/{id}/assignment` — `{ operatorId }`.
pub async fn put_assignment(
    State(core): State<Arc<OperatorCore>>,
    Path(agent_id): Path<String>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let body = tri!(read_body(&parts.headers, body).await);
    let auth = parts.extensions.get::<Auth>().cloned().unwrap_or_default();
    let Some(me) = auth.account.clone() else {
        return err(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "authentication required",
        );
    };
    if !is_zod_uuid(&agent_id) {
        return err(StatusCode::BAD_REQUEST, "invalid_request", "id: invalid");
    }
    let operator_id = match &body {
        Body::Json(Value::Object(m)) => match m.get("operatorId") {
            Some(Value::String(s)) if is_zod_uuid(s) => s.clone(),
            _ => {
                return err(
                    StatusCode::BAD_REQUEST,
                    "bad_request",
                    "operatorId: invalid",
                );
            }
        },
        Body::None => {
            return err(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "operatorId: required",
            );
        }
        _ => return err(StatusCode::BAD_REQUEST, "bad_request", "body: invalid"),
    };

    let owner: Option<String> = db!(sqlx::query_scalar(
        "select owner_account_id::text from operator where id = $1::uuid and revoked_at is null"
    )
    .bind(&operator_id)
    .fetch_optional(&core.pool)
    .await);
    let Some(owner) = owner else {
        return err(StatusCode::NOT_FOUND, "not_found", "그런 오퍼레이터가 없다");
    };
    // 소유자는 **자기** 오퍼레이터에만 배정한다. 남의 오퍼레이터에 넣는 것은 그 사람의 머신에 프로세스를 띄우는 일이라
    // 전역 agent.manage 가 필요하다.
    let target = Target {
        kind: TargetKind::Agent,
        id: &agent_id,
    };
    let allowed = if owner == me.id {
        db!(can(&core.pool, &me, "agent.manage", Some(&target)).await)
    } else {
        db!(can(&core.pool, &me, "agent.manage", None).await)
    };
    if !allowed {
        return err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "이 에이전트를 그 오퍼레이터에 배정할 권한이 없다",
        );
    }

    let caps = core.hub.capabilities(&operator_id);
    let Some(caps) = caps.filter(|c| capable(c, &agent_id)) else {
        return err(
            StatusCode::CONFLICT,
            "not_capable",
            "그 오퍼레이터가 이 에이전트를 돌릴 수 있다고 등록하지 않았다 — 오프라인이거나 로컬 설정에 없다",
        );
    };

    let definition: Option<String> = db!(sqlx::query_scalar(DEFINITION_SQL)
        .bind(&agent_id)
        .fetch_optional(&core.pool)
        .await);
    let Some(definition) = definition.and_then(|d| serde_json::from_str::<Value>(&d).ok()) else {
        return err(StatusCode::NOT_FOUND, "not_found", "그런 에이전트가 없다");
    };
    let harness = definition
        .get("harness")
        .and_then(Value::as_str)
        .unwrap_or("");
    if harness_missing(&caps, harness) {
        return err(
            StatusCode::CONFLICT,
            "harness_missing",
            &format!("그 오퍼레이터의 머신에 {harness} 가 설치돼 있지 않다"),
        );
    }
    // 개인 자격증명을 쥔 에이전트는 **소유자 자신의** 오퍼레이터에만 간다(admin 도 예외 없음).
    if definition.get("credentialScope").and_then(Value::as_str) == Some("personal")
        && definition.get("ownerAccountId").and_then(Value::as_str) != Some(owner.as_str())
    {
        return err(
            StatusCode::FORBIDDEN,
            "personal_on_foreign_operator",
            "개인 자격증명을 쥔 에이전트는 소유자 자신의 오퍼레이터에만 배정할 수 있다",
        );
    }

    // 이전 자리·배정·비밀 grant 세우기를 한 트랜잭션으로(TS 는 따로 쓴다 — 중간에 끊겨 반만 남지 않게).
    let mut tx = db!(core.write.begin().await);
    let previous: Option<String> = db!(sqlx::query_scalar(
        "select operator_id::text from agent_assignment where agent_id = $1::uuid for update"
    )
    .bind(&agent_id)
    .fetch_optional(&mut *tx)
    .await);
    db!(
        sqlx::query(
            "insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1::uuid, $2::uuid, $3::uuid) \
             on conflict (agent_id) do update set operator_id = excluded.operator_id, assigned_by = excluded.assigned_by, assigned_at = now()"
        )
        .bind(&agent_id)
        .bind(&operator_id)
        .bind(&me.id)
        .execute(&mut *tx)
        .await
    );
    // 다른 오퍼레이터에 묶인 비밀 grant 는 세운다 — 비밀 소유자가 믿은 것은 그 머신이었다.
    db!(
        sqlx::query(
            "update secret_grant set suspended_at = now(), suspend_reason = 'assignment_changed' \
             where agent_id = $1::uuid and suspended_at is null and operator_id is not null and operator_id <> $2::uuid"
        )
        .bind(&agent_id)
        .bind(&operator_id)
        .execute(&mut *tx)
        .await
    );
    db!(tx.commit().await);
    // H1 허용 표(기록만) — 커밋 뒤, 요청 밖에서 맞춘다. 실패해도 배정은 그대로다.
    super::device_allow::sync(Some(&agent_id));

    // 순서가 계약이다: 이전 곳이 먼저 놓고(drain), 새 곳이 잡는다.
    if let Some(prev) = previous.as_deref()
        && prev != operator_id
    {
        core.hub.send(
            prev,
            &json!({ "type": "unassign", "agentId": agent_id, "drain": true }),
        );
    }
    // 멈춰 둔 에이전트는 자리만 옮기고 띄우지 않는다 — 되돌리기가 새 자리에 민다.
    if !db!(stop_requested(&core.pool, &agent_id).await) {
        core.hub.send(
            &operator_id,
            &json!({ "type": "assign", "agentId": agent_id, "definition": definition }),
        );
    }
    record_audit(
        &core.write,
        AuditEntry {
            action: "agent.assigned",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&agent_id),
            ip: ip_of(&parts, &core.trust).as_deref(),
            detail: json!({ "operatorId": operator_id, "previous": previous }),
        },
    )
    .await;
    core.events.emit(
        json!({ "type": "agent_assignment.changed", "agentId": agent_id, "audience": "all" }),
    );
    match db!(assignment_of(&core.write, &agent_id).await) {
        Some(row) => json_text(row),
        None => json_text("null".to_string()),
    }
}

/// `DELETE /accounts/agents/{id}/assignment` — `agent.manage`(대상 에이전트).
pub async fn delete_assignment(
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
        return err(StatusCode::BAD_REQUEST, "invalid_request", "id: invalid");
    }
    let previous: Option<String> = db!(sqlx::query_scalar(
        "delete from agent_assignment where agent_id = $1::uuid returning operator_id::text"
    )
    .bind(&agent_id)
    .fetch_optional(&core.write)
    .await);
    let Some(previous) = previous else {
        return err(StatusCode::NOT_FOUND, "not_found", "배정이 없다");
    };
    super::device_allow::sync(Some(&agent_id));
    core.hub.send(
        &previous,
        &json!({ "type": "unassign", "agentId": agent_id, "drain": true }),
    );
    record_audit(
        &core.write,
        AuditEntry {
            action: "agent.unassigned",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&agent_id),
            ip: ip_of(&parts, &core.trust).as_deref(),
            detail: json!({ "operatorId": previous }),
        },
    )
    .await;
    core.events.emit(
        json!({ "type": "agent_assignment.changed", "agentId": agent_id, "audience": "all" }),
    );
    StatusCode::NO_CONTENT.into_response()
}
