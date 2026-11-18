//! S5.4 — 로그인. TS `routes/authRoutes.ts` 의 `POST /auth/login` 과 `buildServer.ts` 의 주소 단위 리밋 훅(`login:{ip}`)을 옮긴다.
//!
//! - 순서는 TS 와 같다: 주소 단위 상한 `login:{ip}`([`rate_limit::LOGIN`], onRequest 훅 — 본문 읽기 **앞**) → 본문 읽기
//!   → `{loginId: string ≤64, password: string}` 아니면 400 `invalid_request` → 계정 단위 상한(검증 **앞**):
//!   `loginAccountIp:{loginKey}:{ip}` 먼저, 허용이면 `loginAccount:{loginKey}` → 막혔으면 감사 `login.failed
//!   {reason: account_rate_limited}` 후 429 → 비밀번호 확인(없는 계정은 더미 해시로 한 번 돈다) → 틀리면 감사
//!   `login.failed` + 401 `invalid_credentials` → 맞으면 두 계정 키 비우기 · 세션 행(`hrks_`, 14일) · 감사
//!   `login.succeeded` → 200 `{token}`. 쿠키는 없다(TS 도 본문으로만 준다).
//! - **리밋 키 묶음**: `login:*`·`loginAccountIp:*`·`loginAccount:*` 는 이 경로만 쓴다 — 셋을 한꺼번에 옮기므로
//!   TS 리미터와 겹쳐 세지 않는다. `signup:{ip}` 는 `/auth/register`·`/bootstrap`·`/claim` 이 나눠 쓰므로 셋을 한꺼번에
//!   옮겼다(`auth_signup`).
//! - 쓰기 권한은 [`AUTH_LOGIN_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use crate::directory::{internal, json_err, json_ok};
use crate::rate_limit::{self, RateLimiter};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, read_body, record_audit};
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{Arc, OnceLock};

/// TS `SESSION_TTL_DAYS` — 세션 INSERT 의 `interval '14 days'` 와 같아야 한다.
pub const SESSION_TTL_DAYS: i64 = 14;

/// 쓰기 풀에 있어야 하는 칸 권한 — homelab GRANT 와 같아야 한다.
/// `grant select (id, password_hash, handle, login_id, kind, deleted_at, disabled_at) on account`,
/// `grant insert (token_hash, account_id, expires_at) on session`,
/// `grant insert (action, actor_id, actor_handle, target, ip, detail) on audit_log`.
pub const AUTH_LOGIN_PRIVILEGES: &[(&str, &str)] = &[
    ("account.id", "SELECT"),
    ("account.password_hash", "SELECT"),
    ("account.handle", "SELECT"),
    ("account.login_id", "SELECT"),
    ("account.kind", "SELECT"),
    ("account.deleted_at", "SELECT"),
    ("account.disabled_at", "SELECT"),
    ("session.token_hash", "INSERT"),
    ("session.account_id", "INSERT"),
    ("session.expires_at", "INSERT"),
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.actor_handle", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.ip", "INSERT"),
    ("audit_log.detail", "INSERT"),
];

pub struct AuthLoginState {
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
    /// `login:*`·`loginAccountIp:*`·`loginAccount:*` 를 세는 리미터(step-up 과 같은 인스턴스를 나눠 쓴다).
    pub limiter: Arc<RateLimiter>,
    /// TS `dummyHash`.
    pub dummy: Arc<OnceLock<String>>,
}

/// TS `normalizeLoginKey` — trim · 소문자 · 앞 128 UTF-16 단위.
pub fn normalize_login_key(login_id: &str) -> String {
    let lower = js_trim(login_id).to_lowercase();
    let units: Vec<u16> = lower.encode_utf16().take(128).collect();
    String::from_utf16_lossy(&units)
}

/// JS `String.prototype.trim` — 공백·줄끝(유니코드 White_Space + BOM).
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// zod `z.object({ loginId: z.string().max(64), password: z.string() }).parse(req.body)`.
fn parse_body(body: Body) -> Option<(String, String)> {
    let Body::Json(Value::Object(mut m)) = body else {
        return None;
    };
    let login_id = match m.remove("loginId") {
        Some(Value::String(s)) if crate::writes_settings::js_len(&s) <= 64 => s,
        _ => return None,
    };
    let password = match m.remove("password") {
        Some(Value::String(s)) => s,
        _ => return None,
    };
    Some((login_id, password))
}

/// TS `newToken('hrks')`.
pub(crate) fn new_session_token() -> (String, String) {
    use base64::Engine;
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("os random");
    let token = format!(
        "hrks_{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
    );
    let hash = crate::auth::hash_token(&token);
    (token, hash)
}

/// `POST /auth/login`.
pub async fn login(State(st): State<Arc<AuthLoginState>>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    let ip_key = ip.clone().unwrap_or_default();
    // onRequest 훅 — 본문을 읽기 전에 센다.
    let addr = st
        .limiter
        .hit(&format!("login:{ip_key}"), rate_limit::LOGIN);
    if !addr.allowed {
        return rate_limit::too_many(addr, false);
    }
    let body = match read_body(&parts.headers, body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let Some((login_id, password)) = parse_body(body) else {
        return json_err(StatusCode::BAD_REQUEST, "invalid_request", "body");
    };
    let login_key = normalize_login_key(&login_id);
    let account_key = format!("loginAccount:{login_key}");
    let account_ip_key = format!("loginAccountIp:{login_key}:{ip_key}");
    let per_ip = st
        .limiter
        .hit(&account_ip_key, rate_limit::LOGIN_ACCOUNT_IP);
    let locked = if per_ip.allowed {
        st.limiter.hit(&account_key, rate_limit::LOGIN_ACCOUNT)
    } else {
        per_ip
    };
    if !locked.allowed {
        record_audit(
            &st.write,
            AuditEntry {
                action: "login.failed",
                actor_id: None,
                actor_handle: Some(&login_id),
                target: None,
                ip: ip.as_deref(),
                detail: json!({ "reason": "account_rate_limited" }),
            },
        )
        .await;
        return rate_limit::too_many(locked, false);
    }
    let row: Option<(String, Option<String>)> = match sqlx::query_as(
        "select id::text, password_hash from account \
          where lower(login_id) = lower($1) and kind = 'human' and deleted_at is null and disabled_at is null",
    )
    .bind(&login_id)
    .fetch_optional(&st.write)
    .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let hash = row
        .as_ref()
        .and_then(|(_, h)| h.clone())
        .filter(|h| !h.is_empty());
    let ok = match hash {
        Some(h) => crate::password::verify_async(h, password).await,
        None => crate::core::step_up_open::verify_against_dummy(st.dummy.clone(), password).await,
    };
    let account_id = row.map(|(id, _)| id);
    let account_id = match account_id {
        Some(id) if ok => id,
        failed_id => {
            record_audit(
                &st.write,
                AuditEntry {
                    action: "login.failed",
                    actor_id: failed_id.as_deref(),
                    actor_handle: Some(&login_id),
                    target: None,
                    ip: ip.as_deref(),
                    detail: json!({}),
                },
            )
            .await;
            return json_err(
                StatusCode::UNAUTHORIZED,
                "invalid_credentials",
                "wrong login ID or password",
            );
        }
    };
    st.limiter.reset(&account_key);
    st.limiter.reset(&account_ip_key);
    let (token, token_hash) = new_session_token();
    if let Err(e) = sqlx::query(
        "insert into session (token_hash, account_id, expires_at) \
         values ($1, $2::uuid, now() + interval '14 days')",
    )
    .bind(&token_hash)
    .bind(&account_id)
    .execute(&st.write)
    .await
    {
        return internal(e);
    }
    record_audit(
        &st.write,
        AuditEntry {
            action: "login.succeeded",
            actor_id: Some(&account_id),
            actor_handle: Some(&login_id),
            target: None,
            ip: ip.as_deref(),
            detail: json!({}),
        },
    )
    .await;
    json_ok(json!({ "token": token }).to_string())
}

pub fn routes(st: AuthLoginState, cors: Arc<crate::cors::Cors>) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AuthLoginState>>::new()
        .post("/auth/login", login)
        .map(|r| {
            r.layer(axum::middleware::from_fn_with_state(
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
    fn body_matches_zod() {
        assert_eq!(
            parse_body(Body::Json(
                json!({ "loginId": "a", "password": "p", "x": 1 })
            )),
            Some(("a".into(), "p".into()))
        );
        assert_eq!(parse_body(Body::None), None);
        assert_eq!(parse_body(Body::Text("x".into())), None);
        assert_eq!(parse_body(Body::Json(json!({ "loginId": "a" }))), None);
        assert_eq!(
            parse_body(Body::Json(json!({ "loginId": 1, "password": "p" }))),
            None
        );
        assert!(
            parse_body(Body::Json(
                json!({ "loginId": "a".repeat(64), "password": "" })
            ))
            .is_some()
        );
        assert_eq!(
            parse_body(Body::Json(
                json!({ "loginId": "a".repeat(65), "password": "" })
            )),
            None
        );
    }

    #[test]
    fn login_key_matches_ts() {
        assert_eq!(normalize_login_key("  Alice\n"), "alice");
        assert_eq!(normalize_login_key(&"A".repeat(200)), "a".repeat(128));
    }

    #[test]
    fn session_token_shape() {
        let (t, h) = new_session_token();
        assert!(t.starts_with("hrks_"));
        assert_eq!(t.len(), 5 + 43);
        assert_eq!(h, crate::auth::hash_token(&t));
    }

    #[test]
    fn privileges_are_column_level() {
        assert!(AUTH_LOGIN_PRIVILEGES.iter().all(|(t, _)| t.contains('.')));
    }
}
