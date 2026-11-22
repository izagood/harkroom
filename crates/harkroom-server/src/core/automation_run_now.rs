//! S5.4 AT3 — 자동화 「지금 한 번」(`POST /automations/:id/run`). TS `routes/automationRoutes.ts` 의 같은 줄과
//! `services/automations.ts::runAutomationNow` → `enqueueRun`(수동 회차: 꺼진 것도 돌리고 디바운스로 모으지 않는다)을 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireAccount`(401) → 본문 해석(fastify 400·415) → 에이전트 403 `agents_cannot_automate` →
//!   경로 id(400 `invalid_request`) → 내 것이 아니거나 지운 것은 404 → 회차 → 202 `{run}`.
//!   `duplicate`·`inactive` 는 409 `{code: status, message: 'not queued'}`.
//! - 1시간 회차가 `RATE_LIMIT_PER_HOUR` 에 닿으면 TS `enqueueRun` 처럼 자동화를 멈추고(`paused_reason = 'rate_limited'`)
//!   위임장을 `automation_off` 로 끝낸 뒤 429 `rate_limited` — sweeper 와 같은 [`RATE_LIMIT_SQL`]·[`end_automation_mandates_tx`]
//!   를 한 트랜잭션으로 쓴다(TS 는 풀에서 문장마다 커밋한다 — 결과는 같다). 권한은 [`AUTOMATION_RUN_NOW_PAUSE_PRIVILEGES`].
//! - TS 로 넘기는 갈래는 없다. 저장된 일정 트리거의 tz 를 못 읽거나 넣은 회차 줄을 못 읽으면 500 `internal` 과 서버 로그다.
//! - 비밀 칸(`ingress_token_hash`·`ingress_secret_enc`)은 문장에 없다. 소유 확인은 읽기 풀, 회차 셈·INSERT 는 쓰기 풀.
//! - 권한은 [`AUTOMATION_RUN_NOW_PRIVILEGES`] — MCP `automation.run` 이 이미 받는 칸의 부분집합이다(새 GRANT 없음).
use super::automation_approve::broken;
use crate::auth::RequireAccount;
use crate::core::mcp::automation_run as ar;
use crate::directory::{internal, json_err};
use crate::loops::automation::{RATE_LIMIT_SQL, end_automation_mandates_tx};
use axum::body::to_bytes;
use axum::extract::{Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀이 쓰는 칸 권한(enqueueRun 의 행 읽기·1시간 셈·INSERT·`returning`).
pub const AUTOMATION_RUN_NOW_PRIVILEGES: &[(&str, &str)] = &[
    ("automation.id", "SELECT"),
    ("automation.enabled", "SELECT"),
    ("automation.debounce_sec", "SELECT"),
    ("automation.deleted_at", "SELECT"),
    ("automation_run.id", "SELECT"),
    ("automation_run.automation_id", "SELECT"),
    ("automation_run.event_key", "SELECT"),
    ("automation_run.trigger_kind", "SELECT"),
    ("automation_run.status", "SELECT"),
    ("automation_run.message_id", "SELECT"),
    ("automation_run.error", "SELECT"),
    ("automation_run.created_at", "SELECT"),
    ("automation_run.finished_at", "SELECT"),
    ("automation_run.initiated_by", "SELECT"),
    ("automation_run.cause_message_id", "SELECT"),
    ("automation_run.automation_id", "INSERT"),
    ("automation_run.event_key", "INSERT"),
    ("automation_run.trigger_kind", "INSERT"),
    ("automation_run.payload", "INSERT"),
    ("automation_run.not_before", "INSERT"),
    ("automation_run.initiated_by", "INSERT"),
    ("automation_run.cause_message_id", "INSERT"),
];

/// 시간당 상한에 닿았을 때의 일시정지·위임장 끝내기 칸(sweeper `AUTOMATION_SWEEP_PRIVILEGES` 의 같은 칸).
pub const AUTOMATION_RUN_NOW_PAUSE_PRIVILEGES: &[(&str, &str)] = &[
    ("automation.enabled", "UPDATE"),
    ("automation.next_at", "UPDATE"),
    ("automation.paused_reason", "UPDATE"),
    ("automation.updated_at", "UPDATE"),
    ("mandate.id", "SELECT"),
    ("mandate.automation_id", "SELECT"),
    ("mandate.ended_at", "SELECT"),
    ("mandate.ended_at", "UPDATE"),
    ("mandate.end_reason", "UPDATE"),
    ("mandate_line.mandate_id", "SELECT"),
    ("mandate_line.revoked_at", "SELECT"),
    ("mandate_line.revoked_at", "UPDATE"),
];

/// TS `getAutomation` 중 여기서 쓰는 칸(소유자·지워지지 않음).
const OWNED_SQL: &str = "select a.id::text, a.trigger::text from automation a \
     where a.id = $1::uuid and a.owner_id = $2::uuid and a.deleted_at is null";

const BODY_LIMIT: usize = 1024 * 1024;

pub struct RunNowState {
    pub read: PgPool,
    pub write: PgPool,
}

enum Out {
    Queued(String),
    Refused(&'static str),
    RateLimited,
    Broken,
}

/// TS `enqueueRun`(사람 「지금 한 번」 — `initiated_by`·원인·연쇄 깊이는 null). 트랜잭션이 없는 것도 TS 와 같다.
async fn enqueue(
    write: &PgPool,
    id: &str,
    event_key: &str,
    payload: &Value,
) -> Result<Out, sqlx::Error> {
    let row: Option<(bool, Option<i32>)> = sqlx::query_as(ar::ENQUEUE_ROW_SQL)
        .bind(id)
        .fetch_optional(write)
        .await?;
    if row.is_none() {
        return Ok(Out::Refused("inactive"));
    }
    let recent: i32 = sqlx::query_scalar(ar::RECENT_SQL)
        .bind(id)
        .fetch_one(write)
        .await?;
    if recent >= ar::RATE_LIMIT_PER_HOUR {
        let mut tx = write.begin().await?;
        sqlx::query(RATE_LIMIT_SQL)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        end_automation_mandates_tx(&mut tx, id, "automation_off").await?;
        tx.commit().await?;
        return Ok(Out::RateLimited);
    }
    let ins = sqlx::query(ar::INSERT_SQL)
        .bind(id)
        .bind(event_key)
        .bind(payload.to_string())
        .bind(None::<String>)
        .bind(None::<String>)
        .bind(None::<i32>)
        .fetch_optional(write)
        .await?;
    let Some(ins) = ins else {
        return Ok(Out::Refused("duplicate"));
    };
    Ok(ar::run_view(&ins).map_or(Out::Broken, Out::Queued))
}

/// `POST /automations/:id/run`.
pub async fn run_now(
    State(st): State<Arc<RunNowState>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (parts, raw) = req.into_parts();
    let bytes = match to_bytes(raw, BODY_LIMIT).await {
        Ok(b) => b,
        Err(_) => {
            return json_err(
                StatusCode::PAYLOAD_TOO_LARGE,
                "fst_err_ctp_body_too_large",
                "Request body is too large",
            );
        }
    };
    if let Err(r) = crate::write::fastify_body(&parts.headers, &bytes) {
        return r;
    }
    if me.kind == "agent" {
        return json_err(
            StatusCode::FORBIDDEN,
            "agents_cannot_automate",
            "agents cannot create or change automations",
        );
    }
    if !crate::lists::is_zod_uuid(&id) {
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    let owned: Option<(String, String)> = match sqlx::query_as(OWNED_SQL)
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some((aid, trigger)) = owned else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "automation not found");
    };
    let Some(vars) = ar::vars_for(&trigger) else {
        // 저장된 트리거는 zod 를 지난 값이다 — 아직 아무것도 쓰지 않았다.
        return broken("run-now: stored trigger has no readable time zone");
    };
    // TS `manual:${randomUUID()}` — v4 를 DB 에서 받는다(크레이트에 uuid 가 없다).
    let event_key: String = match sqlx::query_scalar("select 'manual:' || gen_random_uuid()::text")
        .fetch_one(&st.read)
        .await
    {
        Ok(k) => k,
        Err(e) => return internal(e),
    };
    let payload = serde_json::json!({
        "vars": vars,
        "events": [{ "key": event_key, "summary": event_key }],
    });
    match enqueue(&st.write, &aid, &event_key, &payload).await {
        Ok(Out::Queued(run)) => (
            StatusCode::ACCEPTED,
            [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
            format!("{{\"run\":{run}}}"),
        )
            .into_response(),
        Ok(Out::Refused(code)) => json_err(StatusCode::CONFLICT, code, "not queued"),
        Ok(Out::RateLimited) => json_err(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many runs in the last hour; automation paused",
        ),
        // 회차는 이미 들어갔다 — 넘기면 TS 가 한 번 더 넣는다.
        Ok(Out::Broken) => broken("run-now: inserted run row is unreadable"),
        Err(e) => internal(e),
    }
}

pub fn routes(
    st: RunNowState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<RunNowState>>::new()
        .post("/automations/{id}/run", run_now)
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
    fn never_touches_ingress_secrets() {
        for q in [
            OWNED_SQL,
            ar::ENQUEUE_ROW_SQL,
            ar::RECENT_SQL,
            ar::INSERT_SQL,
        ] {
            assert!(!q.contains("ingress_"), "{q}");
            assert!(!q.contains("returning *"), "{q}");
        }
        assert!(
            AUTOMATION_RUN_NOW_PRIVILEGES
                .iter()
                .all(|p| !p.0.contains("ingress_") && p.1 != "UPDATE")
        );
    }

    #[test]
    fn pause_privileges_are_subset_of_sweeper() {
        for p in AUTOMATION_RUN_NOW_PAUSE_PRIVILEGES {
            assert!(
                crate::loops::automation::AUTOMATION_SWEEP_PRIVILEGES.contains(p),
                "{p:?}"
            );
        }
    }

    #[test]
    fn privileges_are_subset_of_mcp_run() {
        for p in AUTOMATION_RUN_NOW_PRIVILEGES {
            assert!(ar::AUTOMATION_RUN_PRIVILEGES.contains(p), "{p:?}");
        }
    }
}
