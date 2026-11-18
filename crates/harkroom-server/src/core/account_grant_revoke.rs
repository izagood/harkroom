//! S5.4 — grant 거두기. TS `routes/grantRoutes.ts` 의 `DELETE /accounts/:id/grants/:capability` 를 옮긴다.
//!
//! - 순서는 TS 와 같다: `requireAccount`(401) → 경로 zod(400) → `repo.merge`·`repo.read`·`api.call`·`tool.allow` 는
//!   그 에이전트의 소유자나 admin(아니면 403 `소유자나 admin 만 거둔다`), 나머지는 admin(403 `grant 는 admin 만 거둔다`)
//!   → repo 능력은 scope 를 `repoGrantScope` 로 맞춘다(못 맞추면 원문) → 한 트랜잭션에서 줄 삭제(없으면 404) +
//!   `revokeLinesForGrant`(tool·merge 만) → 감사 `grant.revoked {capability, scope}` → `grant.changed` → 204.
//! - 알려진 차이: repo scope 가 인쇄 가능한 ASCII 가 아니면 정규화하지 않고 원문으로 지운다(TS 는 유니코드 trim·소문자 뒤
//!   다시 맞춰 본다 — 저장된 repo scope 는 모두 ASCII 라 결과가 갈리는 것은 404 문구가 아니라 지울 줄이 없는 경우뿐이다).
//! - 쓰기 권한은 [`ACCOUNT_GRANT_REVOKE_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use crate::auth::RequireAccount;
use crate::core::mcp::grant_writes::{REVOKE_LINES_FOR_GRANT_SQL, repo_grant_scope};
use crate::core::mcp::reads4::parse_tool_scope;
use crate::directory::{internal, json_err};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, emit_event, record_audit};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;

/// `grant select (account_id, owner_account_id) on agent_config`,
/// `grant select (account_id, capability, scope), delete on account_grant`,
/// `grant select (revoked_at, cap, scope, agent_ids, request_id), update (revoked_at) on mandate_line`,
/// `grant select (id, agent_id, channel_id) on permission_request`,
/// `grant insert (action, actor_id, actor_handle, target, ip, detail) on audit_log` (+ 이벤트 outbox).
pub const ACCOUNT_GRANT_REVOKE_PRIVILEGES: &[(&str, &str)] = &[
    ("agent_config.account_id", "SELECT"),
    ("agent_config.owner_account_id", "SELECT"),
    ("account_grant.account_id", "SELECT"),
    ("account_grant.capability", "SELECT"),
    ("account_grant.scope", "SELECT"),
    ("account_grant", "DELETE"),
    ("mandate_line.revoked_at", "SELECT"),
    ("mandate_line.cap", "SELECT"),
    ("mandate_line.scope", "SELECT"),
    ("mandate_line.agent_ids", "SELECT"),
    ("mandate_line.request_id", "SELECT"),
    ("mandate_line.revoked_at", "UPDATE"),
    ("permission_request.id", "SELECT"),
    ("permission_request.agent_id", "SELECT"),
    ("permission_request.channel_id", "SELECT"),
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.actor_handle", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.ip", "INSERT"),
    ("audit_log.detail", "INSERT"),
];

pub struct AccountGrantRevokeState {
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
}

fn plain_ascii(s: &str) -> bool {
    s.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

/// TS `repoGrantScope(scope.replace(/^repo:/i, '')) ?? scope`.
fn normalize_repo_scope(scope: &str) -> String {
    if !plain_ascii(scope) {
        return scope.to_string();
    }
    let rest = if scope.len() >= 5 && scope[..5].eq_ignore_ascii_case("repo:") {
        &scope[5..]
    } else {
        scope
    };
    repo_grant_scope(rest).unwrap_or_else(|| scope.to_string())
}

/// TS `revokeLinesForGrant` 의 (cap, lineScope, channelId) — None 이면 줄을 건드리지 않는다.
fn line_target(capability: &str, scope: &str) -> Option<(&'static str, String, Option<String>)> {
    match capability {
        "tool.allow" => {
            let (ch, rule) = parse_tool_scope(scope)?;
            let line_scope = match harkroom_proto::tool_rules::validate_tool_rule(rule) {
                harkroom_proto::tool_rules::ToolRuleVerdict::Ok { rule, .. } => rule,
                harkroom_proto::tool_rules::ToolRuleVerdict::Refused(_) => rule.to_string(),
            };
            Some(("tool", line_scope, Some(ch.to_string())))
        }
        "repo.merge" => {
            // merge `validateScope`: trim·소문자 뒤 `repo:` 로 시작하면 `repoGrantScope`, 못 맞추면 원문.
            let v = if plain_ascii(scope) {
                let raw = scope.trim_matches(' ').to_ascii_lowercase();
                raw.strip_prefix("repo:").and_then(repo_grant_scope)
            } else {
                None
            };
            Some(("merge", v.unwrap_or_else(|| scope.to_string()), None))
        }
        _ => None,
    }
}

fn owner_caps(cap: &str) -> bool {
    matches!(cap, "repo.merge" | "repo.read" | "api.call" | "tool.allow")
}

/// `DELETE /accounts/{id}/grants/{capability}`.
pub async fn revoke(
    State(st): State<Arc<AccountGrantRevokeState>>,
    RequireAccount(me, _): RequireAccount,
    Path((id, cap)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (parts, _) = req.into_parts();
    if !crate::lists::is_zod_uuid(&id) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    let mut scope = url::form_urlencoded::parse(parts.uri.query().unwrap_or("").as_bytes())
        .find(|(k, _)| k == "scope")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    if owner_caps(&cap) {
        if cap == "repo.merge" || cap == "repo.read" {
            scope = normalize_repo_scope(&scope);
        }
        let owns = match sqlx::query_scalar::<_, i32>(
            "select 1 from agent_config where account_id = $1::uuid and owner_account_id = $2::uuid",
        )
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(&st.write)
        .await
        {
            Ok(v) => v.is_some(),
            Err(e) => return internal(e),
        };
        if !owns && !me.is_admin {
            return json_err(
                StatusCode::FORBIDDEN,
                "forbidden",
                "소유자나 admin 만 거둔다",
            );
        }
    } else if !me.is_admin {
        return json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "grant 는 admin 만 거둔다",
        );
    }
    let r = async {
        let mut tx = st.write.begin().await?;
        let n = sqlx::query(
            "delete from account_grant where account_id = $1::uuid and capability = $2 and scope = $3",
        )
        .bind(&id)
        .bind(&cap)
        .bind(&scope)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if n == 0 {
            tx.rollback().await?;
            return Ok::<bool, sqlx::Error>(false);
        }
        if let Some((lc, ls, ch)) = line_target(&cap, &scope) {
            sqlx::query(REVOKE_LINES_FOR_GRANT_SQL)
                .bind(&id)
                .bind(lc)
                .bind(&ls)
                .bind(ch.as_deref())
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(true)
    }
    .await;
    match r {
        Ok(true) => {}
        Ok(false) => return json_err(StatusCode::NOT_FOUND, "not_found", "그런 grant 가 없다"),
        Err(e) => return internal(e),
    }
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "grant.revoked",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: json!({ "capability": cap, "scope": scope }),
        },
    )
    .await;
    let ev = json!({ "type": "grant.changed", "accountId": id, "audience": "all" });
    match st.write.acquire().await {
        Ok(mut conn) => {
            if let Err(e) = emit_event(&mut conn, &ev).await {
                eprintln!(
                    "front: grant.revoked event failed: {}",
                    e.as_database_error().map_or("io", |_| "db")
                );
            }
        }
        Err(e) => eprintln!(
            "front: grant.revoked event failed: {}",
            e.as_database_error().map_or("io", |_| "db")
        ),
    }
    StatusCode::NO_CONTENT.into_response()
}

pub fn routes(
    st: AccountGrantRevokeState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AccountGrantRevokeState>>::new()
        .delete("/accounts/{id}/grants/{capability}", revoke)
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
    fn repo_scope_normalizes_like_ts() {
        assert_eq!(
            normalize_repo_scope("Repo:Izagood/Harkroom"),
            "repo:izagood/harkroom"
        );
        assert_eq!(normalize_repo_scope("izagood/*"), "repo:izagood/*");
        assert_eq!(normalize_repo_scope("bad scope"), "bad scope");
        assert_eq!(normalize_repo_scope(""), "");
    }

    #[test]
    fn line_targets() {
        assert_eq!(line_target("repo.read", "repo:a/b"), None);
        assert_eq!(
            line_target("repo.merge", "repo:a/b").map(|x| x.1),
            Some("repo:a/b".to_string())
        );
        assert_eq!(line_target("tool.allow", "tool:not-a-uuid:Bash(ls)"), None);
        let ch = "0123abcd-0000-4000-8000-000000000000";
        let t = line_target("tool.allow", &format!("tool:{ch}:Bash(ls)")).unwrap();
        assert_eq!((t.0, t.2.as_deref()), ("tool", Some(ch)));
    }
}
