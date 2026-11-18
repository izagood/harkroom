//! S5.4 SE3 — 비밀 REST 쓰기 세 줄: `POST /secrets`·`PATCH /secrets/:id`·`PUT /secrets/:id/value`. TS `routes/secretRoutes.ts` 를 옮긴다.
//! SE4 — 목록 `GET /secrets` 도 여기 있다(키링 상태·행마다 `keyLost` 를 싣는다 — 같은 기동 키링을 쓴다).
//!
//! - 키링은 기동에 한 번 [`load_state`] 가 env 로 읽어 DB 확인값(`secret_key_check`)과 맞춘다(TS `verifySecretKeys`).
//!   키가 없거나 맞지 않으면 TS 와 같이 409(`secret_store_disabled`·`secret_key_mismatch`)로 답한다. env 가 잘못돼
//!   읽을 수 없으면 이 줄들을 붙이지 않는다(TS 에 남는다).
//! - 판정 순서·상태·코드는 TS 와 같다. zod 오류 문구는 다르다 — 대조는 상태·코드만 본다.
//! - **값은 답·감사·오류 어디에도 싣지 않는다.** 봉인은 v2(AAD = id·판·종류·kid).
//! - 권한은 [`SECRET_WRITES_PRIVILEGES`]·[`crate::secrets::verify::SECRET_KEY_CHECK_PRIVILEGES`] — 없으면 TS 에 남는다.
//! - 소유자 보기 `POST /secrets/:id/reveal` 은 `secret_reveal.rs` 가 맡는다(같은 기동 키 확인). 에이전트 `/agent/secrets*` 는 TS 에 남긴다.
use crate::auth::{Account, RequireAccount};
use crate::core::content_scan::scan_write;
use crate::core::secrets_read::{SECRET_SQL, load};
use crate::directory::{internal, json_err, json_ok};
use crate::secrets::keyring::{SecretAad, SecretKeyring};
use crate::secrets::leak::needles_for;
use crate::secrets::verify::{SECRET_KEY_CHECK_PRIVILEGES, kind_of, load_verified_from_env};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, record_audit};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use base64::Engine;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use zeroize::Zeroizing;

/// 계획 D6. 파일·텍스트 공통 상한(바이트).
const SECRET_MAX_BYTES: usize = 64 * 1024;

/// 쓰기 풀이 쓰는 칸 권한(표.칸, 권한).
pub const SECRET_WRITES_PRIVILEGES: &[(&str, &str)] = &[
    ("secret.id", "INSERT"),
    ("secret.name", "INSERT"),
    ("secret.kind", "INSERT"),
    ("secret.filename", "INSERT"),
    ("secret.description", "INSERT"),
    ("secret.owner_account_id", "INSERT"),
    ("secret.expires_at", "INSERT"),
    ("secret.id", "SELECT"),
    ("secret.description", "SELECT"),
    ("secret.expires_at", "SELECT"),
    ("secret.description", "UPDATE"),
    ("secret.expires_at", "UPDATE"),
    ("secret.updated_at", "UPDATE"),
    ("secret_version.secret_id", "INSERT"),
    ("secret_version.version", "INSERT"),
    ("secret_version.sealed", "INSERT"),
    ("secret_version.size_bytes", "INSERT"),
    ("secret_version.created_by", "INSERT"),
    ("secret_version.secret_id", "SELECT"),
    ("secret_version.version", "SELECT"),
    ("secret_version.revoked_at", "SELECT"),
    ("secret_version.sealed", "SELECT"),
    ("secret_version.sealed", "UPDATE"),
    ("secret_version.revoked_at", "UPDATE"),
];

/// 모든 권한(쓰기 세 줄 + 기동 키 확인).
pub fn privileges() -> Vec<(&'static str, &'static str)> {
    SECRET_WRITES_PRIVILEGES
        .iter()
        .chain(SECRET_KEY_CHECK_PRIVILEGES)
        .copied()
        .collect()
}

const NEW_ID_SQL: &str = "select gen_random_uuid()::text";
const INSERT_SECRET_SQL: &str = "insert into secret (id, name, kind, filename, description, owner_account_id, expires_at) \
     values ($1::uuid, $2, $3, $4, $5, $6::uuid, $7::timestamptz)";
const INSERT_VERSION_SQL: &str = "insert into secret_version (secret_id, version, sealed, size_bytes, created_by) \
     values ($1::uuid, $2, $3, $4, $5::uuid)";
const CURRENT_SEALED_SQL: &str = "select version, sealed from secret_version \
     where secret_id = $1::uuid and sealed is not null order by version desc limit 1";
const PATCH_SQL: &str = "update secret set description = coalesce($2, description), \
       expires_at = case when $3::boolean then $4::timestamptz else expires_at end, updated_at = now() \
     where id = $1::uuid";
const LOCK_SQL: &str = "select 1 from secret where id = $1::uuid for update";
const MAX_VERSION_SQL: &str =
    "select coalesce(max(version), 0)::int from secret_version where secret_id = $1::uuid";
const REVOKE_OLD_SQL: &str = "update secret_version set sealed = null, revoked_at = now() \
     where secret_id = $1::uuid and version < $2 and revoked_at is null";
const TOUCH_SQL: &str = "update secret set updated_at = now() where id = $1::uuid";
/// TS `GET /secrets` — `SECRET_COLS` + 지금 판의 kid(`split_part(sealed, '.', 2)`). 값 자체는 고르지 않는다. admin 은 모두, 아니면 내 것.
const LIST_SQL: &str = "select json_build_object(\
       'id', s.id, 'name', s.name, 'kind', s.kind, 'filename', s.filename, 'description', s.description, \
       'ownerAccountId', s.owner_account_id, \
       'expiresAt', to_char(s.expires_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
       'createdAt', to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
       'updatedAt', to_char(s.updated_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
       'version', v.version, 'sizeBytes', v.size_bytes, \
       'grantCount', (select count(*)::int from secret_grant g where g.secret_id = s.id), \
       'createdByAgentId', s.created_by_agent_id, 'createdCauseMessageId', s.created_cause_message_id, \
       'valueSetByAgentId', (select a.id from account a where a.id = v.created_by and a.kind = 'agent'))::text, \
       v.sealed_kid \
     from secret s left join lateral ( \
       select version, size_bytes, created_by, split_part(sealed, '.', 2) as sealed_kid from secret_version \
        where secret_id = s.id and revoked_at is null order by version desc limit 1) v on true \
     where $1::boolean or s.owner_account_id = $2::uuid order by s.name";

pub struct SecretWritesState {
    read: PgPool,
    write: PgPool,
    trust: Arc<TrustProxy>,
    keyring: Option<SecretKeyring>,
    mismatch: bool,
}

/// 기동 한 번: 키를 읽어 확인값과 맞춘다. env 가 잘못됐거나 DB 확인이 실패하면 `Err`(이 줄들은 TS 에 남는다).
pub async fn load_state(
    read: PgPool,
    write: PgPool,
    trust: Arc<TrustProxy>,
) -> Result<SecretWritesState, String> {
    let v = load_verified_from_env(&write).await?;
    let (keyring, mismatch) = match v {
        None => (None, false),
        Some(v) => {
            if !v.rejected_kids.is_empty() {
                eprintln!(
                    "front: secret keys rejected by key check: {:?}",
                    v.rejected_kids
                );
            }
            (v.keyring, v.mismatch)
        }
    };
    Ok(SecretWritesState {
        read,
        write,
        trust,
        keyring,
        mismatch,
    })
}

fn agent_refused() -> Response {
    json_err(
        StatusCode::FORBIDDEN,
        "forbidden",
        "agents cannot manage secrets",
    )
}
fn disabled(mismatch: bool) -> Response {
    if mismatch {
        json_err(
            StatusCode::CONFLICT,
            "secret_key_mismatch",
            "the secret store key on the server does not match the key these secrets were sealed with; the secret store is off",
        )
    } else {
        json_err(
            StatusCode::CONFLICT,
            "secret_store_disabled",
            "HARKROOM_SECRET_KEYS_DIR is not set on the server; the secret store is off",
        )
    }
}
fn bad_request(m: &str) -> Response {
    json_err(StatusCode::BAD_REQUEST, "bad_request", m)
}
fn bad_value(m: &str) -> Response {
    json_err(StatusCode::BAD_REQUEST, "bad_value", m)
}
fn description_leak() -> Response {
    json_err(
        StatusCode::BAD_REQUEST,
        "secret_in_description",
        "the description looks like it contains a secret value",
    )
}
fn internal_msg() -> Response {
    json_err(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "internal error",
    )
}
fn not_found() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such secret")
}

pub(crate) fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// TS `NAME`.
pub(crate) fn valid_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// TS `FILENAME` — `.`·`..` 아님, 1–255 글자(UTF-16), `/`·`\`·NUL 없음.
pub(crate) fn valid_filename(s: &str) -> bool {
    s != "." && s != ".." && (1..=255).contains(&len16(s)) && !s.contains(['/', '\\', '\0'])
}

/// zod `z.string().datetime()`(오프셋 없음, 소수 초 자유).
fn valid_datetime(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 20 || b[b.len() - 1] != b'Z' {
        return false;
    }
    let d = |i: usize| b[i].is_ascii_digit();
    let head = (0..4).all(d)
        && b[4] == b'-'
        && d(5)
        && d(6)
        && b[7] == b'-'
        && d(8)
        && d(9)
        && b[10] == b'T'
        && d(11)
        && d(12)
        && b[13] == b':'
        && d(14)
        && d(15)
        && b[16] == b':'
        && d(17)
        && d(18);
    if !head {
        return false;
    }
    let rest = &b[19..b.len() - 1];
    rest.is_empty()
        || (rest.len() >= 2 && rest[0] == b'.' && rest[1..].iter().all(u8::is_ascii_digit))
}

fn body_object(body: &Body) -> Option<Map<String, Value>> {
    match body {
        Body::None | Body::Json(Value::Null) => Some(Map::new()),
        Body::Json(Value::Object(o)) => Some(o.clone()),
        _ => None,
    }
}

/// `z.string().optional()` — 없으면 None, 문자열이면 Some, 그 밖은 Err.
fn opt_str(o: &Map<String, Value>, k: &str) -> Result<Option<String>, ()> {
    match o.get(k) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        _ => Err(()),
    }
}

/// `z.string().datetime().nullable().optional()` — 없음 / null / 값.
#[derive(Debug, PartialEq)]
enum Expires {
    Absent,
    Null,
    At(String),
}

fn expires(o: &Map<String, Value>) -> Result<Expires, ()> {
    match o.get("expiresAt") {
        None => Ok(Expires::Absent),
        Some(Value::Null) => Ok(Expires::Null),
        Some(Value::String(s)) if valid_datetime(s) => Ok(Expires::At(s.clone())),
        _ => Err(()),
    }
}

impl Expires {
    fn value(&self) -> Option<&str> {
        match self {
            Self::At(s) => Some(s),
            _ => None,
        }
    }
}

#[derive(Debug)]
struct ValueFields {
    value: Option<String>,
    value_base64: Option<String>,
}

fn value_fields(o: &Map<String, Value>) -> Result<ValueFields, ()> {
    Ok(ValueFields {
        value: opt_str(o, "value")?,
        value_base64: opt_str(o, "valueBase64")?,
    })
}

fn node_base64() -> base64::engine::GeneralPurpose {
    base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    )
}

/// TS `valueBytes`. 오류 문장은 값을 되비추지 않는다.
fn value_bytes(kind: &str, v: &ValueFields) -> Result<Zeroizing<Vec<u8>>, String> {
    if kind == "text" {
        let (Some(s), None) = (&v.value, &v.value_base64) else {
            return Err("text secrets take `value`".into());
        };
        let b = Zeroizing::new(s.as_bytes().to_vec());
        if b.is_empty() {
            return Err("value is empty".into());
        }
        if b.len() > SECRET_MAX_BYTES {
            return Err(format!("value is larger than {SECRET_MAX_BYTES} bytes"));
        }
        return Ok(b);
    }
    let (Some(s), None) = (&v.value_base64, &v.value) else {
        return Err("file secrets take `valueBase64`".into());
    };
    let body = s.trim_end_matches('=');
    let pads = s.len() - body.len();
    if pads > 2
        || !body
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
    {
        return Err("valueBase64 is not base64".into());
    }
    // node 는 4로 나눈 나머지가 1인 꼬리 글자를 버린다.
    let usable = if body.len() % 4 == 1 {
        &body[..body.len() - 1]
    } else {
        body
    };
    let b = Zeroizing::new(
        node_base64()
            .decode(usable)
            .map_err(|_| "valueBase64 is not base64".to_owned())?,
    );
    if b.is_empty() {
        return Err("file is empty".into());
    }
    if b.len() > SECRET_MAX_BYTES {
        return Err(format!("file is larger than {SECRET_MAX_BYTES} bytes"));
    }
    Ok(b)
}

fn describes_value(description: &str, value: &[u8]) -> bool {
    needles_for(value)
        .iter()
        .any(|n| description.contains(n.as_str()))
}

fn scan_hits_secret(text: &str) -> bool {
    scan_write(&[Some(text)]).is_some_and(|h| h.rules.contains(&"secret"))
}

#[allow(clippy::result_large_err)]
async fn secret_json(read: &PgPool, id: &str) -> Result<String, Response> {
    let row: Option<(String, String, String)> = sqlx::query_as(SECRET_SQL)
        .bind(id)
        .fetch_optional(read)
        .await
        .map_err(internal)?;
    Ok(row.map_or_else(|| "null".to_owned(), |r| r.0))
}

fn secret_reply(status: StatusCode, json: &str) -> Response {
    let mut r = json_ok(format!("{{\"secret\":{json}}}"));
    *r.status_mut() = status;
    r
}

async fn audit(
    st: &SecretWritesState,
    me: &Account,
    ip: Option<&str>,
    action: &str,
    target: &str,
    detail: Value,
) {
    record_audit(
        &st.write,
        AuditEntry {
            action,
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(target),
            ip,
            detail,
        },
    )
    .await;
}

fn is_unique_violation(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .and_then(|d| d.code())
        .is_some_and(|c| c == "23505")
}

/// `POST /secrets`.
pub async fn create(State(st): State<Arc<SecretWritesState>>, req: Request) -> Response {
    let (body, RequireAccount(me, _), parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if me.kind == "agent" {
        return agent_refused();
    }
    let Some(keyring) = &st.keyring else {
        return disabled(st.mismatch);
    };
    let parsed = (|| -> Result<_, ()> {
        let o = body_object(&body).ok_or(())?;
        let name = match o.get("name") {
            Some(Value::String(s)) if valid_name(s) => s.clone(),
            _ => return Err(()),
        };
        let kind = match o.get("kind") {
            Some(Value::String(s)) if s == "text" || s == "file" => s.clone(),
            _ => return Err(()),
        };
        let filename = match o.get("filename") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if valid_filename(s) => Some(s.clone()),
            _ => return Err(()),
        };
        let description = match o.get("description") {
            None => String::new(),
            Some(Value::String(s)) if len16(s) <= 500 => s.clone(),
            _ => return Err(()),
        };
        Ok((
            name,
            kind,
            filename,
            description,
            expires(&o)?,
            value_fields(&o)?,
        ))
    })();
    let Ok((name, kind, filename, description, exp, vf)) = parsed else {
        return bad_request("body: invalid");
    };
    if kind == "file" && filename.as_deref().is_none_or(str::is_empty) {
        return bad_request("file secrets need a filename");
    }
    if kind == "text" && filename.as_deref().is_some_and(|f| !f.is_empty()) {
        return bad_request("text secrets have no filename");
    }
    if scan_hits_secret(&description) {
        return description_leak();
    }
    let bytes = match value_bytes(&kind, &vf) {
        Ok(b) => b,
        Err(m) => return bad_value(&m),
    };
    if describes_value(&description, &bytes) {
        return description_leak();
    }
    let id: String = match sqlx::query_scalar(NEW_ID_SQL).fetch_one(&st.write).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let sealed = keyring.seal(
        &bytes,
        &SecretAad {
            secret_id: &id,
            version: 1,
            kind: kind_of(&kind).expect("checked above"),
        },
    );
    let res: Result<(), sqlx::Error> = async {
        let mut tx = st.write.begin().await?;
        sqlx::query(INSERT_SECRET_SQL)
            .bind(&id)
            .bind(&name)
            .bind(&kind)
            .bind(&filename)
            .bind(&description)
            .bind(&me.id)
            .bind(exp.value())
            .execute(&mut *tx)
            .await?;
        sqlx::query(INSERT_VERSION_SQL)
            .bind(&id)
            .bind(1i32)
            .bind(&sealed)
            .bind(bytes.len() as i32)
            .bind(&me.id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await
    }
    .await;
    if let Err(e) = res {
        if is_unique_violation(&e) {
            return json_err(
                StatusCode::CONFLICT,
                "name_taken",
                "a secret with that name already exists",
            );
        }
        return internal(e);
    }
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    audit(
        &st,
        &me,
        ip.as_deref(),
        "secret.created",
        &id,
        json!({ "name": name, "kind": kind }),
    )
    .await;
    // 막 쓴 줄이라 쓰기 풀에서 읽는다(복제 지연을 피한다).
    match secret_json(&st.read, &id).await {
        Ok(j) => secret_reply(StatusCode::CREATED, &j),
        Err(r) => r,
    }
}

/// 소유자만(admin 도 남의 것은 404). 답은 (비밀 json 값).
#[allow(clippy::result_large_err)]
async fn load_own(st: &SecretWritesState, me: &Account, id: &str) -> Result<Value, Response> {
    let s = load(&st.read, me, id).await?;
    if s.owner != me.id {
        return Err(not_found());
    }
    serde_json::from_str(&s.json).map_err(|_| internal_msg())
}

/// `PATCH /secrets/:id`.
pub async fn patch(
    State(st): State<Arc<SecretWritesState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, _), parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let s = match load_own(&st, &me, &id).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let parsed = (|| -> Result<_, ()> {
        let o = body_object(&body).ok_or(())?;
        let description = match o.get("description") {
            None => None,
            Some(Value::String(s)) if len16(s) <= 500 => Some(s.clone()),
            _ => return Err(()),
        };
        Ok((description, expires(&o)?))
    })();
    let Ok((description, exp)) = parsed else {
        return bad_request("body: invalid");
    };
    if let Some(d) = &description {
        if scan_hits_secret(d) {
            return description_leak();
        }
        if let Some(keyring) = &st.keyring {
            let cur: Option<(i32, String)> = match sqlx::query_as(CURRENT_SEALED_SQL)
                .bind(&id)
                .fetch_optional(&st.write)
                .await
            {
                Ok(r) => r,
                Err(e) => return internal(e),
            };
            let kind = s.get("kind").and_then(Value::as_str).and_then(kind_of);
            if let (Some((version, sealed)), Some(kind)) = (cur, kind) {
                let value = keyring.open(
                    &sealed,
                    &SecretAad {
                        secret_id: &id,
                        version: i64::from(version),
                        kind,
                    },
                );
                if value.is_some_and(|v| describes_value(d, v.as_bytes())) {
                    return description_leak();
                }
            }
        }
    }
    let set_exp = exp != Expires::Absent;
    if let Err(e) = sqlx::query(PATCH_SQL)
        .bind(&id)
        .bind(&description)
        .bind(set_exp)
        .bind(exp.value())
        .execute(&st.write)
        .await
    {
        return internal(e);
    }
    let mut fields = Vec::new();
    if description.is_some() {
        fields.push("description");
    }
    if set_exp {
        fields.push("expiresAt");
    }
    let mut detail = json!({ "name": s.get("name"), "fields": fields });
    if set_exp {
        detail["expiresAt"] = json!({ "from": s.get("expiresAt"), "to": exp.value() });
    }
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    audit(&st, &me, ip.as_deref(), "secret.updated", &id, detail).await;
    match secret_json(&st.read, &id).await {
        Ok(j) => secret_reply(StatusCode::OK, &j),
        Err(r) => r,
    }
}

/// `PUT /secrets/:id/value` — 새 판. 옛 판의 암호문은 같은 트랜잭션에서 지운다.
pub async fn replace_value(
    State(st): State<Arc<SecretWritesState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, _), parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if me.kind == "agent" {
        return agent_refused();
    }
    let Some(keyring) = &st.keyring else {
        return disabled(st.mismatch);
    };
    let s = match load_own(&st, &me, &id).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let Some(vf) = body_object(&body).and_then(|o| value_fields(&o).ok()) else {
        return bad_request("body: invalid");
    };
    let kind_s = s.get("kind").and_then(Value::as_str).unwrap_or("text");
    let Some(kind) = kind_of(kind_s) else {
        return internal_msg();
    };
    let bytes = match value_bytes(kind_s, &vf) {
        Ok(b) => b,
        Err(m) => return bad_value(&m),
    };
    let description = s.get("description").and_then(Value::as_str).unwrap_or("");
    if describes_value(description, &bytes) {
        return description_leak();
    }
    let res: Result<i32, sqlx::Error> = async {
        let mut tx = st.write.begin().await?;
        sqlx::query(LOCK_SQL).bind(&id).execute(&mut *tx).await?;
        let cur: i32 = sqlx::query_scalar(MAX_VERSION_SQL)
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;
        let version = cur + 1;
        let sealed = keyring.seal(
            &bytes,
            &SecretAad {
                secret_id: &id,
                version: i64::from(version),
                kind,
            },
        );
        sqlx::query(INSERT_VERSION_SQL)
            .bind(&id)
            .bind(version)
            .bind(&sealed)
            .bind(bytes.len() as i32)
            .bind(&me.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(REVOKE_OLD_SQL)
            .bind(&id)
            .bind(version)
            .execute(&mut *tx)
            .await?;
        sqlx::query(TOUCH_SQL).bind(&id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(version)
    }
    .await;
    let version = match res {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    audit(
        &st,
        &me,
        ip.as_deref(),
        "secret.value.replaced",
        &id,
        json!({ "name": s.get("name"), "version": version }),
    )
    .await;
    match secret_json(&st.read, &id).await {
        Ok(j) => secret_reply(StatusCode::OK, &j),
        Err(r) => r,
    }
}

/// 행의 `keyLost` — 보관소가 켜져 있고, 지금 값의 kid 가 있고, 그 kid 가 키링에 없다. kid 이름은 내보내지 않는다.
fn key_lost(keyring: Option<&SecretKeyring>, sealed_kid: Option<&str>) -> bool {
    match (keyring, sealed_kid) {
        (Some(k), Some(kid)) if !kid.is_empty() => !k.kids().any(|x| x == kid),
        _ => false,
    }
}

/// `GET /secrets` — 사람만. admin 은 모두, 아니면 내 것. 이름 순.
pub async fn list(
    State(st): State<Arc<SecretWritesState>>,
    RequireAccount(me, _): RequireAccount,
) -> Response {
    if me.kind == "agent" {
        return agent_refused();
    }
    let rows: Vec<(String, Option<String>)> = match sqlx::query_as(LIST_SQL)
        .bind(me.is_admin)
        .bind(&me.id)
        .fetch_all(&st.read)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let mut secrets = Vec::with_capacity(rows.len());
    for (j, kid) in rows {
        let Ok(Value::Object(mut o)) = serde_json::from_str::<Value>(&j) else {
            return internal_msg();
        };
        o.insert(
            "keyLost".to_owned(),
            Value::Bool(key_lost(st.keyring.as_ref(), kid.as_deref())),
        );
        secrets.push(Value::Object(o));
    }
    json_ok(
        json!({
            "enabled": st.keyring.is_some(),
            "keyMismatch": st.mismatch,
            "secrets": secrets,
        })
        .to_string(),
    )
}

pub fn routes(
    st: SecretWritesState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<SecretWritesState>>::new()
        .get("/secrets", list)
        .post("/secrets", create)
        .patch("/secrets/{id}", patch)
        .put("/secrets/{id}/value", replace_value)
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
    fn name_and_filename_match_ts() {
        assert!(valid_name("a"));
        assert!(valid_name("gh_token-2"));
        assert!(!valid_name("_a"));
        assert!(!valid_name("A"));
        assert!(!valid_name(&"a".repeat(65)));
        assert!(valid_filename("id_rsa"));
        assert!(!valid_filename("."));
        assert!(!valid_filename(".."));
        assert!(!valid_filename("a/b"));
        assert!(!valid_filename(""));
    }

    #[test]
    fn datetime_matches_zod() {
        assert!(valid_datetime("2026-11-18T00:00:00Z"));
        assert!(valid_datetime("2026-11-18T00:00:00.123Z"));
        assert!(!valid_datetime("2026-11-18T00:00:00+09:00"));
        assert!(!valid_datetime("2026-11-18"));
        assert!(!valid_datetime("2026-11-18T00:00:00.Z"));
    }

    #[test]
    fn value_bytes_matches_ts() {
        let t = |v: Option<&str>, b: Option<&str>| ValueFields {
            value: v.map(str::to_owned),
            value_base64: b.map(str::to_owned),
        };
        assert_eq!(
            &value_bytes("text", &t(Some("hi"), None)).unwrap()[..],
            b"hi"
        );
        assert_eq!(
            value_bytes("text", &t(Some(""), None)).unwrap_err(),
            "value is empty"
        );
        assert!(value_bytes("text", &t(Some("x"), Some("eA=="))).is_err());
        assert_eq!(
            &value_bytes("file", &t(None, Some("aGk="))).unwrap()[..],
            b"hi"
        );
        assert_eq!(
            &value_bytes("file", &t(None, Some("aGk"))).unwrap()[..],
            b"hi"
        );
        assert_eq!(
            value_bytes("file", &t(None, Some("a-b"))).unwrap_err(),
            "valueBase64 is not base64"
        );
        assert_eq!(
            value_bytes("file", &t(None, Some(""))).unwrap_err(),
            "file is empty"
        );
        let big = "a".repeat(SECRET_MAX_BYTES + 1);
        assert!(value_bytes("text", &t(Some(&big), None)).is_err());
    }

    #[test]
    fn sql_casts_uuid_and_never_touches_automation() {
        for q in [
            INSERT_SECRET_SQL,
            INSERT_VERSION_SQL,
            CURRENT_SEALED_SQL,
            PATCH_SQL,
            LOCK_SQL,
            MAX_VERSION_SQL,
            REVOKE_OLD_SQL,
            TOUCH_SQL,
        ] {
            assert!(q.contains("$1::uuid"), "{q}");
            assert!(!q.contains("ingress"), "{q}");
        }
    }
}
