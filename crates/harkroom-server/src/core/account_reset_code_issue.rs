//! S5.4 — 재설정 코드 발급 한 줄. TS `routes/passwordResetRoutes.ts` 의 `POST /accounts/:id/password-reset-code` 를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireCap('member.reset_password')`(401·403) → 경로 zod(400) → 사람·세션 아니면 403
//!   `session_required` → step-up 이 살아 있지 않으면 403 `step_up_required` → `targetFor`(거두기와 같은 갈래,
//!   [`super::account_reset_code_revoke::target_refusal`]) → 한 트랜잭션에서 대상 잠금·살아 있는 코드 거두기·새 코드 →
//!   감사 `password_reset_code.issued {replacedLiveCode, expiresAt}` → 201 `{code, expiresAt, loginId}` + `cache-control: no-store`.
//! - 코드는 TS `newResetCode` 와 같다: 31글자 알파벳에서 균등하게 12자, 보이는 꼴 `XXXX-XXXX-XXXX`, 저장은 `hashToken(code)`.
//! - 쓰기 권한은 [`ACCOUNT_RESET_CODE_ISSUE_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use crate::auth::{Auth, Via};
use crate::core::account_reset_code_revoke::target_refusal;
use crate::directory::{internal, json_err};
use crate::perm::require_cap;
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, record_audit};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;

/// services/passwordReset.ts.
const RESET_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const RESET_CODE_LENGTH: usize = 12;
const RESET_CODE_TTL_MS: i64 = 30 * 60_000;

/// `grant select (token_hash, expires_at, stepped_up_until) on session`,
/// `grant select (id, handle, role, login_id, kind, deleted_at, disabled_at), update (id) on account` (`for update` 잠금),
/// `grant select (account_id, used_at, revoked_at), update (revoked_at), insert (account_id, code_hash, issued_by, expires_at) on password_reset_code`,
/// `grant insert (action, actor_id, actor_handle, target, ip, detail) on audit_log`.
pub const ACCOUNT_RESET_CODE_ISSUE_PRIVILEGES: &[(&str, &str)] = &[
    ("session.token_hash", "SELECT"),
    ("session.expires_at", "SELECT"),
    ("session.stepped_up_until", "SELECT"),
    ("account.id", "SELECT"),
    ("account.handle", "SELECT"),
    ("account.role", "SELECT"),
    ("account.login_id", "SELECT"),
    ("account.kind", "SELECT"),
    ("account.deleted_at", "SELECT"),
    ("account.disabled_at", "SELECT"),
    // `select ... for update` 는 어느 한 칸의 UPDATE 권한이 있어야 한다.
    ("account.id", "UPDATE"),
    ("password_reset_code.account_id", "SELECT"),
    ("password_reset_code.used_at", "SELECT"),
    ("password_reset_code.revoked_at", "SELECT"),
    ("password_reset_code.revoked_at", "UPDATE"),
    ("password_reset_code.account_id", "INSERT"),
    ("password_reset_code.code_hash", "INSERT"),
    ("password_reset_code.issued_by", "INSERT"),
    ("password_reset_code.expires_at", "INSERT"),
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.actor_handle", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.ip", "INSERT"),
    ("audit_log.detail", "INSERT"),
];

pub struct ResetCodeIssueState {
    pub read: PgPool,
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
}

/// TS `newResetCode` 의 글자 고르기 — `randomInt(31)` 과 같은 균등 분포(거절 표집).
fn new_code() -> String {
    let n = RESET_CODE_ALPHABET.len() as u8; // 31
    let limit = 256 - (256 % n as u16) as u8 as u16; // 248
    let mut out = String::with_capacity(RESET_CODE_LENGTH);
    while out.len() < RESET_CODE_LENGTH {
        let mut b = [0u8; 32];
        getrandom::fill(&mut b).expect("os random");
        for x in b {
            if (x as u16) < limit && out.len() < RESET_CODE_LENGTH {
                out.push(RESET_CODE_ALPHABET[(x % n) as usize] as char);
            }
        }
    }
    out
}

/// `XXXX-XXXX-XXXX`.
fn display(code: &str) -> String {
    format!("{}-{}-{}", &code[..4], &code[4..8], &code[8..])
}

pub async fn issue(
    State(st): State<Arc<ResetCodeIssueState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (parts, _) = req.into_parts();
    let auth = parts.extensions.get::<Auth>().cloned().unwrap_or_default();
    let actor = match require_cap(&st.read, &auth, "member.reset_password", None).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !crate::lists::is_zod_uuid(&id) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    if actor.kind != "human" || auth.via != Some(Via::Session) {
        return json_err(
            StatusCode::FORBIDDEN,
            "session_required",
            "only a signed-in person can issue a reset code",
        );
    }
    let stepped_up = match auth.credential_hash.as_deref() {
        None => false,
        Some(cred) => match sqlx::query_scalar::<_, i32>(
            "select 1 from session \
              where token_hash = $1 and expires_at > now() and stepped_up_until > now()",
        )
        .bind(cred)
        .fetch_optional(&st.write)
        .await
        {
            Ok(v) => v.is_some(),
            Err(e) => return internal(e),
        },
    };
    if !stepped_up {
        return json_err(
            StatusCode::FORBIDDEN,
            "step_up_required",
            "confirm your password before issuing a reset code",
        );
    }
    let row: Option<(String, Option<String>)> = if id == actor.id {
        None
    } else {
        match sqlx::query_as(
            "select role, login_id from account \
              where id = $1::uuid and kind = 'human' and deleted_at is null and disabled_at is null",
        )
        .bind(&id)
        .fetch_optional(&st.read)
        .await
        {
            Ok(v) => v,
            Err(e) => return internal(e),
        }
    };
    if let Some((s, c, m)) = target_refusal(
        &actor.id,
        &actor.role,
        &id,
        row.as_ref().map(|r| r.0.as_str()),
    ) {
        return json_err(s, c, m);
    }
    let login_id = row.and_then(|r| r.1);

    let code = new_code();
    let hash = crate::auth::hash_token(&code);
    let expires_at =
        crate::core::msg_post::iso_ms(crate::core::msg_post::now_ms() + RESET_CODE_TTL_MS);
    let revoked = match async {
        let mut tx = st.write.begin().await?;
        sqlx::query("select 1 from account where id = $1::uuid for update")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        let n = sqlx::query(
            "update password_reset_code set revoked_at = now() \
              where account_id = $1::uuid and used_at is null and revoked_at is null",
        )
        .bind(&id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        sqlx::query(
            "insert into password_reset_code (account_id, code_hash, issued_by, expires_at) \
             values ($1::uuid, $2, $3::uuid, $4::timestamptz)",
        )
        .bind(&id)
        .bind(&hash)
        .bind(&actor.id)
        .bind(&expires_at)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok::<u64, sqlx::Error>(n)
    }
    .await
    {
        Ok(n) => n,
        Err(e) => return internal(e),
    };
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "password_reset_code.issued",
            actor_id: Some(&actor.id),
            actor_handle: Some(&actor.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: json!({ "replacedLiveCode": revoked > 0, "expiresAt": expires_at }),
        },
    )
    .await;
    let mut r = crate::directory::json_ok(
        json!({ "code": display(&code), "expiresAt": expires_at, "loginId": login_id }).to_string(),
    );
    *r.status_mut() = StatusCode::CREATED;
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

pub fn routes(
    st: ResetCodeIssueState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<ResetCodeIssueState>>::new()
        .post("/accounts/{id}/password-reset-code", issue)
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
    fn code_shape_matches_ts() {
        for _ in 0..50 {
            let c = new_code();
            assert_eq!(c.len(), RESET_CODE_LENGTH);
            assert!(c.bytes().all(|b| RESET_CODE_ALPHABET.contains(&b)));
            let d = display(&c);
            assert_eq!(d.len(), 14);
            assert_eq!(d.replace('-', ""), c);
        }
    }
}
