//! S5.4 AT2 — 자동화 쓰기 한 줄. TS `routes/automationRoutes.ts` 의 `DELETE /automations/:id/ingress`(`revokeIngress`)를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireAccount`(401) → 에이전트 403 `agents_cannot_automate` → 경로 id(400 `invalid_request`) →
//!   내 것이 아니거나 지운 것은 404 → 204.
//! - 수신 비밀(`ingress_token_hash`·`ingress_secret_enc`)은 **null 로 지우기만** 하고 읽지 않는다(SELECT 권한도 받지 않는다).
//! - 권한은 [`AUTOMATIONS_WRITE_PRIVILEGES`] — 쓰기 풀에 하나라도 없으면 `main.rs` 가 붙이지 않아 TS 에 남는다.
//! - 지우기(`DELETE /automations/:id`)는 TS 에 남는다 — 위임장 끝내기·카드 `message.updated` 가 따라온다(`automations_read.rs`).
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀이 쓰는 칸 권한(WHERE·RETURNING 의 SELECT, SET 의 UPDATE).
pub const AUTOMATIONS_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("automation.id", "SELECT"),
    ("automation.owner_id", "SELECT"),
    ("automation.deleted_at", "SELECT"),
    ("automation.ingress_enabled_at", "UPDATE"),
    ("automation.ingress_token_hash", "UPDATE"),
    ("automation.ingress_secret_enc", "UPDATE"),
    ("automation.updated_at", "UPDATE"),
];

/// TS `revokeIngress` 그대로.
const REVOKE_INGRESS_SQL: &str = "update automation set ingress_enabled_at = null, ingress_token_hash = null, ingress_secret_enc = null, updated_at = now() \
     where id = $1::uuid and owner_id = $2::uuid and deleted_at is null returning id::text";

/// `DELETE /automations/:id/ingress`.
pub async fn revoke_ingress(
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
    match sqlx::query_scalar::<_, String>(REVOKE_INGRESS_SQL)
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(write.as_ref())
        .await
    {
        Ok(Some(_)) => StatusCode::NO_CONTENT.into_response(),
        Ok(None) => json_err(StatusCode::NOT_FOUND, "not_found", "automation not found"),
        Err(e) => internal(e),
    }
}

pub fn routes(
    write: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .delete("/automations/{id}/ingress", revoke_ingress)
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
    fn sql_only_clears_secrets_and_privileges_cover_it() {
        assert!(!REVOKE_INGRESS_SQL.contains("returning ingress"));
        assert!(!REVOKE_INGRESS_SQL.contains("returning *"));
        for (col, p) in AUTOMATIONS_WRITE_PRIVILEGES {
            if col.contains("ingress_token") || col.contains("ingress_secret") {
                assert_eq!(*p, "UPDATE", "{col} must never be SELECTed");
            }
        }
    }
}
