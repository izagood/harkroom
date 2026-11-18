//! S5.4 결정 5 — 자동화 지우기. TS `routes/automationRoutes.ts` 의 `DELETE /automations/:id`(`deleteAutomation` →
//! `endAutomationMandates(automation_off)`)를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireAccount`(401) → 에이전트 403 `agents_cannot_automate` → 경로 id(400 `invalid_request`) →
//!   내 것이 아니거나 지운 것은 404 → 204.
//! - 지우기는 soft(`deleted_at`) — 행·감사·줄 흔적이 남는다. 지웠으면 그 자동화의 살아 있는 위임장을 하나씩 끝내고(위임마다 한 tx)
//!   권한 카드를 갱신한다([`super::perm_card::end_mandate`]). TS 처럼 위임 잡기는 `for update` 없이 풀에서 읽는다.
//! - 권한은 [`AUTOMATION_DELETE_PRIVILEGES`] + [`super::perm_card::PERM_CARD_PRIVILEGES`] — 쓰기 풀에 하나라도 없으면
//!   `main.rs` 가 붙이지 않아 TS 에 남는다.
use super::perm_card::end_mandate;
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use sqlx::PgPool;
use std::sync::Arc;

/// 이 줄이 자기 몫으로 쓰는 칸 권한(WHERE·RETURNING 의 SELECT, SET 의 UPDATE). 위임 끝내기·카드 몫은 `PERM_CARD_PRIVILEGES`.
pub const AUTOMATION_DELETE_PRIVILEGES: &[(&str, &str)] = &[
    ("automation.id", "SELECT"),
    ("automation.owner_id", "SELECT"),
    ("automation.deleted_at", "SELECT"),
    ("automation.deleted_at", "UPDATE"),
    ("automation.enabled", "UPDATE"),
    ("automation.next_at", "UPDATE"),
    ("mandate.automation_id", "SELECT"),
];

/// TS `deleteAutomation` 그대로.
const DELETE_SQL: &str = "update automation set deleted_at = now(), enabled = false, next_at = null \
     where id = $1::uuid and owner_id = $2::uuid and deleted_at is null returning id::text";

/// TS `endAutomationMandates` 의 잡기(풀 — `for update` 없음).
const LIVE_MANDATES_SQL: &str =
    "select id::text from mandate where automation_id = $1::uuid and ended_at is null";

/// TS `endAutomationMandates(pool, id, 'automation_off')`. 끝낸 개수.
pub async fn end_automation_mandates(
    pool: &PgPool,
    automation_id: &str,
    reason: &str,
) -> Result<usize, sqlx::Error> {
    let ids: Vec<String> = sqlx::query_scalar(LIVE_MANDATES_SQL)
        .bind(automation_id)
        .fetch_all(pool)
        .await?;
    let mut n = 0;
    for id in &ids {
        if end_mandate(pool, id, reason).await? {
            n += 1;
        }
    }
    Ok(n)
}

/// `DELETE /automations/:id`.
pub async fn delete_automation(
    State(write): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
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
    let gone = match sqlx::query_scalar::<_, String>(DELETE_SQL)
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(write.as_ref())
        .await
    {
        Ok(r) => r.is_some(),
        Err(e) => return internal(e),
    };
    if !gone {
        return json_err(StatusCode::NOT_FOUND, "not_found", "automation not found");
    }
    // ⑤b(security 3·5): 지우면 위임장을 끝내고 줄을 닫는다. TS 처럼 실패는 500(지우기는 이미 커밋됐다).
    if let Err(e) = end_automation_mandates(write.as_ref(), &id, "automation_off").await {
        return internal(e);
    }
    StatusCode::NO_CONTENT.into_response()
}

pub fn routes(
    write: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .delete("/automations/{id}", delete_automation)
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
    fn delete_sql_is_ts_shape() {
        assert!(DELETE_SQL.contains("deleted_at = now(), enabled = false, next_at = null"));
        assert!(!LIVE_MANDATES_SQL.contains("for update"));
    }
}
