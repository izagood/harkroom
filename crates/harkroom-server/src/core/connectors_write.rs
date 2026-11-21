//! S5.4 — API 연결 지우기. TS `routes/connectorRoutes.ts` 의 `DELETE /connectors/:id` 를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireAccount`(401) → 에이전트 403 `forbidden` → 경로 id(400 `invalid_request`) →
//!   없거나 남의 것(admin 이 아니면) 404 `not_found` → 한 트랜잭션에서 그 연결의 `api.call` grant 와 연결을 지운다 →
//!   감사 `connector.deleted {name, removedGrants}` → 지워진 grant 의 계정마다 `grant.changed` → 204.
//! - 비밀 값은 읽지도 건드리지도 않는다(`secret_id` 도 읽지 않는다).
//! - `POST /connectors`·`PATCH /connectors/:id` 는 [`super::connectors_upsert`] 가 맡는다(권한 줄이 따로다).
//! - 권한은 [`CONNECTORS_WRITE_PRIVILEGES`] — 쓰기 풀에 하나라도 없으면 `main.rs` 가 붙이지 않아 TS 에 남는다.
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::lists::is_zod_uuid;
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, emit_event, record_audit};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use sqlx::PgPool;
use std::collections::BTreeSet;
use std::sync::Arc;

/// 쓰기 풀이 쓰는 칸 권한(WHERE·RETURNING 의 SELECT, 줄 DELETE, 감사 INSERT).
pub const CONNECTORS_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("api_connector.id", "SELECT"),
    ("api_connector.name", "SELECT"),
    ("api_connector.owner_account_id", "SELECT"),
    ("api_connector", "DELETE"),
    ("account_grant.capability", "SELECT"),
    ("account_grant.scope", "SELECT"),
    ("account_grant.account_id", "SELECT"),
    ("account_grant", "DELETE"),
    ("audit_log", "INSERT"),
];

#[derive(Clone)]
pub struct ConnectorsWriteState {
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
}

const LOAD_SQL: &str = "select name, owner_account_id::text from api_connector where id = $1::uuid";
/// TS 그대로 — scope 는 `connectorScope(id)` = `connector:<id>`.
const DELETE_GRANTS_SQL: &str = "delete from account_grant where capability = 'api.call' and scope = $1 returning account_id::text";
const DELETE_CONNECTOR_SQL: &str = "delete from api_connector where id = $1::uuid";

/// `DELETE /connectors/{id}`.
pub async fn delete_connector(
    State(st): State<Arc<ConnectorsWriteState>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (parts, _) = req.into_parts();
    if me.kind == "agent" {
        return json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "agents cannot manage API connectors",
        );
    }
    if !is_zod_uuid(&id) {
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    let cur: Option<(String, String)> = match sqlx::query_as(LOAD_SQL)
        .bind(&id)
        .fetch_optional(&st.write)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let name = match cur {
        Some((name, owner)) if owner == me.id || me.is_admin => name,
        _ => return json_err(StatusCode::NOT_FOUND, "not_found", "no such connector"),
    };
    let scope = format!("connector:{id}");
    let r: Result<Vec<String>, sqlx::Error> = async {
        let mut tx = st.write.begin().await?;
        let removed: Vec<String> = sqlx::query_scalar(DELETE_GRANTS_SQL)
            .bind(&scope)
            .fetch_all(&mut *tx)
            .await?;
        sqlx::query(DELETE_CONNECTOR_SQL)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(removed)
    }
    .await;
    let removed = match r {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "connector.deleted",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: json!({ "name": name, "removedGrants": removed.len() }),
        },
    )
    .await;
    // TS 의 `emitEvent` 처럼 커밋 뒤에 낸다 — 실패해도 응답은 바꾸지 않는다.
    let accounts: BTreeSet<&String> = removed.iter().collect();
    if !accounts.is_empty() {
        match st.write.acquire().await {
            Ok(mut conn) => {
                for a in accounts {
                    let ev = json!({ "type": "grant.changed", "accountId": a, "audience": "all" });
                    if let Err(e) = emit_event(&mut conn, &ev).await {
                        eprintln!(
                            "front: connector.deleted event failed: {}",
                            e.as_database_error().map_or("io", |_| "db")
                        );
                    }
                }
            }
            Err(e) => eprintln!(
                "front: connector.deleted event failed: {}",
                e.as_database_error().map_or("io", |_| "db")
            ),
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

pub fn routes(
    st: ConnectorsWriteState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<ConnectorsWriteState>>::new()
        .delete("/connectors/{id}", delete_connector)
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
    fn mirrors_ts_sql_and_never_touches_secrets() {
        for (col, _) in CONNECTORS_WRITE_PRIVILEGES {
            assert!(!col.contains("secret"), "{col}");
        }
        assert!(!LOAD_SQL.contains("secret"));
    }
}
