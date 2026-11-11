//! 외부 API 호출 래퍼 `api.call` — TS `turnApi.ts` 의 `createTurnApi` 이식(s21b-3d-2).
//!
//! **실수 방지 장치이지 경계가 아니다.** 같은 사용자 계정으로 도는 에이전트는 이 머신의 다른 자격에 닿는다. 막는 것은
//! "사람이 허락하지 않은 대상·메서드·경로로 키가 붙어 나가는 것"과 "키가 채팅·transcript 에 평문으로 도는 것"이다.
//!
//! 흐름(TS 와 같은 순서): ① 인자 모양 ② 턴 임대 ③ 서버 `POST /agent/api-checks`(닿지 않으면 fail-closed)
//! ④ URL 짓기·origin 재확인 ⑤ 호출(리다이렉트 안 따름, 시한) ⑥ `POST /agent/api-results` ⑦ 키 값을 가린 응답.
//!
//! TS 와 다른 점(보수 쪽으로만): URL 은 WHATWG 파서 대신 「연결 origin + 경로」로 짓는다 — 경로가 `//`·`/\` 로
//! 시작하거나 공백·제어문자·비 ASCII 를 담으면 `bad_url` 로 거절한다(TS 는 퍼센트 인코딩해서 보낸다). `#` 뒤는 버린다.
use crate::turn_leases::TurnLease;
use crate::turn_merge::Post;
use base64::Engine as _;
use harkroom_proto::p1::{RunnerLinkRequest, RunnerLinkResponse};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::io::Read as _;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// MCP 도구 이름(TS `API_TOOL`).
pub const API_TOOL: &str = "api.call";
pub const API_CHECKS_PATH: &str = "/agent/api-checks";
pub const API_RESULTS_PATH: &str = "/agent/api-results";
/// 요청 본문 상한(TS `API_MAX_BODY`).
pub const API_MAX_BODY: usize = 1024 * 1024;
const RESPONSE_READ_MAX: usize = 2 * 1024 * 1024;
const RESPONSE_RETURN_MAX: usize = 256 * 1024;
const TIMEOUT: Duration = Duration::from_secs(60);
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(15);
const EXCHANGE_READ_MAX: usize = 64 * 1024;
const TOKEN_MAX: usize = 8192;
const TOKEN_TTL_DEFAULT_S: f64 = 300.0;
const TOKEN_TTL_MAX_S: f64 = 3600.0;
/// shared `API_METHODS`.
pub const API_METHODS: [&str; 5] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const USER_AGENT: &str = "harkroom-operator-api";

/// 나가는 요청 하나. 리다이렉트는 따르지 않는 구현이어야 한다.
pub struct ApiRequest<'a> {
    pub method: &'a str,
    pub url: &'a str,
    pub headers: &'a [(String, String)],
    pub body: Option<Vec<u8>>,
    pub timeout: Duration,
    /// 본문을 이만큼까지 읽는다 — 넘으면 `truncated`.
    pub read_max: usize,
}

/// 받은 응답. `body` 는 `read_max` 까지, `read` 는 실제로 읽은 바이트(넘었으면 상한+1 까지).
#[derive(Default)]
pub struct ApiReply {
    pub status: u16,
    pub content_type: Option<String>,
    pub location: Option<String>,
    pub body: Vec<u8>,
    pub read: usize,
    pub truncated: bool,
}

/// 나가는 HTTP(TS `Fetcher`). 시험은 가짜를 꽂는다.
pub type ApiFetch = Arc<dyn Fn(&ApiRequest<'_>) -> Result<ApiReply, String> + Send + Sync>;

/// ureq 판 — `max_redirects(0)`·상태를 오류로 안 바꿈·요청마다 시한.
pub fn ureq_fetch() -> ApiFetch {
    let agent_for = |t: Duration| {
        ureq::Agent::new_with_config(
            ureq::Agent::config_builder()
                .http_status_as_error(false)
                .max_redirects(0)
                .timeout_global(Some(t))
                .build(),
        )
    };
    let (main, exchange) = (agent_for(TIMEOUT), agent_for(EXCHANGE_TIMEOUT));
    Arc::new(move |r: &ApiRequest<'_>| {
        let agent = if r.timeout <= EXCHANGE_TIMEOUT {
            &exchange
        } else {
            &main
        };
        let m = ureq::http::Method::from_bytes(r.method.as_bytes()).map_err(|e| e.to_string())?;
        let mut b = ureq::http::Request::builder().method(m).uri(r.url);
        for (k, v) in r.headers {
            b = b.header(k.as_str(), v.as_str());
        }
        let req = b
            .body(r.body.clone().unwrap_or_default())
            .map_err(|e| e.to_string())?;
        let mut res = agent.run(req).map_err(|e| e.to_string())?;
        let hdr = |n: &str| {
            res.headers()
                .get(n)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        let (content_type, location) = (hdr("content-type"), hdr("location"));
        let status = res.status().as_u16();
        let mut body = Vec::new();
        let mut reader = res
            .body_mut()
            .with_config()
            .limit(u64::MAX)
            .reader()
            .take(r.read_max as u64 + 1);
        reader.read_to_end(&mut body).map_err(|e| e.to_string())?;
        let read = body.len();
        let truncated = read > r.read_max;
        body.truncate(r.read_max);
        Ok(ApiReply {
            status,
            content_type,
            location,
            body,
            read,
            truncated,
        })
    })
}

/// TS `tokenTtlSeconds` — 만료 60초 전까지, 짧으면 max(절반, 10초), 없으면 5분, 상한 1시간.
pub fn token_ttl_seconds(expires_in: Option<&Value>) -> f64 {
    let Some(e) = expires_in
        .and_then(Value::as_f64)
        .filter(|e| e.is_finite() && *e > 0.0)
    else {
        return TOKEN_TTL_DEFAULT_S;
    };
    let ttl = if e > 120.0 {
        e - 60.0
    } else {
        (e / 2.0).max(10.0)
    };
    ttl.min(TOKEN_TTL_MAX_S)
}

/// 토큰 교환 form(TS `TokenForm`).
#[derive(Clone)]
pub struct TokenForm {
    pub grant_type: String,
    pub client_id: String,
    pub key_field: String,
}

/// `application/x-www-form-urlencoded`(URLSearchParams 와 같은 규칙: 공백은 `+`, `*-._` 와 영숫자만 그대로).
fn form_encode(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                o.push(b as char)
            }
            b' ' => o.push('+'),
            _ => o.push_str(&format!("%{b:02X}")),
        }
    }
    o
}

/// JS `encodeURIComponent`.
fn uri_component(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => o.push(b as char),
            _ => o.push_str(&format!("%{b:02X}")),
        }
    }
    o
}

fn is_token(s: &str) -> bool {
    !s.is_empty() && s.len() <= TOKEN_MAX && s.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// TS `exchangeToken` — 실패면 HTTP 상태만(본문·예외 문구는 키가 되비칠 수 있어 싣지 않는다).
pub fn exchange_token(
    fetch: &ApiFetch,
    token_url: &str,
    form: &TokenForm,
    key: &str,
) -> Result<(String, f64), u16> {
    // https·사용자 정보/질의/조각 없음.
    let Some(rest) = token_url.strip_prefix("https://") else {
        return Err(0);
    };
    let authority = rest.split('/').next().unwrap_or("");
    if authority.is_empty()
        || authority.contains('@')
        || token_url.contains('?')
        || token_url.contains('#')
    {
        return Err(0);
    }
    if token_url.bytes().any(|b| !(0x21..=0x7e).contains(&b)) {
        return Err(0);
    }
    let body = format!(
        "grant_type={}&client_id={}&{}={}",
        form_encode(&form.grant_type),
        form_encode(&form.client_id),
        form_encode(&form.key_field),
        form_encode(key)
    );
    let headers = [
        (
            "content-type".to_string(),
            "application/x-www-form-urlencoded".to_string(),
        ),
        ("accept".to_string(), "application/json".to_string()),
        ("user-agent".to_string(), USER_AGENT.to_string()),
    ];
    let Ok(res) = fetch(&ApiRequest {
        method: "POST",
        url: token_url,
        headers: &headers,
        body: Some(body.into_bytes()),
        timeout: EXCHANGE_TIMEOUT,
        read_max: EXCHANGE_READ_MAX,
    }) else {
        return Err(0);
    };
    // 3xx 도 실패다 — Location 을 따라가지 않는다.
    if !(200..300).contains(&res.status) || res.truncated {
        return Err(res.status);
    }
    let Ok(j) = serde_json::from_slice::<Map<String, Value>>(&res.body) else {
        return Err(res.status);
    };
    match j.get("token_type") {
        None => {}
        Some(Value::String(t)) if t.eq_ignore_ascii_case("bearer") => {}
        Some(_) => return Err(res.status),
    }
    match j.get("access_token").and_then(Value::as_str) {
        Some(t) if is_token(t) => Ok((t.to_string(), token_ttl_seconds(j.get("expires_in")))),
        _ => Err(res.status),
    }
}

/// 인자(TS `ApiArgs`).
#[derive(Debug, PartialEq)]
pub struct ApiArgs {
    pub connector: String,
    pub method: String,
    pub path: String,
    pub body: Option<String>,
    pub content_type: Option<String>,
}

pub(crate) fn is_connector(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// TS `/^[\w.+-]+\/[\w.+-]+(;\s*charset=[\w-]+)?$/i`.
pub fn is_content_type(s: &str) -> bool {
    let tok = |t: &str| {
        !t.is_empty()
            && t.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'+' | b'-'))
    };
    let (mime, charset) = match s.split_once(';') {
        Some((m, c)) => (m, Some(c)),
        None => (s, None),
    };
    let Some((a, b)) = mime.split_once('/') else {
        return false;
    };
    if !tok(a) || !tok(b) {
        return false;
    }
    match charset {
        None => true,
        Some(c) => {
            let c = c.trim_start_matches([' ', '\t', '\n', '\r', '\u{b}', '\u{c}']);
            c.len() > 8
                && c[..8].eq_ignore_ascii_case("charset=")
                && c[8..]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        }
    }
}

/// 연결·메서드·경로 셋을 잰다(TS `parseApiArgs` 앞쪽 — 오퍼레이터 쪽은 파일을 읽지 않는다).
fn parse_head(
    connector: &str,
    raw_method: &str,
    path: &str,
) -> Result<(String, String, String), String> {
    if connector.is_empty() || raw_method.is_empty() || path.is_empty() {
        return Err("사용법: harkroom-operator api <연결> <GET|POST|PUT|PATCH|DELETE> </경로> [--data @파일|<글자>] [--content-type <형식>]".into());
    }
    if !is_connector(connector) {
        return Err(format!("연결 이름이 아니다: {}", cut(connector, 100)));
    }
    let method = raw_method.to_ascii_uppercase();
    if !API_METHODS.contains(&method.as_str()) {
        return Err(format!("메서드가 아니다: {}", cut(raw_method, 20)));
    }
    if !path.starts_with('/') || path.encode_utf16().count() > 2000 {
        return Err(
            "경로는 / 로 시작한다(전체 URL 이 아니라 경로만 — 주소는 연결이 정한다)".into(),
        );
    }
    Ok((connector.to_string(), method, path.to_string()))
}

fn cut(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// TS `argsOf` — 소켓으로 온 `arguments` 를 다시 잰다. 이 프로세스가 마지막 관문이다.
fn args_of(payload: &Value) -> Result<ApiArgs, String> {
    let Some(a) = payload
        .pointer("/params/arguments")
        .and_then(Value::as_object)
    else {
        return Err("arguments 가 없다".into());
    };
    let extra: Vec<&str> = a
        .keys()
        .map(String::as_str)
        .filter(|k| !matches!(*k, "connector" | "method" | "path" | "body" | "contentType"))
        .collect();
    if !extra.is_empty() {
        return Err(format!("받지 않는 인자: {}", cut(&extra.join(", "), 100)));
    }
    let s = |k: &str| match a.get(k) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
    };
    let body = match a.get("body") {
        None | Some(Value::Null) => None,
        Some(Value::String(b)) => Some(b.clone()),
        Some(_) => return Err("body 는 글자다".into()),
    };
    let ct = match a.get("contentType") {
        None | Some(Value::Null) => None,
        Some(Value::String(c)) => Some(c.clone()),
        Some(_) => return Err("contentType 은 글자다".into()),
    };
    let (connector, method, path) = parse_head(&s("connector"), &s("method"), &s("path"))?;
    if let Some(b) = &body {
        if b.len() > API_MAX_BODY {
            return Err(format!("본문이 {API_MAX_BODY} 바이트보다 크다"));
        }
        if !b.is_empty() && (method == "GET" || method == "DELETE") {
            return Err(format!("{method} 에는 본문을 싣지 않는다"));
        }
    }
    if let Some(c) = &ct
        && !is_content_type(c)
    {
        return Err("contentType 모양이 아니다".into());
    }
    let content_type = body
        .as_ref()
        .map(|_| ct.unwrap_or_else(|| "application/json".into()));
    Ok(ApiArgs {
        connector,
        method,
        path,
        body,
        content_type,
    })
}

/// TS `scrubValue` — 값 그대로·base64(패딩 없음)·URL 인코딩 꼴을 가린다. 8자 미만(UTF-16) 값은 가리지 않는다.
pub fn scrub_value(text: &str, value: &str) -> String {
    if value.encode_utf16().count() < 8 {
        return text.to_string();
    }
    let mut out = text.replace(value, "[REDACTED]");
    let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode(value.as_bytes());
    if b64.len() >= 8 {
        out = out.replace(&b64, "[REDACTED]");
    }
    let enc = uri_component(value);
    if enc != value {
        out = out.replace(&enc, "[REDACTED]");
    }
    out
}

/// `https://host[:port]` 꼴의 origin 인지 — 경로·질의·사용자 정보가 붙어 있으면 아니다.
fn is_https_origin(base: &str) -> bool {
    let Some(auth) = base.strip_prefix("https://") else {
        return false;
    };
    !auth.is_empty()
        && auth
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']'))
}

/// ④ URL 짓기. origin 을 벗어날 수 있는 꼴(`//`·`/\`·공백·제어·비 ASCII)은 거절한다.
fn build_url(base: &str, path: &str) -> Result<String, &'static str> {
    if !is_https_origin(base) {
        return Err("origin_mismatch");
    }
    let path = path.split('#').next().unwrap_or("");
    if !path.starts_with('/') || path.starts_with("//") || path.starts_with("/\\") {
        return Err("origin_mismatch");
    }
    if path
        .bytes()
        .any(|b| !(0x21..=0x7e).contains(&b) || b == b'\\')
    {
        return Err("bad_url");
    }
    let url = format!("{base}{path}");
    // 지은 URL 을 다시 읽어 authority 가 그대로인지 본다.
    match url.parse::<ureq::http::Uri>() {
        Ok(u)
            if u.scheme_str() == Some("https")
                && u.authority().map(|a| a.as_str()) == base.strip_prefix("https://") =>
        {
            Ok(url)
        }
        Ok(_) => Err("origin_mismatch"),
        Err(_) => Err("bad_url"),
    }
}

type Out = (bool, Value);

fn fail(code: &str, message: &str) -> Out {
    (false, json!({"error": {"code": code, "message": message}}))
}

/// TS `isApiCall`.
pub fn is_api_call(req: &RunnerLinkRequest) -> bool {
    let RunnerLinkRequest::McpRequest { payload, .. } = req else {
        return false;
    };
    payload.get("method").and_then(Value::as_str) == Some("tools/call")
        && payload.get("params").is_some_and(Value::is_object)
        && payload.pointer("/params/name").and_then(Value::as_str) == Some(API_TOOL)
}

/// 받은 토큰 캐시 한 칸.
struct Cached {
    token: String,
    until_ms: f64,
}

/// TS `createTurnApi` 한 벌. 토큰 캐시는 메모리에만, 키는 (에이전트·연결 주소·토큰 주소·form·키 값) sha256 지문.
#[derive(Clone)]
pub struct TurnApi {
    pub fetch: ApiFetch,
    pub now_ms: Arc<dyn Fn() -> f64 + Send + Sync>,
    tokens: Arc<Mutex<HashMap<String, Cached>>>,
}

impl TurnApi {
    pub fn new(fetch: ApiFetch, now_ms: Arc<dyn Fn() -> f64 + Send + Sync>) -> Self {
        Self {
            fetch,
            now_ms,
            tokens: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn system() -> Self {
        Self::new(
            ureq_fetch(),
            Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as f64)
                    .unwrap_or(0.0)
            }),
        )
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, HashMap<String, Cached>> {
        self.tokens.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn token_key(agent_id: &str, base: &str, token_url: &str, f: &TokenForm, key: &str) -> String {
        let s = json!([
            agent_id,
            base,
            token_url,
            f.grant_type,
            f.client_id,
            f.key_field,
            key
        ])
        .to_string();
        let d = ring::digest::digest(&ring::digest::SHA256, s.as_bytes());
        d.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }

    fn run(
        &self,
        agent_id: &str,
        payload: &Value,
        lease: Option<&TurnLease>,
        post: Post<'_>,
        log: &dyn Fn(&str),
    ) -> Out {
        let parsed = match args_of(payload) {
            Ok(a) => a,
            Err(e) => return fail("bad_request", &e),
        };
        let ApiArgs {
            connector,
            method,
            path,
            ..
        } = &parsed;
        let Some(lease) = lease.filter(|l| l.agent_id == agent_id) else {
            return fail(
                "no_lease",
                "api calls are not available in this turn (no turn lease)",
            );
        };

        // ③ 서버 판정. 닿지 않으면 부르지 않는다(fail-closed).
        let check_body = json!({"leaseId": lease.lease_id, "token": lease.token, "connector": connector, "method": method, "path": path, "caps": ["token_exchange"]});
        let (status, text) = match post(API_CHECKS_PATH, check_body.to_string()) {
            Ok((s, t)) if s != 0 => (s, t),
            _ => {
                return fail(
                    "unavailable",
                    "the server could not be reached — call refused (fail-closed)",
                );
            }
        };
        if status != 200 {
            let code = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| {
                    v.pointer("/error/code")
                        .and_then(Value::as_str)
                        .map(|c| cut(c, 100))
                })
                .unwrap_or_else(|| format!("http_{status}"));
            let (_, mut v) = fail(&code, &format!("api call not allowed: {code}"));
            v["blocked"] = Value::Bool(true);
            return (false, v);
        }
        let Ok(mut g) = serde_json::from_str::<Map<String, Value>>(&text) else {
            return fail("bad_reply", "unparseable api-checks reply");
        };
        let value = g
            .remove("valueBase64")
            .and_then(|v| v.as_str().map(str::to_string))
            .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        let gs = |k: &str| g.get(k).and_then(Value::as_str).map(str::to_string);
        let base = gs("baseUrl").unwrap_or_default();
        let auth_kind = gs("authKind").unwrap_or_default();

        let report = |status: u16, ms: f64, bytes: usize, error: Option<&str>| {
            let body = json!({"leaseId": lease.lease_id, "token": lease.token, "connector": connector, "method": method, "path": path, "status": status, "durationMs": ms, "bytes": bytes, "error": error});
            match post(API_RESULTS_PATH, body.to_string()) {
                Ok((201, _)) => {}
                Ok((s, _)) => log(&format!(
                    "api: {connector} {method} 보고가 서버에 닿지 않았다({s})"
                )),
                Err(_) => log(&format!(
                    "api: {connector} {method} 보고가 서버에 닿지 않았다(no response)"
                )),
            }
        };

        // ④ 서버가 판정한 경로(실제로 보낼 꼴)가 있으면 그것을 쓴다.
        let send_path = gs("path")
            .filter(|p| p.starts_with('/'))
            .unwrap_or_else(|| path.clone());
        let url = match build_url(&base, &send_path) {
            Ok(u) => u,
            Err("bad_url") => {
                report(0, 0.0, 0, Some("bad_url"));
                return fail("bad_url", "could not build the URL");
            }
            Err(_) => {
                report(0, 0.0, 0, Some("origin_mismatch"));
                return fail(
                    "origin_mismatch",
                    "the path would leave the connector origin",
                );
            }
        };

        let mut headers: Vec<(String, String)> = vec![
            ("accept".into(), "application/json, */*;q=0.5".into()),
            ("user-agent".into(), USER_AGENT.into()),
        ];
        let form = g.get("tokenForm").and_then(Value::as_object).and_then(|f| {
            let s = |k: &str| f.get(k).and_then(Value::as_str).map(str::to_string);
            Some(TokenForm {
                grant_type: s("grantType")?,
                client_id: s("clientId")?,
                key_field: s("keyField")?,
            })
        });
        let token_url = gs("tokenUrl").filter(|u| !u.is_empty());
        let tk = match (auth_kind.as_str(), &token_url, &form) {
            ("token_exchange", Some(u), Some(f)) => {
                Some(Self::token_key(agent_id, &base, u, f, &value))
            }
            _ => None,
        };
        let mut access = String::new();
        let mut from_cache = false;
        let get_token = |access: &mut String, from_cache: &mut bool| -> bool {
            let (Some(tk), Some(u), Some(f)) = (&tk, &token_url, &form) else {
                return false;
            };
            if let Some(hit) = self.cache().get(tk)
                && hit.until_ms > (self.now_ms)()
            {
                access.clone_from(&hit.token);
                *from_cache = true;
                return true;
            }
            *from_cache = false;
            match exchange_token(&self.fetch, u, f, &value) {
                Ok((t, ttl)) => {
                    self.cache().insert(
                        tk.clone(),
                        Cached {
                            token: t.clone(),
                            until_ms: (self.now_ms)() + ttl * 1000.0,
                        },
                    );
                    *access = t;
                    true
                }
                Err(_) => false,
            }
        };
        match auth_kind.as_str() {
            "token_exchange" => {
                if tk.is_none() {
                    report(0, 0.0, 0, Some("token_exchange_failed"));
                    return fail(
                        "token_exchange_failed",
                        "token exchange is not configured for this connector",
                    );
                }
                if !get_token(&mut access, &mut from_cache) {
                    report(0, 0.0, 0, Some("token_exchange_failed"));
                    return fail("token_exchange_failed", "token exchange failed");
                }
                headers.push(("authorization".into(), format!("Bearer {access}")));
            }
            "bearer" => headers.push(("authorization".into(), format!("Bearer {value}"))),
            "header" => {
                if let Some(h) = gs("authHeader").filter(|h| !h.is_empty()) {
                    headers.push((h.to_ascii_lowercase(), value.clone()));
                }
            }
            _ => {}
        }
        if parsed.body.is_some() {
            headers.push((
                "content-type".into(),
                parsed
                    .content_type
                    .clone()
                    .unwrap_or_else(|| "application/json".into()),
            ));
        }

        // ⑤ 호출. 리다이렉트는 따라가지 않는다.
        let started = (self.now_ms)();
        let send = |headers: &[(String, String)]| {
            (self.fetch)(&ApiRequest {
                method,
                url: &url,
                headers,
                body: parsed.body.clone().map(String::into_bytes),
                timeout: TIMEOUT,
                read_max: RESPONSE_READ_MAX,
            })
        };
        let mut res = send(&headers);
        // 캐시 토큰이 401 이면 버리고 한 번만 다시 교환해 다시 보낸다.
        if matches!(&res, Ok(r) if r.status == 401) && from_cache {
            if let Some(tk) = &tk {
                self.cache().remove(tk);
            }
            if !get_token(&mut access, &mut from_cache) {
                report(
                    0,
                    (self.now_ms)() - started,
                    0,
                    Some("token_exchange_failed"),
                );
                return fail("token_exchange_failed", "token exchange failed");
            }
            for h in headers.iter_mut().filter(|h| h.0 == "authorization") {
                h.1 = format!("Bearer {access}");
            }
            res = send(&headers);
        }
        let scrub = |t: &str| scrub_value(&scrub_value(t, &value), &access);
        let res = match res {
            Ok(r) => r,
            Err(e) => {
                let msg = cut(&scrub(&e), 300);
                report(0, (self.now_ms)() - started, 0, Some(&msg));
                return fail("unreachable", &format!("request failed: {msg}"));
            }
        };
        let ms = (self.now_ms)() - started;
        let text = scrub(&String::from_utf8_lossy(&res.body));
        let returned = cut(&text, RESPONSE_RETURN_MAX);
        let cut_short = returned.len() < text.len();
        report(res.status, ms, res.read, None);
        log(&format!(
            "api: {connector} {method} {} → {} ({ms}ms, {}B) agent={agent_id}",
            path.split('?').next().unwrap_or(""),
            res.status,
            res.read
        ));
        let mut out = Map::new();
        out.insert("status".into(), json!(res.status));
        out.insert("contentType".into(), json!(res.content_type));
        if (300..400).contains(&res.status)
            && let Some(l) = res.location.as_deref().filter(|l| !l.is_empty())
        {
            out.insert("location".into(), json!(scrub(l)));
            out.insert("note".into(), json!("redirects are not followed"));
        }
        out.insert("body".into(), json!(returned));
        if res.truncated || cut_short {
            out.insert("truncated".into(), Value::Bool(true));
        }
        (res.status < 400, Value::Object(out))
    }

    /// `api.call` 이면 답하고 아니면 None(TS `maybeHandle`). `lease` 는 `lookup_for(runner, agent, cause)` 결과.
    pub fn maybe_handle(
        &self,
        agent_id: &str,
        req: &RunnerLinkRequest,
        lease: Option<&TurnLease>,
        post: Post<'_>,
        log: &dyn Fn(&str),
    ) -> Option<RunnerLinkResponse> {
        if !is_api_call(req) {
            return None;
        }
        let RunnerLinkRequest::McpRequest { id, payload, .. } = req else {
            return None;
        };
        let (ok, v) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.run(agent_id, payload, lease, post, log)
        }))
        .unwrap_or_else(|_| {
            log("api: 실패 — 내부 오류(panic)");
            fail("api_error", "the api wrapper hit an internal error")
        });
        let mut result = json!({"content": [{"type": "text", "text": v.to_string()}]});
        if !ok {
            result["isError"] = Value::Bool(true);
        }
        Some(RunnerLinkResponse::McpResponse {
            id: id.clone(),
            messages: vec![
                json!({"jsonrpc": "2.0", "id": payload.get("id").cloned().unwrap_or(Value::Null), "result": result}),
            ],
        })
    }
}

#[cfg(test)]
mod tests;
