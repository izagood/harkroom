//! S5.4 — 계정 권한 목록 읽기 한 줄. TS `routes/grantRoutes.ts` 의 `GET /accounts/:id/grants` 를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireAccount`(401) → 경로(zod uuid, 400) → 자기 자신·admin 이 아니면 **그 에이전트의
//!   소유자**인가(`agent_config.owner_account_id`) — 아니면 403 `forbidden`.
//! - 질의는 TS `listGrants` 와 같은 칸·같은 순서(`capability, scope`)다. 시각은 JS `Date#toJSON` 꼴.
//! - **읽기만 한다.** 읽기 풀만 쓰고 새 GRANT 가 없다. 필요한 SELECT 는 [`ACCOUNT_GRANTS_READ_PRIVILEGES`] — 없으면
//!   `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다. 권한 주기(`PUT`)는 TS 에 남긴다.
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use sqlx::PgPool;
use std::sync::Arc;

/// 읽기 풀에 있어야 하는 권한.
pub const ACCOUNT_GRANTS_READ_PRIVILEGES: &[(&str, &str)] =
    &[("agent_config", "SELECT"), ("account_grant", "SELECT")];

macro_rules! iso {
    ($c:literal) => {
        concat!(
            "to_char(",
            $c,
            " at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        )
    };
}

/// TS `listGrants` 와 같은 칸 — 키 순서도 같다(`json_build_object` 는 넣은 순서를 지킨다).
pub(crate) const GRANTS_SQL: &str = concat!(
    "select coalesce(json_agg(json_build_object(",
    "'accountId', account_id, 'capability', capability, 'scope', scope, 'grantedBy', granted_by, ",
    "'grantedAt', ",
    iso!("granted_at"),
    ", 'expiresAt', ",
    iso!("expires_at"),
    ", 'allowAgentCause', allow_agent_cause, 'id', id, 'parentGrantId', parent_grant_id, ",
    "'delegateDepth', delegate_depth, 'limits', limits, 'suspendedAt', ",
    iso!("suspended_at"),
    ", 'suspendReason', suspend_reason, 'writeNeedsHumanCause', write_needs_human_cause",
    ") order by capability, scope), '[]')::text ",
    "from account_grant where account_id = $1::uuid"
);

pub async fn list_grants(
    State(pool): State<Arc<PgPool>>,
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
    if id != me.id && !me.is_admin {
        let owns = sqlx::query_scalar::<_, i32>(
            "select 1 from agent_config where account_id = $1::uuid and owner_account_id = $2::uuid",
        )
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(&*pool)
        .await;
        match owns {
            Ok(Some(_)) => {}
            Ok(None) => {
                return json_err(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    "남의 권한은 admin 과 그 에이전트의 소유자만 본다",
                );
            }
            Err(e) => return internal(e),
        }
    }
    match sqlx::query_scalar::<_, String>(GRANTS_SQL)
        .bind(&id)
        .fetch_one(&*pool)
        .await
    {
        Ok(rows) => json_ok(format!("{{\"grants\":{rows}}}")),
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
        .get("/accounts/{id}/grants", list_grants)
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
