//! S5.4 AT4 — 에이전트 제안 승인(`POST /automations/:id/approve`). TS `routes/automationRoutes.ts` 의 같은 줄과
//! `services/automations.ts::approveAutomation` 을 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireAccount`(401) → 에이전트 403 `agents_cannot_automate` → 경로 id(400 `invalid_request`) →
//!   내 것이 아니거나 지웠거나 이미 승인한 것은 404 `not_found`('no pending proposal with this id') → UPDATE(0줄이면 404) →
//!   200 `{automation}`.
//! - 다음 회차는 TS `initialNextAt` — 일정 트리거면 `nextOccurrence(trigger, now)`, 아니면 null. 일정 꼴을 Rust 가 못 읽으면
//!   (`Schedule::parse` 실패 — 모르는 tz 등) TS 로 넘긴다(아직 아무것도 쓰지 않았다).
//! - `mandate_session_at` 은 사람 세션으로 승인했을 때만 now()(⑤b).
//! - 비밀 칸(`ingress_token_hash`·`ingress_secret_enc`)은 문장에 없다(`returning` 은 `COLS` 칸만).
//! - 권한은 [`AUTOMATION_APPROVE_PRIVILEGES`] — 없으면 `main.rs` 가 붙이지 않아 TS 에 남는다.
use crate::auth::{RequireAccount, Via};
use crate::core::automation_time as at;
use crate::directory::{internal, json_err, json_ok};
use crate::proxy::Upstream;
use axum::body::to_bytes;
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::Value;
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::Arc;

/// 쓰기 풀이 쓰는 칸 권한(WHERE·`returning`·마지막 회차 join 의 SELECT, SET 의 UPDATE).
pub const AUTOMATION_APPROVE_PRIVILEGES: &[(&str, &str)] = &[
    ("automation.id", "SELECT"),
    ("automation.owner_id", "SELECT"),
    ("automation.channel_id", "SELECT"),
    ("automation.name", "SELECT"),
    ("automation.body", "SELECT"),
    ("automation.trigger", "SELECT"),
    ("automation.enabled", "SELECT"),
    ("automation.next_at", "SELECT"),
    ("automation.paused_reason", "SELECT"),
    ("automation.consecutive_failures", "SELECT"),
    ("automation.ingress_enabled_at", "SELECT"),
    ("automation.debounce_sec", "SELECT"),
    ("automation.proposed_by", "SELECT"),
    ("automation.approved_at", "SELECT"),
    ("automation.created_at", "SELECT"),
    ("automation.updated_at", "SELECT"),
    ("automation.deleted_at", "SELECT"),
    ("automation.approved_at", "UPDATE"),
    ("automation.enabled", "UPDATE"),
    ("automation.next_at", "UPDATE"),
    ("automation.updated_at", "UPDATE"),
    ("automation.mandate_session_at", "UPDATE"),
    ("automation_run.id", "SELECT"),
    ("automation_run.automation_id", "SELECT"),
    ("automation_run.status", "SELECT"),
    ("automation_run.trigger_kind", "SELECT"),
    ("automation_run.created_at", "SELECT"),
    ("automation_run.message_id", "SELECT"),
    ("automation_run.error", "SELECT"),
];

/// TS `getAutomation` 중 여기서 쓰는 칸(소유자·지워지지 않음) — 승인 여부와 트리거.
const PENDING_SQL: &str = "select (a.approved_at is not null), a.trigger::text from automation a \
     where a.id = $1::uuid and a.owner_id = $2::uuid and a.deleted_at is null";

pub struct ApproveState {
    pub read: PgPool,
    pub write: PgPool,
    pub up: Upstream,
}

fn no_pending() -> Response {
    json_err(
        StatusCode::NOT_FOUND,
        "not_found",
        "no pending proposal with this id",
    )
}

/// TS `initialNextAt` — `Some(None)` 는 null, `None` 은 Rust 가 못 읽는 일정(TS 로).
fn initial_next_at(trigger: &str, now_ms: i64) -> Option<Option<String>> {
    let t: Value = serde_json::from_str(trigger).ok()?;
    if t.get("kind").and_then(Value::as_str) != Some("schedule") {
        return Some(None);
    }
    let s = at::Schedule::parse(&t)?;
    Some(at::next_occurrence(&s, now_ms).and_then(at::iso))
}

/// `POST /automations/:id/approve`.
pub async fn approve(
    State(st): State<Arc<ApproveState>>,
    RequireAccount(me, auth): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    // fastify 는 본문을 핸들러 전에 푼다 — 깨진 JSON 은 400·415.
    let (parts, raw) = req.into_parts();
    let Ok(bytes) = to_bytes(raw, 1024 * 1024).await else {
        return json_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "fst_err_ctp_body_too_large",
            "Request body is too large",
        );
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
    let cur: Option<(bool, String)> = match sqlx::query_as(PENDING_SQL)
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some((false, trigger)) = cur else {
        return no_pending();
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok());
    let Some(next_at) = now_ms.and_then(|n| initial_next_at(&trigger, n)) else {
        let req = Request::from_parts(parts, axum::body::Body::from(bytes));
        return crate::proxy::forward(State(st.up.clone()), ConnectInfo(peer), req).await;
    };
    let by_session = me.kind == "human" && auth.via == Some(Via::Session);
    match sqlx::query_scalar::<_, String>(super::automations_read::APPROVE_SQL)
        .bind(&id)
        .bind(&me.id)
        .bind(next_at)
        .bind(by_session)
        .fetch_optional(&st.write)
        .await
    {
        Ok(Some(view)) => json_ok(format!("{{\"automation\":{view}}}")),
        Ok(None) => no_pending(),
        Err(e) => internal(e),
    }
}

pub fn routes(
    st: ApproveState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<ApproveState>>::new()
        .post("/automations/{id}/approve", approve)
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
    fn never_selects_ingress_secrets() {
        for q in [PENDING_SQL, super::super::automations_read::APPROVE_SQL] {
            assert!(!q.contains("ingress_token"), "{q}");
            assert!(!q.contains("ingress_secret"), "{q}");
            assert!(!q.contains("returning *"), "{q}");
        }
        assert!(
            AUTOMATION_APPROVE_PRIVILEGES
                .iter()
                .all(|(c, _)| !c.contains("ingress_token") && !c.contains("ingress_secret"))
        );
    }

    #[test]
    fn initial_next_at_matches_ts_shape() {
        assert_eq!(initial_next_at(r#"{"kind":"webhook"}"#, 0), Some(None));
        // 2026-01-01T00:00:00Z → 매일 09:00 UTC 다음 회차.
        let t = r#"{"kind":"schedule","freq":"daily","time":"09:00","tz":"UTC"}"#;
        assert_eq!(
            initial_next_at(t, 1_767_225_600_000),
            Some(Some("2026-01-01T09:00:00.000Z".to_owned()))
        );
        assert_eq!(
            initial_next_at(
                r#"{"kind":"schedule","freq":"daily","time":"09:00","tz":"Nope/X"}"#,
                0
            ),
            None
        );
    }
}
