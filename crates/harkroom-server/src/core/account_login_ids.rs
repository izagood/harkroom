//! S5.4 — 사람들의 로그인 ID 읽기 한 줄. TS `routes/passwordResetRoutes.ts` 의 `GET /accounts/login-ids` 를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireCap('member.reset_password')`(401·403) → 사람·세션만(403 `session_required`).
//! - 보이는 대상은 재설정 코드 발급 대상과 같은 선(사람·살아 있음·꺼지지 않음, owner 제외, 부른 사람이 admin 이면 admin 도
//!   제외, 자기 자신 제외) — 질의는 TS 와 같다.
//! - 읽은 사실(누가·건수)만 사람마다 하루 한 줄 감사에 남긴다(TS `OncePerWindow` 와 같은 창). 값은 싣지 않는다.
//! - 쓰기는 감사 줄(`audit_log` INSERT)뿐 — [`ACCOUNT_LOGIN_IDS_PRIVILEGES`]. 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에
//!   남는다. 재설정 코드 발급·거두기는 TS 에 남긴다.
use crate::auth::{Auth, Via};
use crate::directory::internal;
use crate::perm::require_cap;
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, record_audit};
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 쓰기 풀이 쓰는 권한(표, 권한) — 감사 줄뿐.
pub const ACCOUNT_LOGIN_IDS_PRIVILEGES: &[(&str, &str)] = &[("audit_log", "INSERT")];

/// 감사 창 — TS `24 * 60 * 60_000`.
const AUDIT_WINDOW: Duration = Duration::from_secs(24 * 60 * 60);

pub struct LoginIdsState {
    pub read: PgPool,
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
    pub once: OncePerWindow,
}

/// TS `OncePerWindow` — 창 안에서 처음이면 true, 그 뒤 창이 닫힐 때까지 false.
#[derive(Default)]
pub struct OncePerWindow {
    until: Mutex<HashMap<String, Instant>>,
}

impl OncePerWindow {
    pub fn first(&self, key: &str, now: Instant, window: Duration) -> bool {
        let mut m = self.until.lock().unwrap_or_else(|e| e.into_inner());
        if m.len() > 10_000 {
            m.retain(|_, t| *t > now);
        }
        if m.get(key).is_some_and(|t| *t > now) {
            return false;
        }
        m.insert(key.to_owned(), now + window.max(Duration::from_secs(1)));
        true
    }
}

const LOGIN_IDS_SQL: &str = "select coalesce(json_object_agg(id, login_id), '{}')::text, count(*) \
       from account \
      where kind = 'human' and deleted_at is null and disabled_at is null and login_id is not null \
        and id <> $1::uuid and role <> 'owner' and ($2::text = 'owner' or role <> 'admin')";

pub async fn login_ids(State(st): State<Arc<LoginIdsState>>, req: Request) -> Response {
    let (parts, _) = req.into_parts();
    let auth = parts.extensions.get::<Auth>().cloned().unwrap_or_default();
    let actor = match require_cap(&st.read, &auth, "member.reset_password", None).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if actor.kind != "human" || auth.via != Some(Via::Session) {
        return crate::directory::json_err(
            StatusCode::FORBIDDEN,
            "session_required",
            "only a signed-in person can read login IDs",
        );
    }
    let (map, count): (String, i64) = match sqlx::query_as(LOGIN_IDS_SQL)
        .bind(&actor.id)
        .bind(&actor.role)
        .fetch_one(&st.read)
        .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if st.once.first(&actor.id, Instant::now(), AUDIT_WINDOW) {
        let ip = crate::writes_settings::ip_of(&parts, &st.trust);
        record_audit(
            &st.write,
            AuditEntry {
                action: "accounts.login_ids.read",
                actor_id: Some(&actor.id),
                actor_handle: Some(&actor.handle),
                target: None,
                ip: ip.as_deref(),
                detail: json!({ "count": count }),
            },
        )
        .await;
    }
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        format!("{{\"loginIds\":{map}}}"),
    )
        .into_response()
}

pub fn routes(
    st: LoginIdsState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<LoginIdsState>>::new()
        .get("/accounts/login-ids", login_ids)
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
    fn once_per_window() {
        let o = OncePerWindow::default();
        let t0 = Instant::now();
        let w = Duration::from_secs(60);
        assert!(o.first("a", t0, w));
        assert!(!o.first("a", t0 + Duration::from_secs(30), w));
        assert!(o.first("b", t0, w));
        assert!(o.first("a", t0 + Duration::from_secs(61), w));
    }
}
