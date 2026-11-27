//! S5.4 — 에이전트가 값을 받는 길 `POST /agent/secrets/reveal`. TS `routes/secretRoutes.ts`(662)·
//! `services/secretAccess.ts`(`revealSecret`·`RevealLimiter`)를 옮긴다.
//!
//! - 순서는 TS 와 같다: 본문 읽기(fastify 파서 400) → `requireAccount`(401) → 오퍼레이터를 거친 에이전트가 아니면 403 `forbidden`
//!   → 키링 없음·키 틀림은 TS 와 같은 409(`secret_store_disabled`·`secret_key_mismatch`)로 직접 답한다(
//!   `agent_secret_create.rs` 와 같다) → 본문 `{leaseId: uuid, token: 1–200, name: NAME}` 아니면 400 `bad_request`
//!   → `revealSecret`: 임대(id·토큰 해시) 읽기 → 이름으로 비밀 읽기 → 임대가 이 에이전트·오퍼레이터의 것이고 살아 있지 않으면
//!   `lease_invalid` → 비밀 없음 `not_found`(로그 없음) → 속도 제한(에이전트마다 10분에 30회) `rate_limited` → 비밀 만료
//!   `secret_expired` → 소유자 비활성 `owner_inactive` → grant 없음 `not_granted` → 남의 에이전트 `not_own_agent` →
//!   채널 `wrong_channel` → 오퍼레이터 `wrong_operator` → 정지 `grant_suspended` → 지금 판 없음 `no_value` → 못 열면
//!   `unreadable` → access log `granted` → 200 `{secret:{id,name,kind,filename,version}, valueBase64}`.
//!   거절은 비밀을 특정할 수 있을 때마다 `secret_access_log` 에 `denied` 한 줄(TS 처럼 막힌 요청마다 — 창마다 한 번이 아니다).
//!   상태: `not_found` 404, `rate_limited` 429(`retry-after` 없음), `unreadable` 500, 나머지 403. `revealSecret` 뒤의 답은
//!   전부 `cache-control: no-store`.
//! - **속도 제한은 프로세스 로컬이다**(TS 도 인메모리 `RevealLimiter`). TS 의 이 리미터(`deps.secretRevealLimiter`)는 이 줄만
//!   쓴다 — 소유자 보기·만들기의 리미터와 따로다. 그래서 이 줄을 Rust 가 받으면 TS 카운터는 쓰이지 않고 나뉘어 세는 일이 없다.
//!   (키링이 없으면 409 로 끝나 리미터를 세지 않는다 — TS 와 같다.)
//! - 감사(`audit_log`) 줄은 없다(TS 도 없다). **값은 답 본문에만** 싣는다.
//! - `automation.*`·`ingress_*` 칸은 읽지 않는다.
//! - 칸 권한은 [`privileges`] — 쓰기 풀에 하나라도 없거나 키 env 를 읽을 수 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
//!   homelab GRANT:
//!   ```sql
//!   grant select (id, token_hash, agent_id, operator_id, channel_id, thread_root_id, expires_at, ended_at) on secret_turn_lease to <write_role>;
//!   grant select (id, name, kind, filename, expires_at, owner_account_id) on secret to <write_role>;
//!   grant select (id, deleted_at, disabled_at) on account to <write_role>;
//!   grant select (account_id, owner_account_id) on agent_config to <write_role>;
//!   grant select (secret_id, agent_id, channel_id, operator_id, suspended_at) on secret_grant to <write_role>;
//!   grant select (secret_id, version, sealed, revoked_at) on secret_version to <write_role>;
//!   grant insert (secret_id, secret_name, version, agent_id, operator_id, turn_id, channel_id, thread_root_id, result, reason, at) on secret_access_log to <write_role>;
//!   grant usage on sequence secret_access_log_id_seq to <write_role>;
//!   -- 기동 키 확인(`secrets::verify`): select (kid, kcv), insert (kid, kcv) on secret_key_check
//!   ```
use crate::auth::RequireAccount;
use crate::core::secret_reveal::RevealLimiter;
use crate::directory::{internal, json_err, json_ok};
use crate::secrets::keyring::{SecretAad, SecretKeyring};
use crate::secrets::verify::{SECRET_KEY_CHECK_PRIVILEGES, kind_of, load_verified_from_env};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use base64::Engine;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::sync::Arc;

/// 쓰기 풀이 쓰는 칸 권한(표.칸, 권한).
pub const AGENT_SECRET_REVEAL_PRIVILEGES: &[(&str, &str)] = &[
    ("secret_turn_lease.id", "SELECT"),
    ("secret_turn_lease.token_hash", "SELECT"),
    ("secret_turn_lease.agent_id", "SELECT"),
    ("secret_turn_lease.operator_id", "SELECT"),
    ("secret_turn_lease.channel_id", "SELECT"),
    ("secret_turn_lease.thread_root_id", "SELECT"),
    ("secret_turn_lease.expires_at", "SELECT"),
    ("secret_turn_lease.ended_at", "SELECT"),
    ("secret.id", "SELECT"),
    ("secret.name", "SELECT"),
    ("secret.kind", "SELECT"),
    ("secret.filename", "SELECT"),
    ("secret.expires_at", "SELECT"),
    ("secret.owner_account_id", "SELECT"),
    ("account.id", "SELECT"),
    ("account.deleted_at", "SELECT"),
    ("account.disabled_at", "SELECT"),
    ("agent_config.account_id", "SELECT"),
    ("agent_config.owner_account_id", "SELECT"),
    ("secret_grant.secret_id", "SELECT"),
    ("secret_grant.agent_id", "SELECT"),
    ("secret_grant.channel_id", "SELECT"),
    ("secret_grant.operator_id", "SELECT"),
    ("secret_grant.suspended_at", "SELECT"),
    ("secret_version.secret_id", "SELECT"),
    ("secret_version.version", "SELECT"),
    ("secret_version.sealed", "SELECT"),
    ("secret_version.revoked_at", "SELECT"),
    ("secret_access_log.secret_id", "INSERT"),
    ("secret_access_log.secret_name", "INSERT"),
    ("secret_access_log.version", "INSERT"),
    ("secret_access_log.agent_id", "INSERT"),
    ("secret_access_log.operator_id", "INSERT"),
    ("secret_access_log.turn_id", "INSERT"),
    ("secret_access_log.channel_id", "INSERT"),
    ("secret_access_log.thread_root_id", "INSERT"),
    ("secret_access_log.result", "INSERT"),
    ("secret_access_log.reason", "INSERT"),
    ("secret_access_log.at", "INSERT"),
];
/// 시퀀스 권한(`bigserial`).
pub const AGENT_SECRET_REVEAL_SEQUENCES: &[(&str, &str)] = &[("secret_access_log_id_seq", "USAGE")];

/// 모든 표 권한(이 줄 + 기동 키 확인).
pub fn privileges() -> Vec<(&'static str, &'static str)> {
    AGENT_SECRET_REVEAL_PRIVILEGES
        .iter()
        .chain(SECRET_KEY_CHECK_PRIVILEGES)
        .copied()
        .collect()
}

/// TS `revealSecret` 의 임대 읽기 — `$3` 은 TS 가 넘기는 `now`(밀리초 ISO).
const LEASE_SQL: &str = "select id::text, agent_id::text, operator_id::text, channel_id::text, \
            thread_root_id::text, expires_at <= $3::timestamptz as expired, ended_at is not null as ended \
       from secret_turn_lease where id = $1::uuid and token_hash = $2";
/// TS `revealSecret` 의 비밀 읽기.
const SECRET_SQL: &str = "select s.id::text, s.name, s.kind, s.filename, s.expires_at <= $2::timestamptz as expired, \
            (o.deleted_at is not null or o.disabled_at is not null) as owner_inactive, \
            (select c.owner_account_id = s.owner_account_id from agent_config c where c.account_id = $3::uuid) as own_agent \
       from secret s join account o on o.id = s.owner_account_id where s.name = $1";
/// J2c — 조합 전용 길(`agent_combo_credential.rs`)이 쓰는 같은 읽기. 비밀을 **id 로만** 고른다(이름으로 잇지 않는다).
const SECRET_BY_ID_SQL: &str = "select s.id::text, s.name, s.kind, s.filename, s.expires_at <= $2::timestamptz as expired, \
            (o.deleted_at is not null or o.disabled_at is not null) as owner_inactive, \
            (select c.owner_account_id = s.owner_account_id from agent_config c where c.account_id = $3::uuid) as own_agent \
       from secret s join account o on o.id = s.owner_account_id where s.id = $1::uuid";
const GRANTS_SQL: &str = "select channel_id::text, operator_id::text, suspended_at is not null as suspended \
       from secret_grant where secret_id = $1::uuid and agent_id = $2::uuid";
const CURRENT_SQL: &str = "select version, sealed from secret_version \
      where secret_id = $1::uuid and revoked_at is null and sealed is not null order by version desc limit 1";
const LOG_SQL: &str = "insert into secret_access_log (secret_id, secret_name, version, agent_id, operator_id, turn_id, channel_id, thread_root_id, result, reason, at) \
       values ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9, $10, $11::timestamptz)";

const BAD_BODY_MESSAGE: &str = "leaseId, token and a valid name are required";

/// TS `RevealDenial`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevealDenial {
    LeaseInvalid,
    NotFound,
    SecretExpired,
    OwnerInactive,
    NotGranted,
    GrantSuspended,
    WrongChannel,
    WrongOperator,
    NoValue,
    Unreadable,
    RateLimited,
    NotOwnAgent,
}

impl RevealDenial {
    pub fn code(self) -> &'static str {
        use RevealDenial::*;
        match self {
            LeaseInvalid => "lease_invalid",
            NotFound => "not_found",
            SecretExpired => "secret_expired",
            OwnerInactive => "owner_inactive",
            NotGranted => "not_granted",
            GrantSuspended => "grant_suspended",
            WrongChannel => "wrong_channel",
            WrongOperator => "wrong_operator",
            NoValue => "no_value",
            Unreadable => "unreadable",
            RateLimited => "rate_limited",
            NotOwnAgent => "not_own_agent",
        }
    }

    /// TS 라우트의 상태 고르기.
    pub fn status(self) -> StatusCode {
        match self {
            RevealDenial::NotFound => StatusCode::NOT_FOUND,
            RevealDenial::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            RevealDenial::Unreadable => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::FORBIDDEN,
        }
    }
}

/// TS 기본 `new RevealLimiter()` — 에이전트마다 10분에 30회.
pub fn agent_reveal_limiter() -> RevealLimiter {
    RevealLimiter::new(30, 10 * 60_000)
}

pub struct AgentSecretRevealState {
    pub(crate) write: PgPool,
    pub(crate) keyring: Option<SecretKeyring>,
    /// 키는 걸렸는데 확인값과 맞지 않아 꺼졌다(409 `secret_key_mismatch`).
    pub(crate) mismatch: bool,
    limiter: RevealLimiter,
    /// J2c — 실행 조합 자격 길(`/agent/exec-combo*`)을 같이 붙인다. `main.rs` 가 조합 기능·칸 권한을 본 뒤 켠다.
    combo: bool,
}

impl AgentSecretRevealState {
    /// J2c — 조합 자격 길을 같이 붙인다(같은 속도 제한 통을 쓴다).
    pub fn with_combo(mut self, on: bool) -> Self {
        self.combo = on;
        self
    }
}

/// 기동 한 번: 키를 읽어 확인값과 맞춘다. env 가 잘못됐으면 `Err`(이 줄은 TS 에 남는다).
pub async fn load_state(write: PgPool) -> Result<AgentSecretRevealState, String> {
    let v = load_verified_from_env(&write).await?;
    let mismatch = v.as_ref().is_some_and(|v| v.mismatch);
    Ok(AgentSecretRevealState {
        write,
        keyring: v.and_then(|v| v.keyring),
        mismatch,
        limiter: agent_reveal_limiter(),
        combo: false,
    })
}

/// zod `{leaseId: uuid, token: string 1–200, name: NAME}`(엄격하지 않다 — 다른 칸은 버린다).
pub fn parse_body(v: &Value) -> Option<(String, String, String)> {
    use crate::core::secret_writes::{len16, valid_name};
    let o = v.as_object()?;
    let lease_id = o.get("leaseId")?.as_str()?;
    if !crate::lists::is_zod_uuid(lease_id) {
        return None;
    }
    let token = o.get("token")?.as_str()?;
    if !(1..=200).contains(&len16(token)) {
        return None;
    }
    let name = o.get("name")?.as_str()?;
    if !valid_name(name) {
        return None;
    }
    Some((lease_id.to_owned(), token.to_owned(), name.to_owned()))
}

/// TS grant 판정 — (채널, 오퍼레이터, 정지). `not_own_agent` 는 grant 가 하나라도 있을 때 채널보다 먼저 본다.
pub fn judge_grants(
    grants: &[(Option<String>, Option<String>, bool)],
    own_agent: Option<bool>,
    lease_channel: &str,
    operator_id: &str,
) -> Option<RevealDenial> {
    let in_channel: Vec<_> = grants
        .iter()
        .filter(|g| g.0.as_deref().is_none_or(|c| c == lease_channel))
        .collect();
    let on_operator: Vec<_> = in_channel
        .iter()
        .filter(|g| g.1.as_deref().is_none_or(|o| o == operator_id))
        .collect();
    let live = on_operator.iter().any(|g| !g.2);
    if grants.is_empty() {
        return Some(RevealDenial::NotGranted);
    }
    if own_agent != Some(true) {
        return Some(RevealDenial::NotOwnAgent);
    }
    if in_channel.is_empty() {
        return Some(RevealDenial::WrongChannel);
    }
    if on_operator.is_empty() {
        return Some(RevealDenial::WrongOperator);
    }
    if !live {
        return Some(RevealDenial::GrantSuspended);
    }
    None
}

/// 성공 본문 — TS 와 같은 칸 순서.
pub fn reveal_body(
    id: &str,
    name: &str,
    kind: &str,
    filename: Option<&str>,
    version: i32,
    value: &[u8],
) -> String {
    let s = |v: &str| Value::String(v.to_owned()).to_string();
    format!(
        "{{\"secret\":{{\"id\":{},\"name\":{},\"kind\":{},\"filename\":{},\"version\":{version}}},\"valueBase64\":{}}}",
        s(id),
        s(name),
        s(kind),
        filename.map_or_else(|| "null".to_owned(), s),
        s(&base64::engine::general_purpose::STANDARD.encode(value)),
    )
}

fn sha256_hex(s: &str) -> String {
    hex::encode(ring::digest::digest(&ring::digest::SHA256, s.as_bytes()))
}

pub(crate) fn no_store(mut r: Response) -> Response {
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

pub(crate) struct Lease {
    id: String,
    agent_id: String,
    operator_id: String,
    pub(crate) channel_id: String,
    pub(crate) thread_root_id: String,
    expired: bool,
    ended: bool,
}

pub(crate) struct Secret {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) filename: Option<String>,
    expired: Option<bool>,
    owner_inactive: bool,
    own_agent: Option<bool>,
}

/// 어느 비밀인가 — 에이전트 길은 이름, 조합 길은 서버가 고른 id.
#[derive(Clone, Copy)]
pub(crate) enum Sel<'a> {
    Name(&'a str),
    Id(&'a str),
}

pub(crate) enum Revealed {
    Ok {
        secret: Secret,
        version: i32,
        value: crate::secrets::keyring::SecretBytes,
    },
    Denied(RevealDenial),
}

/// 임대(id·토큰 해시) 읽기 — 이 에이전트·오퍼레이터의 것이고 살아 있을 때만 돌려준다.
pub(crate) async fn read_lease(
    st: &AgentSecretRevealState,
    agent_id: &str,
    operator_id: &str,
    lease_id: &str,
    token: &str,
    now: &str,
) -> sqlx::Result<Option<Lease>> {
    let lease = sqlx::query(LEASE_SQL)
        .bind(lease_id)
        .bind(sha256_hex(token))
        .bind(now)
        .fetch_optional(&st.write)
        .await?
        .map(|r| -> sqlx::Result<Lease> {
            Ok(Lease {
                id: r.try_get(0)?,
                agent_id: r.try_get(1)?,
                operator_id: r.try_get(2)?,
                channel_id: r.try_get(3)?,
                thread_root_id: r.try_get(4)?,
                expired: r.try_get(5)?,
                ended: r.try_get(6)?,
            })
        })
        .transpose()?;
    Ok(lease.filter(|l| {
        l.agent_id == agent_id && l.operator_id == operator_id && !l.expired && !l.ended
    }))
}

/// TS `revealSecret`.
async fn reveal_secret(
    st: &AgentSecretRevealState,
    keyring: &SecretKeyring,
    agent_id: &str,
    operator_id: &str,
    lease_id: &str,
    token: &str,
    name: &str,
) -> sqlx::Result<Revealed> {
    let now_ms = crate::core::msg_post::now_ms();
    let now = crate::core::msg_post::iso_ms(now_ms);
    let lease = read_lease(st, agent_id, operator_id, lease_id, token, &now).await?;
    reveal_with(
        st,
        Some(keyring),
        agent_id,
        operator_id,
        lease,
        Sel::Name(name),
        now_ms,
        &now,
    )
    .await
}

/// 임대를 읽은 뒤의 거절 사슬 — 에이전트 길과 조합 길이 같이 쓴다. 키링이 없으면 값을 열 자리에서 `unreadable`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn reveal_with(
    st: &AgentSecretRevealState,
    keyring: Option<&SecretKeyring>,
    agent_id: &str,
    operator_id: &str,
    lease: Option<Lease>,
    sel: Sel<'_>,
    now_ms: i64,
    now: &str,
) -> sqlx::Result<Revealed> {
    let (sql, key) = match sel {
        Sel::Name(n) => (SECRET_SQL, n),
        Sel::Id(i) => (SECRET_BY_ID_SQL, i),
    };
    let secret = sqlx::query(sql)
        .bind(key)
        .bind(now)
        .bind(agent_id)
        .fetch_optional(&st.write)
        .await?
        .map(|r| -> sqlx::Result<Secret> {
            Ok(Secret {
                id: r.try_get(0)?,
                name: r.try_get(1)?,
                kind: r.try_get(2)?,
                filename: r.try_get(3)?,
                expired: r.try_get(4)?,
                owner_inactive: r.try_get(5)?,
                own_agent: r.try_get(6)?,
            })
        })
        .transpose()?;

    let log = |result: &'static str, reason: Option<RevealDenial>, version: Option<i32>| {
        let (secret, lease) = (&secret, &lease);
        async move {
            let Some(s) = secret else {
                return Ok(());
            };
            sqlx::query(LOG_SQL)
                .bind(&s.id)
                .bind(&s.name)
                .bind(version)
                .bind(agent_id)
                .bind(operator_id)
                .bind(lease.as_ref().map(|l| &l.id))
                .bind(lease.as_ref().map(|l| &l.channel_id))
                .bind(lease.as_ref().map(|l| &l.thread_root_id))
                .bind(result)
                .bind(reason.map(RevealDenial::code))
                .bind(now)
                .execute(&st.write)
                .await
                .map(|_| ())
        }
    };
    macro_rules! deny {
        ($d:expr) => {{
            log("denied", Some($d), None).await?;
            return Ok(Revealed::Denied($d));
        }};
    }

    let Some(l) = lease.as_ref() else {
        deny!(RevealDenial::LeaseInvalid);
    };
    let Some(s) = secret.as_ref() else {
        return Ok(Revealed::Denied(RevealDenial::NotFound));
    };
    if !st.limiter.take(agent_id, now_ms) {
        deny!(RevealDenial::RateLimited);
    }
    if s.expired == Some(true) {
        deny!(RevealDenial::SecretExpired);
    }
    if s.owner_inactive {
        deny!(RevealDenial::OwnerInactive);
    }
    let grants: Vec<(Option<String>, Option<String>, bool)> = sqlx::query_as(GRANTS_SQL)
        .bind(&s.id)
        .bind(agent_id)
        .fetch_all(&st.write)
        .await?;
    if let Some(d) = judge_grants(&grants, s.own_agent, &l.channel_id, operator_id) {
        deny!(d);
    }
    let cur: Option<(i32, String)> = sqlx::query_as(CURRENT_SQL)
        .bind(&s.id)
        .fetch_optional(&st.write)
        .await?;
    let Some((version, sealed)) = cur else {
        deny!(RevealDenial::NoValue);
    };
    let value = keyring.zip(kind_of(&s.kind)).and_then(|(keyring, k)| {
        keyring.open(
            &sealed,
            &SecretAad {
                secret_id: &s.id,
                version: i64::from(version),
                kind: k,
            },
        )
    });
    drop(sealed);
    let Some(value) = value else {
        deny!(RevealDenial::Unreadable);
    };
    log("granted", None, Some(version)).await?;
    let secret = secret.expect("checked above");
    Ok(Revealed::Ok {
        secret,
        version,
        value,
    })
}

/// `POST /agent/secrets/reveal`.
pub async fn reveal(State(st): State<Arc<AgentSecretRevealState>>, req: Request) -> Response {
    let (mut parts, body) = req.into_parts();
    let bytes = match axum::body::to_bytes(body, crate::write::BODY_LIMIT).await {
        Ok(b) => b,
        Err(_) => {
            return json_err(
                StatusCode::PAYLOAD_TOO_LARGE,
                "fst_err_ctp_body_too_large",
                "Request body is too large",
            );
        }
    };
    let parsed = match crate::write::fastify_body(&parts.headers, &bytes) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let (me, auth) = match RequireAccount::from_request_parts(&mut parts, &()).await {
        Ok(RequireAccount(me, auth)) => (me, auth),
        Err(r) => return r,
    };
    // TS `viaOperator`.
    let op = match (&me.kind[..], auth.operator.as_ref()) {
        ("agent", Some(op)) => op,
        _ => {
            return json_err(
                StatusCode::FORBIDDEN,
                "forbidden",
                "only an agent through its operator can do this",
            );
        }
    };
    // 키가 없거나 틀리면 TS 와 같은 409(`secret_store_disabled`·`secret_key_mismatch`).
    let Some(keyring) = st.keyring.as_ref() else {
        return crate::core::secret_writes::disabled(st.mismatch);
    };
    let json = match &parsed {
        crate::write::Body::Json(v) => v.clone(),
        crate::write::Body::None => json!({}),
        crate::write::Body::Text(s) => Value::String(s.clone()),
    };
    let Some((lease_id, token, name)) = parse_body(&json) else {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD_BODY_MESSAGE);
    };
    match reveal_secret(&st, keyring, &me.id, &op.id, &lease_id, &token, &name).await {
        Err(e) => internal(e),
        Ok(Revealed::Denied(d)) => no_store(json_err(
            d.status(),
            d.code(),
            &format!("secret not revealed: {}", d.code()),
        )),
        Ok(Revealed::Ok {
            secret,
            version,
            value,
        }) => {
            let body = zeroize::Zeroizing::new(reveal_body(
                &secret.id,
                &secret.name,
                &secret.kind,
                secret.filename.as_deref(),
                version,
                value.as_bytes(),
            ));
            no_store(json_ok(body.as_str().to_owned()))
        }
    }
}

pub fn routes(
    st: AgentSecretRevealState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let mut t = Table::<Arc<AgentSecretRevealState>>::new().post("/agent/secrets/reveal", reveal);
    if st.combo {
        t = t.merge(crate::core::agent_combo_credential::table());
    }
    let t = t
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

    const LEASE: &str = "11111111-1111-4111-8111-111111111111";

    #[test]
    fn body_matches_zod() {
        let ok = parse_body(&json!({"leaseId": LEASE, "token": "t", "name": "gh-token", "x": 1}));
        assert_eq!(
            ok,
            Some((LEASE.to_owned(), "t".to_owned(), "gh-token".to_owned()))
        );
        assert!(parse_body(&json!({"leaseId": "nope", "token": "t", "name": "a"})).is_none());
        assert!(parse_body(&json!({"leaseId": LEASE, "token": "", "name": "a"})).is_none());
        assert!(
            parse_body(&json!({"leaseId": LEASE, "token": "x".repeat(201), "name": "a"})).is_none()
        );
        assert!(parse_body(&json!({"leaseId": LEASE, "token": "t", "name": "Bad"})).is_none());
        assert!(parse_body(&json!({"leaseId": LEASE, "token": "t"})).is_none());
        assert!(parse_body(&json!([])).is_none());
        assert!(parse_body(&json!({})).is_none());
    }

    #[test]
    fn status_matches_ts_route() {
        use RevealDenial::*;
        assert_eq!(NotFound.status(), StatusCode::NOT_FOUND);
        assert_eq!(RateLimited.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(Unreadable.status(), StatusCode::INTERNAL_SERVER_ERROR);
        for d in [
            LeaseInvalid,
            SecretExpired,
            OwnerInactive,
            NotGranted,
            GrantSuspended,
            WrongChannel,
            WrongOperator,
            NoValue,
            NotOwnAgent,
        ] {
            assert_eq!(d.status(), StatusCode::FORBIDDEN, "{}", d.code());
        }
    }

    #[test]
    fn grant_order_matches_ts() {
        let g = |c: Option<&str>, o: Option<&str>, s: bool| {
            (c.map(String::from), o.map(String::from), s)
        };
        use RevealDenial::*;
        assert_eq!(judge_grants(&[], Some(true), "c", "op"), Some(NotGranted));
        assert_eq!(judge_grants(&[], None, "c", "op"), Some(NotGranted));
        let any = [g(None, None, false)];
        assert_eq!(
            judge_grants(&any, Some(false), "c", "op"),
            Some(NotOwnAgent)
        );
        assert_eq!(judge_grants(&any, None, "c", "op"), Some(NotOwnAgent));
        assert_eq!(judge_grants(&any, Some(true), "c", "op"), None);
        assert_eq!(
            judge_grants(&[g(Some("x"), None, false)], Some(true), "c", "op"),
            Some(WrongChannel)
        );
        assert_eq!(
            judge_grants(&[g(Some("c"), Some("other"), false)], Some(true), "c", "op"),
            Some(WrongOperator)
        );
        assert_eq!(
            judge_grants(&[g(Some("c"), Some("op"), true)], Some(true), "c", "op"),
            Some(GrantSuspended)
        );
        assert_eq!(
            judge_grants(
                &[g(Some("c"), Some("op"), true), g(None, Some("op"), false)],
                Some(true),
                "c",
                "op"
            ),
            None
        );
    }

    #[test]
    fn body_shape_matches_ts() {
        assert_eq!(
            reveal_body("i", "k", "text", None, 3, b"hi"),
            r#"{"secret":{"id":"i","name":"k","kind":"text","filename":null,"version":3},"valueBase64":"aGk="}"#
        );
        assert_eq!(
            reveal_body("i", "f", "file", Some("id_rsa"), 1, &[0xff, 0]),
            r#"{"secret":{"id":"i","name":"f","kind":"file","filename":"id_rsa","version":1},"valueBase64":"/wA="}"#
        );
    }

    #[test]
    fn limiter_is_thirty_per_ten_minutes() {
        let l = agent_reveal_limiter();
        for i in 0..30 {
            assert!(l.take("a", i));
        }
        assert!(!l.take("a", 31));
        assert!(l.take("b", 31));
        assert!(l.take("a", 600_000));
    }

    #[test]
    fn privileges_cover_tables_and_skip_automation() {
        let p = privileges();
        for t in [
            "secret_turn_lease.token_hash",
            "secret_grant.operator_id",
            "secret_access_log.at",
            "secret_key_check.kcv",
        ] {
            assert!(p.iter().any(|(c, _)| *c == t), "{t}");
        }
        assert!(
            p.iter()
                .all(|(c, _)| !c.starts_with("automation") && !c.contains("ingress_"))
        );
    }
}
