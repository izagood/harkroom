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
