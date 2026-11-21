//! S5.4 — API 연결 만들기·고치기. TS `routes/connectorRoutes.ts` 의 `POST /connectors`·`PATCH /connectors/:id` 를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다.
//!   - POST: `requireAccount`(401) → 에이전트 403 `forbidden` → 본문(zod, 400 `bad_request`) → `normalizeBaseUrl`
//!     (400 `bad_base_url`) → `normalizeTokenUrl`(400 `bad_token_url`) → `checkAuth` → INSERT(이름 겹침 409
//!     `name_taken`) → 감사 `connector.created` → 201 `{connector}`.
//!   - PATCH: `requireAccount` → 403 → 경로 id(400 `invalid_request`) → 없거나 남의 것 404 `not_found`(admin 도) →
//!     본문(400 `bad_request`) → 주소 정규화 → `checkAuth` → 한 트랜잭션에서 UPDATE + grant 멈춤 → 감사
//!     `connector.updated` → 멈춘 grant 의 계정마다 `grant.changed` → 200 `{connector, suspendedGrants}`.
//! - 비밀은 **id 로만** 가리킨다(주인·종류 검사). 값은 읽지도 봉하지도 않는다 — 봉인은 `secret_writes` 몫이다.
//! - 주소 칸(`baseUrl`·`tokenUrl`)은 JS `trim` 짝([`js_trim`]) 뒤 `url` 크레이트(WHATWG + IDNA)로 정규화한다 — node
//!   `new URL()` 과 같은 결과다. 안쪽에 제어 문자·유니코드 공백이 남은 꼴은 같다고 보장하지 못해 400(`bad_base_url`·
//!   `bad_token_url`)으로 거절한다.
//! - 권한은 [`CONNECTORS_UPSERT_PRIVILEGES`] — 쓰기 풀에 하나라도 없으면 `main.rs` 가 붙이지 않아 TS 에 남는다.
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::lists::is_zod_uuid;
use crate::proxy::Upstream;
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, emit_event, record_audit};
use axum::body::to_bytes;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::collections::BTreeSet;
use std::sync::Arc;

/// 쓰기 풀이 쓰는 칸 권한.
pub const CONNECTORS_UPSERT_PRIVILEGES: &[(&str, &str)] = &[
    ("api_connector.id", "SELECT"),
    ("api_connector.name", "SELECT"),
    ("api_connector.owner_account_id", "SELECT"),
    ("api_connector.base_url", "SELECT"),
    ("api_connector.auth_kind", "SELECT"),
    ("api_connector.auth_header", "SELECT"),
    ("api_connector.secret_id", "SELECT"),
    ("api_connector.methods", "SELECT"),
    ("api_connector.token_url", "SELECT"),
    ("api_connector.token_form", "SELECT"),
    ("api_connector.created_at", "SELECT"),
    ("api_connector.updated_at", "SELECT"),
    ("api_connector.name", "INSERT"),
    ("api_connector.owner_account_id", "INSERT"),
    ("api_connector.base_url", "INSERT"),
    ("api_connector.auth_kind", "INSERT"),
    ("api_connector.auth_header", "INSERT"),
    ("api_connector.secret_id", "INSERT"),
    ("api_connector.methods", "INSERT"),
    ("api_connector.token_url", "INSERT"),
    ("api_connector.token_form", "INSERT"),
    ("api_connector.base_url", "UPDATE"),
    ("api_connector.auth_kind", "UPDATE"),
    ("api_connector.auth_header", "UPDATE"),
    ("api_connector.secret_id", "UPDATE"),
    ("api_connector.methods", "UPDATE"),
    ("api_connector.token_url", "UPDATE"),
    ("api_connector.token_form", "UPDATE"),
    ("api_connector.updated_at", "UPDATE"),
    ("secret.id", "SELECT"),
    ("secret.owner_account_id", "SELECT"),
    ("secret.kind", "SELECT"),
    ("account_grant.account_id", "SELECT"),
    ("account_grant.capability", "SELECT"),
    ("account_grant.scope", "SELECT"),
    ("account_grant.suspended_at", "SELECT"),
    ("account_grant.limits", "SELECT"),
    ("account_grant.suspended_at", "UPDATE"),
    ("account_grant.suspend_reason", "UPDATE"),
    ("audit_log", "INSERT"),
];

const BODY_LIMIT: usize = 1024 * 1024;

/// `@harkroom/shared` `API_METHODS`.
pub const API_METHODS: [&str; 5] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
/// `@harkroom/shared` `API_AUTH_KINDS`.
pub const API_AUTH_KINDS: [&str; 4] = ["bearer", "header", "none", "token_exchange"];
const RESERVED_HEADERS: [&str; 5] = [
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "cookie",
];
const RESERVED_FORM_FIELDS: [&str; 2] = ["grant_type", "client_id"];

#[derive(Clone)]
pub struct ConnectorsUpsertState {
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
    pub up: Upstream,
}

// ---------------------------------------------------------------------------------------------
// 주소 정규화 — TS `auth/apiGrants.ts` 의 `parseHttpsUrl`·`normalizeBaseUrl`·`normalizeTokenUrl`·`safePath`.
// ---------------------------------------------------------------------------------------------

/// JS `String.prototype.trim` — 양 끝의 JS `\s`(유니코드 공백·줄끝·BOM)를 벗긴다. Rust `str::trim` 과는 U+FEFF·U+0085 가 다르다.
fn js_trim(input: &str) -> &str {
    input.trim_matches(js_space)
}

/// 다듬은 주소에 남은 글자가 node `new URL()` 과 글자째 같은 결과를 보장할 수 있는 꼴인가.
/// 안쪽의 제어 문자·공백(유니코드 포함)은 WHATWG 의 탭·줄바꿈 지우기와 IDNA 매핑이 얽혀 보장하지 못하므로 거절(400)한다.
/// 나머지 비 ASCII(IDN 호스트·경로)는 `url` 크레이트(WHATWG + UTS46)가 node 와 같게 다룬다.
fn url_comparable(trimmed: &str) -> bool {
    !trimmed
        .chars()
        .any(|c| c.is_control() || js_space(c) || c.is_whitespace())
}

/// TS `parseHttpsUrl`. JS 는 `search`·`hash` 가 `?`·`#` 하나뿐이면 빈 문자열이다 — 그래서 빈 질의·조각은 받는다.
fn parse_https_url(input: &str) -> Option<url::Url> {
    let trimmed = js_trim(input);
    if !url_comparable(trimmed) {
        return None;
    }
    let u = url::Url::parse(trimmed).ok()?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some_and(|p| !p.is_empty())
        || u.query().is_some_and(|q| !q.is_empty())
        || u.fragment().is_some_and(|f| !f.is_empty())
    {
        return None;
    }
    if u.host_str().is_none_or(str::is_empty) {
        return None;
    }
    Some(u)
}

/// TS `normalizeBaseUrl` — https origin 만(경로 없음).
pub fn normalize_base_url(input: &str) -> Option<String> {
    let u = parse_https_url(input)?;
    if u.path() != "/" && !u.path().is_empty() {
        return None;
    }
    Some(u.origin().ascii_serialization())
}

fn has_ci(s: &str, needles: &[&str]) -> bool {
    let l = s.to_ascii_lowercase();
    needles.iter().any(|n| l.contains(n))
}

/// JS `/\/\.\.?(\/|$)/`.
fn has_dot_segment_raw(s: &str) -> bool {
    let b = s.as_bytes();
    (0..b.len()).any(|i| {
        if b[i] != b'/' || b.get(i + 1) != Some(&b'.') {
            return false;
        }
        let j = i + 2;
        // `\.?` — 두 번째 점이 있는 꼴과 없는 꼴을 둘 다 본다.
        (b.get(j) == Some(&b'.') && matches!(b.get(j + 1), None | Some(b'/')))
            || matches!(b.get(j), None | Some(b'/'))
    })
}

/// JS `\s`(ECMAScript WhiteSpace + LineTerminator).
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// TS `decodeSlashes`.
fn decode_slashes(path: &str) -> String {
    let (p, rest) = match path.find('?') {
        Some(i) => (&path[..i], &path[i..]),
        None => (path, ""),
    };
    format!("{}{rest}", p.replace("%2f", "/").replace("%2F", "/"))
}

/// TS `safePath`.
pub fn safe_path(path: &str) -> bool {
    if !path.starts_with('/') || path.starts_with("//") {
        return false;
    }
    if path.chars().any(|c| c == '\\' || c == '#' || js_space(c)) {
        return false;
    }
    let p = path.split('?').next().unwrap_or("");
    if has_ci(p, &["%2e", "%5c", "%25"]) || p.contains(';') {
        return false;
    }
    let dot_seg = |s: &str| s == ".." || s == ".";
    if p.split('/').any(dot_seg) {
        return false;
    }
    if !has_ci(p, &["%2f"]) {
        return true;
    }
    let decoded = decode_slashes(p);
    let segs: Vec<&str> = decoded.split('/').skip(1).collect();
    let last = segs.len().wrapping_sub(1);
    !segs
        .iter()
        .enumerate()
        .any(|(i, s)| dot_seg(s) || (s.is_empty() && !(i == last && p.ends_with('/'))))
}

/// TS `normalizeTokenUrl` — 경로를 받는 https 주소(500자 이하).
pub fn normalize_token_url(input: &str) -> Option<String> {
    if has_ci(input, &["%2e", "%2f", "%5c", "%25"]) || has_dot_segment_raw(input) {
        return None;
    }
    let u = parse_https_url(input)?;
    let path = if u.path().is_empty() { "/" } else { u.path() };
    if !safe_path(path) || has_ci(path, &["%2f"]) {
        return None;
    }
    let origin = u.origin().ascii_serialization();
    let out = if path == "/" {
        origin
    } else {
        format!("{origin}{path}")
    };
    (out.encode_utf16().count() <= 500).then_some(out)
}

// ---------------------------------------------------------------------------------------------
// 본문 — TS zod `createBody`·`patchBody`.
// ---------------------------------------------------------------------------------------------

/// 세 갈래: 칸 없음(undefined), `null`, 값.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Opt<T> {
    #[default]
    Absent,
    Null,
    Val(T),
}

impl<T> Opt<T> {
    fn val(&self) -> Option<&T> {
        match self {
            Opt::Val(v) => Some(v),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenForm {
    pub grant_type: String,
    pub client_id: String,
    pub key_field: String,
}

impl TokenForm {
    /// `JSON.stringify` 와 같은 키 차례(zod 출력 = 스키마 차례).
    fn to_json_text(&self) -> String {
        format!(
            "{{\"grantType\":{},\"clientId\":{},\"keyField\":{}}}",
            Value::from(self.grant_type.as_str()),
            Value::from(self.client_id.as_str()),
            Value::from(self.key_field.as_str())
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateBody {
    pub name: String,
    pub base_url: String,
    pub auth_kind: String,
    pub auth_header: Option<String>,
    pub secret_id: Option<String>,
    pub token_url: Option<String>,
    pub token_form: Option<TokenForm>,
    pub methods: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PatchBody {
    pub base_url: Option<String>,
    pub auth_kind: Option<String>,
    pub auth_header: Opt<String>,
    pub secret_id: Opt<String>,
    pub token_url: Opt<String>,
    pub token_form: Opt<TokenForm>,
    pub methods: Option<Vec<String>>,
    /// `Object.keys(p)` — 스키마 차례로, 들어온 칸만.
    pub fields: Vec<&'static str>,
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `/^[a-z0-9][a-z0-9_-]{0,63}$/`
fn name_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// `/^[A-Za-z0-9-]{1,64}$/`
fn header_ok(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

/// `/^[\x20-\x7e]{1,200}$/`
fn form_value_ok(s: &str) -> bool {
    (1..=200).contains(&s.len()) && s.bytes().all(|c| (0x20..=0x7e).contains(&c))
}

/// `/^[A-Za-z0-9_.-]{1,64}$/`
fn form_field_ok(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}

type Bad = ();

fn str_max(v: &Value, max: usize) -> Result<String, Bad> {
    match v {
        Value::String(s) if utf16_len(s) <= max => Ok(s.clone()),
        _ => Err(()),
    }
}

fn str_re(v: &Value, ok: fn(&str) -> bool) -> Result<String, Bad> {
    match v {
        Value::String(s) if ok(s) => Ok(s.clone()),
        _ => Err(()),
    }
}

fn enum_of(v: &Value, set: &[&str]) -> Result<String, Bad> {
    match v {
        Value::String(s) if set.contains(&s.as_str()) => Ok(s.clone()),
        _ => Err(()),
    }
}

/// `.nullable().optional()`.
fn opt<T>(
    m: &Map<String, Value>,
    k: &str,
    f: impl Fn(&Value) -> Result<T, Bad>,
) -> Result<Opt<T>, Bad> {
    match m.get(k) {
        None => Ok(Opt::Absent),
        Some(Value::Null) => Ok(Opt::Null),
        Some(v) => f(v).map(Opt::Val),
    }
}

fn token_form(v: &Value) -> Result<TokenForm, Bad> {
    let m = v.as_object().ok_or(())?;
    // `.strict()` — 모르는 칸이 있으면 거절.
    if m.keys()
        .any(|k| !matches!(k.as_str(), "grantType" | "clientId" | "keyField"))
    {
        return Err(());
    }
    Ok(TokenForm {
        grant_type: str_re(m.get("grantType").ok_or(())?, form_value_ok)?,
        client_id: str_re(m.get("clientId").ok_or(())?, form_value_ok)?,
        key_field: str_re(m.get("keyField").ok_or(())?, form_field_ok)?,
    })
}

fn methods(v: &Value) -> Result<Vec<String>, Bad> {
    let a = v.as_array().ok_or(())?;
    if a.is_empty() || a.len() > API_METHODS.len() {
        return Err(());
    }
    a.iter().map(|m| enum_of(m, &API_METHODS)).collect()
}

/// `req.body ?? {}` 를 객체로.
fn body_obj(body: &Body) -> Result<Map<String, Value>, Bad> {
    match body {
        Body::None | Body::Json(Value::Null) => Ok(Map::new()),
        Body::Json(Value::Object(m)) => Ok(m.clone()),
        _ => Err(()),
    }
}

/// zod `createBody.safeParse(req.body ?? {})`.
fn parse_create(body: &Body) -> Result<CreateBody, Bad> {
    let m = body_obj(body)?;
    let need = |k: &str| m.get(k).ok_or(());
    // zod 는 칸마다 다 보고 하나라도 틀리면 실패한다 — 결과(성공/실패)만 같으면 된다.
    let name = str_re(need("name")?, name_ok);
    let base_url = str_max(need("baseUrl")?, 300);
    let auth_kind = enum_of(need("authKind")?, &API_AUTH_KINDS);
    let auth_header = opt(&m, "authHeader", |v| str_re(v, header_ok));
    let secret_id = opt(&m, "secretId", |v| str_re(v, is_zod_uuid));
    let token_url = opt(&m, "tokenUrl", |v| str_max(v, 500));
    let tform = opt(&m, "tokenForm", token_form);
    let methods = methods(need("methods")?);
    Ok(CreateBody {
        name: name?,
        base_url: base_url?,
        auth_kind: auth_kind?,
        auth_header: auth_header?.val().cloned(),
        secret_id: secret_id?.val().cloned(),
        token_url: token_url?.val().cloned(),
        token_form: tform?.val().cloned(),
        methods: methods?,
    })
}

/// zod `patchBody.safeParse(req.body ?? {})`.
fn parse_patch(body: &Body) -> Result<PatchBody, Bad> {
    let m = body_obj(body)?;
    let plain = |k: &str,
                 f: &dyn Fn(&Value) -> Result<String, Bad>|
     -> Result<Option<String>, Bad> { m.get(k).map(f).transpose() };
    let mut fields = Vec::new();
    for k in [
        "baseUrl",
        "authKind",
        "authHeader",
        "secretId",
        "tokenUrl",
        "tokenForm",
        "methods",
    ] {
        if m.contains_key(k) {
            fields.push(k);
        }
    }
    Ok(PatchBody {
        base_url: plain("baseUrl", &|v| str_max(v, 300))?,
        auth_kind: plain("authKind", &|v| enum_of(v, &API_AUTH_KINDS))?,
        auth_header: opt(&m, "authHeader", |v| str_re(v, header_ok))?,
        secret_id: opt(&m, "secretId", |v| str_re(v, is_zod_uuid))?,
        token_url: opt(&m, "tokenUrl", |v| str_max(v, 500))?,
        token_form: opt(&m, "tokenForm", token_form)?,
        methods: m.get("methods").map(methods).transpose()?,
        fields,
    })
}

// ---------------------------------------------------------------------------------------------
// checkAuth — 비밀 소유 검사 앞까지는 순수 판정이다.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthFields {
    pub auth_kind: String,
    pub auth_header: Option<String>,
    pub secret_id: Option<String>,
    pub token_url: Option<String>,
    /// 새로 들어온 form 이면 그 JSON(TS `JSON.stringify` 차례), 지금 것을 그대로 두면 DB 의 jsonb 글.
    pub token_form: Option<FormText>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FormText {
    New(TokenForm),
    /// DB 의 `token_form::text` — `keyField` 만 판정에 쓴다.
    Stored {
        text: String,
        key_field: String,
    },
}

impl FormText {
    fn key_field(&self) -> &str {
        match self {
            FormText::New(f) => &f.key_field,
            FormText::Stored { key_field, .. } => key_field,
        }
    }
    fn text(&self) -> String {
        match self {
            FormText::New(f) => f.to_json_text(),
            FormText::Stored { text, .. } => text.clone(),
        }
    }
}

/// 판정 결과: 거절이거나, 비밀 소유 검사가 남았거나(그 id), 통과.
#[derive(Debug, PartialEq, Eq)]
pub enum AuthCheck {
    Bad(StatusCode, &'static str, &'static str),
    NeedSecret(String),
    Ok,
}

/// TS `checkAuth` 의 DB 앞 몫. 문구는 TS 그대로.
pub fn check_auth_pure(a: &AuthFields) -> AuthCheck {
    use AuthCheck::Bad as B;
    let r = StatusCode::BAD_REQUEST;
    if a.auth_kind == "token_exchange" {
        if a.token_url.as_deref().is_none_or(str::is_empty) {
            return B(
                r,
                "bad_token_url",
                "tokenUrl 은 질의·사용자 정보 없는 https 주소다",
            );
        }
        let Some(f) = &a.token_form else {
            return B(
                r,
                "bad_request",
                "authKind token_exchange 에는 tokenForm 이 필요하다",
            );
        };
        if RESERVED_FORM_FIELDS.contains(&f.key_field().to_lowercase().as_str()) {
            return B(
                r,
                "bad_token_form",
                "keyField 는 grant_type·client_id 와 겹칠 수 없다",
            );
        }
    } else if a.token_url.as_deref().is_some_and(|s| !s.is_empty()) || a.token_form.is_some() {
        return B(
            r,
            "bad_request",
            "tokenUrl·tokenForm 은 authKind token_exchange 에서만 쓴다",
        );
    }
    let header = a.auth_header.as_deref().filter(|s| !s.is_empty());
    if a.auth_kind == "header" {
        let Some(h) = header else {
            return B(
                r,
                "bad_request",
                "authKind header 에는 authHeader 가 필요하다",
            );
        };
        if RESERVED_HEADERS.contains(&h.to_lowercase().as_str()) {
            return B(r, "bad_header", "그 헤더 이름은 인증에 쓸 수 없다");
        }
    } else if header.is_some() {
        return B(
            r,
            "bad_request",
            "authHeader 는 authKind header 에서만 쓴다",
        );
    }
    let secret = a.secret_id.as_deref().filter(|s| !s.is_empty());
    if a.auth_kind == "none" {
        if secret.is_some() {
            return B(r, "bad_request", "authKind none 에는 키를 붙이지 않는다");
        }
        return AuthCheck::Ok;
    }
    match secret {
        None => B(r, "bad_request", "인증에 쓸 비밀(secretId)이 필요하다"),
        Some(s) => AuthCheck::NeedSecret(s.to_string()),
    }
}

const SECRET_SQL: &str = "select owner_account_id::text, kind from secret where id = $1::uuid";

#[allow(clippy::result_large_err)] // 거절이 곧 axum 응답이다(CI clippy 1.99).
async fn check_auth(
    pool: &PgPool,
    me: &str,
    a: &AuthFields,
) -> Result<Option<Response>, sqlx::Error> {
    match check_auth_pure(a) {
        AuthCheck::Bad(s, c, m) => Ok(Some(json_err(s, c, m))),
        AuthCheck::Ok => Ok(None),
        AuthCheck::NeedSecret(id) => {
            let row: Option<(String, String)> = sqlx::query_as(SECRET_SQL)
                .bind(&id)
                .fetch_optional(pool)
                .await?;
            Ok(match row {
                Some((owner, _)) if owner != me => Some(no_secret()),
                None => Some(no_secret()),
                Some((_, kind)) if kind != "text" => Some(json_err(
                    StatusCode::BAD_REQUEST,
                    "bad_secret",
                    "헤더에 붙일 비밀은 텍스트 종류여야 한다",
                )),
                Some(_) => None,
            })
        }
    }
}

fn no_secret() -> Response {
    json_err(StatusCode::NOT_FOUND, "no_secret", "그런 비밀이 없다")
}

fn bad_body() -> Response {
    // 문구는 TS(zod 오류)와 다르다 — 대조는 상태·코드만 본다.
    json_err(StatusCode::BAD_REQUEST, "bad_request", "body: invalid")
}

fn bad_base_url() -> Response {
    json_err(
        StatusCode::BAD_REQUEST,
        "bad_base_url",
        "baseUrl 은 경로·질의 없는 https 주소다",
    )
}

fn bad_token_url() -> Response {
    json_err(
        StatusCode::BAD_REQUEST,
        "bad_token_url",
        "tokenUrl 은 질의·사용자 정보 없는 https 주소다",
    )
}

fn forbidden() -> Response {
    json_err(
        StatusCode::FORBIDDEN,
        "forbidden",
        "agents cannot manage API connectors",
    )
}

/// 순서를 지키며 겹침을 뺀다(`[...new Set(xs)]`).
fn dedupe(xs: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for x in xs {
        if !out.contains(x) {
            out.push(x.clone());
        }
    }
    out
}

/// TS `getConnector` — `COLS` 와 같은 칸·차례.
const GET_SQL: &str = concat!(
    "select json_build_object(",
    "'id', c.id::text, 'name', c.name, 'ownerAccountId', c.owner_account_id::text, 'baseUrl', c.base_url, ",
    "'authKind', c.auth_kind, 'authHeader', c.auth_header, 'secretId', c.secret_id::text, 'methods', c.methods, ",
    "'tokenUrl', c.token_url, 'tokenForm', c.token_form, 'createdAt', ",
    crate::iso!("c.created_at"),
    ", 'updatedAt', ",
    crate::iso!("c.updated_at"),
    ", 'grantCount', (select count(*)::int from account_grant g where g.capability = 'api.call' and g.scope = 'connector:' || c.id::text)",
    ")::text from api_connector c where c.id = $1::uuid"
);

async fn get_connector(pool: &PgPool, id: &str) -> Result<String, sqlx::Error> {
    let r: Option<String> = sqlx::query_scalar(GET_SQL)
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(r.unwrap_or_else(|| "null".into()))
}

fn json_resp(status: StatusCode, body: String) -> Response {
    (
        status,
        [(
            axum::http::header::CONTENT_TYPE,
            "application/json; charset=utf-8",
        )],
        body,
    )
        .into_response()
}

#[allow(clippy::result_large_err)] // 거절이 곧 axum 응답이다(CI clippy 1.99).
async fn read_body(
    parts: &Parts,
    raw: axum::body::Body,
) -> Result<(axum::body::Bytes, Body), Response> {
    let bytes = to_bytes(raw, BODY_LIMIT).await.map_err(|_| {
        json_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "fst_err_ctp_body_too_large",
            "Request body is too large",
        )
    })?;
    let body = crate::write::fastify_body(&parts.headers, &bytes)?;
    Ok((bytes, body))
}

const INSERT_SQL: &str = "insert into api_connector (name, owner_account_id, base_url, auth_kind, auth_header, secret_id, methods, token_url, token_form)
 values ($1, $2::uuid, $3, $4, $5, $6::uuid, $7, $8, $9::jsonb) returning id::text";

/// `POST /connectors`.
pub async fn create(
    State(st): State<Arc<ConnectorsUpsertState>>,
    RequireAccount(me, _): RequireAccount,
    req: Request,
) -> Response {
    let (parts, raw) = req.into_parts();
    // fastify 는 본문을 핸들러 앞에서 읽는다(415·깨진 JSON 이 먼저다).
    let (_, body) = match read_body(&parts, raw).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    if me.kind == "agent" {
        return forbidden();
    }
    let Ok(b) = parse_create(&body) else {
        return bad_body();
    };
    let Some(base_url) = normalize_base_url(&b.base_url) else {
        return bad_base_url();
    };
    let token_in = b.token_url.as_deref().filter(|s| !s.is_empty());
    let token_url = token_in.and_then(normalize_token_url);
    if token_in.is_some() && token_url.is_none() {
        return bad_token_url();
    }
    let auth = AuthFields {
        auth_kind: b.auth_kind.clone(),
        auth_header: b.auth_header.clone(),
        secret_id: b.secret_id.clone(),
        token_url: token_url.clone(),
        token_form: b.token_form.clone().map(FormText::New),
    };
    match check_auth(&st.write, &me.id, &auth).await {
        Ok(Some(r)) => return r,
        Ok(None) => {}
        Err(e) => return internal(e),
    }
    let methods = dedupe(&b.methods);
    let id: String = match sqlx::query_scalar(INSERT_SQL)
        .bind(&b.name)
        .bind(&me.id)
        .bind(&base_url)
        .bind(&auth.auth_kind)
        .bind(&auth.auth_header)
        .bind(&auth.secret_id)
        .bind(&methods)
        .bind(&auth.token_url)
        .bind(auth.token_form.as_ref().map(FormText::text))
        .fetch_one(&st.write)
        .await
    {
        Ok(id) => id,
        Err(e) if e.as_database_error().and_then(|d| d.code()).as_deref() == Some("23505") => {
            return json_err(
                StatusCode::CONFLICT,
                "name_taken",
                "a connector with that name already exists",
            );
        }
        Err(e) => return internal(e),
    };
    let mut detail = json!({
        "name": b.name, "baseUrl": base_url, "authKind": auth.auth_kind,
        "secretId": auth.secret_id, "methods": b.methods,
    });
    if let Some(t) = &auth.token_url {
        detail["tokenUrl"] = json!(t);
    }
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "connector.created",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail,
        },
    )
    .await;
    match get_connector(&st.write, &id).await {
        Ok(c) => json_resp(StatusCode::CREATED, format!("{{\"connector\":{c}}}")),
        Err(e) => internal(e),
    }
}

/// PATCH 가 읽는 지금 줄. `token_form` 은 jsonb 글과 `keyField` 만.
const CUR_SQL: &str = "select id::text, name, owner_account_id::text, base_url, auth_kind, auth_header, secret_id::text, methods,
 token_url, token_form::text, token_form->>'keyField' from api_connector where id = $1::uuid";

type CurRow = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Vec<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

const UPDATE_SQL: &str = "update api_connector set base_url = $2, auth_kind = $3, auth_header = $4, secret_id = $5::uuid, methods = $6,
 token_url = $7, token_form = $8::jsonb, updated_at = now() where id = $1::uuid";
const SUSPEND_TARGET_SQL: &str =
    "update account_grant set suspended_at = now(), suspend_reason = 'connector_changed'
 where capability = 'api.call' and scope = $1 and suspended_at is null returning account_id::text";
const SUSPEND_METHODS_SQL: &str = "update account_grant set suspended_at = now(), suspend_reason = 'methods_narrowed'
 where capability = 'api.call' and scope = $1 and suspended_at is null
   and exists (select 1 from jsonb_array_elements_text(limits->'methods') m where m = any($2::text[]))
 returning account_id::text";

/// `JSON.stringify(next.tokenForm) !== JSON.stringify(cur.tokenForm)`. 새 form 은 zod 차례(grantType 먼저),
/// DB 의 것은 jsonb 차례(clientId 먼저)라 둘 다 있으면 늘 다르다 — TS 가 그렇게 동작하므로 그대로 둔다.
pub fn form_changed(next: Option<&FormText>, cur_text: Option<&str>) -> bool {
    match (next, cur_text) {
        (None, None) => false,
        (Some(FormText::Stored { text, .. }), Some(c)) => text != c,
        _ => true,
    }
}

/// `PATCH /connectors/{id}`.
pub async fn patch(
    State(st): State<Arc<ConnectorsUpsertState>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (parts, raw) = req.into_parts();
    // fastify 는 본문을 핸들러 앞에서 읽는다(415·깨진 JSON 이 먼저다).
    let (_, body) = match read_body(&parts, raw).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    if me.kind == "agent" {
        return forbidden();
    }
    if !is_zod_uuid(&id) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    let cur: Option<CurRow> = match sqlx::query_as(CUR_SQL)
        .bind(&id)
        .fetch_optional(&st.write)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some(cur) = cur.filter(|c| c.2 == me.id) else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such connector");
    };
    let (
        cid,
        cname,
        _,
        c_base,
        c_kind,
        c_header,
        c_secret,
        c_methods,
        c_token_url,
        c_form_text,
        c_form_key,
    ) = cur;
    let Ok(p) = parse_patch(&body) else {
        return bad_body();
    };
    let base_url = match &p.base_url {
        Some(u) => normalize_base_url(u),
        None => Some(c_base.clone()),
    };
    // TS `if (!baseUrl)` — 빈 문자열(지금 값이 비었을 때)도 거절이다.
    let Some(base_url) = base_url.filter(|s| !s.is_empty()) else {
        return bad_base_url();
    };
    let token_in = p.token_url.val().filter(|s| !s.is_empty());
    let token_url_in = token_in.and_then(|t| normalize_token_url(t.as_str()));
    if token_in.is_some() && token_url_in.is_none() {
        return bad_token_url();
    }
    let leaves_exchange = p
        .auth_kind
        .as_deref()
        .is_some_and(|k| k != "token_exchange");
    let cur_form = match (c_form_text.clone(), c_form_key) {
        (Some(text), key) => Some(FormText::Stored {
            text,
            key_field: key.unwrap_or_default(),
        }),
        (None, _) => None,
    };
    let next = AuthFields {
        auth_kind: p.auth_kind.clone().unwrap_or_else(|| c_kind.clone()),
        auth_header: match &p.auth_header {
            Opt::Val(h) => Some(h.clone()),
            Opt::Null => None,
            Opt::Absent if p.auth_kind.as_deref().is_some_and(|k| k != "header") => None,
            Opt::Absent => c_header.clone(),
        },
        secret_id: match &p.secret_id {
            Opt::Val(s) => Some(s.clone()),
            Opt::Null => None,
            Opt::Absent if p.auth_kind.as_deref() == Some("none") => None,
            Opt::Absent => c_secret.clone(),
        },
        token_url: match &p.token_url {
            Opt::Absent if leaves_exchange => None,
            Opt::Absent => c_token_url.clone(),
            _ => token_url_in,
        },
        token_form: match &p.token_form {
            Opt::Val(f) => Some(FormText::New(f.clone())),
            Opt::Null => None,
            Opt::Absent if leaves_exchange => None,
            Opt::Absent => cur_form,
        },
    };
    match check_auth(&st.write, &me.id, &next).await {
        Ok(Some(r)) => return r,
        Ok(None) => {}
        Err(e) => return internal(e),
    }
    let methods = match &p.methods {
        Some(m) => dedupe(m),
        None => c_methods.clone(),
    };
    let target = base_url != c_base
        || next.auth_kind != c_kind
        || next.auth_header != c_header
        || next.secret_id != c_secret
        || next.token_url != c_token_url
        || form_changed(next.token_form.as_ref(), c_form_text.as_deref());
    let dropped: Vec<String> = c_methods
        .iter()
        .filter(|m| !methods.contains(m))
        .cloned()
        .collect();
    let scope = format!("connector:{cid}");
    let r: Result<Vec<String>, sqlx::Error> = async {
        let mut tx = st.write.begin().await?;
        sqlx::query(UPDATE_SQL)
            .bind(&cid)
            .bind(&base_url)
            .bind(&next.auth_kind)
            .bind(&next.auth_header)
            .bind(&next.secret_id)
            .bind(&methods)
            .bind(&next.token_url)
            .bind(next.token_form.as_ref().map(FormText::text))
            .execute(&mut *tx)
            .await?;
        let suspended: Vec<String> = if target {
            sqlx::query_scalar(SUSPEND_TARGET_SQL)
                .bind(&scope)
                .fetch_all(&mut *tx)
                .await?
        } else if !dropped.is_empty() {
            sqlx::query_scalar(SUSPEND_METHODS_SQL)
                .bind(&scope)
                .bind(&dropped)
                .fetch_all(&mut *tx)
                .await?
        } else {
            Vec::new()
        };
        tx.commit().await?;
        Ok(suspended)
    }
    .await;
    let suspended = match r {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let reason = if target {
        json!("connector_changed")
    } else if !dropped.is_empty() {
        json!("methods_narrowed")
    } else {
        Value::Null
    };
    let mut detail = json!({ "name": cname, "fields": p.fields });
    if next.token_url != c_token_url {
        detail["tokenUrl"] = json!(next.token_url);
    }
    detail["suspendedGrants"] = json!(suspended.len());
    detail["reason"] = reason;
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "connector.updated",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&cid),
            ip: ip.as_deref(),
            detail,
        },
    )
    .await;
    let accounts: BTreeSet<&String> = suspended.iter().collect();
    if !accounts.is_empty() {
        match st.write.acquire().await {
            Ok(mut conn) => {
                for a in accounts {
                    let ev = json!({ "type": "grant.changed", "accountId": a, "audience": "all" });
                    if let Err(e) = emit_event(&mut conn, &ev).await {
                        eprintln!(
                            "front: connector.updated event failed: {}",
                            e.as_database_error().map_or("io", |_| "db")
                        );
                    }
                }
            }
            Err(e) => eprintln!(
                "front: connector.updated event failed: {}",
                e.as_database_error().map_or("io", |_| "db")
            ),
        }
    }
    match get_connector(&st.write, &cid).await {
        Ok(c) => json_resp(
            StatusCode::OK,
            format!(
                "{{\"connector\":{c},\"suspendedGrants\":{}}}",
                suspended.len()
            ),
        ),
        Err(e) => internal(e),
    }
}

pub fn routes(
    st: ConnectorsUpsertState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<ConnectorsUpsertState>>::new()
        .post("/connectors", create)
        .patch("/connectors/{id}", patch)
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
    fn base_url_matches_ts() {
        let ok = [
            ("https://api.example.com", "https://api.example.com"),
            ("https://api.example.com/", "https://api.example.com"),
            ("  https://API.Example.com  ", "https://api.example.com"),
            ("https://api.example.com:443", "https://api.example.com"),
            (
                "https://api.example.com:8443/",
                "https://api.example.com:8443",
            ),
            ("https://api.example.com/?", "https://api.example.com"),
            ("https://api.example.com#", "https://api.example.com"),
            ("https://@api.example.com", "https://api.example.com"),
            ("HTTPS://api.example.com", "https://api.example.com"),
            ("https://0x7f.1", "https://127.0.0.1"),
            ("https://[::1]", "https://[::1]"),
            ("https:api.example.com", "https://api.example.com"),
        ];
        for (i, want) in ok {
            assert_eq!(normalize_base_url(i).as_deref(), Some(want), "{i}");
        }
        for i in [
            "",
            "http://api.example.com",
            "https://api.example.com/v1",
            "https://api.example.com?x=1",
            "https://api.example.com#x",
            "https://u:p@api.example.com",
            "https://u@api.example.com",
            "https://:p@api.example.com",
            "ftp://x",
            "not a url",
            "https://",
        ] {
            assert_eq!(normalize_base_url(i), None, "{i}");
        }
    }

    #[test]
    fn token_url_matches_ts() {
        let ok = [
            (
                "https://auth.example.com/oauth/token",
                "https://auth.example.com/oauth/token",
            ),
            ("https://auth.example.com/", "https://auth.example.com"),
            ("https://auth.example.com", "https://auth.example.com"),
            ("https://auth.example.com/a/", "https://auth.example.com/a/"),
            (
                "https://auth.example.com/a%20b",
                "https://auth.example.com/a%20b",
            ),
            ("https://auth.example.com/a?", "https://auth.example.com/a"),
        ];
        for (i, want) in ok {
            assert_eq!(normalize_token_url(i).as_deref(), Some(want), "{i}");
        }
        let long = format!("https://a.example.com/{}", "x".repeat(480));
        for i in [
            "http://auth.example.com/token",
            "https://auth.example.com/a/../b",
            "https://auth.example.com/a/./b",
            "https://auth.example.com/..",
            "https://auth.example.com/%2e%2e/b",
            "https://auth.example.com/a%2Fb",
            "https://auth.example.com/a%5cb",
            "https://auth.example.com/a%25b",
            "https://auth.example.com/a;b",
            "https://auth.example.com/token?x=1",
            "https://auth.example.com/token#f",
            "https://u@auth.example.com/token",
            "https://auth.example.com//token",
            long.as_str(),
        ] {
            assert_eq!(normalize_token_url(i), None, "{i}");
        }
    }

    #[test]
    fn raw_dot_segment_regex() {
        assert!(has_dot_segment_raw("/."));
        assert!(has_dot_segment_raw("/../x"));
        assert!(has_dot_segment_raw("a/./b"));
        assert!(!has_dot_segment_raw("/.x"));
        assert!(!has_dot_segment_raw("/...")); // `/..` 뒤가 `.` — JS 정규식도 맞지 않는다.
        assert!(!has_dot_segment_raw("/..x"));
    }

    #[test]
    fn safe_path_matches_ts() {
        assert!(safe_path("/a/b"));
        assert!(safe_path("/a%2Fb"));
        assert!(safe_path("/a%2Fb/"));
        assert!(!safe_path("/a%2F"));
        assert!(!safe_path("/a%2F..%2Fb"));
        assert!(!safe_path("//a"));
        assert!(!safe_path("a"));
        assert!(!safe_path("/a b"));
        assert!(!safe_path("/a\\b"));
        assert!(!safe_path("/a/../b"));
        assert!(!safe_path("/a;b"));
        assert!(!safe_path("/%2e"));
    }

    /// 기대값은 node 22 `new URL(s.trim()).origin`(+ pathname) 출력이다.
    #[test]
    fn idn_matches_node() {
        for (input, want) in [
            ("https://bücher.example", "https://xn--bcher-kva.example"),
            ("https://BÜCHER.example/", "https://xn--bcher-kva.example"),
            ("https://例え.テスト", "https://xn--r8jz45g.xn--zckzah"),
            ("https://Faß.de", "https://xn--fa-hia.de"),
            ("https://ＥＸＡＭＰＬＥ.com", "https://example.com"),
            ("https://example。com", "https://example.com"),
            ("https://１２７.０.０.１", "https://127.0.0.1"),
            ("https://ex\u{200b}ample.com", "https://example.com"),
            ("https://\u{130}.example", "https://xn--i-9bb.example"),
            (
                "\u{feff} https://bücher.example\u{3000}",
                "https://xn--bcher-kva.example",
            ),
        ] {
            assert_eq!(normalize_base_url(input).as_deref(), Some(want), "{input}");
        }
        assert_eq!(
            normalize_token_url("https://münchen.de/tok%C3%A9n").as_deref(),
            Some("https://xn--mnchen-3ya.de/tok%C3%A9n")
        );
        assert_eq!(
            normalize_token_url("https://a.example.com/路径/x").as_deref(),
            Some("https://a.example.com/%E8%B7%AF%E5%BE%84/x")
        );
        // node 도 거절한다(호스트 안의 NBSP).
        assert_eq!(normalize_base_url("https://\u{a0}a.example.com"), None);
    }

    #[test]
    fn portable_inputs_only() {
        assert!(url_comparable("https://a.example.com/x"));
        assert!(url_comparable("https://예시.com"));
        assert!(!url_comparable("https://a.example.com/\t"));
        assert!(!url_comparable("https://\u{a0}a.example.com"));
    }

    fn j(v: Value) -> Body {
        Body::Json(v)
    }

    #[test]
    fn create_body_follows_zod() {
        let base = json!({"name": "gh", "baseUrl": "https://api.github.com", "authKind": "bearer",
            "secretId": "AAAAAAAA-0000-0000-0000-000000000000", "methods": ["GET", "GET"], "extra": 1});
        let b = parse_create(&j(base.clone())).unwrap();
        assert_eq!(b.methods, vec!["GET", "GET"]);
        assert_eq!(dedupe(&b.methods), vec!["GET"]);
        assert_eq!(
            b.secret_id.as_deref(),
            Some("AAAAAAAA-0000-0000-0000-000000000000")
        );
        for (k, v) in [
            ("name", json!("Gh")),
            ("name", json!("-x")),
            ("baseUrl", json!("x".repeat(301))),
            ("authKind", json!("basic")),
            ("authHeader", json!("")),
            ("authHeader", json!("X Key")),
            ("secretId", json!("nope")),
            ("tokenUrl", json!(1)),
            (
                "tokenForm",
                json!({"grantType": "a", "clientId": "b", "keyField": "c", "x": 1}),
            ),
            (
                "tokenForm",
                json!({"grantType": "a\n", "clientId": "b", "keyField": "c"}),
            ),
            (
                "tokenForm",
                json!({"grantType": "a", "clientId": "b", "keyField": "c d"}),
            ),
            ("methods", json!([])),
            ("methods", json!(["GET", "HEAD"])),
            ("methods", json!(["GET", "GET", "GET", "GET", "GET", "GET"])),
        ] {
            let mut x = base.clone();
            x[k] = v;
            assert!(parse_create(&j(x)).is_err(), "{k}");
        }
        for k in ["name", "baseUrl", "authKind", "methods"] {
            let mut x = base.clone();
            x.as_object_mut().unwrap().remove(k);
            assert!(parse_create(&j(x)).is_err(), "{k}");
        }
        assert!(parse_create(&Body::None).is_err());
        assert!(parse_create(&Body::Text("x".into())).is_err());
        assert!(parse_create(&j(json!([]))).is_err());
        let mut x = base;
        x["tokenUrl"] = Value::Null;
        x["authHeader"] = Value::Null;
        assert!(parse_create(&j(x)).is_ok());
    }

    #[test]
    fn patch_body_follows_zod() {
        let p = parse_patch(&Body::None).unwrap();
        assert!(p.fields.is_empty());
        let p = parse_patch(&j(
            json!({"methods": ["GET"], "authHeader": null, "baseUrl": "x", "zzz": 1}),
        ))
        .unwrap();
        assert_eq!(p.fields, vec!["baseUrl", "authHeader", "methods"]);
        assert_eq!(p.auth_header, Opt::Null);
        assert!(parse_patch(&j(json!({"baseUrl": null}))).is_err());
        assert!(parse_patch(&j(json!({"methods": null}))).is_err());
        assert!(parse_patch(&j(json!({"authKind": null}))).is_err());
        assert!(parse_patch(&j(json!("x"))).is_err());
    }

    fn af(
        kind: &str,
        header: Option<&str>,
        secret: Option<&str>,
        tu: Option<&str>,
        key: Option<&str>,
    ) -> AuthFields {
        AuthFields {
            auth_kind: kind.into(),
            auth_header: header.map(Into::into),
            secret_id: secret.map(Into::into),
            token_url: tu.map(Into::into),
            token_form: key.map(|k| {
                FormText::New(TokenForm {
                    grant_type: "g".into(),
                    client_id: "c".into(),
                    key_field: k.into(),
                })
            }),
        }
    }

    #[test]
    fn check_auth_order_matches_ts() {
        let s = Some("00000000-0000-0000-0000-000000000000");
        let code = |a: AuthFields| match check_auth_pure(&a) {
            AuthCheck::Bad(st, c, _) => format!("{} {c}", st.as_u16()),
            AuthCheck::NeedSecret(_) => "secret".into(),
            AuthCheck::Ok => "ok".into(),
        };
        assert_eq!(
            code(af("token_exchange", None, s, None, Some("k"))),
            "400 bad_token_url"
        );
        assert_eq!(
            code(af("token_exchange", None, s, Some("https://t"), None)),
            "400 bad_request"
        );
        assert_eq!(
            code(af(
                "token_exchange",
                None,
                s,
                Some("https://t"),
                Some("Client_ID")
            )),
            "400 bad_token_form"
        );
        assert_eq!(
            code(af(
                "token_exchange",
                None,
                s,
                Some("https://t"),
                Some("api_key")
            )),
            "secret"
        );
        assert_eq!(
            code(af("bearer", None, s, Some("https://t"), None)),
            "400 bad_request"
        );
        assert_eq!(
            code(af("bearer", None, s, None, Some("k"))),
            "400 bad_request"
        );
        assert_eq!(code(af("header", None, s, None, None)), "400 bad_request");
        assert_eq!(
            code(af("header", Some("Cookie"), s, None, None)),
            "400 bad_header"
        );
        assert_eq!(code(af("header", Some("X-Key"), s, None, None)), "secret");
        assert_eq!(
            code(af("bearer", Some("X-Key"), s, None, None)),
            "400 bad_request"
        );
        assert_eq!(code(af("none", None, s, None, None)), "400 bad_request");
        assert_eq!(code(af("none", None, None, None, None)), "ok");
        assert_eq!(
            code(af("bearer", None, None, None, None)),
            "400 bad_request"
        );
        // TS 는 하나의 truthiness 로 본다 — 빈 tokenUrl 은 없는 것이다.
        assert_eq!(code(af("bearer", None, s, Some(""), None)), "secret");
    }

    #[test]
    fn token_form_compare_mirrors_json_stringify() {
        let stored = FormText::Stored {
            text: r#"{"clientId": "c", "keyField": "k", "grantType": "g"}"#.into(),
            key_field: "k".into(),
        };
        let fresh = FormText::New(TokenForm {
            grant_type: "g".into(),
            client_id: "c".into(),
            key_field: "k".into(),
        });
        assert!(!form_changed(None, None));
        assert!(!form_changed(
            Some(&stored),
            Some(r#"{"clientId": "c", "keyField": "k", "grantType": "g"}"#)
        ));
        assert!(form_changed(
            Some(&fresh),
            Some(r#"{"clientId": "c", "keyField": "k", "grantType": "g"}"#)
        ));
        assert!(form_changed(None, Some("{}")));
        assert!(form_changed(Some(&fresh), None));
        assert_eq!(
            fresh.text(),
            r#"{"grantType":"g","clientId":"c","keyField":"k"}"#
        );
    }

    #[test]
    fn mirrors_ts_source() {
        let shared = include_str!("../../../../packages/shared/src/permissions.ts");
        assert!(shared.contains(
            "export const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;"
        ));
        assert!(shared.contains(
            "export const API_AUTH_KINDS = ['bearer', 'header', 'none', 'token_exchange'] as const;"
        ));
    }
}
