//! S5.4 — 가입 표면 셋. TS `routes/authRoutes.ts` 의 `POST /bootstrap`·`POST /claim`·`POST /auth/register` 와
//! `buildServer.ts` 의 주소 단위 리밋 훅(`signup:{ip}`, 15분 10회)을 옮긴다.
//!
//! - **셋을 같이 옮긴다**: `signup:{ip}` 키를 셋이 나눠 쓴다. 일부만 옮기면 TS 리미터와 Rust 리미터가 따로 세어
//!   한도가 사실상 두 배가 된다. 그래서 권한도 [`AUTH_SIGNUP_PRIVILEGES`] 하나로 묶었다 — 없으면 셋 다 TS 에 남는다.
//! - 리미터는 login·step-up·재설정과 같은 인스턴스(`main.rs` 의 `auth_limiter`)다. 키 이름이 달라 서로 세지 않는다.
//! - 순서(모두 리밋 훅 → 본문 읽기 다음):
//!   - `/bootstrap`: 사람 계정이 있으면 409 `already_bootstrapped` → 본문 검증(400 `invalid_request`) → 해시 →
//!     트랜잭션(계정 owner/admin INSERT + 기본 채널 `general`) → 커밋 뒤 감사 `account.created {via:bootstrap,isAdmin:true}`·
//!     `channel.created {via:bootstrap}` → 201 `{id}`.
//!   - `/claim`: 본문 검증(+`claimToken`) → 트랜잭션: 토큰 `for update`(없거나 썼으면 404 `invalid_claim`) → 사람
//!     계정 있으면 409 → 같은 이름 집합이면 400 `handle_taken` → 해시 → 계정 + 채널 + 토큰 소진 → 커밋 뒤 감사(`via:claim`) → 201.
//!   - `/auth/register`: 본문 검증(+`inviteToken`) → 트랜잭션: 초대 `for update`(쓴·취소·만료면 400 `invalid_invite`) →
//!     집합 이름이면 400 `handle_taken` → 해시 → 계정(일반) INSERT + 초대 소진 → 커밋 뒤 감사 `account.created {via:invite}` → 201.
//! - 세션·쿠키는 없다(TS 도 `{id}` 만 준다). 이벤트도 없다(TS `createChannel` 은 이벤트를 내지 않는다).
use crate::directory::{internal, json_err};
use crate::rate_limit::{self, RateLimiter};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, read_body, record_audit};
use crate::writes_settings::js_len;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::sync::Arc;

/// shared `PASSWORD_MIN_LENGTH`·`PASSWORD_MAX_LENGTH`.
const PASSWORD_MIN: usize = 8;
const PASSWORD_MAX: usize = 128;
/// TS `DEFAULT_CHANNEL_NAME`.
pub const DEFAULT_CHANNEL_NAME: &str = "general";
/// services/reservedHandles.ts `DELETED_HANDLE_PREFIX`.
const DELETED_HANDLE_PREFIX: &str = "deleted-";

/// 쓰기 풀에 있어야 하는 칸 권한 — homelab GRANT 와 같아야 한다.
/// `grant select (id, kind), insert (handle, login_id, display_name, kind, is_admin, role, password_hash) on account`,
/// `grant select (id), insert (name, topic, kind, repo, visibility, created_by) on channel`,
/// `grant select (handle) on handle_group`,
/// `grant select (token_hash, used_by, revoked_at, expires_at), update (used_by) on invite`,
/// `grant select (token_hash, used_at), update (used_at, used_by) on claim_token`,
/// `grant insert (action, actor_id, actor_handle, target, ip, detail) on audit_log`.
pub const AUTH_SIGNUP_PRIVILEGES: &[(&str, &str)] = &[
    ("account.id", "SELECT"),
    ("account.kind", "SELECT"),
    ("account.handle", "INSERT"),
    ("account.login_id", "INSERT"),
    ("account.display_name", "INSERT"),
    ("account.kind", "INSERT"),
    ("account.is_admin", "INSERT"),
    ("account.role", "INSERT"),
    ("account.password_hash", "INSERT"),
    ("channel.id", "SELECT"),
    ("channel.name", "INSERT"),
    ("channel.topic", "INSERT"),
    ("channel.kind", "INSERT"),
    ("channel.repo", "INSERT"),
    ("channel.visibility", "INSERT"),
    ("channel.created_by", "INSERT"),
    ("handle_group.handle", "SELECT"),
    ("invite.token_hash", "SELECT"),
    ("invite.used_by", "SELECT"),
    ("invite.revoked_at", "SELECT"),
    ("invite.expires_at", "SELECT"),
    ("invite.used_by", "UPDATE"),
    ("claim_token.token_hash", "SELECT"),
    ("claim_token.used_at", "SELECT"),
    ("claim_token.used_at", "UPDATE"),
    ("claim_token.used_by", "UPDATE"),
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.actor_handle", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.ip", "INSERT"),
    ("audit_log.detail", "INSERT"),
];

pub struct AuthSignupState {
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
    /// `signup:*` 를 세는 리미터(login·step-up·재설정과 같은 인스턴스).
    pub limiter: Arc<RateLimiter>,
}

#[derive(Debug, PartialEq, Eq)]
struct Credentials {
    login_id: String,
    handle: String,
    display_name: String,
    password: String,
    /// `claimToken`·`inviteToken`(경로에 따라).
    token: Option<String>,
}

fn login_id_ok(s: &str) -> bool {
    (2..=32).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn handle_ok(s: &str) -> bool {
    (2..=32).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
        && !s.to_lowercase().starts_with(DELETED_HANDLE_PREFIX)
}

/// zod `credentials`(+ `extend({ <token_key>: z.string() })`).
fn parse_credentials(body: Body, token_key: Option<&str>) -> Option<Credentials> {
    let Body::Json(Value::Object(mut m)) = body else {
        return None;
    };
    fn take(m: &mut Map<String, Value>, k: &str) -> Option<String> {
        match m.remove(k) {
            Some(Value::String(s)) => Some(s),
            _ => None,
        }
    }
    let login_id = take(&mut m, "loginId").filter(|s| login_id_ok(s));
    let handle = take(&mut m, "handle").filter(|s| handle_ok(s));
    let display_name = take(&mut m, "displayName").filter(|s| (1..=64).contains(&js_len(s)));
    let password =
        take(&mut m, "password").filter(|s| (PASSWORD_MIN..=PASSWORD_MAX).contains(&js_len(s)));
    let token = match token_key {
        Some(k) => Some(take(&mut m, k)?),
        None => None,
    };
    Some(Credentials {
        login_id: login_id?,
        handle: handle?,
        display_name: display_name?,
        password: password?,
        token,
    })
}

fn bad_body() -> Response {
    json_err(StatusCode::BAD_REQUEST, "invalid_request", "invalid body")
}

fn created(id: &str) -> Response {
    (
        StatusCode::CREATED,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        json!({ "id": id }).to_string(),
    )
        .into_response()
}

fn already_bootstrapped() -> Response {
    json_err(
        StatusCode::CONFLICT,
        "already_bootstrapped",
        "workspace already has a human account",
    )
}

fn handle_taken() -> Response {
    json_err(
        StatusCode::BAD_REQUEST,
        "handle_taken",
        "a group with this handle already exists",
    )
}

/// onRequest 훅(`signup:{ip}`) → 본문 읽기. 막히면 응답을 돌려준다.
async fn gate(st: &AuthSignupState, req: Request) -> Result<(Option<String>, Body), Response> {
    let (parts, body) = req.into_parts();
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    let v = st.limiter.hit(
        &format!("signup:{}", ip.clone().unwrap_or_default()),
        rate_limit::SIGNUP,
    );
    if !v.allowed {
        return Err(rate_limit::too_many(v, false));
    }
    let body = read_body(&parts.headers, body).await?;
    Ok((ip, body))
}

const HUMAN_EXISTS_SQL: &str = "select 1 from account where kind = 'human' limit 1";
const GROUP_BY_HANDLE_SQL: &str = "select 1 from handle_group g where lower(g.handle) = lower($1)";
const INSERT_OWNER_SQL: &str = "insert into account (handle, login_id, display_name, kind, is_admin, role, password_hash) \
     values ($1, $2, $3, 'human', true, 'owner', $4) returning id::text";
/// services/channels.ts `CREATE_CHANNEL_SQL` — public · topic '' · repo null · created_by null.
const CREATE_DEFAULT_CHANNEL_SQL: &str = "insert into channel (name, topic, kind, repo, visibility, created_by) \
     values ($1, '', 'standard', null, 'public', null::uuid) returning id::text";

async fn audit_first_admin(
    pool: &PgPool,
    ip: Option<&str>,
    handle: &str,
    account_id: &str,
    channel_id: &str,
    via: &str,
) {
    record_audit(
        pool,
        AuditEntry {
            action: "account.created",
            actor_id: Some(account_id),
            actor_handle: Some(handle),
            target: Some(account_id),
            ip,
            detail: json!({ "via": via, "isAdmin": true }),
        },
    )
    .await;
    record_audit(
        pool,
        AuditEntry {
            action: "channel.created",
            actor_id: Some(account_id),
            actor_handle: Some(handle),
            target: Some(channel_id),
            ip,
            detail: json!({ "via": via }),
        },
    )
    .await;
}

/// `POST /bootstrap`.
pub async fn bootstrap(State(st): State<Arc<AuthSignupState>>, req: Request) -> Response {
    let (ip, body) = match gate(&st, req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    match sqlx::query_scalar::<_, i32>(HUMAN_EXISTS_SQL)
        .fetch_optional(&st.write)
        .await
    {
        Ok(Some(_)) => return already_bootstrapped(),
        Ok(None) => {}
        Err(e) => return internal(e),
    }
    let Some(c) = parse_credentials(body, None) else {
        return bad_body();
    };
    let hash = crate::password::hash_async(c.password.clone()).await;
    let res: Result<(String, String), sqlx::Error> = async {
        let mut tx = st.write.begin().await?;
        let account_id: String = sqlx::query_scalar(INSERT_OWNER_SQL)
            .bind(&c.handle)
            .bind(&c.login_id)
            .bind(&c.display_name)
            .bind(&hash)
            .fetch_one(&mut *tx)
            .await?;
        let channel_id: String = sqlx::query_scalar(CREATE_DEFAULT_CHANNEL_SQL)
            .bind(DEFAULT_CHANNEL_NAME)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok((account_id, channel_id))
    }
    .await;
    let (account_id, channel_id) = match res {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    audit_first_admin(
        &st.write,
        ip.as_deref(),
        &c.handle,
        &account_id,
        &channel_id,
        "bootstrap",
    )
    .await;
    created(&account_id)
}

enum Rejected {
    Resp(Response),
    Db(sqlx::Error),
}

impl From<sqlx::Error> for Rejected {
    fn from(e: sqlx::Error) -> Self {
        Rejected::Db(e)
    }
}

/// `POST /claim`.
pub async fn claim(State(st): State<Arc<AuthSignupState>>, req: Request) -> Response {
    let (ip, body) = match gate(&st, req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(c) = parse_credentials(body, Some("claimToken")) else {
        return bad_body();
    };
    let token_hash = crate::auth::hash_token(c.token.as_deref().unwrap_or_default());
    // 거절(404·409·400)은 트랜잭션을 버리면(drop) 롤백된다 — TS 의 `rollback` 과 같다.
    let res: Result<(String, String), Rejected> = async {
        let mut tx = st.write.begin().await?;
        let tok: Option<String> = sqlx::query_scalar(
            "select token_hash from claim_token where token_hash = $1 and used_at is null for update",
        )
        .bind(&token_hash)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(tok) = tok else {
            return Err(Rejected::Resp(json_err(
                StatusCode::NOT_FOUND,
                "invalid_claim",
                "claim token invalid or already used",
            )));
        };
        if sqlx::query_scalar::<_, i32>(HUMAN_EXISTS_SQL)
            .fetch_optional(&mut *tx)
            .await?
            .is_some()
        {
            return Err(Rejected::Resp(already_bootstrapped()));
        }
        if sqlx::query_scalar::<_, i32>(GROUP_BY_HANDLE_SQL)
            .bind(&c.handle)
            .fetch_optional(&mut *tx)
            .await?
            .is_some()
        {
            return Err(Rejected::Resp(handle_taken()));
        }
        let hash = crate::password::hash_async(c.password.clone()).await;
        let account_id: String = sqlx::query_scalar(INSERT_OWNER_SQL)
            .bind(&c.handle)
            .bind(&c.login_id)
            .bind(&c.display_name)
            .bind(&hash)
            .fetch_one(&mut *tx)
            .await?;
        let channel_id: String = sqlx::query_scalar(CREATE_DEFAULT_CHANNEL_SQL)
            .bind(DEFAULT_CHANNEL_NAME)
            .fetch_one(&mut *tx)
            .await?;
        sqlx::query(
            "update claim_token set used_at = now(), used_by = $1::uuid where token_hash = $2",
        )
        .bind(&account_id)
        .bind(&tok)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok((account_id, channel_id))
    }
    .await;
    let (account_id, channel_id) = match res {
        Ok(v) => v,
        Err(Rejected::Resp(r)) => return r,
        Err(Rejected::Db(e)) => return internal(e),
    };
    audit_first_admin(
        &st.write,
        ip.as_deref(),
        &c.handle,
        &account_id,
        &channel_id,
        "claim",
    )
    .await;
    created(&account_id)
}

/// `POST /auth/register`.
pub async fn register(State(st): State<Arc<AuthSignupState>>, req: Request) -> Response {
    let (ip, body) = match gate(&st, req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(c) = parse_credentials(body, Some("inviteToken")) else {
        return bad_body();
    };
    let token_hash = crate::auth::hash_token(c.token.as_deref().unwrap_or_default());
    let res: Result<String, Rejected> = async {
        let mut tx = st.write.begin().await?;
        let inv: Option<String> = sqlx::query_scalar(
            "select token_hash from invite \
              where token_hash = $1 and used_by is null and revoked_at is null \
                and (expires_at is null or expires_at > now()) \
              for update",
        )
        .bind(&token_hash)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(inv) = inv else {
            return Err(Rejected::Resp(json_err(
                StatusCode::BAD_REQUEST,
                "invalid_invite",
                "invite invalid or used",
            )));
        };
        if sqlx::query_scalar::<_, i32>(GROUP_BY_HANDLE_SQL)
            .bind(&c.handle)
            .fetch_optional(&mut *tx)
            .await?
            .is_some()
        {
            return Err(Rejected::Resp(handle_taken()));
        }
        let pw = crate::password::hash_async(c.password.clone()).await;
        let account_id: String = sqlx::query_scalar(
            "insert into account (handle, login_id, display_name, kind, password_hash) \
             values ($1, $2, $3, 'human', $4) returning id::text",
        )
        .bind(&c.handle)
        .bind(&c.login_id)
        .bind(&c.display_name)
        .bind(&pw)
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query("update invite set used_by = $1::uuid where token_hash = $2")
            .bind(&account_id)
            .bind(&inv)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(account_id)
    }
    .await;
    let account_id = match res {
        Ok(v) => v,
        Err(Rejected::Resp(r)) => return r,
        Err(Rejected::Db(e)) => return internal(e),
    };
    record_audit(
        &st.write,
        AuditEntry {
            action: "account.created",
            actor_id: Some(&account_id),
            actor_handle: Some(&c.handle),
            target: Some(&account_id),
            ip: ip.as_deref(),
            detail: json!({ "via": "invite" }),
        },
    )
    .await;
    created(&account_id)
}

pub fn routes(st: AuthSignupState, cors: Arc<crate::cors::Cors>) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AuthSignupState>>::new()
        .post("/bootstrap", bootstrap)
        .post("/claim", claim)
        .post("/auth/register", register)
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

    fn ok_body() -> Value {
        json!({ "loginId": "Alice_1", "handle": "alice", "displayName": "Alice", "password": "12345678" })
    }

    #[test]
    fn credentials_match_zod() {
        let c = parse_credentials(Body::Json(ok_body()), None).unwrap();
        assert_eq!(c.login_id, "Alice_1");
        assert_eq!(c.token, None);
        assert_eq!(parse_credentials(Body::None, None), None);
        assert_eq!(parse_credentials(Body::Text("x".into()), None), None);
        let with = |k: &str, v: Value| {
            let mut b = ok_body();
            b[k] = v;
            parse_credentials(Body::Json(b), None)
        };
        assert!(with("loginId", json!("a")).is_none());
        assert!(with("loginId", json!("a".repeat(33))).is_none());
        assert!(with("loginId", json!("a b")).is_none());
        assert!(with("handle", json!("Alice")).is_none());
        assert!(with("handle", json!("deleted-x")).is_none());
        assert!(with("handle", json!("a-_9")).is_some());
        assert!(with("displayName", json!("")).is_none());
        assert!(with("displayName", json!("가".repeat(64))).is_some());
        assert!(with("displayName", json!("가".repeat(65))).is_none());
        assert!(with("password", json!("1234567")).is_none());
        assert!(with("password", json!("p".repeat(128))).is_some());
        assert!(with("password", json!("p".repeat(129))).is_none());
        assert!(with("password", json!(12345678)).is_none());
    }

    #[test]
    fn token_key_is_required_string() {
        assert!(parse_credentials(Body::Json(ok_body()), Some("inviteToken")).is_none());
        let mut b = ok_body();
        b["claimToken"] = json!(1);
        assert!(parse_credentials(Body::Json(b.clone()), Some("claimToken")).is_none());
        b["claimToken"] = json!("");
        assert_eq!(
            parse_credentials(Body::Json(b), Some("claimToken"))
                .unwrap()
                .token,
            Some(String::new())
        );
    }

    #[test]
    fn privileges_are_column_level() {
        assert!(AUTH_SIGNUP_PRIVILEGES.iter().all(|(t, _)| t.contains('.')));
    }
}
