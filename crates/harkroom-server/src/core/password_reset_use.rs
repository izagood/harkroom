//! S5.4 — 재설정 코드로 비밀번호 바꾸기. TS `routes/passwordResetRoutes.ts` 의 `POST /auth/password-reset` 과
//! `buildServer.ts` 의 주소 단위 리밋 훅(`passwordReset:{ip}`)을 옮긴다.
//!
//! - 순서: 주소 단위 `passwordReset:{ip}`([`rate_limit::PASSWORD_RESET`], 본문 읽기 앞) → 본문
//!   `{loginId ≤64, code ≤64, newPassword 8..=128}` 아니면 400 `bad_request` → 로그인 ID 단위
//!   `passwordReset:{loginKey}`([`rate_limit::PASSWORD_RESET_ACCOUNT`], Argon2 앞) → 막혔으면 감사 후 429(`retryAfterSec` 헤더·본문)
//!   → 코드 정규화 실패면 감사 `password_reset_code.failed` + 400 `invalid_reset_code` → 해시(트랜잭션 밖) → 한 트랜잭션에서
//!   코드 잠금·소진·해시 교체·세션 전부 삭제·새 세션 → 감사 둘 → 200 `{token}` + `cache-control: no-store`.
//! - **리밋 키 묶음**: `passwordReset:*` 는 이 경로만 쓴다(주소·로그인 ID 둘 다 같은 접두어) — 통째로 옮긴다.
//! - 알려진 차이: zod 실패의 `message` 는 TS 가 zod issue JSON 문자열을 싣는다 — 여기서는 `"body"` 다(다른 포트와 같은 관례).
//! - 쓰기 권한은 [`PASSWORD_RESET_USE_PRIVILEGES`].
use crate::core::auth_login::normalize_login_key;
use crate::directory::{internal, json_err};
use crate::rate_limit::{self, RateLimiter};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, read_body, record_audit};
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;

/// shared `PASSWORD_MIN_LENGTH`·`PASSWORD_MAX_LENGTH`.
const PASSWORD_MIN: usize = 8;
const PASSWORD_MAX: usize = 128;
/// services/passwordReset.ts.
const RESET_CODE_ALPHABET: &str = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const RESET_CODE_LENGTH: usize = 12;

/// `grant select (id, account_id, code_hash, used_at, revoked_at, expires_at, issued_by), update (used_at) on password_reset_code`,
/// `grant select (id, handle, login_id, kind, deleted_at, disabled_at, role), update (password_hash) on account`,
/// `grant select (account_id), delete on session`, `grant insert (token_hash, account_id, expires_at) on session`,
/// `grant insert (action, actor_id, actor_handle, target, ip, detail) on audit_log`.
pub const PASSWORD_RESET_USE_PRIVILEGES: &[(&str, &str)] = &[
    ("password_reset_code.id", "SELECT"),
    ("password_reset_code.account_id", "SELECT"),
    ("password_reset_code.code_hash", "SELECT"),
    ("password_reset_code.used_at", "SELECT"),
    ("password_reset_code.revoked_at", "SELECT"),
    ("password_reset_code.expires_at", "SELECT"),
    ("password_reset_code.issued_by", "SELECT"),
    ("password_reset_code.used_at", "UPDATE"),
    ("account.id", "SELECT"),
    ("account.handle", "SELECT"),
    ("account.login_id", "SELECT"),
    ("account.kind", "SELECT"),
    ("account.deleted_at", "SELECT"),
    ("account.disabled_at", "SELECT"),
    ("account.role", "SELECT"),
    ("account.password_hash", "UPDATE"),
    ("session.account_id", "SELECT"),
    // DELETE 는 칸 단위가 없다 — 표 단위.
    ("session", "DELETE"),
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

pub struct PasswordResetUseState {
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
    pub limiter: Arc<RateLimiter>,
}

/// zod `{loginId: max(64), code: max(64), newPassword: min(8).max(128)}.safeParse(req.body ?? {})`.
fn parse_body(body: Body) -> Option<(String, String, String)> {
    let Body::Json(Value::Object(mut m)) = body else {
        return None;
    };
    let mut s = |k: &str, min: usize, max: usize| match m.remove(k) {
        Some(Value::String(v)) if (min..=max).contains(&crate::writes_settings::js_len(&v)) => {
            Some(v)
        }
        _ => None,
    };
    let login_id = s("loginId", 0, 64);
    let code = s("code", 0, 64);
    let pw = s("newPassword", PASSWORD_MIN, PASSWORD_MAX);
    Some((login_id?, code?, pw?))
}

/// TS `normalizeResetCode`.
fn normalize_reset_code(input: &str) -> Option<String> {
    let s: String = input
        .chars()
        .filter(|c| !(c.is_whitespace() || *c == '-' || *c == '\u{feff}'))
        .collect::<String>()
        .to_uppercase();
    (s.encode_utf16().count() == RESET_CODE_LENGTH
        && s.chars().all(|c| RESET_CODE_ALPHABET.contains(c)))
    .then_some(s)
}

fn invalid() -> Response {
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_reset_code",
        "the reset code is wrong, already used, or expired",
    )
}

/// `POST /auth/password-reset`.
pub async fn use_code(State(st): State<Arc<PasswordResetUseState>>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    let ip_key = ip.clone().unwrap_or_default();
    let addr = st.limiter.hit(
        &format!("passwordReset:{ip_key}"),
        rate_limit::PASSWORD_RESET,
    );
    if !addr.allowed {
        return rate_limit::too_many(addr, false);
    }
    let body = match read_body(&parts.headers, body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let Some((login_id, code, new_password)) = parse_body(body) else {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", "body");
    };
    let key = format!("passwordReset:{}", normalize_login_key(&login_id));
    let verdict = st.limiter.hit(&key, rate_limit::PASSWORD_RESET_ACCOUNT);
    let audit_fail = |reason: Option<&'static str>| AuditEntry {
        action: "password_reset_code.failed",
        actor_id: None,
        actor_handle: Some(&login_id),
        target: None,
        ip: ip.as_deref(),
        detail: reason.map_or_else(|| json!({}), |r| json!({ "reason": r })),
    };
    if !verdict.allowed {
        record_audit(&st.write, audit_fail(Some("rate_limited"))).await;
        return rate_limit::too_many(verdict, true);
    }
    let Some(normalized) = normalize_reset_code(&code) else {
        record_audit(&st.write, audit_fail(None)).await;
        return invalid();
    };
    let new_hash = tokio::task::spawn_blocking(move || crate::password::hash(&new_password))
        .await
        .expect("argon2 hash task");
    let mut tx = match st.write.begin().await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    let row: Option<(String, String, String)> = match sqlx::query_as(
        "select c.id::text, c.account_id::text, a.handle
           from password_reset_code c
           join account a on a.id = c.account_id
           join account i on i.id = c.issued_by
          where c.code_hash = $1 and lower(a.login_id) = lower($2)
            and c.used_at is null and c.revoked_at is null and c.expires_at > now()
            and a.kind = 'human' and a.deleted_at is null and a.disabled_at is null and a.role <> 'owner'
            and i.kind = 'human' and i.deleted_at is null and i.disabled_at is null and i.role in ('owner', 'admin')
            and (a.role <> 'admin' or i.role = 'owner')
          for update of c",
    )
    .bind(crate::auth::hash_token(&normalized))
    .bind(&login_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let Some((code_id, account_id, handle)) = row else {
        drop(tx);
        record_audit(&st.write, audit_fail(None)).await;
        return invalid();
    };
    let (token, token_hash) = crate::core::auth_login::new_session_token();
    let steps: [(&str, &[&str]); 4] = [
        (
            "update password_reset_code set used_at = now() where id = $1::uuid",
            &[&code_id],
        ),
        (
            "update account set password_hash = $1 where id = $2::uuid",
            &[&new_hash, &account_id],
        ),
        (
            "delete from session where account_id = $1::uuid",
            &[&account_id],
        ),
        (
            "insert into session (token_hash, account_id, expires_at) \
             values ($1, $2::uuid, now() + interval '14 days')",
            &[&token_hash, &account_id],
        ),
    ];
    for (sql, binds) in steps {
        let mut q = sqlx::query(sql);
        for b in binds {
            q = q.bind(*b);
        }
        if let Err(e) = q.execute(&mut *tx).await {
            return internal(e);
        }
    }
    if let Err(e) = tx.commit().await {
        return internal(e);
    }
    st.limiter.reset(&key);
    record_audit(
        &st.write,
        AuditEntry {
            action: "password_reset_code.used",
            actor_id: Some(&account_id),
            actor_handle: Some(&handle),
            target: Some(&account_id),
            ip: ip.as_deref(),
            detail: json!({ "codeId": code_id }),
        },
    )
    .await;
    record_audit(
        &st.write,
        AuditEntry {
            action: "password.changed",
            actor_id: Some(&account_id),
            actor_handle: Some(&handle),
            target: None,
            ip: ip.as_deref(),
            detail: json!({ "via": "reset_code", "allSessionsInvalidated": true }),
        },
    )
    .await;
    let mut res = (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        json!({ "token": token }).to_string(),
    )
        .into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

pub fn routes(
    st: PasswordResetUseState,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PasswordResetUseState>>::new()
        .post("/auth/password-reset", use_code)
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
        let ok = json!({ "loginId": "a", "code": "c", "newPassword": "12345678" });
        assert!(parse_body(Body::Json(ok)).is_some());
        assert!(parse_body(Body::None).is_none());
        assert!(
            parse_body(Body::Json(
                json!({ "loginId": "a", "code": "c", "newPassword": "1234567" })
            ))
            .is_none()
        );
        assert!(
            parse_body(Body::Json(
                json!({ "loginId": "a", "code": "c", "newPassword": "a".repeat(129) })
            ))
            .is_none()
        );
        assert!(
            parse_body(Body::Json(
                json!({ "loginId": "a".repeat(65), "code": "c", "newPassword": "12345678" })
            ))
            .is_none()
        );
    }

    #[test]
    fn reset_code_normalizes_like_ts() {
        assert_eq!(
            normalize_reset_code("abcd-efgh-jkmn").as_deref(),
            Some("ABCDEFGHJKMN")
        );
        assert_eq!(
            normalize_reset_code(" ab cd efgh jkmn "),
            Some("ABCDEFGHJKMN".into())
        );
        assert_eq!(
            normalize_reset_code("ABCDEFGHJKMI"),
            None,
            "I not in alphabet"
        );
        assert_eq!(normalize_reset_code("ABCDEFGHJKM"), None);
    }
}
