//! S5.4 결정 5 — 소유자의 [위임 끝]. TS `routes/mandateRoutes.ts` 의 `POST /mandates/:id/end`(`endMandate(owner)`)를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: 본문(fastify 파서 — 415·400) → `requireAccount`(401) → 경로 id(아니면 404) →
//!   `ownMandate`(사람 세션이 아니거나 내 위임이 아니면 404 `no such mandate` — 남의 위임이 있는지도 말하지 않는다) →
//!   끝내기([`super::perm_card::end_mandate`] — 한 tx 에서 위임·줄, 커밋 뒤 카드 갱신) → 끝냈으면 감사 `mandate.ended` →
//!   위임을 다시 읽어 `{ ended, endedAt, endReason }`. 이미 끝났으면 그대로 200(`ended: false`, 멱등).
//! - 권한은 [`MANDATE_END_PRIVILEGES`] + [`super::perm_card::PERM_CARD_PRIVILEGES`] — 쓰기 풀에 하나라도 없으면
//!   `main.rs` 가 붙이지 않아 TS 에 남는다.
use super::perm_card::end_mandate;
use crate::auth::{Auth, Via};
use crate::directory::{internal, json_err, json_ok};
use crate::lists::is_zod_uuid;
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, read_body, record_audit};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;

/// 이 줄이 자기 몫으로 쓰는 칸 권한(소유 확인·다시 읽기의 SELECT, 감사 INSERT). 끝내기·카드 몫은 `PERM_CARD_PRIVILEGES`.
pub const MANDATE_END_PRIVILEGES: &[(&str, &str)] = &[
    ("mandate.id", "SELECT"),
    ("mandate.owner_account_id", "SELECT"),
    ("mandate.ended_at", "SELECT"),
    ("mandate.end_reason", "SELECT"),
    ("audit_log", "INSERT"),
];

/// TS `ownMandate` 그대로.
const OWN_SQL: &str = "select 1 from mandate where id = $1::uuid and owner_account_id = $2::uuid";

/// TS 의 끝난 뒤 다시 읽기. `endedAt` 은 `toISOString()` 꼴로 DB 에서 만든다.
const READ_SQL: &str = "select to_char(ended_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
       end_reason from mandate where id = $1::uuid";

#[derive(Clone)]
pub struct MandateEndState {
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
}

fn not_found() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such mandate")
}

/// `POST /mandates/{id}/end`.
pub async fn post_mandate_end(
    State(st): State<Arc<MandateEndState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    // 본문은 읽지 않지만 fastify 처럼 파서는 탄다(415·빈 JSON 400 은 인증보다 먼저).
    if let Err(r) = read_body(&parts.headers, body).await {
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
    if !is_zod_uuid(&id) {
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
    let ended = match end_mandate(&st.write, &id, "owner").await {
        Ok(b) => b,
        Err(e) => return internal(e),
    };
    if ended {
        let ip = crate::writes_settings::ip_of(&parts, &st.trust);
        record_audit(
            &st.write,
            AuditEntry {
                action: "mandate.ended",
                actor_id: Some(&me.id),
                actor_handle: Some(&me.handle),
                target: Some(&id),
                ip: ip.as_deref(),
                detail: json!({ "reason": "owner" }),
            },
        )
        .await;
    }
    let row: Option<(Option<String>, Option<String>)> = match sqlx::query_as(READ_SQL)
        .bind(&id)
        .fetch_optional(&st.write)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let (ended_at, end_reason) = row.unwrap_or((None, None));
    json_ok(json!({ "ended": ended, "endedAt": ended_at, "endReason": end_reason }).to_string())
}

pub fn routes(
    st: MandateEndState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<MandateEndState>>::new()
        .post("/mandates/{id}/end", post_mandate_end)
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
    fn sql_is_ts_shape() {
        assert!(OWN_SQL.contains("owner_account_id = $2::uuid"));
        assert!(READ_SQL.contains("MS\"Z\""));
        assert!(READ_SQL.contains("end_reason"));
    }

    #[test]
    fn privileges_cover_reads_and_audit() {
        for need in [
            ("mandate.owner_account_id", "SELECT"),
            ("mandate.end_reason", "SELECT"),
            ("audit_log", "INSERT"),
        ] {
            assert!(MANDATE_END_PRIVILEGES.contains(&need), "{need:?}");
        }
        // 자동화 표는 건드리지 않는다(비밀 칸 포함 — 표 단위 SELECT 없음).
        assert!(
            MANDATE_END_PRIVILEGES
                .iter()
                .all(|(c, _)| !c.starts_with("automation"))
        );
    }
}
