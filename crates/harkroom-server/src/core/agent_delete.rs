//! S5.4 — 에이전트 지우기. TS `routes/accountRoutes.ts` 의 `DELETE /accounts/agents/:id` 와 `services/agents.ts` 의
//! `deleteAgentAccount` 를 옮긴다.
//!
//! - 순서는 TS 와 같다: `requireCap('agent.manage', {kind:'agent', param:'id'})`(401·403) → 경로 zod(400) →
//!   지우지 않은 에이전트인가(404 `no such agent`) → 한 트랜잭션(사진 칸 비우기·묘비 이름·PAT 거두기·팀원·자동멘션·배정·
//!   비밀 grant 정지·호출자·대리·MCP·대기 wake 취소·기억·푸시 기기) → 옛 사진 파일 정리 → `avatar.changed` →
//!   감사 `agent.deleted {handle, revokedPats}` → 204.
//! - 쓰기 권한은 [`AGENT_DELETE_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use super::attachment_store::LocalStorage;
use crate::auth::Auth;
use crate::directory::{internal, json_err};
use crate::perm::{Target, TargetKind, require_cap};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, emit_event, record_audit};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;

pub const AGENT_DELETE_PRIVILEGES: &[(&str, &str)] = &[
    ("account.id", "SELECT"),
    ("account.kind", "SELECT"),
    ("account.handle", "SELECT"),
    ("account.deleted_at", "SELECT"),
    ("account.avatar_attachment_id", "SELECT"),
    ("account.avatar_source_attachment_id", "SELECT"),
    ("account.deleted_at", "UPDATE"),
    ("account.disabled_at", "UPDATE"),
    ("account.handle", "UPDATE"),
    ("account.avatar_attachment_id", "UPDATE"),
    ("account.avatar_source_attachment_id", "UPDATE"),
    ("account.avatar_crop", "UPDATE"),
    ("agent_team.name", "SELECT"),
    ("handle_group.handle", "SELECT"),
    ("pat.account_id", "SELECT"),
    ("pat.revoked_at", "SELECT"),
    ("pat.label", "SELECT"),
    ("pat.revoked_at", "UPDATE"),
    ("agent_team_member", "DELETE"),
    ("agent_team_member.agent_account_id", "SELECT"),
    ("channel_auto_mention", "DELETE"),
    ("channel_auto_mention.agent_account_id", "SELECT"),
    ("agent_assignment", "DELETE"),
    ("agent_assignment.agent_id", "SELECT"),
    ("secret_grant.agent_id", "SELECT"),
    ("secret_grant.suspended_at", "SELECT"),
    ("secret_grant.suspended_at", "UPDATE"),
    ("secret_grant.suspend_reason", "UPDATE"),
    ("agent_invoker", "DELETE"),
    ("agent_invoker.agent_id", "SELECT"),
    ("agent_owner_delegate", "DELETE"),
    ("agent_owner_delegate.agent_id", "SELECT"),
    ("agent_owner_delegate.delegate_id", "SELECT"),
    ("agent_mcp_server", "DELETE"),
    ("agent_mcp_server.agent_id", "SELECT"),
    ("agent_wake.account_id", "SELECT"),
    ("agent_wake.fired_at", "SELECT"),
    ("agent_wake.canceled_at", "SELECT"),
    ("agent_wake.canceled_at", "UPDATE"),
    ("agent_memory", "DELETE"),
    ("agent_memory.account_id", "SELECT"),
    ("push_device", "DELETE"),
    ("push_device.account_id", "SELECT"),
    // 옛 사진 정리(`releaseAvatarFiles`).
    ("attachment", "DELETE"),
    ("attachment.id", "SELECT"),
    ("attachment.message_id", "SELECT"),
    ("attachment.storage_key", "SELECT"),
    ("workspace_profile.icon_attachment_id", "SELECT"),
    ("artifact_version.attachment_id", "SELECT"),
    ("artifact_version.cover_attachment_id", "SELECT"),
    ("event_outbox", "INSERT"),
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.actor_handle", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.ip", "INSERT"),
    ("audit_log.detail", "INSERT"),
];

pub struct AgentDeleteState {
    pub write: PgPool,
    pub storage: LocalStorage,
    pub trust: Arc<TrustProxy>,
}

pub(crate) const DELETED_HANDLE_PREFIX: &str = "deleted-";

/// `freeDeletedHandle` — 묘비 이름. 앞 8자, 겹치면 24자, 그래도 겹치면 난수 12바이트.
pub(crate) async fn free_deleted_handle(
    tx: &mut sqlx::PgConnection,
    id: &str,
) -> Result<String, sqlx::Error> {
    let hex: String = id.chars().filter(|c| *c != '-').collect();
    for n in [8usize, 24] {
        let cand = format!("{DELETED_HANDLE_PREFIX}{}", &hex[..n.min(hex.len())]);
        let taken: Option<i32> = sqlx::query_scalar(
            "select 1 from account where lower(handle) = lower($1) and id <> $2::uuid \
             union all select 1 from agent_team where lower(name) = lower($1) \
             union all select 1 from handle_group where lower(handle) = lower($1)",
        )
        .bind(&cand)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
        if taken.is_none() {
            return Ok(cand);
        }
    }
    let mut b = [0u8; 12];
    getrandom::fill(&mut b).expect("os random");
    Ok(format!("{DELETED_HANDLE_PREFIX}{}", hex::encode(b)))
}

struct Removed {
    handle: String,
    revoked_pats: Vec<String>,
    avatar_ids: Vec<Option<String>>,
}

/// `deleteAgentAccount` — 없거나 이미 지웠으면 `None`.
async fn delete_agent_account(pool: &PgPool, id: &str) -> Result<Option<Removed>, sqlx::Error> {
    let handle: Option<String> = sqlx::query_scalar(
        "select handle from account where id = $1::uuid and kind = 'agent' and deleted_at is null",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    let Some(handle) = handle else {
        return Ok(None);
    };
    let mut tx = pool.begin().await?;
    let pics: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "select avatar_attachment_id::text, avatar_source_attachment_id::text from account \
          where id = $1::uuid for update",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let tombstone = free_deleted_handle(&mut tx, id).await?;
    sqlx::query(
        "update account set deleted_at = now(), disabled_at = coalesce(disabled_at, now()), handle = $2, \
                avatar_attachment_id = null, avatar_source_attachment_id = null, avatar_crop = null \
          where id = $1::uuid",
    )
    .bind(id)
    .bind(&tombstone)
    .execute(&mut *tx)
    .await?;
    let revoked_pats: Vec<String> = sqlx::query_scalar(
        "update pat set revoked_at = now() where account_id = $1::uuid and revoked_at is null returning label",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    for sql in [
        "delete from agent_team_member where agent_account_id = $1::uuid",
        "delete from channel_auto_mention where agent_account_id = $1::uuid",
        "delete from agent_assignment where agent_id = $1::uuid",
        "update secret_grant set suspended_at = now(), suspend_reason = 'agent_deleted' \
          where agent_id = $1::uuid and suspended_at is null",
        "delete from agent_invoker where agent_id = $1::uuid",
        "delete from agent_owner_delegate where agent_id = $1::uuid or delegate_id = $1::uuid",
        "delete from agent_mcp_server where agent_id = $1::uuid",
        "update agent_wake set canceled_at = now() \
          where account_id = $1::uuid and fired_at is null and canceled_at is null",
        "delete from agent_memory where account_id = $1::uuid",
        "delete from push_device where account_id = $1::uuid",
    ] {
        sqlx::query(sql).bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    let (a, s) = pics.unwrap_or((None, None));
    Ok(Some(Removed {
        handle,
        revoked_pats,
        avatar_ids: vec![a, s],
    }))
}

/// `DELETE /accounts/agents/{id}`.
pub async fn delete_agent(
    State(st): State<Arc<AgentDeleteState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (parts, _) = req.into_parts();
    let auth = parts.extensions.get::<Auth>().cloned().unwrap_or_default();
    let target = Target {
        kind: TargetKind::Agent,
        id: &id,
    };
    let actor = match require_cap(&st.write, &auth, "agent.manage", Some(target)).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !crate::lists::is_zod_uuid(&id) {
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    let removed = match delete_agent_account(&st.write, &id).await {
        Ok(Some(r)) => r,
        Ok(None) => return json_err(StatusCode::NOT_FOUND, "not_found", "no such agent"),
        Err(e) => return internal(e),
    };
    super::avatar_write::release_files(&st.write, &st.storage, removed.avatar_ids).await;
    let ev = json!({ "type": "avatar.changed", "accountId": id, "avatarAttachmentId": null });
    match st.write.acquire().await {
        Ok(mut conn) => {
            if let Err(e) = emit_event(&mut conn, &ev).await {
                eprintln!(
                    "front: avatar.changed event failed: {}",
                    e.as_database_error().map_or("io", |_| "db")
                );
            }
        }
        Err(e) => eprintln!(
            "front: avatar.changed event failed: {}",
            e.as_database_error().map_or("io", |_| "db")
        ),
    }
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "agent.deleted",
            actor_id: Some(&actor.id),
            actor_handle: Some(&actor.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: json!({ "handle": removed.handle, "revokedPats": removed.revoked_pats }),
        },
    )
    .await;
    StatusCode::NO_CONTENT.into_response()
}

pub fn routes(
    st: AgentDeleteState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AgentDeleteState>>::new()
        .delete("/accounts/agents/{id}", delete_agent)
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
    fn privileges_cover_release() {
        for p in [
            ("attachment", "DELETE"),
            ("event_outbox", "INSERT"),
            ("pat.revoked_at", "UPDATE"),
        ] {
            assert!(AGENT_DELETE_PRIVILEGES.contains(&p), "{p:?}");
        }
    }
}
