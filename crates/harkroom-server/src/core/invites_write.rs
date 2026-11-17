//! S5.4 AC4 — 초대 쓰기 두 줄. TS `routes/accountRoutes.ts` 의 `POST /invites`·`DELETE /invites/:id` 를 옮긴다.
//!
//! - `POST /invites`: 본문에 `email` 칸이 **있으면** 그대로 TS 로 넘긴다(메일 발송·시간당 상한·`mail_disabled` 는 TS 몫).
//!   없으면 `requireCap('member.invite')`(401·403) → 본문(400: 객체가 아님·`locale` 이 ko/en 이 아님) → 새 토큰
//!   (`hrki_` + base64url 32바이트, sha256 hex 해시만 저장) → INSERT(만료 `INVITE_TTL_DAYS`=7일) → 감사
//!   `invite.created {inviteId}` → 201 `{id, expiresAt, mail: "off", token}`.
//! - `DELETE /invites/{id}`: `requireCap`(401·403) → 경로(400) → 없음 404 → 쓰임 409 `invite_used` → 이미 취소면 204 →
//!   UPDATE(0줄이면 409) → 감사 `invite.revoked {inviteId}` → 204.
//! - `POST /invites/{id}/resend` 는 언제나 메일을 보내므로 옮기지 않는다(TS).
//! - 권한은 [`INVITES_WRITE_PRIVILEGES`] — 없으면 `main.rs` 가 붙이지 않아 TS 에 남는다.
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::lists::is_zod_uuid;
use crate::proxy::Upstream;
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, record_audit};
use axum::body::to_bytes;
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::Arc;

/// 쓰기 풀이 쓰는 칸 권한. 감사(`audit_log` INSERT)는 이미 있는 쓰기 코어 권한이다.
pub const INVITES_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("invite.token_hash", "INSERT"),
    ("invite.created_by", "INSERT"),
    ("invite.expires_at", "INSERT"),
    ("invite.id", "SELECT"),
    ("invite.expires_at", "SELECT"),
    ("invite.used_by", "SELECT"),
    ("invite.revoked_at", "SELECT"),
    ("invite.revoked_at", "UPDATE"),
    ("invite.revoked_by", "UPDATE"),
];

/// TS `@harkroom/shared` `INVITE_TTL_DAYS`.
pub const INVITE_TTL_DAYS: i32 = 7;

const BODY_LIMIT: usize = 1024 * 1024;

#[derive(Clone)]
pub struct InvitesWriteState {
    pub read: PgPool,
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
    pub up: Upstream,
}

/// 본문 판정 결과.
#[derive(Debug, PartialEq, Eq)]
pub enum Kind {
    /// Rust 가 맡는다.
    Rust,
    /// `email` 칸이 있다 — TS 몫.
    Ts,
    /// 400.
    Bad,
}

/// 본문 판정.
/// zod `z.object({email?, locale?: enum}).default({})` 를 `req.body ?? {}` 에 건다 — 본문 없음·JSON `null` 은 `{}`.
pub fn classify(body: &Body) -> Kind {
    let m = match body {
        Body::None | Body::Json(Value::Null) => return Kind::Rust,
        Body::Json(Value::Object(m)) => m,
        _ => return Kind::Bad,
    };
    if m.contains_key("email") {
        return Kind::Ts;
    }
    match m.get("locale") {
        None => Kind::Rust,
        Some(Value::String(s)) if s == "ko" || s == "en" => Kind::Rust,
        Some(_) => Kind::Bad,
    }
}

/// TS `newToken('hrki')`.
pub fn new_token() -> (String, String) {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("os random");
    let token = format!(
        "hrki_{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
    );
    let hash = crate::auth::hash_token(&token);
    (token, hash)
}

fn bad(what: &str) -> Response {
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        &format!("{what}: invalid"),
    )
}

async fn audit(
    st: &InvitesWriteState,
    parts: &Parts,
    me: &crate::auth::Account,
    action: &'static str,
    id: &str,
) {
    let ip = crate::writes_settings::ip_of(parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action,
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: None,
            ip: ip.as_deref(),
            detail: json!({ "inviteId": id }),
        },
    )
    .await;
}

const INSERT: &str = concat!(
    "insert into invite (token_hash, created_by, expires_at)
 values ($1, $2::uuid, now() + make_interval(days => $3))
 returning id::text, ",
    crate::iso!("expires_at")
);

/// `POST /invites`.
pub async fn create(
    State(st): State<Arc<InvitesWriteState>>,
    RequireAccount(_, auth): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let (parts, raw) = req.into_parts();
    let bytes = match to_bytes(raw, BODY_LIMIT).await {
        Ok(b) => b,
        Err(_) => {
            return json_err(
                StatusCode::PAYLOAD_TOO_LARGE,
                "fst_err_ctp_body_too_large",
                "Request body is too large",
            );
        }
    };
    let body = match crate::write::fastify_body(&parts.headers, &bytes) {
        Ok(b) => b,
        Err(r) => return r,
    };
    // 메일이 실린 요청은 판정 전부를 TS 에 맡긴다(cap 판정도 TS 가 같은 차례로 한다).
    if classify(&body) == Kind::Ts {
        return crate::proxy::forward(
            State(st.up.clone()),
            ConnectInfo(peer),
            Request::from_parts(parts, axum::body::Body::from(bytes)),
        )
        .await;
    }
    let me = match crate::perm::require_cap(&st.read, &auth, "member.invite", None).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    if classify(&body) == Kind::Bad {
        return bad("body");
    }
    let (token, hash) = new_token();
    let row: (String, String) = match sqlx::query_as(INSERT)
        .bind(&hash)
        .bind(&me.id)
        .bind(INVITE_TTL_DAYS)
        .fetch_one(&st.write)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    audit(&st, &parts, &me, "invite.created", &row.0).await;
    (
        StatusCode::CREATED,
        [(
            axum::http::header::CONTENT_TYPE,
            "application/json; charset=utf-8",
        )],
        // 키 차례를 TS(`{id, expiresAt, mail, token}`)와 맞춘다 — `json!` 은 키를 정렬한다.
        format!(
            "{{\"id\":{},\"expiresAt\":{},\"mail\":\"off\",\"token\":{}}}",
            Value::from(row.0),
            Value::from(row.1),
            Value::from(token)
        ),
    )
        .into_response()
}

const CUR: &str =
    "select used_by is not null, revoked_at is not null from invite where id = $1::uuid";
const REVOKE: &str = "update invite set revoked_at = now(), revoked_by = $2::uuid
 where id = $1::uuid and used_by is null and revoked_at is null";

fn used() -> Response {
    json_err(StatusCode::CONFLICT, "invite_used", "invite already used")
}

/// `DELETE /invites/{id}`.
pub async fn revoke(
    State(st): State<Arc<InvitesWriteState>>,
    RequireAccount(_, auth): RequireAccount,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (parts, _) = req.into_parts();
    let me = match crate::perm::require_cap(&st.read, &auth, "member.invite", None).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    if !is_zod_uuid(&id) {
        return bad("params");
    }
    let cur: Option<(bool, bool)> = match sqlx::query_as(CUR)
        .bind(&id)
        .fetch_optional(&st.write)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some((is_used, is_revoked)) = cur else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "invite not found");
    };
    if is_used {
        return used();
    }
    if is_revoked {
        return StatusCode::NO_CONTENT.into_response();
    }
    match sqlx::query(REVOKE)
        .bind(&id)
        .bind(&me.id)
        .execute(&st.write)
        .await
    {
        Ok(r) if r.rows_affected() == 0 => return used(),
        Ok(_) => {}
        Err(e) => return internal(e),
    }
    audit(&st, &parts, &me, "invite.revoked", &id).await;
    StatusCode::NO_CONTENT.into_response()
}

pub fn routes(
    st: InvitesWriteState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<InvitesWriteState>>::new()
        .post("/invites", create)
        .delete("/invites/{id}", revoke)
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
    fn body_follows_zod_default() {
        assert_eq!(classify(&Body::None), Kind::Rust);
        assert_eq!(classify(&Body::Json(Value::Null)), Kind::Rust);
        assert_eq!(classify(&Body::Json(json!({}))), Kind::Rust);
        assert_eq!(
            classify(&Body::Json(json!({ "locale": "ko", "x": 1 }))),
            Kind::Rust
        );
        assert_eq!(classify(&Body::Json(json!({ "locale": "fr" }))), Kind::Bad);
        assert_eq!(classify(&Body::Json(json!({ "email": "a@b.c" }))), Kind::Ts);
        assert_eq!(
            classify(&Body::Json(json!({ "email": null, "locale": "fr" }))),
            Kind::Ts
        );
        assert_eq!(classify(&Body::Json(json!([]))), Kind::Bad);
        assert_eq!(classify(&Body::Text("x".into())), Kind::Bad);
    }

    #[test]
    fn token_matches_ts_shape() {
        let (t, h) = new_token();
        assert!(t.starts_with("hrki_"));
        assert_eq!(t.len(), 5 + 43);
        assert_eq!(h, crate::auth::hash_token(&t));
        assert_eq!(h.len(), 64);
    }
}
