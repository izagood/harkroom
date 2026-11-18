//! S5.4 SE4 — 에이전트가 비밀을 만드는 길(102). TS `services/secretCreate.ts`·`routes/secretRoutes.ts` 를 옮긴다.
//!
//! - **옮긴 줄**:
//!   - `GET /agent/secret-create` → `{ granted }`(러너가 프롬프트에 만들기 절을 쓸지 고른다. 판정이 아니다).
//!     차례는 TS 와 같다: 인증(401) → 오퍼레이터를 거친 에이전트(403) → `cache-control: no-store` →
//!     `granted = 키링이 있음 && secret.create 부여가 살아 있음`.
//!   - `POST /agent/secrets`·`POST /agent/secrets/rotate` — **generate·import 두 갈래 모두**. 두 줄은 하나의
//!     [`CreateLimiter`](에이전트마다 시간당 10회)를 나눠 쓰고, generate·import 도 같은 제한기를 센다(TS `makeLimiter` 하나) —
//!     그래서 함께 선다([`crate::rate_limit`] 머리말 규칙).
//!     차례는 TS 와 같다: 인증(401) → 오퍼레이터를 거친 에이전트(403) → 본문(400 `badCreate`, import 의 base64 는 Node
//!     `Buffer.from(b64,'base64')` 처럼 너그럽게 푼다) → `gate`
//!     (임대 → 소유자 비활성 → `secret.create` 부여 → 소유자 원인(F2) → 속도 제한, 거절마다 감사 `secret.<action>.denied`)
//!     → 만들기: 20개 상한(미리 한 번 + tx 안 advisory lock 뒤 다시) → 값 → 설명 누출 → tx(secret·secret_version·secret_grant,
//!     23505 → `name_taken`) / 회전: 대상(404·`secret_expired`) → 입양(`adopted_by_owner`)·정지(`grant_suspended`) → 값 →
//!     종류·설명 누출 → tx(새 판·옛 판 회수·`updated_at`) → `secret_access_log` → 감사(`record_audit`) →
//!     소유자 알림(TS `notifyOwner`: 그 턴 스레드의 `system`·`serverNotice` 줄, `@소유자` 부름, `meta.secretNotice`·`meta.i18n`,
//!     실패해도 되돌리지 않고 로그만). 값은 키링 v2 `seal` 로 봉한다. 거절·성공 모두 `cache-control: no-store`.
//!     "값" 단계(TS `resolveValue`): generate 는 길이 판정 뒤 만든다. import 는 빈 값·64 KiB 넘음 → `bad_value`, text 인데
//!     UTF-8 로 풀어 U+FFFD 가 보이면 `bad_value`, 그 뒤 F4 "마운트된 값"([`is_mounted_value`] — 같은 오퍼레이터의 살아 있는
//!     임대로 `granted` 된 판의 봉투를 풀어 시간 차 없이 견준다, 끝 공백·줄바꿈 차이는 같은 값) → `value_is_mounted`(409).
//! - **TS 에 남는 줄**:
//!   1. 키링이 없거나 키가 틀린 경우의 409(`secret_store_disabled`·`secret_key_mismatch`) — TS 에 넘겨 그대로 답하게 한다.
//!   2. `POST /agent/secrets/reveal`(값 내주기)은 이 파일 몫이 아니다(`agent_secret_reveal.rs`).
//!
//! 쓰기 풀 칸 권한: `GET` 은 [`AGENT_SECRET_CREATE_PRIVILEGES`] + 기동 키 확인. 두 POST 는 그 위에 [`CREATE_WRITE_PRIVILEGES`]
//! (임대·소유자·원인 글 읽기, secret·secret_version·secret_grant·secret_access_log 쓰기, F4 의 접근 기록·봉투 읽기, `audit_log`)와 글 경로
//! (`msg_post::MESSAGE_POST_PRIVILEGES`)까지. `automation.*` 은 읽지 않는다.
//! - 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 권한이 다 있을 때만 선다(`main.rs`). 키 env 를 읽을 수 없으면
//!   세 줄 모두 TS 에 남는다(TS 와 같이 키가 없거나 틀리면 `granted: false`). POST 두 줄의 권한이나 글 경로가 없으면 `GET` 만 선다.
use crate::auth::{Account, RequireAccount};
use crate::core::msg_post::{PostState, to_ts};
use crate::directory::{internal, json_err, json_ok};
use crate::secrets::keyring::{SecretAad, SecretKeyring, SecretKind};
use crate::secrets::verify::{SECRET_KEY_CHECK_PRIVILEGES, load_verified_from_env};
use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::{StatusCode, header};
use axum::response::Response;
use sqlx::PgPool;
use std::collections::HashMap;
use std::net::SocketAddr;
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
/// OpenSSH 개인키 머리·꼬리. 비밀 검사(gitleaks)가 소스의 이 글자를 개인키로 잡지 않게 쪼개 쓴다.
const PEM_BEGIN: &str = concat!("-----BEGIN OPENSSH ", "PRIVATE KEY-----\n");
const PEM_END: &str = concat!("-----END OPENSSH ", "PRIVATE KEY-----\n");

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
    let mut pem = zeroize::Zeroizing::new(String::from(PEM_BEGIN));
    for chunk in b64.as_bytes().chunks(70) {
        pem.push_str(std::str::from_utf8(chunk).expect("base64 is ascii"));
        pem.push('\n');
    }
    pem.push_str(PEM_END);
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

/// import 로 들어온 값. drop 하면 지우고 `Debug` 는 가린다(값은 로그·응답에 싣지 않는다).
#[derive(PartialEq)]
pub struct ImportValue(pub zeroize::Zeroizing<Vec<u8>>);

impl std::fmt::Debug for ImportValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ImportValue(<redacted>)")
    }
}

/// 라우트 본문의 값 출처(TS `toSource`).
#[derive(Debug, PartialEq)]
pub enum Source {
    Generate {
        kind: String,
        length: Option<i64>,
    },
    /// TS `{ import: { kind, filename, value } }` — 값은 base64 를 푼 바이트. 길이·글자·F4 판정은 gate 뒤(`resolve_value`).
    Import {
        kind: &'static str,
        filename: Option<String>,
        value: ImportValue,
    },
}

/// Node `Buffer.from(b64, 'base64')` — `/^[A-Za-z0-9+/]*={0,2}$/` 를 지난 글에 한해. 덧붙임(`=`)은 무시하고, 4 글자로
/// 떨어지지 않는 꼬리는 채워진 8 비트만 낸다(1 글자 꼬리는 버린다). 남는 비트가 0 이 아니어도 탓하지 않는다.
pub fn node_base64_decode(b64: &str) -> Option<zeroize::Zeroizing<Vec<u8>>> {
    let body = b64.trim_end_matches('=');
    let mut out = zeroize::Zeroizing::new(Vec::with_capacity(body.len() / 4 * 3 + 3));
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in body.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        acc = ((acc << 6) | u32::from(v)) & 0xffff;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
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
    Some(Source::Import {
        kind: if kind == "file" { "file" } else { "text" },
        filename: filename.cloned(),
        value: ImportValue(node_base64_decode(b64)?),
    })
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
    keyring: Option<SecretKeyring>,
    /// 만들기·회전 두 줄(`POST /agent/secrets`·`/agent/secrets/rotate`) — 글 경로와 [`CREATE_WRITE_PRIVILEGES`] 가 있을 때만 선다.
    post: Option<PostState>,
    /// 두 줄이 함께 쓰는 하나의 속도 제한(TS `makeLimiter`).
    limiter: CreateLimiter,
}

/// 기동 한 번: 키를 읽어 확인값과 맞춘다(TS `verifySecretKeys`). env 가 잘못됐으면 `Err`(이 줄은 TS 에 남는다).
pub async fn load_state(write: PgPool) -> Result<AgentSecretCreateState, String> {
    let v = load_verified_from_env(&write).await?;
    Ok(AgentSecretCreateState {
        write,
        keyring: v.and_then(|v| v.keyring),
        post: None,
        limiter: CreateLimiter::create(),
    })
}

impl AgentSecretCreateState {
    /// 만들기·회전 두 줄을 켠다(`main.rs` 가 두 겹 잠금을 본 뒤). 글 경로의 쓰기 풀은 이 상태의 쓰기 풀과 같아야 한다.
    pub fn with_post(mut self, post: PostState) -> Self {
        self.post = Some(post);
        self
    }
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
    let granted = if st.keyring.is_some() {
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

// ─── 만들기·회전(generate) ─────────────────────────────────────────────────────────────

/// TS `readCreateLease` — `$3` 은 TS 가 넘기는 `now`(밀리초 ISO).
const READ_LEASE_SQL: &str = "select l.id::text, l.agent_id::text, l.operator_id::text, l.channel_id::text, \
            l.thread_root_id::text, l.cause_message_id::text, \
            l.expires_at <= $3::timestamptz as expired, l.ended_at is not null as ended, \
            c.owner_account_id::text as owner_id, \
            coalesce(o.deleted_at is not null or o.disabled_at is not null, true) as owner_inactive, \
            m.author_id::text as cause_author_id, a.kind as cause_kind, \
            case when m.meta ? 'ask' and m.meta->'ask'->>'mirrorOf' is null and m.meta->'ask'->>'answeredVia' is null \
                 then m.author_id::text end as cause_ask_author_id, \
            m.meta->'ask'->>'answeredBy' as ask_answered_by, ans.kind as ask_answerer_kind \
       from secret_turn_lease l \
       left join agent_config c on c.account_id = l.agent_id \
       left join account o on o.id = c.owner_account_id \
       left join message m on m.id = l.cause_message_id \
       left join account a on a.id = m.author_id \
       left join account ans on ans.id = nullif(m.meta->'ask'->>'answeredBy', '')::uuid \
      where l.id = $1::uuid and l.token_hash = $2";
/// TS `countCreated`.
const COUNT_CREATED_SQL: &str =
    "select count(*)::int from secret where created_by_agent_id = $1::uuid";
const INSERT_SECRET_SQL: &str = "insert into secret (name, kind, filename, description, owner_account_id, expires_at, created_by_agent_id, created_cause_message_id) \
     values ($1, $2, $3, $4, $5::uuid, $6::timestamptz, $7::uuid, $8::uuid) returning id::text";
const INSERT_VERSION_SQL: &str = "insert into secret_version (secret_id, version, sealed, size_bytes, created_by) \
     values ($1::uuid, $2, $3, $4, $5::uuid)";
const INSERT_GRANT_SQL: &str = "insert into secret_grant (secret_id, agent_id, channel_id, operator_id, granted_by) \
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $2::uuid)";
/// TS `logAccess`.
const LOG_ACCESS_SQL: &str = "insert into secret_access_log (secret_id, secret_name, version, agent_id, operator_id, turn_id, channel_id, thread_root_id, result, reason, at) \
     values ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9, null, $10::timestamptz)";
/// TS `rotateAgentSecret` 의 대상 읽기.
const ROTATE_TARGET_SQL: &str = "select s.id::text, s.name, s.kind, s.description, s.expires_at <= $3::timestamptz as expired, \
            (select created_by::text from secret_version v where v.secret_id = s.id order by version desc limit 1) as latest_by \
       from secret s where s.name = $1 and s.created_by_agent_id = $2::uuid";
const ROTATE_GRANTS_SQL: &str = "select agent_id::text, granted_by::text, channel_id::text, suspended_at is not null \
       from secret_grant where secret_id = $1::uuid";
const ROTATE_LOCK_SQL: &str = "select 1 from secret where id = $1::uuid for update";
const ROTATE_MAX_SQL: &str =
    "select coalesce(max(version), 0)::int from secret_version where secret_id = $1::uuid";
const ROTATE_REVOKE_SQL: &str = "update secret_version set sealed = null, revoked_at = now() \
     where secret_id = $1::uuid and version < $2 and revoked_at is null";
const ROTATE_TOUCH_SQL: &str = "update secret set updated_at = now() where id = $1::uuid";
/// TS `notifyOwner` 의 handle 읽기.
const HANDLES_SQL: &str =
    "select a.handle, o.handle from account a, account o where a.id = $1::uuid and o.id = $2::uuid";

/// TS `isMountedValue`(F4) — 같은 오퍼레이터의 살아 있는 임대로 `granted` 된 판의 봉투. `$2` 는 TS 가 넘기는 `now`.
const MOUNTED_SQL: &str = "select distinct s.id::text, s.kind, v.version, v.sealed \
       from secret_access_log g \
       join secret_turn_lease l on l.id = g.turn_id \
       join secret s on s.id = g.secret_id \
       join secret_version v on v.secret_id = g.secret_id and v.version = g.version \
      where g.result = 'granted' and l.operator_id = $1::uuid and l.ended_at is null and l.expires_at > $2::timestamptz \
        and v.sealed is not null";

/// 만들기·회전 두 줄이 닿는 칸(TS `secretCreate.ts`, generate·import 갈래 — import 의 `isMountedValue` 포함).
/// 소유자 알림의 글 경로 칸은 `msg_post::MESSAGE_POST_PRIVILEGES`(`main.rs` 가 따로 본다).
pub const CREATE_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("secret_turn_lease.id", "SELECT"),
    ("secret_turn_lease.agent_id", "SELECT"),
    ("secret_turn_lease.operator_id", "SELECT"),
    ("secret_turn_lease.channel_id", "SELECT"),
    ("secret_turn_lease.thread_root_id", "SELECT"),
    ("secret_turn_lease.cause_message_id", "SELECT"),
    ("secret_turn_lease.expires_at", "SELECT"),
    ("secret_turn_lease.ended_at", "SELECT"),
    ("secret_turn_lease.token_hash", "SELECT"),
    ("agent_config.account_id", "SELECT"),
    ("agent_config.owner_account_id", "SELECT"),
    ("account.id", "SELECT"),
    ("account.kind", "SELECT"),
    ("account.handle", "SELECT"),
    ("account.deleted_at", "SELECT"),
    ("account.disabled_at", "SELECT"),
    ("message.id", "SELECT"),
    ("message.author_id", "SELECT"),
    ("message.meta", "SELECT"),
    ("secret.id", "SELECT"),
    ("secret.name", "SELECT"),
    ("secret.kind", "SELECT"),
    ("secret.description", "SELECT"),
    ("secret.expires_at", "SELECT"),
    ("secret.created_by_agent_id", "SELECT"),
    ("secret.name", "INSERT"),
    ("secret.kind", "INSERT"),
    ("secret.filename", "INSERT"),
    ("secret.description", "INSERT"),
    ("secret.owner_account_id", "INSERT"),
    ("secret.expires_at", "INSERT"),
    ("secret.created_by_agent_id", "INSERT"),
    ("secret.created_cause_message_id", "INSERT"),
    ("secret.updated_at", "UPDATE"),
    ("secret_version.secret_id", "SELECT"),
    ("secret_version.version", "SELECT"),
    ("secret_version.created_by", "SELECT"),
    ("secret_version.revoked_at", "SELECT"),
    ("secret_version.secret_id", "INSERT"),
    ("secret_version.version", "INSERT"),
    ("secret_version.sealed", "INSERT"),
    ("secret_version.size_bytes", "INSERT"),
    ("secret_version.created_by", "INSERT"),
    ("secret_version.sealed", "UPDATE"),
    ("secret_version.revoked_at", "UPDATE"),
    ("secret_grant.secret_id", "SELECT"),
    ("secret_grant.agent_id", "SELECT"),
    ("secret_grant.granted_by", "SELECT"),
    ("secret_grant.channel_id", "SELECT"),
    ("secret_grant.suspended_at", "SELECT"),
    ("secret_grant.secret_id", "INSERT"),
    ("secret_grant.agent_id", "INSERT"),
    ("secret_grant.channel_id", "INSERT"),
    ("secret_grant.operator_id", "INSERT"),
    ("secret_grant.granted_by", "INSERT"),
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
    // F4(`isMountedValue`) — 접근 기록을 읽어 살아 있는 임대의 봉투를 푼다.
    ("secret_access_log.secret_id", "SELECT"),
    ("secret_access_log.version", "SELECT"),
    ("secret_access_log.turn_id", "SELECT"),
    ("secret_access_log.result", "SELECT"),
    ("secret_version.sealed", "SELECT"),
    ("audit_log", "INSERT"),
];

/// 두 줄의 모든 권한(`GET` 줄 + 기동 키 확인 + 만들기·회전).
pub fn write_privileges() -> Vec<(&'static str, &'static str)> {
    privileges()
        .into_iter()
        .chain(CREATE_WRITE_PRIVILEGES.iter().copied())
        .collect()
}

/// TS `CreateLease`.
#[derive(Debug, Clone)]
struct CreateLease {
    id: String,
    agent_id: String,
    operator_id: String,
    channel_id: String,
    thread_root_id: String,
    cause_message_id: String,
    expired: bool,
    ended: bool,
    owner_id: Option<String>,
    owner_inactive: bool,
    cause_author_id: Option<String>,
    cause_kind: Option<String>,
    cause_ask_author_id: Option<String>,
    ask_answered_by: Option<String>,
    ask_answerer_kind: Option<String>,
}

impl CreateLease {
    fn cause(&self) -> LeaseCause<'_> {
        LeaseCause {
            agent_id: &self.agent_id,
            owner_id: self.owner_id.as_deref(),
            cause_author_id: self.cause_author_id.as_deref(),
            cause_kind: self.cause_kind.as_deref(),
            cause_ask_author_id: self.cause_ask_author_id.as_deref(),
            ask_answered_by: self.ask_answered_by.as_deref(),
            ask_answerer_kind: self.ask_answerer_kind.as_deref(),
        }
    }
}

fn sha256_hex(s: &str) -> String {
    hex::encode(ring::digest::digest(&ring::digest::SHA256, s.as_bytes()))
}

async fn read_lease(
    pool: &PgPool,
    lease_id: &str,
    token: &str,
    now_iso: &str,
) -> sqlx::Result<Option<CreateLease>> {
    use sqlx::Row;
    let Some(r) = sqlx::query(READ_LEASE_SQL)
        .bind(lease_id)
        .bind(sha256_hex(token))
        .bind(now_iso)
        .fetch_optional(pool)
        .await?
    else {
        return Ok(None);
    };
    Ok(Some(CreateLease {
        id: r.try_get(0)?,
        agent_id: r.try_get(1)?,
        operator_id: r.try_get(2)?,
        channel_id: r.try_get(3)?,
        thread_root_id: r.try_get(4)?,
        cause_message_id: r.try_get(5)?,
        expired: r.try_get(6)?,
        ended: r.try_get(7)?,
        owner_id: r.try_get(8)?,
        owner_inactive: r.try_get(9)?,
        cause_author_id: r.try_get(10)?,
        cause_kind: r.try_get(11)?,
        cause_ask_author_id: r.try_get(12)?,
        ask_answered_by: r.try_get(13)?,
        ask_answerer_kind: r.try_get(14)?,
    }))
}

/// 만들기인가 회전인가(감사 action·오류 문구·알림 갈래).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Create,
    Rotate,
}

impl Action {
    fn word(self) -> &'static str {
        match self {
            Action::Create => "create",
            Action::Rotate => "rotate",
        }
    }
    fn done(self) -> &'static str {
        match self {
            Action::Create => "created",
            Action::Rotate => "rotated",
        }
    }
}

/// TS 오류 몸 `{ error: { code, message: "secret not created: <code>" } }`.
pub fn denial_message(action: Action, d: CreateDenial) -> String {
    let w = match action {
        Action::Create => "created",
        Action::Rotate => "rotated",
    };
    format!("secret not {w}: {}", d.code())
}

/// 요청자(오퍼레이터를 거친 에이전트).
struct Who {
    agent_id: String,
    operator_id: String,
}

/// TS `gate`. 거절은 감사 한 줄(`secret.<action>.denied`)을 남긴다.
async fn gate(
    st: &AgentSecretCreateState,
    who: &Who,
    lease_id: &str,
    token: &str,
    action: Action,
) -> Result<Result<(CreateLease, i64), CreateDenial>, sqlx::Error> {
    let now = crate::core::msg_post::now_ms();
    let now_iso = crate::core::msg_post::iso_ms(now);
    let lease = read_lease(&st.write, lease_id, token, &now_iso).await?;
    let lease = lease.filter(|l| {
        l.agent_id == who.agent_id && l.operator_id == who.operator_id && !l.expired && !l.ended
    });
    let deny = |code: CreateDenial, l: Option<&CreateLease>| {
        let detail = serde_json::json!({
            "code": code.code(),
            "operatorId": who.operator_id,
            "leaseId": l.map(|l| l.id.clone()),
            "causeAuthorId": l.and_then(|l| l.cause_author_id.clone()),
        });
        async move {
            crate::write::record_audit(
                &st.write,
                crate::write::AuditEntry {
                    action: &format!("secret.{}.denied", action.word()),
                    actor_id: Some(&who.agent_id),
                    actor_handle: None,
                    target: Some(&who.agent_id),
                    ip: None,
                    detail,
                },
            )
            .await;
            Err(code)
        }
    };
    let Some(lease) = lease else {
        return Ok(deny(CreateDenial::LeaseInvalid, None).await);
    };
    if lease.owner_inactive {
        return Ok(deny(CreateDenial::OwnerInactive, Some(&lease)).await);
    }
    let granted = sqlx::query_scalar::<_, i32>(HAS_CREATE_GRANT_SQL)
        .bind(&who.agent_id)
        .fetch_optional(&st.write)
        .await?
        .is_some();
    if !granted {
        return Ok(deny(CreateDenial::NotGranted, Some(&lease)).await);
    }
    if !cause_by_owner(&lease.cause()) {
        return Ok(deny(CreateDenial::CauseNotOwner, Some(&lease)).await);
    }
    if !st.limiter.take(&who.agent_id, now.max(0) as u64) {
        return Ok(deny(CreateDenial::RateLimited, Some(&lease)).await);
    }
    Ok(Ok((lease, now)))
}

/// TS `descriptionLeaks`.
fn description_leaks(description: &str, value: &[u8]) -> bool {
    crate::core::content_scan::scan_write(&[Some(description)])
        .is_some_and(|h| h.rules.contains(&"secret"))
        || crate::secrets::leak::needles_for(value)
            .iter()
            .any(|n| description.contains(n.as_str()))
}

async fn count_created<'e, E: sqlx::PgExecutor<'e>>(db: E, agent: &str) -> sqlx::Result<i32> {
    sqlx::query_scalar(COUNT_CREATED_SQL)
        .bind(agent)
        .fetch_one(db)
        .await
}

async fn log_access(
    pool: &PgPool,
    secret_id: &str,
    name: &str,
    version: i32,
    lease: &CreateLease,
    action: Action,
    now_iso: &str,
) -> sqlx::Result<()> {
    sqlx::query(LOG_ACCESS_SQL)
        .bind(secret_id)
        .bind(name)
        .bind(version)
        .bind(&lease.agent_id)
        .bind(&lease.operator_id)
        .bind(&lease.id)
        .bind(&lease.channel_id)
        .bind(&lease.thread_root_id)
        .bind(action.done())
        .bind(now_iso)
        .execute(pool)
        .await?;
    Ok(())
}

/// 소유자 알림의 본문·meta(TS `notifyOwner`). `gen_type` 이 `None` 이면 import 갈래.
pub fn notice_line(
    agent_handle: &str,
    owner_handle: &str,
    n: &NoticeArgs<'_>,
) -> (String, serde_json::Map<String, serde_json::Value>) {
    use serde_json::json;
    let how = match n.gen_type {
        Some(t) => format!("서버가 만든 값({t})"),
        None => "값을 에이전트가 정함(import)".to_owned(),
    };
    let what = match n.action {
        Action::Create => "만들었다".to_owned(),
        Action::Rotate => format!("회전했다(판 {})", n.version),
    };
    let body = format!(
        "🔑 {agent_handle} 가 비밀 `{}` 을 {what} · {how} · 이 채널로 자기에게만 부여 · 설정 › 나 › 비밀과 API @{owner_handle}",
        n.name.replace('@', "＠")
    );
    let mut meta = serde_json::Map::new();
    meta.insert(
        "secretNotice".into(),
        json!({ "action": n.action.done(), "secretId": n.secret_id, "name": n.name, "version": n.version,
            "via": if n.gen_type.is_some() { "generate" } else { "import" },
            "agentId": n.agent_id, "ownerAccountId": n.owner_id }),
    );
    let i18n = match (n.action, n.gen_type) {
        (Action::Create, Some(t)) => json!({ "key": "system.secret.createdGenerated",
            "args": { "agentId": n.agent_id, "name": n.name, "type": t, "ownerId": n.owner_id } }),
        (Action::Create, None) => json!({ "key": "system.secret.createdImported",
            "args": { "agentId": n.agent_id, "name": n.name, "ownerId": n.owner_id } }),
        (Action::Rotate, Some(t)) => json!({ "key": "system.secret.rotatedGenerated",
            "args": { "agentId": n.agent_id, "name": n.name, "version": n.version, "type": t, "ownerId": n.owner_id } }),
        (Action::Rotate, None) => json!({ "key": "system.secret.rotatedImported",
            "args": { "agentId": n.agent_id, "name": n.name, "version": n.version, "ownerId": n.owner_id } }),
    };
    meta.insert("i18n".into(), i18n);
    (body, meta)
}

/// [`notice_line`] 의 값.
pub struct NoticeArgs<'a> {
    pub action: Action,
    pub agent_id: &'a str,
    pub owner_id: &'a str,
    pub secret_id: &'a str,
    pub name: &'a str,
    pub version: i32,
    /// generate 의 종류(`password` 등). `None` = import.
    pub gen_type: Option<&'a str>,
}

/// TS `notifyOwner` — 실패해도 만들기를 되돌리지 않는다(로그만).
async fn notify_owner(
    post: &PostState,
    lease: &CreateLease,
    secret_id: &str,
    name: &str,
    version: i32,
    action: Action,
    gen_type: Option<&str>,
) {
    use crate::core::msg_post::{Origin, Outcome, PostBody, channel_is_dm, post_in_tx};
    let Some(owner) = lease.owner_id.as_deref() else {
        return;
    };
    let r: sqlx::Result<Option<Outcome>> = async {
        let who: Option<(String, String)> = sqlx::query_as(HANDLES_SQL)
            .bind(&lease.agent_id)
            .bind(owner)
            .fetch_optional(&post.write)
            .await?;
        let Some((agent_h, owner_h)) = who else {
            return Ok(None);
        };
        let (body, meta) = notice_line(
            &agent_h,
            &owner_h,
            &NoticeArgs {
                action,
                agent_id: &lease.agent_id,
                owner_id: owner,
                secret_id,
                name,
                version,
                gen_type,
            },
        );
        let audience = crate::core::audience::audience_for(&post.write, &lease.channel_id)
            .await?
            .to_json();
        let is_dm = channel_is_dm(&post.write, &lease.channel_id).await?;
        let input = PostBody {
            body,
            attachment_ids: Vec::new(),
            thread_root: Some(lease.thread_root_id.clone()),
            also_in_channel: false,
        };
        let origin = Origin {
            cause: Some(&lease.cause_message_id),
            meta,
            system: true,
            server_notice: true,
            ..Origin::default()
        };
        post_in_tx(
            post,
            &lease.channel_id,
            &lease.agent_id,
            true,
            &input,
            None,
            &audience,
            is_dm,
            &origin,
        )
        .await
        .map(Some)
    }
    .await;
    match r {
        Ok(None) | Ok(Some(Outcome::Posted { .. })) => {}
        Ok(Some(_)) => eprintln!(
            "[secretCreate] 소유자 알림 실패: not_posted secretId={secret_id} agentId={}",
            lease.agent_id
        ),
        Err(e) => eprintln!(
            "[secretCreate] 소유자 알림 실패: secretId={secret_id} agentId={} ({})",
            lease.agent_id,
            e.as_database_error().map_or("io", |_| "db")
        ),
    }
}

/// TS `trimEnd` — 끝의 `\r`·`\n`·`\t`·공백 바이트를 걷는다(latin1 왕복이라 바이트 단위다).
pub fn trim_end_ws(b: &[u8]) -> &[u8] {
    let n = b
        .iter()
        .rposition(|c| !matches!(c, b'\r' | b'\n' | b'\t' | b' '))
        .map_or(0, |i| i + 1);
    &b[..n]
}

/// TS `isMountedValue` 의 견주기 — 그대로 같거나, 끝 공백·줄바꿈을 걷고 같으면 같은 값. 시간 차 없이 견준다(TS `timingSafeEqual`).
pub fn same_mounted_value(opened: &[u8], value: &[u8]) -> bool {
    use crate::secrets::verify::ct_eq;
    ct_eq(opened, value) || ct_eq(trim_end_ws(opened), trim_end_ws(value))
}

/// TS `isMountedValue`(F4): 들어온 값이 **같은 오퍼레이터에서 지금 살아 있는 임대로 reveal 된 값**이면 참.
/// 봉투를 풀지 못한 판은 건너뛴다(TS `keyring.open` 이 null). 연 값은 곧바로 지운다.
async fn is_mounted_value(
    pool: &PgPool,
    keyring: &SecretKeyring,
    operator_id: &str,
    value: &[u8],
    now_iso: &str,
) -> sqlx::Result<bool> {
    let rows: Vec<(String, String, i32, String)> = sqlx::query_as(MOUNTED_SQL)
        .bind(operator_id)
        .bind(now_iso)
        .fetch_all(pool)
        .await?;
    for (secret_id, kind, version, sealed) in &rows {
        let Some(kind) = crate::secrets::verify::kind_of(kind) else {
            continue;
        };
        let opened = keyring.open(
            sealed,
            &SecretAad {
                secret_id,
                version: i64::from(*version),
                kind,
            },
        );
        if opened.is_some_and(|v| same_mounted_value(v.as_bytes(), value)) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// TS `resolveValue` 의 성공 갈래.
struct Resolved {
    kind: &'static str,
    filename: Option<String>,
    value: zeroize::Zeroizing<Vec<u8>>,
    public_key: Option<String>,
    /// generate 의 종류. `None` = import(감사 `via: 'import'`, `type: null`).
    gen_type: Option<String>,
}

impl Resolved {
    fn via(&self) -> &'static str {
        if self.gen_type.is_some() {
            "generate"
        } else {
            "import"
        }
    }
}

/// TS `resolveValue` 의 import 값 판정(F4 앞): 빈 값·64 KiB 넘음, text 인데 UTF-8 로 풀어 U+FFFD 가 보임 → `bad_value`.
pub fn check_import_value(kind: &str, value: &[u8]) -> Result<(), CreateDenial> {
    if value.is_empty() || value.len() > SECRET_CREATE_MAX_BYTES {
        return Err(CreateDenial::BadValue);
    }
    if kind == "text" && String::from_utf8_lossy(value).contains('\u{FFFD}') {
        return Err(CreateDenial::BadValue);
    }
    Ok(())
}

/// TS `resolveValue`.
async fn resolve_value(
    st: &AgentSecretCreateState,
    keyring: &SecretKeyring,
    lease: &CreateLease,
    now_iso: &str,
    source: &Source,
    name: &str,
) -> Result<Result<Resolved, CreateDenial>, sqlx::Error> {
    match source {
        Source::Generate { kind, length } => Ok(match generate_value(kind, *length, name) {
            Some(Ok(g)) => Ok(Resolved {
                kind: g.kind,
                filename: g.filename.map(str::to_owned),
                value: g.value,
                public_key: g.public_key,
                gen_type: Some(kind.clone()),
            }),
            Some(Err(d)) => Err(d),
            None => Err(CreateDenial::BadLength),
        }),
        Source::Import {
            kind,
            filename,
            value,
        } => {
            if let Err(d) = check_import_value(kind, &value.0) {
                return Ok(Err(d));
            }
            if is_mounted_value(&st.write, keyring, &lease.operator_id, &value.0, now_iso).await? {
                return Ok(Err(CreateDenial::ValueIsMounted));
            }
            Ok(Ok(Resolved {
                kind,
                filename: filename.clone(),
                value: value.0.clone(),
                public_key: None,
                gen_type: None,
            }))
        }
    }
}

/// 성공 결과(TS `CreateResult` 의 ok 갈래).
struct Created {
    name: String,
    kind: &'static str,
    version: i32,
    public_key: Option<String>,
    expires_at: Option<String>,
}

/// TS `createAgentSecret`.
async fn create_secret(
    st: &AgentSecretCreateState,
    post: &PostState,
    keyring: &SecretKeyring,
    who: &Who,
    b: &AgentBody,
) -> Result<Result<Created, CreateDenial>, sqlx::Error> {
    let (lease, now) = match gate(st, who, &b.lease_id, &b.token, Action::Create).await? {
        Ok(v) => v,
        Err(d) => return Ok(Err(d)),
    };
    let now_iso = crate::core::msg_post::iso_ms(now);
    if count_created(&st.write, &who.agent_id).await? >= AGENT_SECRET_MAX as i32 {
        return Ok(Err(CreateDenial::TooMany));
    }
    let g = match resolve_value(st, keyring, &lease, &now_iso, &b.source, &b.name).await? {
        Ok(g) => g,
        Err(d) => return Ok(Err(d)),
    };
    if description_leaks(&b.description, &g.value) {
        return Ok(Err(CreateDenial::SecretInDescription));
    }
    let days = b
        .expires_in_days
        .unwrap_or(AGENT_SECRET_DEFAULT_DAYS)
        .min(AGENT_SECRET_MAX_DAYS);
    let expires_at = crate::core::msg_post::iso_ms(now + days * 86_400_000);
    let kind = if g.kind == "file" {
        SecretKind::File
    } else {
        SecretKind::Text
    };
    let tx_result: Result<Option<String>, sqlx::Error> = async {
        let mut tx = st.write.begin().await?;
        sqlx::query("select pg_advisory_xact_lock(hashtext($1))")
            .bind(format!("secret.create:{}", who.agent_id))
            .execute(&mut *tx)
            .await?;
        if count_created(&mut *tx, &who.agent_id).await? >= AGENT_SECRET_MAX as i32 {
            tx.rollback().await?;
            return Ok(None);
        }
        let id: String = sqlx::query_scalar(INSERT_SECRET_SQL)
            .bind(&b.name)
            .bind(g.kind)
            .bind(g.filename.as_deref())
            .bind(&b.description)
            .bind(lease.owner_id.as_deref())
            .bind(&expires_at)
            .bind(&who.agent_id)
            .bind(&lease.cause_message_id)
            .fetch_one(&mut *tx)
            .await?;
        let sealed = keyring.seal(
            &g.value,
            &SecretAad {
                secret_id: &id,
                version: 1,
                kind,
            },
        );
        sqlx::query(INSERT_VERSION_SQL)
            .bind(&id)
            .bind(1i32)
            .bind(&sealed)
            .bind(g.value.len() as i32)
            .bind(&who.agent_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(INSERT_GRANT_SQL)
            .bind(&id)
            .bind(&who.agent_id)
            .bind(&lease.channel_id)
            .bind(&lease.operator_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(Some(id))
    }
    .await;
    let id = match tx_result {
        Ok(Some(id)) => id,
        Ok(None) => return Ok(Err(CreateDenial::TooMany)),
        Err(e)
            if e.as_database_error()
                .and_then(|d| d.code())
                .is_some_and(|c| c == "23505") =>
        {
            return Ok(Err(CreateDenial::NameTaken));
        }
        Err(e) => return Err(e),
    };
    log_access(&st.write, &id, &b.name, 1, &lease, Action::Create, &now_iso).await?;
    crate::write::record_audit(
        &st.write,
        crate::write::AuditEntry {
            action: "secret.created",
            actor_id: Some(&who.agent_id),
            actor_handle: None,
            target: Some(&id),
            ip: None,
            detail: serde_json::json!({
                "name": b.name, "kind": g.kind, "via": g.via(), "type": g.gen_type, "byAgent": true,
                "leaseId": lease.id, "causeMessageId": lease.cause_message_id, "causeAuthorId": lease.cause_author_id,
                "channelId": lease.channel_id, "operatorId": lease.operator_id,
            }),
        },
    )
    .await;
    notify_owner(
        post,
        &lease,
        &id,
        &b.name,
        1,
        Action::Create,
        g.gen_type.as_deref(),
    )
    .await;
    Ok(Ok(Created {
        name: b.name.clone(),
        kind: g.kind,
        version: 1,
        public_key: g.public_key,
        expires_at: Some(expires_at),
    }))
}

/// 회전 대상의 부여가 "자동 부여 한 줄뿐"인가(TS `auto`). `Some(suspended)` = 자동 부여, `None` = 입양됨.
pub fn auto_grant(agent: &str, grants: &[(String, String, Option<String>, bool)]) -> Option<bool> {
    match grants {
        [(a, by, Some(_), suspended)] if a == agent && by == agent => Some(*suspended),
        _ => None,
    }
}

/// TS `rotateAgentSecret`.
async fn rotate_secret(
    st: &AgentSecretCreateState,
    post: &PostState,
    keyring: &SecretKeyring,
    who: &Who,
    b: &AgentBody,
) -> Result<Result<Created, CreateDenial>, sqlx::Error> {
    let (lease, now) = match gate(st, who, &b.lease_id, &b.token, Action::Rotate).await? {
        Ok(v) => v,
        Err(d) => return Ok(Err(d)),
    };
    let now_iso = crate::core::msg_post::iso_ms(now);
    type Target = (String, String, String, String, Option<bool>, Option<String>);
    let s: Option<Target> = sqlx::query_as(ROTATE_TARGET_SQL)
        .bind(&b.name)
        .bind(&who.agent_id)
        .bind(&now_iso)
        .fetch_optional(&st.write)
        .await?;
    let Some((sid, sname, skind, sdesc, expired, latest_by)) = s else {
        return Ok(Err(CreateDenial::NotFound));
    };
    if expired == Some(true) {
        return Ok(Err(CreateDenial::SecretExpired));
    }
    let grants: Vec<(String, String, Option<String>, bool)> = sqlx::query_as(ROTATE_GRANTS_SQL)
        .bind(&sid)
        .fetch_all(&st.write)
        .await?;
    let auto = auto_grant(&who.agent_id, &grants);
    if latest_by.as_deref() != Some(who.agent_id.as_str()) || auto.is_none() {
        return Ok(Err(CreateDenial::AdoptedByOwner));
    }
    if auto == Some(true) {
        return Ok(Err(CreateDenial::GrantSuspended));
    }
    let g = match resolve_value(st, keyring, &lease, &now_iso, &b.source, &sname).await? {
        Ok(g) => g,
        Err(d) => return Ok(Err(d)),
    };
    if g.kind != skind {
        return Ok(Err(CreateDenial::KindMismatch));
    }
    if description_leaks(&sdesc, &g.value) {
        return Ok(Err(CreateDenial::SecretInDescription));
    }
    let kind = if g.kind == "file" {
        SecretKind::File
    } else {
        SecretKind::Text
    };
    let mut tx = st.write.begin().await?;
    sqlx::query(ROTATE_LOCK_SQL)
        .bind(&sid)
        .execute(&mut *tx)
        .await?;
    let cur: i32 = sqlx::query_scalar(ROTATE_MAX_SQL)
        .bind(&sid)
        .fetch_one(&mut *tx)
        .await?;
    let version = cur + 1;
    let sealed = keyring.seal(
        &g.value,
        &SecretAad {
            secret_id: &sid,
            version: i64::from(version),
            kind,
        },
    );
    sqlx::query(INSERT_VERSION_SQL)
        .bind(&sid)
        .bind(version)
        .bind(&sealed)
        .bind(g.value.len() as i32)
        .bind(&who.agent_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(ROTATE_REVOKE_SQL)
        .bind(&sid)
        .bind(version)
        .execute(&mut *tx)
        .await?;
    sqlx::query(ROTATE_TOUCH_SQL)
        .bind(&sid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    log_access(
        &st.write,
        &sid,
        &sname,
        version,
        &lease,
        Action::Rotate,
        &now_iso,
    )
    .await?;
    crate::write::record_audit(
        &st.write,
        crate::write::AuditEntry {
            action: "secret.rotated",
            actor_id: Some(&who.agent_id),
            actor_handle: None,
            target: Some(&sid),
            ip: None,
            detail: serde_json::json!({
                "name": sname, "version": version, "via": g.via(), "type": g.gen_type,
                "leaseId": lease.id, "causeMessageId": lease.cause_message_id, "causeAuthorId": lease.cause_author_id,
                "channelId": lease.channel_id, "operatorId": lease.operator_id,
            }),
        },
    )
    .await;
    notify_owner(
        post,
        &lease,
        &sid,
        &sname,
        version,
        Action::Rotate,
        g.gen_type.as_deref(),
    )
    .await;
    Ok(Ok(Created {
        name: sname,
        kind: g.kind,
        version,
        public_key: g.public_key,
        expires_at: None,
    }))
}

fn no_store(mut r: Response) -> Response {
    r.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    r
}

/// 성공 응답 몸 — 만들기는 201 + `expiresAt`, 회전은 200(`expiresAt` 없음).
pub fn created_json(
    action: Action,
    name: &str,
    kind: &str,
    version: i32,
    expires_at: Option<&str>,
    public_key: Option<&str>,
) -> String {
    use serde_json::json;
    let secret = match action {
        Action::Create => {
            json!({ "name": name, "kind": kind, "version": version, "expiresAt": expires_at })
        }
        Action::Rotate => json!({ "name": name, "kind": kind, "version": version }),
    };
    json!({ "secret": secret, "publicKey": public_key }).to_string()
}

/// `POST /agent/secrets`·`POST /agent/secrets/rotate` 공통(generate·import). 키링 없음만 판정·속도 제한 **앞에서** TS 로 넘긴다.
async fn create_or_rotate(
    st: Arc<AgentSecretCreateState>,
    peer: SocketAddr,
    req: Request,
    action: Action,
) -> Response {
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
    // `routes` 는 글 경로가 있을 때만 이 줄을 붙인다.
    let Some(post) = st.post.as_ref() else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "not found");
    };
    // 키가 없거나 틀리면 TS 가 409(`secret_store_disabled`·`secret_key_mismatch`)를 그대로 낸다.
    let Some(keyring) = st.keyring.as_ref() else {
        return to_ts(post.up.clone(), peer, parts, bytes).await;
    };
    let json = match &parsed {
        crate::write::Body::Json(v) => v.clone(),
        crate::write::Body::None => serde_json::json!({}),
        crate::write::Body::Text(s) => serde_json::Value::String(s.clone()),
    };
    let Some(b) = parse_body(&json, action == Action::Rotate) else {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD_CREATE_MESSAGE);
    };
    // 본문 사본(import 의 base64 포함)은 여기서 놓는다 — 값은 `b.source` 의 지워지는 버퍼에만 남는다.
    drop(json);
    drop(parsed);
    let who = Who {
        agent_id: me.id.clone(),
        operator_id: op.id.clone(),
    };
    let r = match action {
        Action::Create => create_secret(&st, post, keyring, &who, &b).await,
        Action::Rotate => rotate_secret(&st, post, keyring, &who, &b).await,
    };
    match r {
        Err(e) => internal(e),
        Ok(Err(d)) => no_store(json_err(d.status(), d.code(), &denial_message(action, d))),
        Ok(Ok(c)) => {
            let mut resp = json_ok(created_json(
                action,
                &c.name,
                c.kind,
                c.version,
                c.expires_at.as_deref(),
                c.public_key.as_deref(),
            ));
            if action == Action::Create {
                *resp.status_mut() = StatusCode::CREATED;
            }
            no_store(resp)
        }
    }
}

/// `POST /agent/secrets`.
pub async fn create(
    State(st): State<Arc<AgentSecretCreateState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    create_or_rotate(st, peer, req, Action::Create).await
}

/// `POST /agent/secrets/rotate`.
pub async fn rotate(
    State(st): State<Arc<AgentSecretCreateState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    create_or_rotate(st, peer, req, Action::Rotate).await
}

pub fn routes(
    st: AgentSecretCreateState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let mut t =
        Table::<Arc<AgentSecretCreateState>>::new().get("/agent/secret-create", secret_create);
    // 두 줄은 같은 속도 제한을 나눠 쓰므로 함께 선다(글 경로가 있을 때만).
    if st.post.is_some() {
        t = t
            .post("/agent/secrets", create)
            .post("/agent/secrets/rotate", rotate);
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
        assert!(pem.starts_with(PEM_BEGIN));
        assert!(pem.ends_with(PEM_END));
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
        assert_eq!(
            parse_body(&imp, false).unwrap().source,
            Source::Import {
                kind: "text",
                filename: None,
                value: ImportValue(zeroize::Zeroizing::new(b"hi".to_vec()))
            }
        );
        imp["source"] =
            json!({"import": {"kind": "file", "filename": "id_rsa", "valueBase64": "", }});
        assert_eq!(
            parse_body(&imp, true).unwrap().source,
            Source::Import {
                kind: "file",
                filename: Some("id_rsa".into()),
                value: ImportValue(zeroize::Zeroizing::new(Vec::new()))
            },
            "빈 값은 본문을 지나고 gate 뒤에 bad_value"
        );
        imp["source"] = json!({"import": {"kind": "text", "filename": null, "valueBase64": "a"}});
        assert!(parse_body(&imp, false).is_some());
        imp["source"] = json!({"import": {"kind": "text", "valueBase64": "x".repeat(87_389)}});
        assert!(parse_body(&imp, false).is_none(), "zod max");
        imp["source"] = json!({"import": {"kind": "text", "valueBase64": "QUFB".repeat(21_847)}});
        assert!(parse_body(&imp, false).is_some(), "87388 글자까지");
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
    fn notice_line_matches_ts_notify_owner() {
        let n = NoticeArgs {
            action: Action::Create,
            agent_id: "ag",
            owner_id: "ow",
            secret_id: "s1",
            name: "db@x",
            version: 1,
            gen_type: Some("password"),
        };
        let (body, meta) = notice_line("bot", "kim", &n);
        assert_eq!(
            body,
            "🔑 bot 가 비밀 `db＠x` 을 만들었다 · 서버가 만든 값(password) · 이 채널로 자기에게만 부여 · 설정 › 나 › 비밀과 API @kim"
        );
        assert_eq!(
            meta["i18n"],
            serde_json::json!({ "key": "system.secret.createdGenerated",
                "args": { "agentId": "ag", "name": "db@x", "type": "password", "ownerId": "ow" } })
        );
        assert_eq!(
            meta["secretNotice"],
            serde_json::json!({ "action": "created", "secretId": "s1", "name": "db@x", "version": 1,
                "via": "generate", "agentId": "ag", "ownerAccountId": "ow" })
        );
        let (body, meta) = notice_line(
            "bot",
            "kim",
            &NoticeArgs {
                action: Action::Rotate,
                version: 3,
                ..n
            },
        );
        assert!(body.contains("을 회전했다(판 3) · 서버가 만든 값(password)"));
        assert_eq!(meta["i18n"]["key"], "system.secret.rotatedGenerated");
        assert_eq!(meta["i18n"]["args"]["version"], 3);
        assert_eq!(meta["secretNotice"]["action"], "rotated");
        let imp = NoticeArgs {
            gen_type: None,
            ..n
        };
        let (body, meta) = notice_line("bot", "kim", &imp);
        assert_eq!(
            body,
            "🔑 bot 가 비밀 `db＠x` 을 만들었다 · 값을 에이전트가 정함(import) · 이 채널로 자기에게만 부여 · 설정 › 나 › 비밀과 API @kim"
        );
        assert_eq!(
            meta["i18n"],
            serde_json::json!({ "key": "system.secret.createdImported",
                "args": { "agentId": "ag", "name": "db@x", "ownerId": "ow" } })
        );
        assert_eq!(meta["secretNotice"]["via"], "import");
        let (body, meta) = notice_line(
            "bot",
            "kim",
            &NoticeArgs {
                action: Action::Rotate,
                version: 2,
                ..imp
            },
        );
        assert!(body.contains("을 회전했다(판 2) · 값을 에이전트가 정함(import) ·"));
        assert_eq!(
            meta["i18n"],
            serde_json::json!({ "key": "system.secret.rotatedImported",
                "args": { "agentId": "ag", "name": "db@x", "version": 2, "ownerId": "ow" } })
        );
    }

    #[test]
    fn base64_decodes_like_node_buffer() {
        // `node -e 'Buffer.from(s, "base64")'` 의 결과.
        for (s, want) in [
            ("", &b""[..]),
            ("a", b""),
            ("aG", b"h"),
            ("aGk", b"hi"),
            ("aGk=", b"hi"),
            ("aGk==", b"hi"),
            ("aGl=", b"hi"),
            ("aGkx", b"hi1"),
            ("aGkxa", b"hi1"),
            ("aGkxaG", b"hi1h"),
            ("+/8=", &[0xfb, 0xff]),
        ] {
            assert_eq!(&node_base64_decode(s).unwrap()[..], want, "{s}");
        }
        assert!(node_base64_decode("a-b").is_none());
    }

    #[test]
    fn import_value_rules_match_ts_resolve_value() {
        assert_eq!(check_import_value("text", b""), Err(CreateDenial::BadValue));
        assert_eq!(check_import_value("file", b""), Err(CreateDenial::BadValue));
        let big = vec![b'a'; SECRET_CREATE_MAX_BYTES];
        assert_eq!(check_import_value("text", &big), Ok(()));
        let over = vec![b'a'; SECRET_CREATE_MAX_BYTES + 1];
        assert_eq!(
            check_import_value("file", &over),
            Err(CreateDenial::BadValue)
        );
        assert_eq!(
            check_import_value("text", &[0xff, 0x41]),
            Err(CreateDenial::BadValue)
        );
        assert_eq!(
            check_import_value("text", "x\u{FFFD}".as_bytes()),
            Err(CreateDenial::BadValue),
            "TS 는 풀린 글에 U+FFFD 가 있는지만 본다"
        );
        assert_eq!(check_import_value("file", &[0xff, 0x00]), Ok(()));
        assert_eq!(check_import_value("text", "비밀".as_bytes()), Ok(()));
    }

    #[test]
    fn mounted_value_compare_trims_trailing_whitespace() {
        assert_eq!(trim_end_ws(b"abc \r\n\t"), b"abc");
        assert_eq!(trim_end_ws(b" \n"), b"");
        assert_eq!(trim_end_ws(b" a b"), b" a b");
        assert!(same_mounted_value(b"tok", b"tok"));
        assert!(same_mounted_value(b"tok\n", b"tok"));
        assert!(same_mounted_value(b"tok", b"tok \r\n"));
        assert!(!same_mounted_value(b"tok", b" tok"), "앞 공백은 다르다");
        assert!(!same_mounted_value(b"tok", b"toke"));
        assert!(!same_mounted_value(b"tok\x0b", b"tok"), "VT 는 걷지 않는다");
    }

    #[test]
    fn import_value_debug_is_redacted() {
        let s = Source::Import {
            kind: "text",
            filename: None,
            value: ImportValue(zeroize::Zeroizing::new(b"hunter2".to_vec())),
        };
        assert!(!format!("{s:?}").contains("hunter2"));
    }

    #[test]
    fn auto_grant_is_one_own_channel_row() {
        let own = |s: bool| ("a".to_owned(), "a".to_owned(), Some("c".to_owned()), s);
        assert_eq!(auto_grant("a", &[own(false)]), Some(false));
        assert_eq!(auto_grant("a", &[own(true)]), Some(true));
        assert_eq!(auto_grant("a", &[]), None);
        assert_eq!(auto_grant("a", &[own(false), own(false)]), None);
        assert_eq!(
            auto_grant("a", &[("a".into(), "h".into(), Some("c".into()), false)]),
            None,
            "사람이 다시 줬다"
        );
        assert_eq!(
            auto_grant("a", &[("a".into(), "a".into(), None, false)]),
            None,
            "null 채널"
        );
    }

    #[test]
    fn reply_bodies_match_ts() {
        assert_eq!(
            denial_message(Action::Create, CreateDenial::TooMany),
            "secret not created: too_many"
        );
        assert_eq!(
            denial_message(Action::Rotate, CreateDenial::AdoptedByOwner),
            "secret not rotated: adopted_by_owner"
        );
        let c: serde_json::Value = serde_json::from_str(&created_json(
            Action::Create,
            "k",
            "file",
            1,
            Some("2027-01-01T00:00:00.000Z"),
            Some("ssh-ed25519 AAA harkroom:k"),
        ))
        .unwrap();
        assert_eq!(
            c,
            serde_json::json!({ "secret": { "name": "k", "kind": "file", "version": 1, "expiresAt": "2027-01-01T00:00:00.000Z" },
                "publicKey": "ssh-ed25519 AAA harkroom:k" })
        );
        let r: serde_json::Value =
            serde_json::from_str(&created_json(Action::Rotate, "k", "text", 2, None, None))
                .unwrap();
        assert_eq!(
            r,
            serde_json::json!({ "secret": { "name": "k", "kind": "text", "version": 2 }, "publicKey": null })
        );
    }

    #[test]
    fn description_leak_catches_value() {
        let v = b"s3cr3t-value-0123456789";
        assert!(description_leaks("see s3cr3t-value-0123456789", v));
        assert!(!description_leaks("database password", v));
    }

    #[test]
    fn token_hash_is_sha256_hex() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn write_privileges_exclude_automation_and_cover_tables() {
        let p = write_privileges();
        assert!(!p.iter().any(|(c, _)| c.starts_with("automation")));
        for need in [
            ("secret_turn_lease.token_hash", "SELECT"),
            ("secret.created_cause_message_id", "INSERT"),
            ("secret_grant.granted_by", "INSERT"),
            ("secret_access_log.at", "INSERT"),
            ("secret_version.revoked_at", "UPDATE"),
            ("secret.updated_at", "UPDATE"),
            ("audit_log", "INSERT"),
            ("account_grant.capability", "SELECT"),
        ] {
            assert!(p.contains(&need), "{need:?}");
        }
        // import 의 F4(마운트된 값) — TS `isMountedValue` 가 읽는 칸.
        let own = CREATE_WRITE_PRIVILEGES;
        for need in [
            ("secret_access_log.secret_id", "SELECT"),
            ("secret_access_log.version", "SELECT"),
            ("secret_access_log.turn_id", "SELECT"),
            ("secret_access_log.result", "SELECT"),
            ("secret_turn_lease.operator_id", "SELECT"),
            ("secret_turn_lease.ended_at", "SELECT"),
            ("secret_turn_lease.expires_at", "SELECT"),
            ("secret.kind", "SELECT"),
            ("secret_version.sealed", "SELECT"),
        ] {
            assert!(own.contains(&need), "{need:?}");
        }
        // 접근 기록의 다른 칸(이름·사유·채널…)은 읽지 않는다.
        assert!(!own.contains(&("secret_access_log.secret_name", "SELECT")));
        assert!(!own.contains(&("secret_access_log.reason", "SELECT")));
    }

    #[test]
    fn privileges_include_key_check() {
        let p = privileges();
        assert!(p.contains(&("account_grant.suspended_at", "SELECT")));
        assert!(p.contains(&("secret_key_check.kcv", "SELECT")));
    }
}
