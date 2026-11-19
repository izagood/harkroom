//! S5.4 — `POST /agents/{id}/merge-denials/{denialId}/grant`(TS `mergeDenialRoutes.ts` → `grantFromDenial`). 옛 머지 거절 카드의
//! [7일 주기]: 거절 기록을 **한 번** 써서 그 저장소 `repo.merge` grant 를 7일 준다.
//!
//! - 순서는 TS 그대로: uuid 아님 400 → 사람 세션 아님 403 → 그 에이전트의 소유자 아님 403 → 잠근 거절 기록으로 판정(404·409·400) →
//!   쓰기. 요청 본문은 읽지 않는다(fastify 본문 규칙만 지난다) — scope·기한은 거절 기록과 서버 상수다.
//! - 쓰기(거절 기록 `used_*`, grant upsert, 카드 meta `mergeDenial.granted`)와 이벤트(`grant.changed`, 카드 `message.updated` —
//!   outbox)는 **한 tx** 다. 감사 `grant.given` 은 TS 처럼 커밋 뒤에 따로 쓰고 실패를 삼킨다.
//! - TS 의 `now`(JS `new Date()`)는 DB 시계(ms 로 자름)로 본다.
//! - fail-closed: 쓰기 풀에 [`MERGE_DENIAL_GRANT_PRIVILEGES`] 가 다 있을 때만 붙는다(`main.rs`). 새 운영 GRANT 는 모듈 끝 주석.
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

/// 쓰기 풀에 있어야 하는 권한.
pub const MERGE_DENIAL_GRANT_PRIVILEGES: &[(&str, &str)] = &[
    ("agent_config", "SELECT"),
    ("merge_denial", "SELECT"),
    ("merge_denial.used_at", "UPDATE"),
    ("merge_denial.used_by", "UPDATE"),
    ("account_grant", "SELECT"),
    ("account_grant.account_id", "INSERT"),
    ("account_grant.capability", "INSERT"),
    ("account_grant.scope", "INSERT"),
    ("account_grant.granted_by", "INSERT"),
    ("account_grant.expires_at", "INSERT"),
    ("account_grant.allow_agent_cause", "INSERT"),
    ("account_grant.granted_by", "UPDATE"),
    ("account_grant.granted_at", "UPDATE"),
    ("account_grant.expires_at", "UPDATE"),
    ("account_grant.allow_agent_cause", "UPDATE"),
    ("message", "SELECT"),
    ("message.meta", "UPDATE"),
    ("channel", "SELECT"),
    ("audit_log", "INSERT"),
];

const BAD: &str = "agent id and denial id must be uuids";
const NOT_SESSION: &str = "only a person signed in to the app can grant from a merge card";
const NOT_OWNER: &str = "only the owner of this agent can grant merge permission";
const NOT_FOUND: &str = "no such merge denial for this agent";
const USED: &str = "this denial was already used";
const EXPIRED: &str = "this denial expired";
/// TS `PR_CLOSED_MESSAGE`.
const PR_CLOSED: &str = "that pull request was already merged or closed — this card is closed";
/// TS `HEAD_MOVED_MESSAGE`.
const HEAD_MOVED: &str = "that pull request got a new commit after this card was raised, so this card cannot approve it — approve on the newer card, or if there is none, ask the agent to try the merge again";
/// TS `CI_CARD_ONCE_ONLY_MESSAGE`.
pub(crate) const CI_ONCE: &str =
    "a CI-failure card only approves one merge with the CI check skipped — it never grants 7 days";

const OWNER_SQL: &str =
    "select 1 from agent_config where account_id = $1::uuid and owner_account_id = $2::uuid";

/// DB 시계 — 지금과 7일 뒤(TS `DENIAL_GRANT_TTL_MS`), JS `toISOString()` 꼴.
const NOW_SQL: &str = "with n as (select date_trunc('milliseconds', clock_timestamp()) as t) \
     select to_char(t at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
            to_char((t + interval '7 days') at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') from n";

/// TS `readDenial(client, id, now, true)` — 같은 칸·같은 잠금.
const READ_DENIAL_SQL: &str = "select id::text, agent_id::text, scope, \
       expires_at <= $2::timestamptz, used_at is not null, card_message_id::text, reason::text, \
       obsoleted_at is not null, \
       (obsoleted_at is not null and exists ( \
         select 1 from merge_denial n \
          where n.agent_id = d.agent_id and n.scope = d.scope and n.channel_id = d.channel_id and n.thread_root_id = d.thread_root_id \
            and n.pr_number = d.pr_number and n.head_sha <> d.head_sha and n.created_at > d.created_at)) \
     from merge_denial d where id = $1::uuid for update of d";

const USE_SQL: &str = "update merge_denial set used_at = $2::timestamptz, used_by = $3::uuid \
     where id = $1::uuid and used_at is null returning id::text";

const GRANT_SQL: &str = "insert into account_grant (account_id, capability, scope, granted_by, expires_at, allow_agent_cause) \
       values ($1::uuid, 'repo.merge', $2, $3::uuid, $4::timestamptz, false) \
       on conflict (account_id, capability, scope) do update \
         set granted_by = excluded.granted_by, granted_at = now(), expires_at = excluded.expires_at, allow_agent_cause = false";

const CARD_SQL: &str = "update message set meta = jsonb_set(meta, '{mergeDenial,granted}', $2::jsonb) \
     where id = $1::uuid and meta ? 'mergeDenial'";

type DenialRow = (
    String,
    String,
    String,
    bool,
    bool,
    Option<String>,
    Option<String>,
    bool,
    bool,
);

/// 판정 결과 — 거절이면 (status, code, message).
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Refuse(u16, &'static str, &'static str),
    Go,
}

/// TS `grantFromDenial` 의 판정 순서(잠근 기록을 읽은 뒤, 쓰기 전).
#[allow(clippy::too_many_arguments)]
pub fn judge(
    found: bool,
    same_agent: bool,
    used: bool,
    expired: bool,
    obsolete: bool,
    head_moved: bool,
    reason: Option<&str>,
) -> Verdict {
    if !found || !same_agent {
        return Verdict::Refuse(404, "not_found", NOT_FOUND);
    }
    if used {
        return Verdict::Refuse(409, "denial_used", USED);
    }
    if expired {
        return Verdict::Refuse(409, "denial_expired", EXPIRED);
    }
    if obsolete {
        return if head_moved {
            Verdict::Refuse(409, "head_moved", HEAD_MOVED)
        } else {
            Verdict::Refuse(409, "pr_closed", PR_CLOSED)
        };
    }
    if reason == Some("ci_not_green") {
        return Verdict::Refuse(400, "ci_card_once_only", CI_ONCE);
    }
    Verdict::Go
}

enum Outcome {
    Refused(u16, &'static str, &'static str),
    Granted {
        denial_id: String,
        scope: String,
        expires_at: String,
        card: Option<String>,
    },
}

async fn grant(write: &PgPool, agent: &str, denial: &str, actor: &str) -> sqlx::Result<Outcome> {
    let mut tx = write.begin().await?;
    let (now, expires): (String, String) = sqlx::query_as(NOW_SQL).fetch_one(&mut *tx).await?;
    let d: Option<DenialRow> = sqlx::query_as(READ_DENIAL_SQL)
        .bind(denial)
        .bind(&now)
        .fetch_optional(&mut *tx)
        .await?;
    let v = match &d {
        None => judge(false, false, false, false, false, false, None),
        Some((_, a, _, expired, used, _, reason, obsolete, moved)) => judge(
            true,
            a == agent,
            *used,
            *expired,
            *obsolete,
            *moved,
            reason.as_deref(),
        ),
    };
    // 거절은 쓰기 전이다 — tx 를 떨어뜨리면 rollback.
    if let Verdict::Refuse(s, c, m) = v {
        return Ok(Outcome::Refused(s, c, m));
    }
    let Some((id, agent_id, scope, _, _, card, _, _, _)) = d else {
        return Ok(Outcome::Refused(404, "not_found", NOT_FOUND));
    };
    let used: Option<String> = sqlx::query_scalar(USE_SQL)
        .bind(&id)
        .bind(&now)
        .bind(actor)
        .fetch_optional(&mut *tx)
        .await?;
    if used.is_none() {
        return Ok(Outcome::Refused(409, "denial_used", USED));
    }
    sqlx::query(GRANT_SQL)
        .bind(&agent_id)
        .bind(&scope)
        .bind(actor)
        .bind(&expires)
        .execute(&mut *tx)
        .await?;
    if let Some(card) = &card {
        let granted = json!({ "by": actor, "at": now, "expiresAt": expires });
        sqlx::query(CARD_SQL)
            .bind(card)
            .bind(granted.to_string())
            .execute(&mut *tx)
            .await?;
    }
    // 이벤트 순서는 TS 그대로: grant.changed → 카드 message.updated.
    emit_event(
        &mut tx,
        &json!({ "type": "grant.changed", "accountId": agent_id, "audience": "all" }),
    )
    .await?;
    if let Some(card) = &card
        && let Some(row) = message_by_id(&mut *tx, card).await?
    {
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
    Ok(Outcome::Granted {
        denial_id: id,
        scope,
        expires_at: expires,
        card,
    })
}

/// `POST /agents/{id}/merge-denials/{denialId}/grant`.
pub async fn grant_route(
    State(write): State<Arc<PgPool>>,
    RequireAccount(me, auth): RequireAccount,
    Path((agent, denial)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    // 본문은 쓰지 않지만 fastify 본문 규칙(415·깨진 JSON 400)은 지난다.
    if let Err(r) = super::ask::read_bytes(&parts.headers, body).await {
        return r;
    }
    if !is_uuid(&agent) || !is_uuid(&denial) {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD);
    }
    if !super::decide_routes::human_session(&me, &auth) {
        return json_err(StatusCode::FORBIDDEN, "forbidden", NOT_SESSION);
    }
    let owner: sqlx::Result<Option<i32>> = sqlx::query_scalar(OWNER_SQL)
        .bind(&agent)
        .bind(&me.id)
        .fetch_optional(&*write)
        .await;
    match owner {
        Ok(Some(_)) => {}
        Ok(None) => return json_err(StatusCode::FORBIDDEN, "forbidden", NOT_OWNER),
        Err(e) => return internal(e),
    }
    match grant(&write, &agent, &denial, &me.id).await {
        Err(e) => internal(e),
        Ok(Outcome::Refused(s, c, m)) => json_err(
            StatusCode::from_u16(s).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            c,
            m,
        ),
        Ok(Outcome::Granted {
            denial_id,
            scope,
            expires_at,
            card,
        }) => {
            record_audit(
                &write,
                AuditEntry {
                    action: "grant.given",
                    actor_id: Some(&me.id),
                    actor_handle: None,
                    target: Some(&agent),
                    ip: None,
                    detail: json!({
                        "capability": "repo.merge", "scope": scope, "expiresAt": expires_at,
                        "allowAgentCause": false, "via": "merge_denial", "denialId": denial_id,
                    }),
                },
            )
            .await;
            let repo = scope.strip_prefix("repo:").unwrap_or(&scope);
            (
                StatusCode::OK,
                [(
                    axum::http::header::CONTENT_TYPE,
                    "application/json; charset=utf-8",
                )],
                json!({ "repo": repo, "expiresAt": expires_at, "cardMessageId": card }).to_string(),
            )
                .into_response()
        }
    }
}

/// 코어 라우터에 합칠 줄 — `pr_watch_due.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    write: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .post("/agents/{id}/merge-denials/{denialId}/grant", grant_route)
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

    #[test]
    fn judge_follows_ts_order() {
        let r = |v: Verdict| match v {
            Verdict::Refuse(s, c, _) => (s, c),
            Verdict::Go => (200, "go"),
        };
        assert_eq!(
            r(judge(false, false, false, false, false, false, None)),
            (404, "not_found")
        );
        assert_eq!(
            r(judge(true, false, true, true, true, true, None)),
            (404, "not_found")
        );
        assert_eq!(
            r(judge(true, true, true, true, true, false, None)),
            (409, "denial_used")
        );
        assert_eq!(
            r(judge(true, true, false, true, true, false, None)),
            (409, "denial_expired")
        );
        assert_eq!(
            r(judge(true, true, false, false, true, true, None)),
            (409, "head_moved")
        );
        assert_eq!(
            r(judge(true, true, false, false, true, false, None)),
            (409, "pr_closed")
        );
        assert_eq!(
            r(judge(
                true,
                true,
                false,
                false,
                false,
                false,
                Some("ci_not_green")
            )),
            (400, "ci_card_once_only")
        );
        assert_eq!(
            r(judge(
                true,
                true,
                false,
                false,
                false,
                false,
                Some("not_granted")
            )),
            (200, "go")
        );
    }
}

// 새 운영 GRANT(쓰기 역할): `grant update (used_at, used_by) on merge_denial`, `grant select on merge_denial, agent_config`,
// `grant select, insert (account_id, capability, scope, granted_by, expires_at, allow_agent_cause),
//  update (granted_by, granted_at, expires_at, allow_agent_cause) on account_grant` — 이미 있는 것은 그대로다.
