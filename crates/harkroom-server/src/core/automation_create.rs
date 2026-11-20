//! S5.4 AT5 — 자동화 만들기(`POST /automations`). TS `routes/automationRoutes.ts` 의 같은 줄과 `createAutomation` 을 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireAccount`(401) → 본문 해석(fastify 400·415) → 에이전트 403 `agents_cannot_automate` →
//!   zod → `gateFor`(채널 없음 404 `channel_not_found` · 안 보임 403 `forbidden` · 보관 403 `channel_archived`) →
//!   INSERT → 201 `{automation}`.
//! - zod 판정은 Rust 가 끝낸다([`parse_rest`] 가 `None` 이면 400 `invalid_request` — 문구만 TS 와 다르다). TS 로 넘기는
//!   갈래는 없다. zod 를 지난 트리거의 다음 회차를 못 세는 일은 없어야 하므로 그때는 500 `internal` 과 서버 로그다.
//! - 비밀 칸은 문장에 없다(`returning` 은 `COLS` 칸만). 권한은 [`AUTOMATION_CREATE_PRIVILEGES`] — 없으면 TS 에 남는다.
use crate::auth::{RequireAccount, Via};
use crate::core::automation_approve::{broken, invalid_body};
use crate::core::mcp::automation_propose::parse_rest;
use crate::directory::{internal, json_err};
use crate::write::Body;
use axum::body::to_bytes;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀이 쓰는 칸 권한(INSERT 칸, `returning`·회차 join 의 SELECT).
pub const AUTOMATION_CREATE_PRIVILEGES: &[(&str, &str)] = &[
    ("automation.owner_id", "INSERT"),
    ("automation.channel_id", "INSERT"),
    ("automation.name", "INSERT"),
    ("automation.body", "INSERT"),
    ("automation.trigger", "INSERT"),
    ("automation.next_at", "INSERT"),
    ("automation.debounce_sec", "INSERT"),
    ("automation.mandate_session_at", "INSERT"),
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
    ("automation_run.id", "SELECT"),
    ("automation_run.automation_id", "SELECT"),
    ("automation_run.status", "SELECT"),
    ("automation_run.trigger_kind", "SELECT"),
    ("automation_run.created_at", "SELECT"),
    ("automation_run.message_id", "SELECT"),
    ("automation_run.error", "SELECT"),
];

const BODY_LIMIT: usize = 1024 * 1024;

pub struct CreateState {
    pub read: PgPool,
    pub write: PgPool,
}

/// `POST /automations`.
pub async fn create(
    State(st): State<Arc<CreateState>>,
    RequireAccount(me, auth): RequireAccount,
    req: Request,
) -> Response {
    let (parts, raw) = req.into_parts();
    let Ok(bytes) = to_bytes(raw, BODY_LIMIT).await else {
        return json_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "fst_err_ctp_body_too_large",
            "Request body is too large",
        );
    };
    let body = match crate::write::fastify_body(&parts.headers, &bytes) {
        Ok(b) => b,
        Err(r) => return r,
    };
    if me.kind == "agent" {
        return json_err(
            StatusCode::FORBIDDEN,
            "agents_cannot_automate",
            "agents cannot create or change automations",
        );
    }
    let parsed = match &body {
        Body::Json(v) => parse_rest(v),
        _ => None,
    };
    let Some(a) = parsed else {
        return invalid_body();
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok());
    let Some(next_at) = now_ms
        .and_then(|n| crate::core::automation_approve::initial_next_at(&a.trigger.to_string(), n))
    else {
        return broken("create: parsed trigger is not a readable schedule");
    };
    // TS `gateFor`.
    let exists: Option<i32> = match sqlx::query_scalar("select 1 from channel where id = $1::uuid")
        .bind(&a.channel)
        .fetch_optional(&st.read)
        .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if exists.is_none() {
        return json_err(
            StatusCode::NOT_FOUND,
            "channel_not_found",
            "channel not found",
        );
    }
    let gate: Option<(bool, bool)> = match sqlx::query_as(crate::core::msg_post::gate_sql())
        .bind(&a.channel)
        .bind(&me.id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if let Some((visible, archived)) = gate {
        if !visible {
            return json_err(
                StatusCode::FORBIDDEN,
                "forbidden",
                "not a member of this channel",
            );
        }
        if archived {
            return json_err(
                StatusCode::FORBIDDEN,
                "channel_archived",
                "archived channels are read-only",
            );
        }
    }
    let by_session = me.kind == "human" && auth.via == Some(Via::Session);
    match sqlx::query_scalar::<_, String>(super::automations_read::CREATE_SQL)
        .bind(&me.id)
        .bind(&a.channel)
        .bind(&a.name)
        .bind(&a.body)
        .bind(a.trigger.to_string())
        .bind(next_at)
        .bind(a.debounce)
        .bind(by_session)
        .fetch_one(&st.write)
        .await
    {
        Ok(view) => (
            StatusCode::CREATED,
            [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
            format!("{{\"automation\":{view}}}"),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

pub fn routes(
    st: CreateState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<CreateState>>::new()
        .post("/automations", create)
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
        let q = super::super::automations_read::CREATE_SQL;
        assert!(
            !q.contains("ingress_token")
                && !q.contains("ingress_secret")
                && !q.contains("returning *")
        );
        assert!(
            AUTOMATION_CREATE_PRIVILEGES
                .iter()
                .all(|(c, _)| !c.contains("ingress_token") && !c.contains("ingress_secret"))
        );
    }

    #[test]
    fn rest_parse_ignores_for_handle() {
        let v = serde_json::json!({
            "name": " n ", "channelId": "0b9f6c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f", "body": "b",
            "trigger": { "kind": "webhook" }, "forHandle": 5,
        });
        let a = parse_rest(&v).expect("parses");
        assert_eq!(a.name, "n");
        assert!(parse_rest(&serde_json::json!([])).is_none());
        // zod `.nullable().optional()` — null 은 없음과 같다. 소수·범위 밖은 거절.
        let with = |d: serde_json::Value| {
            let mut v = v.clone();
            v["debounceSec"] = d;
            parse_rest(&v).map(|a| a.debounce)
        };
        assert_eq!(with(serde_json::Value::Null), Some(None));
        assert_eq!(with(serde_json::json!(30.0)), Some(Some(30)));
        assert_eq!(with(serde_json::json!(1.5)), None);
        assert_eq!(with(serde_json::json!(3601)), None);
    }
}
