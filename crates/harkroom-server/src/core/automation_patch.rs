//! S5.4 AT6 — 자동화 고치기(`PATCH /automations/:id`). TS `routes/automationRoutes.ts` 의 같은 줄과
//! `services/automations.ts::updateAutomation` 을 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireAccount`(401) → 본문 해석(fastify 400·415) → 에이전트 403 `agents_cannot_automate` →
//!   경로 id(400 `invalid_request`) → zod(`.strict()`) → `gateFor`(채널을 바꿀 때) → 켜기인데 승인 전이면 409 `not_approved` →
//!   내 것이 아니거나 지운 것은 404 → UPDATE → 200 `{automation}`.
//! - zod 판정은 Rust 가 끝낸다(`parse_patch` 가 `None` 이면 400 `invalid_request`). TS 로 넘기는 갈래는 없다. 다음 회차를
//!   못 세면(저장된 트리거가 깨졌을 때뿐) 500 `internal` 과 서버 로그다.
//! - 시간 트리거로 바뀌면 수신 칸을 **null 로 지우기만** 한다(같은 tx 의 따로 문장 — 읽지 않으므로 SELECT 권한이 없다).
//! - 본문·트리거·채널이 바뀌면 `mandate_session_at` 을 다시 찍고 위임장을 `automation_changed` 로 끝낸다. 끄기면 `automation_off`.
//!   트리거 비교는 TS 처럼 `JSON.stringify` 글자 비교 — 새 값은 zod 키 순서, 옛 값은 jsonb 키 순서.
//! - 권한은 [`AUTOMATION_PATCH_PRIVILEGES`] + [`super::perm_card::PERM_CARD_PRIVILEGES`] — 없으면 TS 에 남는다.
use super::automation_approve::{broken, invalid_body};
use super::automation_delete::end_automation_mandates;
use super::mcp::automation_propose::{
    jsonb_order, parse_patch, stringify_ordered, zod_trigger_order,
};
use crate::auth::{RequireAccount, Via};
use crate::directory::{internal, json_err};
use crate::write::Body;
use axum::body::to_bytes;
use axum::extract::{Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀이 쓰는 칸 권한(WHERE·`returning`·회차 join 의 SELECT, SET 의 UPDATE). 위임 끝내기·카드 몫은 `PERM_CARD_PRIVILEGES`.
pub const AUTOMATION_PATCH_PRIVILEGES: &[(&str, &str)] = &[
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
    ("automation.name", "UPDATE"),
    ("automation.body", "UPDATE"),
    ("automation.channel_id", "UPDATE"),
    ("automation.trigger", "UPDATE"),
    ("automation.enabled", "UPDATE"),
    ("automation.next_at", "UPDATE"),
    ("automation.paused_reason", "UPDATE"),
    ("automation.consecutive_failures", "UPDATE"),
    ("automation.debounce_sec", "UPDATE"),
    ("automation.updated_at", "UPDATE"),
    ("automation.mandate_session_at", "UPDATE"),
    ("automation.ingress_enabled_at", "UPDATE"),
    ("automation.ingress_token_hash", "UPDATE"),
    ("automation.ingress_secret_enc", "UPDATE"),
    ("automation_run.id", "SELECT"),
    ("automation_run.automation_id", "SELECT"),
    ("automation_run.status", "SELECT"),
    ("automation_run.trigger_kind", "SELECT"),
    ("automation_run.created_at", "SELECT"),
    ("automation_run.message_id", "SELECT"),
    ("automation_run.error", "SELECT"),
    ("mandate.automation_id", "SELECT"),
];

/// TS `getAutomation` 중 여기서 쓰는 칸.
const CUR_SQL: &str = "select a.body, a.channel_id::text, a.trigger::text, a.enabled, (a.approved_at is not null) \
     from automation a where a.id = $1::uuid and a.owner_id = $2::uuid and a.deleted_at is null";

/// 시간 트리거로 바뀌면 수신을 닫는다(065) — 지우기만 한다.
pub(crate) const CLEAR_INGRESS_SQL: &str = "update automation set ingress_enabled_at = null, ingress_token_hash = null, ingress_secret_enc = null \
     where id = $1::uuid and owner_id = $2::uuid and deleted_at is null";

const SESSION_SQL: &str = "update automation set mandate_session_at = case when $2 then now() else null end where id = $1::uuid";

const BODY_LIMIT: usize = 1024 * 1024;

pub struct PatchState {
    pub read: PgPool,
    pub write: PgPool,
}

/// TS `JSON.stringify(patch.trigger) !== JSON.stringify(cur.trigger)`.
fn trigger_changed(new: &Value, cur_text: &str) -> bool {
    let Ok(cur) = serde_json::from_str::<Value>(cur_text) else {
        return true;
    };
    stringify_ordered(new, &zod_trigger_order) != stringify_ordered(&cur, &jsonb_order)
}

/// `PATCH /automations/:id`.
pub async fn patch(
    State(st): State<Arc<PatchState>>,
    RequireAccount(me, auth): RequireAccount,
    Path(id): Path<String>,
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
    if !crate::lists::is_zod_uuid(&id) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    let parsed = match &body {
        Body::Json(v) => parse_patch(v),
        _ => None,
    };
    let Some(p) = parsed else {
        return invalid_body();
    };
    if let Some(ch) = &p.channel {
        let exists: Option<i32> =
            match sqlx::query_scalar("select 1 from channel where id = $1::uuid")
                .bind(ch)
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
            .bind(ch)
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
    }
    let cur: Option<(String, String, String, bool, bool)> = match sqlx::query_as(CUR_SQL)
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(&st.write)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some((cur_body, cur_channel, cur_trigger, cur_enabled, approved)) = cur else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "automation not found");
    };
    if p.enabled == Some(true) && !approved {
        return json_err(
            StatusCode::CONFLICT,
            "not_approved",
            "approve the proposal first",
        );
    }
    let trigger_text = match &p.trigger {
        Some(t) => stringify_ordered(t, &zod_trigger_order),
        None => cur_trigger.clone(),
    };
    let enabled = p.enabled.unwrap_or(cur_enabled);
    let reschedule = p.trigger.is_some() || (p.enabled == Some(true) && !cur_enabled);
    let next_at = if reschedule {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|d| i64::try_from(d.as_millis()).ok());
        match now_ms
            .and_then(|n| crate::core::automation_approve::initial_next_at(&trigger_text, n))
        {
            Some(v) => v,
            // 새 트리거는 zod 를, 옛 트리거는 저장될 때 zod 를 지났다 — 아직 아무것도 쓰지 않았다.
            None => return broken("patch: trigger is not a readable schedule"),
        }
    } else {
        None
    };
    let to_schedule = serde_json::from_str::<Value>(&trigger_text)
        .ok()
        .and_then(|t| {
            t.get("kind")
                .and_then(Value::as_str)
                .map(|k| k == "schedule")
        })
        .unwrap_or(false);
    let mut tx = match st.write.begin().await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    if to_schedule
        && let Err(e) = sqlx::query(CLEAR_INGRESS_SQL)
            .bind(&id)
            .bind(&me.id)
            .execute(&mut *tx)
            .await
    {
        return internal(e);
    }
    let view: Option<String> = match sqlx::query_scalar(super::automations_read::PATCH_SQL)
        .bind(&id)
        .bind(&me.id)
        .bind(&p.name)
        .bind(&p.body)
        .bind(&p.channel)
        .bind(&trigger_text)
        .bind(enabled)
        .bind(reschedule)
        .bind(next_at)
        .bind(p.enabled == Some(true))
        .bind(p.debounce.is_some())
        .bind(p.debounce.flatten())
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if let Err(e) = tx.commit().await {
        return internal(e);
    }
    let Some(view) = view else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "automation not found");
    };
    let changed = p.body.as_ref().is_some_and(|b| *b != cur_body)
        || p.channel.as_ref().is_some_and(|c| *c != cur_channel)
        || p.trigger
            .as_ref()
            .is_some_and(|t| trigger_changed(t, &cur_trigger));
    let by_session = me.kind == "human" && auth.via == Some(Via::Session);
    if changed {
        if let Err(e) = sqlx::query(SESSION_SQL)
            .bind(&id)
            .bind(by_session)
            .execute(&st.write)
            .await
        {
            return internal(e);
        }
        if let Err(e) = end_automation_mandates(&st.write, &id, "automation_changed").await {
            return internal(e);
        }
    } else if p.enabled == Some(false)
        && cur_enabled
        && let Err(e) = end_automation_mandates(&st.write, &id, "automation_off").await
    {
        return internal(e);
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        format!("{{\"automation\":{view}}}"),
    )
        .into_response()
}

pub fn routes(
    st: PatchState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PatchState>>::new()
        .patch("/automations/{id}", patch)
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
    use serde_json::json;

    #[test]
    fn never_selects_ingress_secrets() {
        let q = super::super::automations_read::PATCH_SQL;
        assert!(!q.contains("ingress_token") && !q.contains("ingress_secret"));
        assert!(!CLEAR_INGRESS_SQL.contains("returning"));
        for (c, p) in AUTOMATION_PATCH_PRIVILEGES {
            if c.contains("ingress_token") || c.contains("ingress_secret") {
                assert_eq!(*p, "UPDATE");
            }
        }
    }

    #[test]
    fn patch_is_strict_and_nullable_debounce() {
        assert!(parse_patch(&json!({"nope": 1})).is_none());
        assert!(parse_patch(&json!({"name": null})).is_none());
        let p = parse_patch(&json!({"debounceSec": null, "enabled": true})).unwrap();
        assert_eq!(p.debounce, Some(None));
        assert_eq!(p.enabled, Some(true));
        assert_eq!(parse_patch(&json!({})).unwrap().debounce, None);
    }

    #[test]
    fn trigger_compare_follows_js_stringify_key_order() {
        // 같은 webhook — 키 하나라 순서가 같다.
        assert!(!trigger_changed(
            &json!({"kind": "webhook"}),
            r#"{"kind": "webhook"}"#
        ));
        // jsonb 는 짧은 키 먼저(tz·freq·kind·time) — zod 순서(kind·freq·time·tz)와 글자가 다르다(TS 도 바뀐 것으로 본다).
        let t = json!({"kind": "schedule", "freq": "daily", "time": "09:00", "tz": "UTC"});
        assert!(trigger_changed(
            &t,
            r#"{"tz": "UTC", "freq": "daily", "kind": "schedule", "time": "09:00"}"#
        ));
    }
}
