//! S5.4 MD2 — 위임장 줄 하나 빼기(`DELETE /mandates/:id/lines/:lineId`). TS `routes/mandateRoutes.ts` 의 같은 줄과
//! `services/mandateLines.ts::revokeMandateLine` 을 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: 본문(fastify 파서) → `requireAccount`(401) → 경로 id 둘이 uuid 가 아니면 404 → `ownMandate`(사람
//!   세션·내 위임장이 아니면 404 `no such mandate`) → 저장된 줄 회수(UPDATE) → 이미 뺀 줄이면 409 `already_revoked`.
//! - 줄이 아예 없으면 상시 줄(409 `standing_line`)인지 없는 줄(404)인지는 TS `listMandateLines` 가 가른다 — 아직 아무것도 쓰지
//!   않았으므로 그 판정은 TS 로 넘긴다.
//! - 뺐으면 감사 `mandate.line.revoked` → 그 요청 카드에 `lineRevokedAt` 을 적고 `message.updated` → `{ok, lineId, revokedAt}`.
//! - 권한은 [`MANDATE_LINE_REVOKE_PRIVILEGES`] + [`super::perm_card::PERM_CARD_PRIVILEGES`] — 없으면 TS 에 남는다.
use super::ask_sync::announce_updated;
use crate::auth::{Auth, Via};
use crate::directory::{internal, json_err, json_ok};
use crate::lists::is_zod_uuid;
use crate::proxy::Upstream;
use crate::write::{AuditEntry, record_audit};
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::json;
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::Arc;

/// 이 줄이 자기 몫으로 쓰는 칸 권한. 카드 `message.updated` 몫은 `PERM_CARD_PRIVILEGES`.
pub const MANDATE_LINE_REVOKE_PRIVILEGES: &[(&str, &str)] = &[
    ("mandate.id", "SELECT"),
    ("mandate.owner_account_id", "SELECT"),
    ("mandate_line.id", "SELECT"),
    ("mandate_line.mandate_id", "SELECT"),
    ("mandate_line.cap", "SELECT"),
    ("mandate_line.scope", "SELECT"),
    ("mandate_line.via", "SELECT"),
    ("mandate_line.request_id", "SELECT"),
    ("mandate_line.revoked_at", "SELECT"),
    ("mandate_line.revoked_at", "UPDATE"),
    ("permission_request.id", "SELECT"),
    ("permission_request.card_message_id", "SELECT"),
    ("audit_log", "INSERT"),
];

const OWN_SQL: &str = "select 1 from mandate where id = $1::uuid and owner_account_id = $2::uuid";

/// TS `revokeMandateLine` 의 UPDATE — 회수 시각은 `toISOString()` 꼴로 DB 에서 만든다.
const REVOKE_SQL: &str = "update mandate_line set revoked_at = now() \
     where id = $1::uuid and mandate_id = $2::uuid and revoked_at is null \
     returning id::text, cap, scope, via, request_id::text, \
     to_char(revoked_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";

const HAD_SQL: &str = "select 1 from mandate_line where id = $1::uuid and mandate_id = $2::uuid";

/// TS 의 카드 표시 — 그 요청의 카드에 `lineRevokedAt`.
const CARD_SQL: &str = "update message m set meta = jsonb_set(m.meta, '{permissionRequest}', (m.meta->'permissionRequest') || $2::jsonb) \
     from permission_request r \
     where r.id = $1::uuid and m.id = r.card_message_id and m.meta ? 'permissionRequest' \
     returning m.id::text";

pub struct MandateLineRevokeState {
    pub write: PgPool,
    pub up: Upstream,
}

fn not_found() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such mandate")
}

type Revoked = (String, String, String, String, Option<String>, String);

/// `DELETE /mandates/{id}/lines/{lineId}`.
pub async fn delete_line(
    State(st): State<Arc<MandateLineRevokeState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((id, line_id)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, 1024 * 1024).await else {
        return json_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "fst_err_ctp_body_too_large",
            "Request body is too large",
        );
    };
    if let Err(r) = crate::write::fastify_body(&parts.headers, &bytes) {
        return r;
    }
    let auth = parts.extensions.get::<Auth>().cloned().unwrap_or_default();
    let Some(me) = auth.account.clone() else {
        return json_err(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "authentication required",
        );
    };
    if !is_zod_uuid(&id) || !is_zod_uuid(&line_id) {
        return not_found();
    }
    if me.kind != "human" || auth.via != Some(Via::Session) {
        return not_found();
    }
    let own: Option<i32> = match sqlx::query_scalar(OWN_SQL)
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(&st.write)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    if own.is_none() {
        return not_found();
    }
    let row: Option<Revoked> = match sqlx::query_as(REVOKE_SQL)
        .bind(&line_id)
        .bind(&id)
        .fetch_optional(&st.write)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some((lid, cap, scope, via, request_id, at)) = row else {
        let had: Option<i32> = match sqlx::query_scalar(HAD_SQL)
            .bind(&line_id)
            .bind(&id)
            .fetch_optional(&st.write)
            .await
        {
            Ok(r) => r,
            Err(e) => return internal(e),
        };
        if had.is_some() {
            return json_err(
                StatusCode::CONFLICT,
                "already_revoked",
                "line already removed",
            );
        }
        // 상시 줄인지 없는 줄인지 — TS `listMandateLines` 판정(아직 쓴 것 없음).
        let req = Request::from_parts(parts, axum::body::Body::from(bytes));
        return crate::proxy::forward(State(st.up.clone()), ConnectInfo(peer), req).await;
    };
    record_audit(
        &st.write,
        AuditEntry {
            action: "mandate.line.revoked",
            actor_id: Some(&me.id),
            actor_handle: None,
            target: Some(&id),
            ip: None,
            detail: json!({
                "mandateId": id, "lineId": lid, "cap": cap, "scope": scope, "via": via,
                "requestId": request_id,
            }),
        },
    )
    .await;
    if let Some(rid) = &request_id
        && let Err(e) = mark_cards(&st.write, rid, &at).await
    {
        return internal(e);
    }
    json_ok(json!({ "ok": true, "lineId": lid, "revokedAt": at }).to_string())
}

async fn mark_cards(pool: &PgPool, request_id: &str, at: &str) -> Result<(), sqlx::Error> {
    let mut conn = pool.acquire().await?;
    let cards: Vec<String> = sqlx::query_scalar(CARD_SQL)
        .bind(request_id)
        .bind(json!({ "lineRevokedAt": at }).to_string())
        .fetch_all(&mut *conn)
        .await?;
    for c in cards {
        announce_updated(&mut conn, &c).await?;
    }
    Ok(())
}

pub fn routes(
    st: MandateLineRevokeState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<MandateLineRevokeState>>::new()
        .delete("/mandates/{id}/lines/{lineId}", delete_line)
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
