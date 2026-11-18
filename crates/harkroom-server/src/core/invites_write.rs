//! S5.4 AC4 — 초대 쓰기 두 줄. TS `routes/accountRoutes.ts` 의 `POST /invites`·`DELETE /invites/:id` 를 옮긴다.
//!
//! - `POST /invites`: `email` 이 있으면 메일(149)로 보낸다 — 앞단에 메일 설정이 없으면 TS 로 넘긴다, 시간당 30통
//!   상한(보내는 사람 advisory lock 안에서 센다) 429 `mail_rate_limited`, 발송 결과는 `mail_status`·감사(가린 주소)에 남는다.
//!   없으면 `requireCap('member.invite')`(401·403) → 본문(400: 객체가 아님·`locale` 이 ko/en 이 아님) → 새 토큰
//!   (`hrki_` + base64url 32바이트, sha256 hex 해시만 저장) → INSERT(만료 `INVITE_TTL_DAYS`=7일) → 감사
//!   `invite.created {inviteId}` → 201 `{id, expiresAt, mail: "off", token}`.
//! - `DELETE /invites/{id}`: `requireCap`(401·403) → 경로(400) → 없음 404 → 쓰임 409 `invite_used` → 이미 취소면 204 →
//!   UPDATE(0줄이면 409) → 감사 `invite.revoked {inviteId}` → 204.
//! - `POST /invites/{id}/resend`: 새 토큰으로 새 초대를 만들어 같은 주소로 보내고 앞 초대를 취소한다(TS 와 같은 검사·차례).
//! - 권한은 [`INVITES_WRITE_PRIVILEGES`] — 없으면 `main.rs` 가 붙이지 않아 TS 에 남는다.
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::lists::is_zod_uuid;
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, record_audit};
use axum::body::to_bytes;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use serde_json::{Value, json};
use sqlx::PgPool;
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
    ("invite.email", "INSERT"),
    ("invite.email", "SELECT"),
    ("invite.last_sent_at", "INSERT"),
    ("invite.last_sent_at", "SELECT"),
    ("invite.created_by", "SELECT"),
    ("invite.mail_status", "UPDATE"),
];

/// TS `MAIL_PER_HOUR`.
pub const MAIL_PER_HOUR: i64 = 30;
/// TS `RESEND_GAP_SEC`.
pub const RESEND_GAP_SEC: i32 = 60;

/// TS `@harkroom/shared` `INVITE_TTL_DAYS`.
pub const INVITE_TTL_DAYS: i32 = 7;

const BODY_LIMIT: usize = 1024 * 1024;

#[derive(Clone)]
pub struct InvitesWriteState {
    pub read: PgPool,
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
    /// None 이면 앞단에 메일 설정이 없다 — TS 가 메일을 켰는지 모르니 `email` 을 실은 발급·다시 보내기는 TS 로 넘긴다.
    pub mailer: Option<Arc<super::invite_mail::Mailer>>,
    pub up: crate::proxy::Upstream,
}

/// 본문 판정 결과.
#[derive(Debug, PartialEq, Eq)]
pub enum Kind {
    /// Rust 가 맡는다.
    Rust,
    /// `email` 칸이 있다 — 메일로 보낸다(소문자·trim 한 주소, ko 여부).
    Mail(String, bool),
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
    let ko = match m.get("locale") {
        None => false,
        Some(Value::String(s)) if s == "ko" => true,
        Some(Value::String(s)) if s == "en" => false,
        Some(_) => return Kind::Bad,
    };
    match m.get("email") {
        None => Kind::Rust,
        Some(Value::String(e)) => {
            let e = e.trim().to_lowercase();
            if e.chars().count() <= 254 && is_email(&e) {
                Kind::Mail(e, ko)
            } else {
                Kind::Bad
            }
        }
        Some(_) => Kind::Bad,
    }
}

/// zod `.email()` 근사: 로컬부 `[A-Za-z0-9_'+\-.]`(점으로 시작·끝·연속 없음) `@` 라벨들 `.` 2자 이상 영문 TLD.
pub fn is_email(e: &str) -> bool {
    let Some((local, domain)) = e.split_once('@') else {
        return false;
    };
    let local_ok = !local.is_empty()
        && !local.starts_with('.')
        && !local.ends_with('.')
        && !local.contains("..")
        && local
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_'+-.".contains(c));
    let labels: Vec<&str> = domain.split('.').collect();
    let domain_ok = labels.len() >= 2
        && labels[..labels.len() - 1].iter().all(|l| {
            !l.is_empty()
                && !l.starts_with('-')
                && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
        && labels
            .last()
            .is_some_and(|t| t.len() >= 2 && t.chars().all(|c| c.is_ascii_alphabetic()));
    local_ok && domain_ok
}

/// 감사에 실을 가린 주소 — TS `maskEmail` (`a***@example.com`).
pub fn mask_email(email: &str) -> String {
    let at = email.rfind('@');
    let (head, tail) = match at {
        Some(i) => (email.get(..1.min(i)).unwrap_or(""), &email[i..]),
        // TS: lastIndexOf = -1 → slice(0, -1) 은 끝 한 글자를 뺀 것, slice(-1) 은 끝 한 글자.
        None => {
            let n = email.char_indices().last().map_or(0, |(i, _)| i);
            (&email[..n], &email[n..])
        }
    };
    format!("{head}***{tail}")
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
    detail: Value,
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
            detail,
        },
    )
    .await;
}

const INSERT: &str = concat!(
    "insert into invite (token_hash, created_by, expires_at, email, last_sent_at)
 values ($1, $2::uuid, now() + make_interval(days => $3), $4, case when $4::text is null then null else now() end)
 returning id::text, ",
    crate::iso!("expires_at")
);
const LOCK: &str = "select pg_advisory_xact_lock(hashtext('invite-mail:' || $1::text))";
const COUNT: &str = "select count(*)::bigint from invite where created_by = $1::uuid and last_sent_at > now() - interval '1 hour'";
const MAIL_STATUS: &str = "update invite set mail_status = $2 where id = $1::uuid";

fn too_many() -> Response {
    json_err(
        StatusCode::TOO_MANY_REQUESTS,
        "mail_rate_limited",
        &format!("at most {MAIL_PER_HOUR} invite mails per hour"),
    )
}

/// TS `lockSenderAndCheckBudget` — 트랜잭션 안에서 부른다.
async fn lock_and_budget(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    account_id: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query(LOCK)
        .bind(account_id)
        .execute(&mut **tx)
        .await?;
    let (n,): (i64,) = sqlx::query_as(COUNT)
        .bind(account_id)
        .fetch_one(&mut **tx)
        .await?;
    Ok(n < MAIL_PER_HOUR)
}

/// TS `sendInvite` — 실패해도 던지지 않고 `failed` 로 남긴다. 로그에는 오류 종류만.
async fn send_invite(
    st: &InvitesWriteState,
    mailer: &super::invite_mail::Mailer,
    me: &crate::auth::Account,
    (id, expires_at): (&str, &str),
    token: &str,
    email: &str,
    ko: bool,
) -> &'static str {
    let msg = super::invite_mail::invite_mail(
        email,
        token,
        &mailer.public_url,
        &me.handle,
        expires_at,
        ko,
    );
    let status = match mailer.send(&msg).await {
        Ok(()) => "sent",
        Err(code) => {
            eprintln!("front: invite mail failed inviteId={id} {code}");
            "failed"
        }
    };
    if let Err(e) = sqlx::query(MAIL_STATUS)
        .bind(id)
        .bind(status)
        .execute(&st.write)
        .await
    {
        eprintln!(
            "front: invite mail_status update failed ({})",
            e.as_database_error().map_or("io", |_| "db")
        );
    }
    status
}

/// 201 `{id, expiresAt, mail[, token]}` — 키 차례를 TS 와 맞춘다(`json!` 은 키를 정렬한다).
fn created(id: String, expires_at: String, mail: &str, token: String) -> Response {
    let tok = if mail == "sent" {
        String::new()
    } else {
        format!(",\"token\":{}", Value::from(token))
    };
    (
        StatusCode::CREATED,
        [(
            axum::http::header::CONTENT_TYPE,
            "application/json; charset=utf-8",
        )],
        format!(
            "{{\"id\":{},\"expiresAt\":{},\"mail\":\"{mail}\"{tok}}}",
            Value::from(id),
            Value::from(expires_at),
        ),
    )
        .into_response()
}

#[allow(clippy::result_large_err)]
async fn read_body(req: Request) -> Result<(Parts, Body, axum::body::Bytes), Response> {
    let (parts, raw) = req.into_parts();
    let bytes = match to_bytes(raw, BODY_LIMIT).await {
        Ok(b) => b,
        Err(_) => {
            return Err(json_err(
                StatusCode::PAYLOAD_TOO_LARGE,
                "fst_err_ctp_body_too_large",
                "Request body is too large",
            ));
        }
    };
    let body = crate::write::fastify_body(&parts.headers, &bytes)?;
    Ok((parts, body, bytes))
}

/// `POST /invites`.
pub async fn create(
    State(st): State<Arc<InvitesWriteState>>,
    RequireAccount(_, auth): RequireAccount,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    req: Request,
) -> Response {
    let (parts, body, bytes) = match read_body(req).await {
        Ok(x) => x,
        Err(r) => return r,
    };
    let me = match crate::perm::require_cap(&st.read, &auth, "member.invite", None).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    let (email, ko) = match classify(&body) {
        Kind::Bad => return bad("body"),
        Kind::Rust => (None, false),
        Kind::Mail(e, ko) => (Some(e), ko),
    };
    let mailer = match (&email, &st.mailer) {
        (Some(_), None) => {
            return super::msg_post::to_ts(st.up.clone(), peer, parts, bytes).await;
        }
        (_, m) => m.clone(),
    };
    let (token, hash) = new_token();
    let row: (String, String) = {
        let mut tx = match st.write.begin().await {
            Ok(t) => t,
            Err(e) => return internal(e),
        };
        if email.is_some() {
            match lock_and_budget(&mut tx, &me.id).await {
                Ok(true) => {}
                Ok(false) => return too_many(),
                Err(e) => return internal(e),
            }
        }
        let row = match sqlx::query_as(INSERT)
            .bind(&hash)
            .bind(&me.id)
            .bind(INVITE_TTL_DAYS)
            .bind(email.as_deref())
            .fetch_one(&mut *tx)
            .await
        {
            Ok(r) => r,
            Err(e) => return internal(e),
        };
        if let Err(e) = tx.commit().await {
            return internal(e);
        }
        row
    };
    let (mail, detail) = match (&email, &mailer) {
        (Some(e), Some(m)) => {
            let mail = send_invite(&st, m, &me, (&row.0, &row.1), &token, e, ko).await;
            (
                mail,
                json!({ "inviteId": row.0, "email": mask_email(e), "mail": mail }),
            )
        }
        _ => ("off", json!({ "inviteId": row.0 })),
    };
    audit(&st, &parts, &me, "invite.created", detail).await;
    created(row.0, row.1, mail, token)
}

const RESEND_CUR: &str = "select email, used_by is not null, revoked_at is not null,
 coalesce(last_sent_at > now() - make_interval(secs => $2), false)
 from invite where id = $1::uuid for update";
const RESEND_REVOKE: &str =
    "update invite set revoked_at = now(), revoked_by = $2::uuid where id = $1::uuid";
const RESEND_INSERT: &str = concat!(
    "insert into invite (token_hash, created_by, expires_at, email, last_sent_at)
 values ($1, $2::uuid, now() + make_interval(days => $3), $4, now())
 returning id::text, ",
    crate::iso!("expires_at")
);

/// `POST /invites/{id}/resend` — TS 와 같은 차례: cap → params → body → (메일 설정 없으면 TS) → (tx) 잠금·검사 → 취소+새 행 → 발송 → 감사.
pub async fn resend(
    State(st): State<Arc<InvitesWriteState>>,
    RequireAccount(_, auth): RequireAccount,
    Path(id): Path<String>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    req: Request,
) -> Response {
    let (parts, body, bytes) = match read_body(req).await {
        Ok(x) => x,
        Err(r) => return r,
    };
    let me = match crate::perm::require_cap(&st.read, &auth, "member.invite", None).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    if !is_zod_uuid(&id) {
        return bad("params");
    }
    // 본문은 `{locale?}` 만 본다(다른 칸은 버린다) — `email` 칸이 있어도 zod 가 무시하므로 classify 를 쓰지 않는다.
    let ko = match &body {
        Body::None | Body::Json(Value::Null) => false,
        Body::Json(Value::Object(m)) => match m.get("locale") {
            None => false,
            Some(Value::String(s)) if s == "ko" => true,
            Some(Value::String(s)) if s == "en" => false,
            Some(_) => return bad("body"),
        },
        _ => return bad("body"),
    };
    let Some(mailer) = st.mailer.clone() else {
        return super::msg_post::to_ts(st.up.clone(), peer, parts, bytes).await;
    };
    let (token, hash) = new_token();
    let (row, email): ((String, String), String) = {
        let mut tx = match st.write.begin().await {
            Ok(t) => t,
            Err(e) => return internal(e),
        };
        // 보내는 사람 잠금을 먼저 — 행 잠금과 순서가 늘 같아야 교착이 없다.
        let budget = match lock_and_budget(&mut tx, &me.id).await {
            Ok(b) => b,
            Err(e) => return internal(e),
        };
        let cur: Option<(Option<String>, bool, bool, bool)> = match sqlx::query_as(RESEND_CUR)
            .bind(&id)
            .bind(RESEND_GAP_SEC)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(r) => r,
            Err(e) => return internal(e),
        };
        let Some((old_email, is_used, is_revoked, recent)) = cur else {
            return json_err(StatusCode::NOT_FOUND, "not_found", "invite not found");
        };
        if is_used {
            return used();
        }
        if is_revoked {
            return json_err(
                StatusCode::CONFLICT,
                "invite_revoked",
                "invite was revoked or replaced; resend the latest one",
            );
        }
        let Some(email) = old_email else {
            return json_err(
                StatusCode::CONFLICT,
                "no_email",
                "this invite has no email address",
            );
        };
        if recent {
            let mut r = json_err(
                StatusCode::TOO_MANY_REQUESTS,
                "resend_too_soon",
                &format!("wait {RESEND_GAP_SEC}s before sending again"),
            );
            r.headers_mut().insert(
                axum::http::header::RETRY_AFTER,
                axum::http::HeaderValue::from(RESEND_GAP_SEC),
            );
            return r;
        }
        if !budget {
            return too_many();
        }
        if let Err(e) = sqlx::query(RESEND_REVOKE)
            .bind(&id)
            .bind(&me.id)
            .execute(&mut *tx)
            .await
        {
            return internal(e);
        }
        let row = match sqlx::query_as(RESEND_INSERT)
            .bind(&hash)
            .bind(&me.id)
            .bind(INVITE_TTL_DAYS)
            .bind(&email)
            .fetch_one(&mut *tx)
            .await
        {
            Ok(r) => r,
            Err(e) => return internal(e),
        };
        if let Err(e) = tx.commit().await {
            return internal(e);
        }
        (row, email)
    };
    let mail = send_invite(&st, &mailer, &me, (&row.0, &row.1), &token, &email, ko).await;
    audit(
        &st,
        &parts,
        &me,
        "invite.resent",
        json!({ "inviteId": row.0, "replaces": id, "email": mask_email(&email), "mail": mail }),
    )
    .await;
    created(row.0, row.1, mail, token)
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
    audit(
        &st,
        &parts,
        &me,
        "invite.revoked",
        json!({ "inviteId": id }),
    )
    .await;
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
        .post("/invites/{id}/resend", resend)
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
        assert_eq!(
            classify(&Body::Json(
                json!({ "email": " A@Example.com ", "locale": "ko" })
            )),
            Kind::Mail("a@example.com".into(), true)
        );
        assert_eq!(classify(&Body::Json(json!({ "email": null }))), Kind::Bad);
        assert_eq!(classify(&Body::Json(json!({ "email": "nope" }))), Kind::Bad);
        assert_eq!(
            classify(&Body::Json(json!({ "email": "a@b.co", "locale": "fr" }))),
            Kind::Bad
        );
        assert_eq!(classify(&Body::Json(json!([]))), Kind::Bad);
        assert_eq!(classify(&Body::Text("x".into())), Kind::Bad);
    }

    #[test]
    fn mask_matches_ts() {
        assert_eq!(mask_email("alice@example.com"), "a***@example.com");
        assert_eq!(mask_email("@x.io"), "***@x.io");
        assert!(is_email("a.b+c@sub.example.com"));
        assert!(!is_email("a..b@example.com"));
        assert!(!is_email("a@example"));
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
