//! S5.4 SE4 — 에이전트가 비밀을 만드는 길(102). TS `services/secretCreate.ts`·`routes/secretRoutes.ts` 를 옮긴다.
//!
//! - **옮긴 줄**: `GET /agent/secret-create` → `{ granted }`(러너가 프롬프트에 만들기 절을 쓸지 고른다. 판정이 아니다).
//!   차례는 TS 와 같다: 인증(401) → 오퍼레이터를 거친 에이전트(403) → `cache-control: no-store` →
//!   `granted = 키링이 있음 && secret.create 부여가 살아 있음`.
//! - **TS 에 남는 줄**: `POST /agent/secrets`·`POST /agent/secrets/rotate`. 이유:
//!   1. 둘이 같은 인메모리 속도 제한(`createLimiter`, 에이전트마다 시간당 10회)을 나눠 쓴다. 한쪽만 옮기면 상한이 둘로 갈라진다
//!      ([`crate::rate_limit`] 머리말 규칙). 둘을 같이 옮겨야 한다.
//!   2. 성공 뒤 소유자 알림(`notifyOwner`)이 `postMessage` 전체(인박스·푸시·i18n 표지·`serverNotice`)를 탄다.
//!   3. import 의 "마운트된 값" 판정(F4)은 살아 있는 임대의 봉투를 전부 풀어 견준다(아직 안 옮김 — import 는 TS 로 넘겨야 한다).
//!      generate 값 만들기([`generate_value`], ssh_ed25519 는 이미 있는 `ring` 으로)는 옮겨 두었다.
//!
//! 두 줄을 옮길 때 쓰기 풀에 필요한 칸 권한(TS `secretCreate.ts` 가 닿는 칸, `automation.*` 은 읽지 않는다):
//! SELECT secret_turn_lease(id, agent_id, operator_id, channel_id, thread_root_id, cause_message_id, expires_at, ended_at, token_hash),
//! agent_config(account_id, owner_account_id), account(id, kind, handle, deleted_at, disabled_at), message(id, author_id, meta),
//! secret(id, name, kind, description, expires_at, created_by_agent_id), secret_version(secret_id, version, created_by, sealed),
//! secret_grant(secret_id, agent_id, granted_by, channel_id, suspended_at), secret_access_log(secret_id, version, turn_id, result);
//! INSERT secret(name, kind, filename, description, owner_account_id, expires_at, created_by_agent_id, created_cause_message_id),
//! secret_version(secret_id, version, sealed, size_bytes, created_by), secret_grant(secret_id, agent_id, channel_id, operator_id, granted_by),
//! secret_access_log(secret_id, secret_name, version, agent_id, operator_id, turn_id, channel_id, thread_root_id, result, reason, at);
//! UPDATE secret_version(sealed, revoked_at), secret(updated_at); 그리고 감사(`record_audit`)·`msg_post::post` 가 쓰는 칸.
//!
//!   그 대신 판정 조각([`cause_by_owner`]·[`check_length`]·[`CreateDenial::status`]·[`CreateLimiter`])은 여기서 TS 와
//! 같게 옮겨 단위 시험으로 묶어 둔다 — 다음 회차가 두 줄을 옮길 때 그대로 쓴다.
//! - 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 [`privileges`] 가 다 있을 때만 선다(`main.rs`). 키 env 를 읽을 수 없으면
//!   TS 에 남는다(TS 와 같이 키가 없거나 틀리면 `granted: false`).
use crate::auth::{Account, RequireAccount};
use crate::directory::{internal, json_err, json_ok};
use crate::secrets::verify::{SECRET_KEY_CHECK_PRIVILEGES, load_verified_from_env};
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::Response;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// TS `hasCreateGrant` 가 읽는 칸.
pub const AGENT_SECRET_CREATE_PRIVILEGES: &[(&str, &str)] = &[
    ("account_grant.account_id", "SELECT"),
    ("account_grant.capability", "SELECT"),
    ("account_grant.scope", "SELECT"),
    ("account_grant.expires_at", "SELECT"),
    ("account_grant.suspended_at", "SELECT"),
];

/// 모든 권한(이 줄 + 기동 키 확인).
pub fn privileges() -> Vec<(&'static str, &'static str)> {
    AGENT_SECRET_CREATE_PRIVILEGES
        .iter()
        .chain(SECRET_KEY_CHECK_PRIVILEGES)
        .copied()
        .collect()
}

/// TS `hasCreateGrant`.
const HAS_CREATE_GRANT_SQL: &str = "select 1 from account_grant \
     where account_id = $1::uuid and capability = 'secret.create' and scope = '' \
       and (expires_at is null or expires_at > now()) and suspended_at is null limit 1";

/// TS `AGENT_SECRET_MAX`·`AGENT_SECRET_DEFAULT_DAYS`·`AGENT_SECRET_MAX_DAYS`·`SECRET_CREATE_MAX_BYTES`.
pub const AGENT_SECRET_MAX: i64 = 20;
pub const AGENT_SECRET_DEFAULT_DAYS: i64 = 90;
pub const AGENT_SECRET_MAX_DAYS: i64 = 365;
pub const SECRET_CREATE_MAX_BYTES: usize = 64 * 1024;

/// TS `CreateDenial`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateDenial {
    LeaseInvalid,
    NotGranted,
    CauseNotOwner,
    RateLimited,
    TooMany,
    BadValue,
    BadLength,
    ValueIsMounted,
    SecretInDescription,
    NameTaken,
    NotFound,
    AdoptedByOwner,
    GrantSuspended,
    SecretExpired,
    KindMismatch,
    OwnerInactive,
}

impl CreateDenial {
    pub fn code(self) -> &'static str {
        use CreateDenial::*;
        match self {
            LeaseInvalid => "lease_invalid",
            NotGranted => "not_granted",
            CauseNotOwner => "cause_not_owner",
            RateLimited => "rate_limited",
            TooMany => "too_many",
            BadValue => "bad_value",
            BadLength => "bad_length",
            ValueIsMounted => "value_is_mounted",
            SecretInDescription => "secret_in_description",
            NameTaken => "name_taken",
            NotFound => "not_found",
            AdoptedByOwner => "adopted_by_owner",
            GrantSuspended => "grant_suspended",
            SecretExpired => "secret_expired",
            KindMismatch => "kind_mismatch",
            OwnerInactive => "owner_inactive",
        }
    }

    /// TS `createStatus`.
    pub fn status(self) -> StatusCode {
        use CreateDenial::*;
        match self {
            LeaseInvalid | NotGranted | CauseNotOwner | OwnerInactive | GrantSuspended => {
                StatusCode::FORBIDDEN
            }
            RateLimited => StatusCode::TOO_MANY_REQUESTS,
            NotFound => StatusCode::NOT_FOUND,
            BadValue | BadLength | SecretInDescription | KindMismatch => StatusCode::BAD_REQUEST,
            TooMany | NameTaken | ValueIsMounted | AdoptedByOwner | SecretExpired => {
                StatusCode::CONFLICT
            }
        }
    }
}

/// TS `causeByOwner` 가 보는 임대 칸.
#[derive(Debug, Clone, Default)]
pub struct LeaseCause<'a> {
    pub agent_id: &'a str,
    pub owner_id: Option<&'a str>,
    pub cause_author_id: Option<&'a str>,
    pub cause_kind: Option<&'a str>,
    pub cause_ask_author_id: Option<&'a str>,
    pub ask_answered_by: Option<&'a str>,
    pub ask_answerer_kind: Option<&'a str>,
}

/// TS `causeByOwner`(F2) — 턴을 띄운 글이 이 에이전트 소유자의 사람 글이거나, 소유자가 이 에이전트 자신의 선택 카드에 답한 턴.
pub fn cause_by_owner(l: &LeaseCause<'_>) -> bool {
    let Some(owner) = l.owner_id else {
        return false;
    };
    if l.cause_kind == Some("human") && l.cause_author_id == Some(owner) {
        return true;
    }
    l.cause_ask_author_id == Some(l.agent_id)
        && l.ask_answered_by == Some(owner)
        && l.ask_answerer_kind == Some("human")
}

/// TS `GENERATE_TYPES`.
pub const GENERATE_TYPES: &[&str] = &["password", "token_hex", "token_base64url", "ssh_ed25519"];

/// TS `generateValue` 의 길이 판정. `Ok(Some(n))` = 그 길이로 만든다, `Ok(None)` = ssh(길이 없음).
/// password 는 글자 수, token_* 는 바이트 수. 모르는 종류는 `None`(라우트의 zod 가 먼저 400 으로 거른다).
pub fn check_length(kind: &str, length: Option<i64>) -> Option<Result<Option<i64>, CreateDenial>> {
    let (min, max, def) = match kind {
        "ssh_ed25519" => {
            return Some(match length {
                Some(_) => Err(CreateDenial::BadLength),
                None => Ok(None),
            });
        }
        "password" => (16, 128, 32),
        "token_hex" | "token_base64url" => (16, 64, 32),
        _ => return None,
    };
    let n = length.unwrap_or(def);
    Some(if (min..=max).contains(&n) {
        Ok(Some(n))
    } else {
        Err(CreateDenial::BadLength)
    })
}

/// TS `PASSWORD_ALPHABET`.
const PASSWORD_ALPHABET: &[u8] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%+-.=@^_~";

/// TS `generateValue` 의 결과(성공). 값은 [`Zeroizing`] 으로 잡는다.
pub struct Generated {
    pub kind: &'static str,
    pub filename: Option<&'static str>,
    pub value: zeroize::Zeroizing<Vec<u8>>,
    pub public_key: Option<String>,
}

/// TS `randomInt(n)` — 치우침 없는 균등(거절 표집).
fn random_below(n: u8) -> u8 {
    let limit = u8::MAX - (u8::MAX % n);
    loop {
        let mut b = [0u8; 1];
        getrandom::fill(&mut b).expect("os random");
        if b[0] < limit {
            return b[0] % n;
        }
    }
}

fn ssh_string(out: &mut Vec<u8>, b: &[u8]) {
    out.extend_from_slice(&(b.len() as u32).to_be_bytes());
    out.extend_from_slice(b);
}

/// TS `sshEd25519` — OpenSSH `openssh-key-v1`(암호 없음). 공개키 줄의 주석은 `comment`.
pub fn ssh_ed25519(comment: &str) -> (zeroize::Zeroizing<Vec<u8>>, String) {
    use base64::Engine;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    let doc =
        Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).expect("ed25519 keygen");
    let kp = Ed25519KeyPair::from_pkcs8(doc.as_ref()).expect("ed25519 pkcs8");
    let pubk = kp.public_key().as_ref().to_vec();
    // ring 의 PKCS#8 v2 모양: 16 바이트 머리 + 시드 32 바이트 + … + 공개키 32 바이트.
    let seed = zeroize::Zeroizing::new(doc.as_ref()[16..48].to_vec());
    let mut pub_blob = Vec::new();
    ssh_string(&mut pub_blob, b"ssh-ed25519");
    ssh_string(&mut pub_blob, &pubk);
    let mut check = [0u8; 4];
    getrandom::fill(&mut check).expect("os random");
    let mut priv_ = zeroize::Zeroizing::new(Vec::new());
    priv_.extend_from_slice(&check);
    priv_.extend_from_slice(&check);
    ssh_string(&mut priv_, b"ssh-ed25519");
    ssh_string(&mut priv_, &pubk);
    let mut sk = zeroize::Zeroizing::new(seed.to_vec());
    sk.extend_from_slice(&pubk);
    ssh_string(&mut priv_, &sk);
    ssh_string(&mut priv_, comment.as_bytes());
    let mut i = 1u8;
    while priv_.len() % 8 != 0 {
        priv_.push(i);
        i += 1;
    }
    let mut blob = zeroize::Zeroizing::new(b"openssh-key-v1\0".to_vec());
    ssh_string(&mut blob, b"none");
    ssh_string(&mut blob, b"none");
    ssh_string(&mut blob, b"");
    blob.extend_from_slice(&1u32.to_be_bytes());
    ssh_string(&mut blob, &pub_blob);
    ssh_string(&mut blob, &priv_);
    let b64 = zeroize::Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(&*blob));
    let mut pem = zeroize::Zeroizing::new(String::from("-----BEGIN OPENSSH PRIVATE KEY-----\n"));
    for chunk in b64.as_bytes().chunks(70) {
        pem.push_str(std::str::from_utf8(chunk).expect("base64 is ascii"));
        pem.push('\n');
    }
    pem.push_str("-----END OPENSSH PRIVATE KEY-----\n");
    let public = format!(
        "ssh-ed25519 {} {comment}",
        base64::engine::general_purpose::STANDARD.encode(&pub_blob)
    );
    (zeroize::Zeroizing::new(pem.as_bytes().to_vec()), public)
}

/// TS `generateValue`. 모르는 종류는 `None`(라우트가 먼저 400 으로 거른다).
pub fn generate_value(
    kind: &str,
    length: Option<i64>,
    name: &str,
) -> Option<Result<Generated, CreateDenial>> {
    let n = match check_length(kind, length)? {
        Err(d) => return Some(Err(d)),
        Ok(n) => n,
    };
    let Some(n) = n else {
        let (value, pk) = ssh_ed25519(&format!("harkroom:{name}"));
        return Some(Ok(Generated {
            kind: "file",
            filename: Some("id_ed25519"),
            value,
            public_key: Some(pk),
        }));
    };
    let n = n as usize;
    let text = if kind == "password" {
        (0..n)
            .map(|_| PASSWORD_ALPHABET[random_below(PASSWORD_ALPHABET.len() as u8) as usize])
            .collect::<Vec<u8>>()
    } else {
        use base64::Engine;
        let mut bytes = zeroize::Zeroizing::new(vec![0u8; n]);
        getrandom::fill(&mut bytes).expect("os random");
        if kind == "token_hex" {
            bytes
                .iter()
                .flat_map(|b| format!("{b:02x}").into_bytes())
                .collect()
        } else {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(&*bytes)
                .into_bytes()
        }
    };
    Some(Ok(Generated {
        kind: "text",
        filename: None,
        value: zeroize::Zeroizing::new(text),
        public_key: None,
    }))
}

/// 라우트 본문의 값 출처(TS `toSource`).
#[derive(Debug, PartialEq)]
pub enum Source {
    Generate {
        kind: String,
        length: Option<i64>,
    },
    /// import 는 TS `isMountedValue`(F4)를 아직 옮기지 않았다 — 라우트가 서면 gate 앞에서 TS 로 넘긴다.
    Import,
}

/// TS `agentCreateBody`·`agentRotateBody`(zod strict) + `toSource` 를 지난 본문. 실패는 400 `badCreate`.
#[derive(Debug, PartialEq)]
pub struct AgentBody {
    pub lease_id: String,
    pub token: String,
    pub name: String,
    pub description: String,
    pub expires_in_days: Option<i64>,
    pub source: Source,
}

/// TS `badCreate` 문구.
pub const BAD_CREATE_MESSAGE: &str = "leaseId, token, a valid name and one source ({generate:{type,length?}} or {import:{kind,filename?,valueBase64}}) are required";

/// zod `z.number().int()` — JS 정수(`32.0` 도 정수다).
fn js_int(v: &serde_json::Value) -> Option<i64> {
    let f = v.as_f64()?;
    (f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0).then_some(f as i64)
}

fn only_keys(o: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> bool {
    o.keys().all(|k| keys.contains(&k.as_str()))
}

fn parse_source(v: &serde_json::Value) -> Option<Source> {
    use serde_json::Value;
    let o = v.as_object()?;
    if let Some(g) = o.get("generate") {
        let g = g.as_object()?;
        if o.len() != 1 || !only_keys(g, &["type", "length"]) {
            return None;
        }
        let kind = g.get("type")?.as_str()?;
        if !GENERATE_TYPES.contains(&kind) {
            return None;
        }
        let length = match g.get("length") {
            None => None,
            Some(l) => Some(js_int(l)?),
        };
        return Some(Source::Generate {
            kind: kind.to_owned(),
            length,
        });
    }
    let i = o.get("import")?.as_object()?;
    if o.len() != 1 || !only_keys(i, &["kind", "filename", "valueBase64"]) {
        return None;
    }
    let kind = i.get("kind")?.as_str()?;
    if kind != "text" && kind != "file" {
        return None;
    }
    let filename = match i.get("filename") {
        None | Some(Value::Null) => None,
        Some(Value::String(f)) if crate::core::secret_writes::valid_filename(f) => Some(f),
        _ => return None,
    };
    let b64 = i.get("valueBase64")?.as_str()?;
    if crate::core::secret_writes::len16(b64) > (64 * 1024_usize).div_ceil(3) * 4 + 4 {
        return None;
    }
    // TS `/^[A-Za-z0-9+/]*={0,2}$/`.
    let body = b64.trim_end_matches('=');
    if b64.len() - body.len() > 2
        || !body
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
    {
        return None;
    }
    if kind == "file" && filename.is_none_or(|f| f.is_empty()) {
        return None;
    }
    if kind == "text" && filename.is_some_and(|f| !f.is_empty()) {
        return None;
    }
    Some(Source::Import)
}

/// TS `agentCreateBody`(`rotate == false`) 또는 `agentRotateBody`(`rotate == true`) + `toSource`.
pub fn parse_body(v: &serde_json::Value, rotate: bool) -> Option<AgentBody> {
    use crate::core::secret_writes::{len16, valid_name};
    let o = v.as_object()?;
    let allowed: &[&str] = if rotate {
        &["leaseId", "token", "name", "source"]
    } else {
        &[
            "leaseId",
            "token",
            "name",
            "description",
            "expiresInDays",
            "source",
        ]
    };
    if !only_keys(o, allowed) {
        return None;
    }
    let lease_id = o.get("leaseId")?.as_str()?;
    if !crate::core::msg_read::is_uuid(lease_id) {
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
    let description = match o.get("description") {
        None => String::new(),
        Some(d) => {
            let d = d.as_str()?;
            if len16(d) > 500 {
                return None;
            }
            d.to_owned()
        }
    };
    let expires_in_days = match o.get("expiresInDays") {
        None => None,
        Some(d) => {
            let n = js_int(d)?;
            if !(1..=365).contains(&n) {
                return None;
            }
            Some(n)
        }
    };
    Some(AgentBody {
        lease_id: lease_id.to_owned(),
        token: token.to_owned(),
        name: name.to_owned(),
        description,
        expires_in_days,
        source: parse_source(o.get("source")?)?,
    })
}

/// TS `RevealLimiter` (`createLimiter` = 시간당 10회) — 미끄럼 창. 키는 에이전트 id.
pub struct CreateLimiter {
    max: usize,
    window_ms: u64,
    hits: Mutex<HashMap<String, Vec<u64>>>,
}

impl CreateLimiter {
    pub fn new(max: usize, window_ms: u64) -> Self {
        Self {
            max,
            window_ms,
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// TS `createLimiter()`.
    pub fn create() -> Self {
        Self::new(10, 3_600_000)
    }

    pub fn take(&self, key: &str, now_ms: u64) -> bool {
        let mut m = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        let recent = m.entry(key.to_owned()).or_default();
        recent.retain(|t| now_ms.saturating_sub(*t) < self.window_ms);
        if recent.len() >= self.max {
            return false;
        }
        recent.push(now_ms);
        true
    }
}

pub struct AgentSecretCreateState {
    write: PgPool,
    keyring_on: bool,
}

/// 기동 한 번: 키를 읽어 확인값과 맞춘다(TS `verifySecretKeys`). env 가 잘못됐으면 `Err`(이 줄은 TS 에 남는다).
pub async fn load_state(write: PgPool) -> Result<AgentSecretCreateState, String> {
    let v = load_verified_from_env(&write).await?;
    let keyring_on = v.is_some_and(|v| v.keyring.is_some());
    Ok(AgentSecretCreateState { write, keyring_on })
}

/// TS `viaOperator`.
fn via_operator(me: &Account, auth: &crate::auth::Auth) -> Option<String> {
    match (&me.kind[..], &auth.operator) {
        ("agent", Some(_)) => Some(me.id.clone()),
        _ => None,
    }
}

/// `GET /agent/secret-create` → `{ granted }`.
pub async fn secret_create(
    State(st): State<Arc<AgentSecretCreateState>>,
    RequireAccount(me, auth): RequireAccount,
) -> Response {
    let Some(agent_id) = via_operator(&me, &auth) else {
        return json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "only an agent through its operator can do this",
        );
    };
    // TS: `!!keyring && (await hasCreateGrant(...))` — 키링이 없으면 묻지 않는다.
    let granted = if st.keyring_on {
        match sqlx::query_scalar::<_, i32>(HAS_CREATE_GRANT_SQL)
            .bind(&agent_id)
            .fetch_optional(&st.write)
            .await
        {
            Ok(r) => r.is_some(),
            Err(e) => return internal(e),
        }
    } else {
        false
    };
    let mut r = json_ok(format!(r#"{{"granted":{granted}}}"#));
    r.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    r
}

pub fn routes(
    st: AgentSecretCreateState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AgentSecretCreateState>>::new()
        .get("/agent/secret-create", secret_create)
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

    const AGENT: &str = "a";
    const OWNER: &str = "o";

    fn lease<'a>() -> LeaseCause<'a> {
        LeaseCause {
            agent_id: AGENT,
            owner_id: Some(OWNER),
            ..Default::default()
        }
    }

    #[test]
    fn cause_owner_human_post() {
        let l = LeaseCause {
            cause_kind: Some("human"),
            cause_author_id: Some(OWNER),
            ..lease()
        };
        assert!(cause_by_owner(&l));
    }

    #[test]
    fn cause_other_human_or_agent_refused() {
        let other = LeaseCause {
            cause_kind: Some("human"),
            cause_author_id: Some("x"),
            ..lease()
        };
        assert!(!cause_by_owner(&other));
        let agent_post = LeaseCause {
            cause_kind: Some("agent"),
            cause_author_id: Some(OWNER),
            ..lease()
        };
        assert!(!cause_by_owner(&agent_post));
    }

    #[test]
    fn cause_no_owner_refused() {
        let l = LeaseCause {
            owner_id: None,
            cause_kind: Some("human"),
            cause_author_id: None,
            ..lease()
        };
        assert!(!cause_by_owner(&l));
    }

    #[test]
    fn cause_owner_answered_own_ask() {
        let l = LeaseCause {
            cause_kind: Some("agent"),
            cause_author_id: Some(AGENT),
            cause_ask_author_id: Some(AGENT),
            ask_answered_by: Some(OWNER),
            ask_answerer_kind: Some("human"),
            ..lease()
        };
        assert!(cause_by_owner(&l));
        // 다른 에이전트의 카드, 사람이 아닌 답, 소유자 아닌 답은 아니다.
        assert!(!cause_by_owner(&LeaseCause {
            cause_ask_author_id: Some("b"),
            ..l.clone()
        }));
        assert!(!cause_by_owner(&LeaseCause {
            ask_answerer_kind: Some("agent"),
            ..l.clone()
        }));
        assert!(!cause_by_owner(&LeaseCause {
            ask_answered_by: Some("x"),
            ..l
        }));
    }

    #[test]
    fn length_rules() {
        assert_eq!(check_length("password", None), Some(Ok(Some(32))));
        assert_eq!(check_length("password", Some(16)), Some(Ok(Some(16))));
        assert_eq!(check_length("password", Some(128)), Some(Ok(Some(128))));
        assert_eq!(
            check_length("password", Some(15)),
            Some(Err(CreateDenial::BadLength))
        );
        assert_eq!(
            check_length("password", Some(129)),
            Some(Err(CreateDenial::BadLength))
        );
        for t in ["token_hex", "token_base64url"] {
            assert_eq!(check_length(t, None), Some(Ok(Some(32))));
            assert_eq!(check_length(t, Some(64)), Some(Ok(Some(64))));
            assert_eq!(
                check_length(t, Some(65)),
                Some(Err(CreateDenial::BadLength))
            );
        }
        assert_eq!(check_length("ssh_ed25519", None), Some(Ok(None)));
        assert_eq!(
            check_length("ssh_ed25519", Some(32)),
            Some(Err(CreateDenial::BadLength))
        );
        assert_eq!(check_length("rsa", None), None);
    }

    #[test]
    fn denial_status_matches_ts_create_status() {
        use CreateDenial::*;
        for (d, s) in [
            (LeaseInvalid, 403),
            (NotGranted, 403),
            (CauseNotOwner, 403),
            (OwnerInactive, 403),
            (GrantSuspended, 403),
            (RateLimited, 429),
            (NotFound, 404),
            (BadValue, 400),
            (BadLength, 400),
            (SecretInDescription, 400),
            (KindMismatch, 400),
            (TooMany, 409),
            (NameTaken, 409),
            (ValueIsMounted, 409),
            (AdoptedByOwner, 409),
            (SecretExpired, 409),
        ] {
            assert_eq!(d.status().as_u16(), s, "{}", d.code());
        }
    }

    #[test]
    fn limiter_ten_per_hour_per_agent() {
        let l = CreateLimiter::create();
        for i in 0..10 {
            assert!(l.take("a", 1_000 + i));
        }
        assert!(!l.take("a", 2_000), "11번째는 막힌다");
        assert!(l.take("b", 2_000), "에이전트마다 따로");
        assert!(!l.take("a", 1_000 + 3_600_000 - 1), "창 안");
        assert!(
            l.take("a", 1_000 + 3_600_000),
            "첫 기록이 창을 벗어나면 풀린다"
        );
    }

    #[test]
    fn generate_text_values_match_ts_shapes() {
        let p = generate_value("password", None, "x").unwrap().unwrap();
        assert_eq!((p.kind, p.filename, p.value.len()), ("text", None, 32));
        assert!(p.value.iter().all(|c| PASSWORD_ALPHABET.contains(c)));
        let h = generate_value("token_hex", Some(16), "x").unwrap().unwrap();
        assert_eq!(h.value.len(), 32);
        assert!(
            h.value
                .iter()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        let b = generate_value("token_base64url", None, "x")
            .unwrap()
            .unwrap();
        assert_eq!(b.value.len(), 43, "32 바이트 base64url, 덧붙임 없음");
        assert!(!b.value.contains(&b'=') && !b.value.contains(&b'+') && !b.value.contains(&b'/'));
        assert!(matches!(
            generate_value("password", Some(8), "x"),
            Some(Err(CreateDenial::BadLength))
        ));
        assert!(generate_value("rsa", None, "x").is_none());
    }

    #[test]
    fn ssh_ed25519_is_openssh_v1() {
        use base64::Engine;
        let g = generate_value("ssh_ed25519", None, "deploy")
            .unwrap()
            .unwrap();
        assert_eq!((g.kind, g.filename), ("file", Some("id_ed25519")));
        let pem = std::str::from_utf8(&g.value).unwrap();
        assert!(pem.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----\n"));
        assert!(pem.ends_with("-----END OPENSSH PRIVATE KEY-----\n"));
        let body: Vec<&str> = pem.lines().filter(|l| !l.starts_with("-----")).collect();
        assert!(body.iter().all(|l| l.len() <= 70));
        let blob = base64::engine::general_purpose::STANDARD
            .decode(body.concat())
            .unwrap();
        assert!(blob.starts_with(b"openssh-key-v1\0"));
        let pk = g.public_key.unwrap();
        let parts: Vec<&str> = pk.split(' ').collect();
        assert_eq!(parts[0], "ssh-ed25519");
        assert_eq!(parts[2], "harkroom:deploy");
        let pub_blob = base64::engine::general_purpose::STANDARD
            .decode(parts[1])
            .unwrap();
        assert_eq!(pub_blob.len(), 4 + 11 + 4 + 32);
        // 공개 블롭이 개인 블록 안에 그대로 있고, 개인키 64 바이트의 뒤 32 바이트가 공개키다.
        let raw_pub = &pub_blob[19..];
        let pos = blob
            .windows(pub_blob.len())
            .position(|w| w == &pub_blob[..])
            .unwrap();
        assert!(pos > 0);
        assert!(blob.windows(32).filter(|w| *w == raw_pub).count() >= 3);
    }

    #[test]
    fn body_matches_zod_and_to_source() {
        use serde_json::json;
        let base = json!({"leaseId": "123e4567-e89b-12d3-a456-426614174000", "token": "t", "name": "db-pass",
            "source": {"generate": {"type": "password", "length": 32.0}}});
        let b = parse_body(&base, false).unwrap();
        assert_eq!(
            b.source,
            Source::Generate {
                kind: "password".into(),
                length: Some(32)
            }
        );
        assert_eq!(b.description, "");
        assert!(parse_body(&base, true).is_some());
        let mut extra = base.clone();
        extra["description"] = json!("d");
        assert!(parse_body(&extra, false).is_some());
        assert!(
            parse_body(&extra, true).is_none(),
            "rotate 는 strict — description 없음"
        );
        let mut bad = base.clone();
        bad["expiresInDays"] = json!(366);
        assert!(parse_body(&bad, false).is_none());
        let mut bad = base.clone();
        bad["source"] = json!({"generate": {"type": "rsa"}});
        assert!(parse_body(&bad, false).is_none());
        let mut bad = base.clone();
        bad["source"]["generate"]["length"] = json!(1.5);
        assert!(parse_body(&bad, false).is_none());
        let mut bad = base.clone();
        bad["name"] = json!("Bad");
        assert!(parse_body(&bad, false).is_none());
        let mut imp = base.clone();
        imp["source"] = json!({"import": {"kind": "text", "valueBase64": "aGk="}});
        assert_eq!(parse_body(&imp, false).unwrap().source, Source::Import);
        imp["source"] = json!({"import": {"kind": "file", "valueBase64": "aGk="}});
        assert!(
            parse_body(&imp, false).is_none(),
            "file 은 filename 이 있어야"
        );
        imp["source"] = json!({"import": {"kind": "text", "filename": "a", "valueBase64": "aGk="}});
        assert!(parse_body(&imp, false).is_none());
        imp["source"] = json!({"import": {"kind": "text", "valueBase64": "a-b"}});
        assert!(parse_body(&imp, false).is_none());
        imp["source"] = json!({"import": {"kind": "text", "valueBase64": "a==="}});
        assert!(parse_body(&imp, false).is_none());
    }

    #[test]
    fn privileges_include_key_check() {
        let p = privileges();
        assert!(p.contains(&("account_grant.suspended_at", "SELECT")));
        assert!(p.contains(&("secret_key_check.kcv", "SELECT")));
    }
}
