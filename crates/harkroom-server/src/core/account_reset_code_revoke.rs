//! S5.4 — 재설정 코드 거두기 한 줄. TS `routes/passwordResetRoutes.ts` 의 `DELETE /accounts/:id/password-reset-code` 를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireCap('member.reset_password')`(401·403) → 경로 zod(400) → `targetFor`
//!   (자기 자신 400 `self` → 사람·살아 있음·꺼지지 않음 아니면 404 → owner 대상 403 `owner_target` → admin 대상은 owner 만 403 `forbidden`).
//! - 살아 있는 코드가 없어도 204(멱등). 거둔 줄이 있을 때만 감사 한 줄(코드 없음).
//! - 쓰기는 [`ACCOUNT_RESET_CODE_REVOKE_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
//!   발급(`POST`, step-up·코드 생성)은 TS 에 남긴다.
use crate::auth::Auth;
use crate::directory::{internal, json_err};
use crate::perm::require_cap;
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, record_audit};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀이 쓰는 권한(표, 권한) — 칸 권한으로 좁힌다(읽기는 역할의 SELECT).
pub const ACCOUNT_RESET_CODE_REVOKE_PRIVILEGES: &[(&str, &str)] = &[
    ("password_reset_code.revoked_at", "UPDATE"),
    ("audit_log", "INSERT"),
];

pub struct ResetCodeRevokeState {
    pub read: PgPool,
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
}

/// TS `targetFor` 의 거절 갈래 — None 이면 지나간다.
pub(crate) fn target_refusal(
    actor_id: &str,
    actor_role: &str,
    id: &str,
    target_role: Option<&str>,
) -> Option<(StatusCode, &'static str, &'static str)> {
    if id == actor_id {
        return Some((
            StatusCode::BAD_REQUEST,
            "self",
            "use POST /auth/password for your own password",
        ));
    }
    match target_role {
        None => Some((StatusCode::NOT_FOUND, "not_found", "no such person")),
        Some("owner") => Some((
            StatusCode::FORBIDDEN,
            "owner_target",
            "an owner password is reset with the server tool, not a code",
        )),
        Some("admin") if actor_role != "owner" => Some((
            StatusCode::FORBIDDEN,
            "forbidden",
            "only the owner can issue a reset code for an admin",
        )),
        Some(_) => None,
    }
}

pub async fn revoke(
    State(st): State<Arc<ResetCodeRevokeState>>,
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
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    let role: Option<String> = if id == actor.id {
        None
    } else {
        match sqlx::query_scalar(
            "select role from account \
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
    if let Some((s, c, m)) = target_refusal(&actor.id, &actor.role, &id, role.as_deref()) {
        return json_err(s, c, m);
    }
    let n = match sqlx::query(
        "update password_reset_code set revoked_at = now() \
          where account_id = $1::uuid and used_at is null and revoked_at is null",
    )
    .bind(&id)
    .execute(&st.write)
    .await
    {
        Ok(r) => r.rows_affected(),
        Err(e) => return internal(e),
    };
    if n > 0 {
        let ip = crate::writes_settings::ip_of(&parts, &st.trust);
        record_audit(
            &st.write,
            AuditEntry {
                action: "password_reset_code.revoked",
                actor_id: Some(&actor.id),
                actor_handle: Some(&actor.handle),
                target: Some(&id),
                ip: ip.as_deref(),
                detail: json!({}),
            },
        )
        .await;
    }
    StatusCode::NO_CONTENT.into_response()
}

pub fn routes(
    st: ResetCodeRevokeState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<ResetCodeRevokeState>>::new()
        .delete("/accounts/{id}/password-reset-code", revoke)
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
    use super::target_refusal as t;
    use axum::http::StatusCode;

    #[test]
    fn target_refusals_follow_ts_order() {
        assert_eq!(
            t("a", "owner", "a", Some("member")).map(|x| x.1),
            Some("self")
        );
        assert_eq!(
            t("a", "owner", "b", None).map(|x| x.0),
            Some(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            t("a", "owner", "b", Some("owner")).map(|x| x.1),
            Some("owner_target")
        );
        assert_eq!(
            t("a", "admin", "b", Some("admin")).map(|x| x.1),
            Some("forbidden")
        );
        assert_eq!(t("a", "owner", "b", Some("admin")), None);
        assert_eq!(t("a", "admin", "b", Some("member")), None);
    }
}
