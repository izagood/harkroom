//! S5.4 AU1 — 인증의 가벼운 줄 4개. TS `routes/authRoutes.ts` 의 `GET /auth/me`·`POST /auth/logout` 과
//! `routes/passwordResetRoutes.ts` 의 `GET /auth/password-reset-notices`·`POST /auth/password-reset-notices/ack` 를 옮긴다.
//!
//! - 넷 다 `requireAccount`(401) 뒤다. 남의 것을 가리킬 길이 없다 — 계정 id 는 인증에서만 온다.
//! - `/auth/me` 는 인증이 읽은 계정 칸 + **전역** capability(TS `effectiveCapabilities`). 대상 한정 grant 는 싣지 않는다.
//! - 로그아웃은 **이 자격증명의 세션 한 줄만** 지운다(PAT·오퍼레이터 토큰은 session 표에 없으니 지울 것이 없다 — TS 와 같다).
//! - 권한은 [`AUTH_LIGHT_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
//! - login·register·step-up·bootstrap·claim·재설정 코드 발급/사용은 TS 에 남긴다.
use crate::auth::{Account, RequireAccount};
use crate::directory::{internal, json_err, json_ok};
use crate::perm::{CAPABILITIES, MEMBER_DEFAULT_CAPABILITIES};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, record_audit};
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀이 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. 칸 권한으로 좁힌다(읽기는 역할의 SELECT).
/// 감사 줄(`audit_log` INSERT)은 이미 있는 쓰기 코어 권한이다.
pub const AUTH_LIGHT_PRIVILEGES: &[(&str, &str)] = &[
    ("session", "DELETE"),
    ("password_reset_code.notice_seen_at", "UPDATE"),
];

/// TS `NEVER_GLOBAL` — 전역 grant 로 뜻이 없는 capability.
const NEVER_GLOBAL: &[&str] = &["repo.merge", "repo.read", "api.call"];
/// zod `.max(50)`.
const ACK_IDS_MAX: usize = 50;

#[derive(Clone)]
pub struct AuthLightState {
    pub read: PgPool,
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
}

fn bad() -> Response {
    // 문구는 TS(zod 오류)와 다르다 — 대조는 상태·코드만 본다.
    json_err(StatusCode::BAD_REQUEST, "bad_request", "body: invalid")
}

/// TS `effectiveCapabilities` — 전역 grant 줄은 이미 읽은 것(`global`)을 받는다.
/// 순서: owner·admin 은 `CAPABILITIES` 순서, member 는 기본값 뒤에 줄 순서(TS `Set` 삽입 순서).
pub fn effective(role: &str, global: &[String]) -> Vec<String> {
    match role {
        "owner" | "admin" => CAPABILITIES
            .iter()
            .filter(|c| !NEVER_GLOBAL.contains(c))
            .map(|c| c.to_string())
            .collect(),
        "guest" => Vec::new(),
        _ => {
            let mut out: Vec<String> = MEMBER_DEFAULT_CAPABILITIES
                .iter()
                .map(|c| c.to_string())
                .collect();
            for c in global {
                if !NEVER_GLOBAL.contains(&c.as_str()) && !out.contains(c) {
                    out.push(c.clone());
                }
            }
            out
        }
    }
}

/// TS `AccountView` 꼴 — 인증이 읽은 칸 그대로(`plugin.ts` 의 `ACCOUNT_COLS`).
pub fn account_json(a: &Account, caps: &[String]) -> Value {
    json!({
        "id": a.id,
        "handle": a.handle,
        "displayName": a.display_name,
        "kind": a.kind,
        "isAdmin": a.is_admin,
        "role": a.role,
        "status": a.status,
        "statusText": a.status_text,
        "avatarAttachmentId": a.avatar_attachment_id,
        "capabilities": caps,
    })
}

pub async fn me(
    State(st): State<Arc<AuthLightState>>,
    RequireAccount(me, _): RequireAccount,
) -> Response {
    let global: Vec<String> = if matches!(me.role.as_str(), "owner" | "admin" | "guest") {
        Vec::new()
    } else {
        match sqlx::query_scalar(
            "select distinct capability from account_grant \
              where account_id = $1::uuid and scope = '' and (expires_at is null or expires_at > now()) \
              order by capability",
        )
        .bind(&me.id)
        .fetch_all(&st.read)
        .await
        {
            Ok(v) => v,
            Err(e) => return internal(e),
        }
    };
    json_ok(account_json(&me, &effective(&me.role, &global)).to_string())
}

pub async fn logout(State(st): State<Arc<AuthLightState>>, req: Request) -> Response {
    let (_, RequireAccount(me, auth), parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if let Some(h) = auth.credential_hash.as_deref()
        && let Err(e) = sqlx::query("delete from session where token_hash = $1")
            .bind(h)
            .execute(&st.write)
            .await
    {
        return internal(e);
    }
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "logout",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: None,
            ip: ip.as_deref(),
            detail: json!({}),
        },
    )
    .await;
    StatusCode::NO_CONTENT.into_response()
}

/// 재설정 알림 목록 — 시각은 JS `Date#toJSON` 꼴(밀리초·Z).
macro_rules! iso {
    ($c:literal) => {
        concat!(
            "to_char(",
            $c,
            " at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        )
    };
}
const NOTICES_SQL: &str = concat!(
    "select coalesce(json_agg(json_build_object(",
    "'id', id, 'issuedById', issued_by, ",
    "'issuedAt', ",
    iso!("created_at"),
    ", ",
    "'expiresAt', ",
    iso!("expires_at"),
    ", ",
    "'usedAt', ",
    iso!("used_at"),
    ", ",
    "'revokedAt', ",
    iso!("revoked_at"),
    ") order by created_at desc), '[]')::text ",
    "from (select * from password_reset_code ",
    "where account_id = $1::uuid and notice_seen_at is null ",
    "order by created_at desc limit 20) n"
);

pub async fn notices(
    State(st): State<Arc<AuthLightState>>,
    RequireAccount(me, _): RequireAccount,
) -> Response {
    match sqlx::query_scalar::<_, String>(NOTICES_SQL)
        .bind(&me.id)
        .fetch_one(&st.read)
        .await
    {
        Ok(rows) => json_ok(format!("{{\"notices\":{rows}}}")),
        Err(e) => internal(e),
    }
}

/// zod `z.object({ ids: z.array(z.string().uuid()).max(50).optional() })` 를 `req.body ?? {}` 에 —
/// 모르는 칸은 버린다(strict 아님). Ok(None) 은 「내 것 전부」.
fn parse_ack(body: &Body) -> Result<Option<Vec<String>>, ()> {
    let m = match body {
        Body::None => return Ok(None),
        Body::Json(Value::Object(m)) => m,
        _ => return Err(()),
    };
    match m.get("ids") {
        None => Ok(None),
        Some(Value::Array(a)) if a.len() <= ACK_IDS_MAX => a
            .iter()
            .map(|x| {
                x.as_str()
                    .filter(|s| super::channels::is_uuid(s))
                    .map(str::to_string)
                    .ok_or(())
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        _ => Err(()),
    }
}

pub async fn ack(State(st): State<Arc<AuthLightState>>, req: Request) -> Response {
    let (body, RequireAccount(me, _), _) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let Ok(ids) = parse_ack(&body) else {
        return bad();
    };
    match sqlx::query(
        "update password_reset_code set notice_seen_at = now() \
          where account_id = $1::uuid and notice_seen_at is null and ($2::uuid[] is null or id = any($2::uuid[]))",
    )
    .bind(&me.id)
    .bind(ids)
    .execute(&st.write)
    .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => internal(e),
    }
}

/// 코어 라우터에 합칠 줄 — `sections_write.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    st: AuthLightState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AuthLightState>>::new()
        .get("/auth/me", me)
        .post("/auth/logout", logout)
        .get("/auth/password-reset-notices", notices)
        .post("/auth/password-reset-notices/ack", ack)
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

    const U: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

    #[test]
    fn caps_by_role() {
        let admin = effective("admin", &[]);
        assert!(!admin.iter().any(|c| NEVER_GLOBAL.contains(&c.as_str())));
        assert_eq!(admin.len(), CAPABILITIES.len() - NEVER_GLOBAL.len());
        assert!(effective("guest", &["channel.create".into()]).is_empty());
        assert_eq!(
            effective(
                "member",
                &[
                    "repo.merge".into(),
                    "channel.create".into(),
                    "operator.register".into()
                ]
            ),
            vec!["operator.register", "channel.create"]
        );
    }

    #[test]
    fn ack_body() {
        assert_eq!(parse_ack(&Body::None), Ok(None));
        assert_eq!(parse_ack(&Body::Json(json!({ "x": 1 }))), Ok(None));
        assert_eq!(
            parse_ack(&Body::Json(json!({ "ids": [U] }))),
            Ok(Some(vec![U.to_string()]))
        );
        assert!(parse_ack(&Body::Json(json!({ "ids": ["nope"] }))).is_err());
        assert!(parse_ack(&Body::Json(json!({ "ids": null }))).is_err());
        assert!(parse_ack(&Body::Json(json!([]))).is_err());
        assert!(parse_ack(&Body::Text("x".into())).is_err());
        let many: Vec<&str> = vec![U; 51];
        assert!(parse_ack(&Body::Json(json!({ "ids": many }))).is_err());
    }
}
