//! S5.4 AT1 — 자동화 REST 의 읽기 두 줄. TS `routes/automationRoutes.ts` 의 `GET /automations`·`GET /automations/:id` 를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireAccount`(401) → 경로 id(400 `invalid_request`) → 내 것이 아니거나 지운 것은 404.
//!   읽기는 에이전트도 막지 않는다(TS 도 만들기·고치기만 막는다).
//! - **비밀은 고르지 않는다.** `ingress_token_hash`·`ingress_secret_enc`(서명 비밀 봉투)는 문장에 없다 — 답 칸은 TS `COLS`·
//!   `LAST_RUN_JOIN`·`RUN_COLS` 그대로다. 수신이 켜졌는지는 `ingressEnabledAt` 시각만 싣는다.
//! - **읽기만 한다.** 읽기 풀만 쓰므로 새 GRANT 가 없다.
//! - `DELETE /automations/:id` 는 [`super::automation_delete`] 가 맡는다(위임장 끝내기·카드 `message.updated` 는
//!   [`super::perm_card`]).
//! - 만들기·고치기·승인·돌리기·수신(봉투·서명)은 TS 에 남긴다.
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use sqlx::PgPool;
use std::sync::Arc;

/// 시각은 JS `Date#toJSON` 꼴(밀리초·Z).
macro_rules! iso {
    ($c:literal) => {
        concat!(
            "to_char(",
            $c,
            " at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        )
    };
}

/// TS `COLS` + `toView` 의 `lastRun` 그대로. 한 줄을 json 으로 만든다(별칭 `a` = automation, `lr` = 마지막 회차).
macro_rules! view_json {
    () => {
        concat!(
            "json_build_object(",
            "'id', a.id, 'ownerId', a.owner_id, 'channelId', a.channel_id, 'name', a.name, 'body', a.body, ",
            "'trigger', a.trigger, 'enabled', a.enabled, 'nextAt', ",
            iso!("a.next_at"),
            ", 'pausedReason', a.paused_reason, 'consecutiveFailures', a.consecutive_failures, ",
            "'ingressEnabledAt', ",
            iso!("a.ingress_enabled_at"),
            ", 'debounceSec', a.debounce_sec, 'proposedBy', a.proposed_by, 'approvedAt', ",
            iso!("a.approved_at"),
            ", 'createdAt', ",
            iso!("a.created_at"),
            ", 'updatedAt', ",
            iso!("a.updated_at"),
            ", 'lastRun', case when lr.id is not null and lr.status is not null and lr.created_at is not null then ",
            "json_build_object('id', lr.id, 'status', lr.status, 'triggerKind', coalesce(lr.trigger_kind, 'manual'), ",
            "'createdAt', ",
            iso!("lr.created_at"),
            ", 'messageId', lr.message_id, 'error', lr.error) end)"
        )
    };
}

/// TS `LAST_RUN_JOIN` 그대로 — 가장 최근 회차 한 건.
macro_rules! last_run_join {
    () => {
        concat!(
            "left join lateral (select id, status, trigger_kind, created_at, message_id, error ",
            "from automation_run where automation_id = a.id order by created_at desc limit 1) lr on true "
        )
    };
}

/// TS `listAutomations`.
const LIST_SQL: &str = concat!(
    "select coalesce(json_agg(",
    view_json!(),
    " order by a.created_at), '[]')::text from automation a ",
    last_run_join!(),
    "where a.owner_id = $1::uuid and a.deleted_at is null"
);

/// TS `getAutomation`.
const GET_SQL: &str = concat!(
    "select ",
    view_json!(),
    "::text from automation a ",
    last_run_join!(),
    "where a.id = $1::uuid and a.owner_id = $2::uuid and a.deleted_at is null"
);

/// TS `approveAutomation` 의 `writeReturningView` — `returning *` 대신 `COLS` 칸만 돌려받는다(수신 비밀 칸은 고르지 않는다).
/// $1 id · $2 소유자 · $3 다음 회차(timestamptz 또는 null) · $4 사람 세션으로 승인했나.
pub(crate) const APPROVE_SQL: &str = concat!(
    "with w as (update automation set approved_at = now(), enabled = true, next_at = $3::timestamptz, updated_at = now(), ",
    "mandate_session_at = case when $4 then now() else null end ",
    "where id = $1::uuid and owner_id = $2::uuid and approved_at is null and deleted_at is null ",
    "returning id, owner_id, channel_id, name, body, trigger, enabled, next_at, paused_reason, consecutive_failures, ",
    "ingress_enabled_at, debounce_sec, proposed_by, approved_at, created_at, updated_at) select ",
    view_json!(),
    "::text from w a ",
    last_run_join!()
);

/// TS `listRuns(pool, id)` — `RUN_COLS`, 최근 50.
const RUNS_SQL: &str = concat!(
    "select coalesce(json_agg(json_build_object(",
    "'id', r.id, 'automationId', r.automation_id, 'eventKey', r.event_key, 'triggerKind', r.trigger_kind, ",
    "'status', r.status, 'messageId', r.message_id, 'error', r.error, 'createdAt', ",
    iso!("r.created_at"),
    ", 'finishedAt', ",
    iso!("r.finished_at"),
    ", 'initiatedBy', r.initiated_by, 'causeMessageId', r.cause_message_id",
    ") order by r.created_at desc), '[]')::text from (",
    "select * from automation_run where automation_id = $1::uuid order by created_at desc limit 50) r"
);

/// `GET /automations`.
pub async fn list_automations(
    State(read): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
) -> Response {
    match sqlx::query_scalar::<_, String>(LIST_SQL)
        .bind(&me.id)
        .fetch_one(read.as_ref())
        .await
    {
        Ok(rows) => json_ok(format!("{{\"automations\":{rows}}}")),
        Err(e) => internal(e),
    }
}

/// `GET /automations/:id` — 내 것만. `{ automation, runs }`.
pub async fn get_automation(
    State(read): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if !crate::lists::is_zod_uuid(&id) {
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    let view = match sqlx::query_scalar::<_, String>(GET_SQL)
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(read.as_ref())
        .await
    {
        Ok(Some(v)) => v,
        Ok(None) => {
            return json_err(StatusCode::NOT_FOUND, "not_found", "automation not found");
        }
        Err(e) => return internal(e),
    };
    match sqlx::query_scalar::<_, String>(RUNS_SQL)
        .bind(&id)
        .fetch_one(read.as_ref())
        .await
    {
        Ok(runs) => json_ok(format!("{{\"automation\":{view},\"runs\":{runs}}}")),
        Err(e) => internal(e),
    }
}

pub fn routes(
    pool: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .get("/automations", list_automations)
        .get("/automations/{id}", get_automation)
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
        router: t.router.with_state(Arc::new(pool)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_never_selects_ingress_secrets() {
        for q in [LIST_SQL, GET_SQL, RUNS_SQL, APPROVE_SQL] {
            assert!(!q.contains("ingress_token"), "{q}");
            assert!(!q.contains("secret"), "{q}");
            assert!(!q.contains("a.*"), "{q}");
        }
    }
}
