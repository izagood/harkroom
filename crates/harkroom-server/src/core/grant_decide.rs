//! P4 — 위임 대기 줄(E2) 허락·거절. TS `routes/grantRoutes.ts` 의 `POST /grants/:id/approve`·`POST /grants/:id/decline`
//! (→ `services/apiDelegation.ts` `decideDelegation`)을 옮긴다.
//!
//! - 순서는 TS 그대로: 본문 규칙(fastify — 415·깨진 JSON 400) → 인증(401) → 경로 uuid 아님 400 `invalid_request`
//!   → 사람 아님 403 `forbidden` → 사슬 루트 없음 404 `not_found` → 루트를 준 사람이 아님 403 `not_root`
//!   → 대기 줄 아님 409 `not_pending` → 허락(`suspended_at`·`suspend_reason` 비움)·거절(줄 삭제) → 감사 → 이벤트 → 204.
//! - 쓰기·이벤트(`grant.changed` → 위임 카드마다 `message.updated`)는 **한 tx**(outbox)다. TS 는 감사를 쓰기와 이벤트 사이에
//!   쓰지만 여기서는 커밋 뒤에 쓰고 실패를 삼킨다(TS `recordAudit` 도 실패를 삼킨다) — 감사 행 내용(`ip`·`actor_handle` 없음)은 같다.
//! - 알려진 차이: 경로 zod 실패의 `message` 는 TS 가 zod issue JSON 이다 — 여기서는 `"params: invalid"`.
//! - fail-closed: 쓰기 풀에 [`GRANT_DECIDE_PRIVILEGES`] 가 다 있을 때만 `main.rs` 가 붙인다 — 아니면 TS 에 남는다.
use super::audience::audience_on;
use super::msg_read::{is_uuid, message_by_id};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::write::{AuditEntry, emit_event, record_audit};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀에 있어야 하는 권한(이벤트 outbox 는 `write::missing_in` 이 따로 본다).
pub const GRANT_DECIDE_PRIVILEGES: &[(&str, &str)] = &[
    ("account_grant", "SELECT"),
    ("account_grant", "DELETE"),
    ("account_grant.suspended_at", "UPDATE"),
    ("account_grant.suspend_reason", "UPDATE"),
    ("message", "SELECT"),
    ("message.meta", "UPDATE"),
    ("channel", "SELECT"),
    ("audit_log", "INSERT"),
];

/// TS `PENDING_APPROVAL`.
const PENDING_APPROVAL: &str = "pending_approval";

/// TS `rootOf` — 줄에서 위로 5단까지. 가까운 것부터(`order by d`).
const ROOT_SQL: &str = "with recursive up as (
       select id, parent_grant_id, granted_by, account_id, suspend_reason, 0 as d from account_grant where id = $1::uuid
       union all
       select p.id, p.parent_grant_id, p.granted_by, p.account_id, p.suspend_reason, up.d + 1 from account_grant p join up on p.id = up.parent_grant_id where up.d < 5)
     select parent_grant_id::text, granted_by::text, account_id::text, suspend_reason from up order by d";

const APPROVE_SQL: &str = "update account_grant set suspended_at = null, suspend_reason = null where id = $1::uuid and suspend_reason = $2";
const DECLINE_SQL: &str = "delete from account_grant where id = $1::uuid";
const CARD_SQL: &str = "update message set meta = jsonb_set(jsonb_set(meta, '{delegation,pending}', 'false'::jsonb), '{delegation,decision}', to_jsonb($2::text))
      where meta->'delegation'->>'grantId' = $1 and deleted_at is null returning id::text";

type ChainRow = (Option<String>, String, String, Option<String>);

/// 사슬 판정 — TS `rootOf` + `decideDelegation` 의 앞 세 갈래. `Ok(agent)` 면 지나간다.
fn judge(rows: &[ChainRow], human: &str) -> Result<String, (StatusCode, &'static str)> {
    let (Some(leaf), Some(root)) = (rows.first(), rows.last()) else {
        return Err((StatusCode::NOT_FOUND, "not_found"));
    };
    if root.0.is_some() || leaf.0.is_none() {
        return Err((StatusCode::NOT_FOUND, "not_found"));
    }
    if root.1 != human {
        return Err((StatusCode::FORBIDDEN, "not_root"));
    }
    if leaf.3.as_deref() != Some(PENDING_APPROVAL) {
        return Err((StatusCode::CONFLICT, "not_pending"));
    }
    Ok(leaf.2.clone())
}

enum Outcome {
    Refused(StatusCode, &'static str),
    Done { agent: String },
}

async fn decide(write: &PgPool, grant: &str, human: &str, approve: bool) -> sqlx::Result<Outcome> {
    let mut tx = write.begin().await?;
    let rows: Vec<ChainRow> = sqlx::query_as(ROOT_SQL)
        .bind(grant)
        .fetch_all(&mut *tx)
        .await?;
    let agent = match judge(&rows, human) {
        Ok(a) => a,
        Err((s, c)) => return Ok(Outcome::Refused(s, c)),
    };
    if approve {
        sqlx::query(APPROVE_SQL)
            .bind(grant)
            .bind(PENDING_APPROVAL)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query(DECLINE_SQL)
            .bind(grant)
            .execute(&mut *tx)
            .await?;
    }
    emit_event(
        &mut tx,
        &json!({ "type": "grant.changed", "accountId": agent, "audience": "all" }),
    )
    .await?;
    let cards: Vec<String> = sqlx::query_scalar(CARD_SQL)
        .bind(grant)
        .bind(if approve { "approved" } else { "declined" })
        .fetch_all(&mut *tx)
        .await?;
    for card in cards {
        let Some(row) = message_by_id(&mut *tx, &card).await? else {
            continue;
        };
        let message: Value =
            serde_json::from_str(&row).map_err(|e| sqlx::Error::Decode(e.into()))?;
        if let Some(channel) = message.get("channelId").and_then(Value::as_str) {
            let audience = audience_on(&mut tx, channel).await?.to_json();
            emit_event(
                &mut tx,
                &json!({ "type": "message.updated", "message": message, "audience": audience }),
            )
            .await?;
        }
    }
    tx.commit().await?;
    Ok(Outcome::Done { agent })
}

async fn route(
    write: &PgPool,
    me: &crate::auth::Account,
    id: &str,
    req: Request,
    approve: bool,
) -> Response {
    let (parts, body) = req.into_parts();
    // 본문은 쓰지 않지만 fastify 본문 규칙(415·깨진 JSON 400)은 지난다.
    if let Err(r) = super::ask::read_bytes(&parts.headers, body).await {
        return r;
    }
    if !is_uuid(id) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    if me.kind != "human" {
        return json_err(StatusCode::FORBIDDEN, "forbidden", "only a person decides");
    }
    match decide(write, id, &me.id, approve).await {
        Err(e) => internal(e),
        Ok(Outcome::Refused(s, c)) => json_err(s, c, c),
        Ok(Outcome::Done { agent }) => {
            record_audit(
                write,
                AuditEntry {
                    action: if approve {
                        "grant.delegate.approved"
                    } else {
                        "grant.delegate.declined"
                    },
                    actor_id: Some(&me.id),
                    actor_handle: None,
                    target: Some(&agent),
                    ip: None,
                    detail: json!({ "grantId": id }),
                },
            )
            .await;
            StatusCode::NO_CONTENT.into_response()
        }
    }
}

/// `POST /grants/{id}/approve`.
pub async fn approve_route(
    State(write): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    route(&write, &me, &id, req, true).await
}

/// `POST /grants/{id}/decline`.
pub async fn decline_route(
    State(write): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    route(&write, &me, &id, req, false).await
}

/// 코어 라우터에 합칠 줄(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    write: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .post("/grants/{id}/approve", approve_route)
        .post("/grants/{id}/decline", decline_route)
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
        router: t.router.with_state(Arc::new(write)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(parent: Option<&str>, by: &str, agent: &str, reason: Option<&str>) -> ChainRow {
        (
            parent.map(str::to_string),
            by.to_string(),
            agent.to_string(),
            reason.map(str::to_string),
        )
    }

    #[test]
    fn judge_follows_ts_order() {
        let code = |r: Result<String, (StatusCode, &'static str)>| match r {
            Ok(a) => a,
            Err((_, c)) => c.to_string(),
        };
        // 줄이 없다.
        assert_eq!(code(judge(&[], "h")), "not_found");
        // 사슬이 아닌 줄(부모 없음)은 대기 줄이 아니다 — 404.
        assert_eq!(
            code(judge(&[row(None, "h", "a", Some(PENDING_APPROVAL))], "h")),
            "not_found"
        );
        // 5단에서 끊겨 루트가 사람이 아님.
        assert_eq!(
            code(judge(
                &[
                    row(Some("p"), "x", "a", Some(PENDING_APPROVAL)),
                    row(Some("q"), "h", "x", None)
                ],
                "h"
            )),
            "not_found"
        );
        let chain = [
            row(Some("p"), "x", "a", Some(PENDING_APPROVAL)),
            row(None, "h", "x", None),
        ];
        assert_eq!(code(judge(&chain, "other")), "not_root");
        assert_eq!(code(judge(&chain, "h")), "a");
        let live = [row(Some("p"), "x", "a", None), row(None, "h", "x", None)];
        assert_eq!(code(judge(&live, "h")), "not_pending");
    }
}
