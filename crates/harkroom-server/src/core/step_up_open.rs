//! S5.4 — 보관소 잠금 해제(열기). TS `routes/authRoutes.ts` 의 `POST /auth/step-up` 과 `services/stepUp.ts` 의 `openStepUp` 을 옮긴다.
//!
//! - 순서는 TS 와 같다: 본문 읽기 → `requireAccount`(401) → 본문 `{password: string ≤256}` 아니면 400 `bad_request`
//!   → 사람·세션이 아니면 403 `session_required` → 시도 상한 `stepUp:{accountId}`([`rate_limit::STEP_UP`]) 을 **검증 앞**에서 센다
//!   → 막혔으면 창마다 한 번 감사 `step_up.failed {reason: rate_limited}` 후 429(`retryAfterSec` 를 헤더·본문 둘 다)
//!   → 비밀번호 확인(계정에 해시가 없으면 더미 해시로 한 번 돈다 — 응답 시간으로 갈리지 않게)
//!   → 틀리면 감사 `step_up.failed {reason: wrong_password}` + 401 `invalid_credentials`
//!   → 맞으면 상한 비우기 · 세션 창 열기(15분) · 감사 `step_up.succeeded` → 200 `{steppedUpUntil}`.
//! - **시도 상한 카운터는 프로세스 로컬이다.** Rust 리미터와 TS 리미터는 따로 센다 — 이 줄을 Rust 가 받는 동안 TS 의
//!   `stepUp:*` 키는 쓰이지 않는다(같은 키를 쓰는 다른 경로가 없다). 단, login(`loginAccount*`)·passwordReset·stepUp 은
//!   같은 비밀번호 추측 표면이라 **같이 옮겨야** 한다 — login 은 아직 TS 다(옮길 때 이 리미터를 공유할 것).
//! - 쓰기 권한은 [`STEP_UP_OPEN_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use crate::auth::{RequireAccount, Via};
use crate::core::account_login_ids::OncePerWindow;
use crate::directory::{internal, json_err, json_ok};
use crate::rate_limit::{self, RateLimiter};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, record_audit};
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// TS `STEP_UP_IDLE_MS`.
pub const STEP_UP_IDLE_MS: i64 = 15 * 60_000;

/// 쓰기 풀에 있어야 하는 칸 권한 — homelab GRANT 와 같아야 한다.
/// `grant select (id, password_hash) on account`, `grant select (token_hash, stepped_up_until), update (stepped_up_at, stepped_up_until) on session`
/// (UPDATE 의 WHERE·RETURNING 이 읽는 칸은 SELECT 도 있어야 한다),
/// `grant insert (action, actor_id, actor_handle, target, ip, detail) on audit_log`.
pub const STEP_UP_OPEN_PRIVILEGES: &[(&str, &str)] = &[
    ("account.id", "SELECT"),
    ("account.password_hash", "SELECT"),
    ("session.token_hash", "SELECT"),
    ("session.stepped_up_at", "UPDATE"),
    ("session.stepped_up_until", "UPDATE"),
    ("session.stepped_up_until", "SELECT"),
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.actor_handle", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.ip", "INSERT"),
    ("audit_log.detail", "INSERT"),
];

pub struct StepUpOpenState {
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
    /// `stepUp:{accountId}` 를 세는 리미터. login·passwordReset 을 옮길 때 같은 인스턴스를 나눠 쓴다.
    pub limiter: Arc<RateLimiter>,
    /// TS `stepUpLimitedAudit` — 막힌 동안의 감사는 창마다 한 줄.
    pub limited_audit: OncePerWindow,
    /// TS `dummyHash` — 첫 필요 때 한 번 만든다(같은 기본 비용).
    pub dummy: Arc<OnceLock<String>>,
}

impl StepUpOpenState {
    pub fn new(write: PgPool, trust: Arc<TrustProxy>, limiter: Arc<RateLimiter>) -> Self {
        Self {
            write,
            trust,
            limiter,
            limited_audit: OncePerWindow::default(),
            dummy: Arc::new(OnceLock::new()),
        }
    }
}

/// zod `z.object({ password: z.string().max(256) }).safeParse(req.body ?? {})`.
fn parse_password(body: Body) -> Option<String> {
    let Body::Json(Value::Object(mut m)) = body else {
        return None;
    };
    match m.remove("password") {
        Some(Value::String(p)) if crate::writes_settings::js_len(&p) <= 256 => Some(p),
        _ => None,
    }
}

/// TS `verifyAgainstDummy` — 늘 false 지만 진짜 검증과 같은 시간을 쓴다.
pub(crate) async fn verify_against_dummy(dummy: Arc<OnceLock<String>>, password: String) -> bool {
    tokio::task::spawn_blocking(move || {
        let h = dummy.get_or_init(|| {
            let mut b = [0u8; 32];
            getrandom::fill(&mut b).expect("os random");
            let pw: String = b.iter().map(|x| format!("{x:02x}")).collect();
            crate::password::hash(&pw)
        });
        let _ = crate::password::verify(h, &password);
    })
    .await
    .expect("argon2 dummy verify task");
    false
}

/// `POST /auth/step-up`.
pub async fn open_step_up(State(st): State<Arc<StepUpOpenState>>, req: Request) -> Response {
    let (body, RequireAccount(me, auth), parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let Some(password) = parse_password(body) else {
        return json_err(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "password is required",
        );
    };
    let cred = match (me.kind.as_str(), auth.via, auth.credential_hash.as_deref()) {
        ("human", Some(Via::Session), Some(h)) => h.to_owned(),
        _ => {
            return json_err(
                StatusCode::FORBIDDEN,
                "session_required",
                "step-up is only for a signed-in person",
            );
        }
    };
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    let key = format!("stepUp:{}", me.id);
    let verdict = st.limiter.hit(&key, rate_limit::STEP_UP);
    if !verdict.allowed {
        if st.limited_audit.first(
            &me.id,
            Instant::now(),
            Duration::from_millis(verdict.retry_after_ms),
        ) {
            record_audit(
                &st.write,
                AuditEntry {
                    action: "step_up.failed",
                    actor_id: Some(&me.id),
                    actor_handle: Some(&me.handle),
                    target: None,
                    ip: ip.as_deref(),
                    detail: json!({ "reason": "rate_limited" }),
                },
            )
            .await;
        }
        return rate_limit::too_many(verdict, true);
    }
    let stored: Option<Option<String>> =
        match sqlx::query_scalar("select password_hash from account where id = $1::uuid")
            .bind(&me.id)
            .fetch_optional(&st.write)
            .await
        {
            Ok(v) => v,
            Err(e) => return internal(e),
        };
    let ok = match stored.flatten().filter(|h| !h.is_empty()) {
        Some(h) => crate::password::verify_async(h, password).await,
        None => verify_against_dummy(st.dummy.clone(), password).await,
    };
    if !ok {
        record_audit(
            &st.write,
            AuditEntry {
                action: "step_up.failed",
                actor_id: Some(&me.id),
                actor_handle: Some(&me.handle),
                target: None,
                ip: ip.as_deref(),
                detail: json!({ "reason": "wrong_password" }),
            },
        )
        .await;
        return json_err(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "wrong password",
        );
    }
    st.limiter.reset(&key);
    // TS `openStepUp(pool, hash, new Date())` — `now` 는 밀리초 정밀도, 응답은 `until.toISOString()`.
    let now_ms = crate::core::msg_post::now_ms();
    let until: Option<String> = match sqlx::query_scalar(
        "update session set stepped_up_at = $2::timestamptz, \
                stepped_up_until = $2::timestamptz + $3 * interval '1 millisecond' \
          where token_hash = $1 \
          returning to_char(stepped_up_until at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
    )
    .bind(&cred)
    .bind(crate::core::msg_post::iso_ms(now_ms))
    .bind(STEP_UP_IDLE_MS as f64)
    .fetch_optional(&st.write)
    .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    // 세션 행이 사이에 사라졌으면 TS 는 `rows[0].until` 에서 던진다(500).
    let Some(until) = until else {
        return json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        );
    };
    record_audit(
        &st.write,
        AuditEntry {
            action: "step_up.succeeded",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: None,
            ip: ip.as_deref(),
            detail: json!({}),
        },
    )
    .await;
    json_ok(json!({ "steppedUpUntil": until }).to_string())
}

pub fn routes(
    st: StepUpOpenState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<StepUpOpenState>>::new()
        .post("/auth/step-up", open_step_up)
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
    fn password_body_matches_zod() {
        assert_eq!(
            parse_password(Body::Json(json!({ "password": "pw", "x": 1 }))),
            Some("pw".into())
        );
        assert_eq!(parse_password(Body::None), None);
        assert_eq!(parse_password(Body::Text("pw".into())), None);
        assert_eq!(parse_password(Body::Json(json!({ "password": 1 }))), None);
        assert_eq!(parse_password(Body::Json(json!(["pw"]))), None);
        assert_eq!(
            parse_password(Body::Json(json!({ "password": "a".repeat(256) }))),
            Some("a".repeat(256))
        );
        assert_eq!(
            parse_password(Body::Json(json!({ "password": "a".repeat(257) }))),
            None
        );
        // UTF-16 단위로 센다 — 이모지 하나는 2.
        assert_eq!(
            parse_password(Body::Json(json!({ "password": "😀".repeat(129) }))),
            None
        );
    }

    #[test]
    fn privileges_are_column_level() {
        assert!(STEP_UP_OPEN_PRIVILEGES.iter().all(|(t, _)| t.contains('.')));
    }
}
