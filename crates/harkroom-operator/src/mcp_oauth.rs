//! 원격 MCP 의 OAuth(S2 A5d) — `operatorMcpAuthStart`·`operatorMcpAuthStatus`·`operatorMcpAuthForget` 와 목록의 `auth` 칸.
//!
//! 정본은 `packages/operator/src/mcpOAuth.ts` 의 `start`·`status`·`forget` 이다. 흐름도 같다
//! (MCP 권한 명세 2025-06-18 · RFC 9728 · RFC 8414 · RFC 7591 · PKCE):
//! 1. 보호 자원 메타데이터 — 인증 없는 `initialize` 의 401 `resource_metadata`, 없으면 well-known 두 곳.
//! 2. 인가 서버 메타데이터 — `oauth-authorization-server`, 없으면 `openid-configuration`(두 자리).
//! 3. 클라이언트 — 정의의 `oauth.clientId`(PKCE 공개 클라이언트), 없으면 동적 등록(`token_endpoint_auth_method: none`).
//! 4. 루프백 콜백(127.0.0.1, ::1 은 되면) → 코드 교환(`resource` = MCP url) → `secrets/mcp-oauth.json` 에 잠금 쓰기.
//!
//! **러너 쪽(s21) 몫으로 남긴 것**: `refresh`·`tokensFor`·`refreshDue`·`reportRejected`·`onToken`(도는 러너 설정 재작성).
//! 이 묶음은 사람이 데스크톱에서 인증하고 상태를 보는 길만 옮긴다. 소켓으로는 토큰 값을 내보내지 않는다(상태만).
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use harkroom_proto::p3::{DaemonError, DaemonErrorCode};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{Map, Value, json};

use crate::callback_page::{self, Kind};
use crate::file_lock::{FileLockOptions, with_file_lock};
use crate::local_mcp::{read_object, write_object};

fn internal(message: impl Into<String>) -> DaemonError {
    DaemonError {
        code: DaemonErrorCode::Internal,
        message: message.into(),
    }
}

pub const FLOW_TIMEOUT: Duration = Duration::from_secs(5 * 60);

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9.0e15 {
        json!(f as i64)
    } else {
        json!(f)
    }
}

// ── URL 조각(url crate 없이 — 필요한 것은 origin·경로·쿼리뿐) ──────────────────────────────────────

/// `scheme://authority/path?query#frag` 를 가른다. http(s) 만.
#[derive(Debug, Clone, PartialEq)]
pub struct SimpleUrl {
    pub origin: String,
    pub path: String,
    pub query: String,
}

pub fn parse_url(s: &str) -> Option<SimpleUrl> {
    let (scheme, rest) = s.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let rest = rest.split('#').next().unwrap_or("");
    let end = rest.find(['/', '?']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let tail = &rest[end..];
    let (path, query) = match tail.split_once('?') {
        Some((p, q)) => (p, q),
        None => (tail, ""),
    };
    let mut host = authority.to_ascii_lowercase();
    let default = if scheme == "https" { ":443" } else { ":80" };
    if let Some(h) = host.strip_suffix(default) {
        host = h.to_string();
    }
    Some(SimpleUrl {
        origin: format!("{scheme}://{host}"),
        path: if path.is_empty() {
            "/".into()
        } else {
            path.into()
        },
        query: query.into(),
    })
}

/// `application/x-www-form-urlencoded` 인코딩(URLSearchParams 와 같은 규칙 — 공백은 `+`).
pub fn form_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn form_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                match std::str::from_utf8(&bytes[i + 1..i + 3])
                    .ok()
                    .and_then(|h| u8::from_str_radix(h, 16).ok())
                    .ok_or(())
                {
                    Ok(v) => {
                        out.push(v);
                        i += 3;
                        continue;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 쿼리 문자열의 첫 `key` 값(디코드).
pub fn query_get(query: &str, key: &str) -> Option<String> {
    query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| p.split_once('=').unwrap_or((p, "")))
        .find(|(k, _)| form_decode(k) == key)
        .map(|(_, v)| form_decode(v))
}

/// 인가 url — 원래 쿼리에서 같은 키를 빼고(URLSearchParams.set 과 같다) 우리 값을 붙인다.
pub fn with_query(endpoint: &str, params: &[(&str, &str)]) -> Option<String> {
    let u = parse_url(endpoint)?;
    let mut parts: Vec<String> = u
        .query
        .split('&')
        .filter(|p| !p.is_empty())
        .filter(|p| {
            let k = form_decode(p.split_once('=').map(|x| x.0).unwrap_or(p));
            !params.iter().any(|(pk, _)| *pk == k)
        })
        .map(str::to_string)
        .collect();
    for (k, v) in params {
        parts.push(format!("{}={}", form_encode(k), form_encode(v)));
    }
    Some(format!("{}{}?{}", u.origin, u.path, parts.join("&")))
}

/// `resource_metadata="…"` 를 `WWW-Authenticate` 에서 꺼낸다(TS 와 같은 정규식).
pub fn resource_metadata_of(www: &str) -> Option<String> {
    let i = www.find("resource_metadata=\"")? + "resource_metadata=\"".len();
    let rest = &www[i..];
    let end = rest.find('"')?;
    (end > 0).then(|| rest[..end].to_string())
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────

fn agent() -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(20)))
            .build(),
    )
}

fn object(v: Option<Value>) -> Option<Map<String, Value>> {
    match v {
        Some(Value::Object(m)) => Some(m),
        _ => None,
    }
}

fn get_json(a: &ureq::Agent, url: &str) -> Option<Map<String, Value>> {
    let mut res = a
        .get(url)
        .header("accept", "application/json")
        .call()
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    object(res.body_mut().read_json::<Value>().ok())
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub struct AuthServer {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    pub scopes: Vec<String>,
}

/// 1·2단계.
fn discover(a: &ureq::Agent, mcp_url: &str) -> Result<AuthServer, String> {
    let u = parse_url(mcp_url).ok_or_else(|| format!("{mcp_url} 는 http(s) url 이 아니다"))?;
    let body = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"harkroom-operator","version":"1"}}});
    let prm_url = a
        .post(mcp_url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .send(body.to_string())
        .ok()
        .and_then(|res| {
            res.headers()
                .get("www-authenticate")
                .and_then(|h| h.to_str().ok())
                .and_then(resource_metadata_of)
        });
    let path = if u.path == "/" { "" } else { u.path.as_str() };
    let prm = prm_url
        .and_then(|p| get_json(a, &p))
        .or_else(|| {
            get_json(
                a,
                &format!("{}/.well-known/oauth-protected-resource{path}", u.origin),
            )
        })
        .or_else(|| {
            get_json(
                a,
                &format!("{}/.well-known/oauth-protected-resource", u.origin),
            )
        });
    let servers = strings(prm.as_ref().and_then(|p| p.get("authorization_servers")));
    let issuer_raw = servers.first().cloned().unwrap_or_else(|| u.origin.clone());
    let issuer = parse_url(&issuer_raw)
        .ok_or_else(|| format!("인가 서버 주소가 url 이 아니다: {issuer_raw}"))?;
    let ipath = if issuer.path == "/" {
        ""
    } else {
        issuer.path.as_str()
    };
    let o = &issuer.origin;
    let as_meta = get_json(
        a,
        &format!("{o}/.well-known/oauth-authorization-server{ipath}"),
    )
    .or_else(|| get_json(a, &format!("{o}/.well-known/openid-configuration{ipath}")))
    .or_else(|| {
        (!ipath.is_empty())
            .then(|| get_json(a, &format!("{o}{ipath}/.well-known/openid-configuration")))
            .flatten()
    });
    let fail = || {
        format!(
            "{mcp_url} 의 인가 서버 메타데이터를 찾지 못했다 — 이 서버가 OAuth 를 쓰지 않거나 명세 밖이다"
        )
    };
    let m = as_meta.ok_or_else(fail)?;
    let (Some(authz), Some(token)) = (
        m.get("authorization_endpoint").and_then(Value::as_str),
        m.get("token_endpoint").and_then(Value::as_str),
    ) else {
        return Err(fail());
    };
    Ok(AuthServer {
        authorization_endpoint: authz.into(),
        token_endpoint: token.into(),
        registration_endpoint: m
            .get("registration_endpoint")
            .and_then(Value::as_str)
            .map(str::to_string),
        scopes: strings(prm.as_ref().and_then(|p| p.get("scopes_supported"))),
    })
}

#[derive(Clone)]
struct Client {
    id: String,
    secret: Option<String>,
}

fn register(a: &ureq::Agent, endpoint: Option<&str>, redirect_uri: &str) -> Result<Client, String> {
    let Some(endpoint) = endpoint else {
        return Err(
            "이 인가 서버는 동적 클라이언트 등록을 받지 않는다 — 정의에 oauth.clientId 가 필요하다"
                .into(),
        );
    };
    let body = json!({
        "client_name": "Harkroom", "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let mut res = a
        .post(endpoint)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .send(body.to_string())
        .map_err(|e| format!("클라이언트 등록 실패({e})"))?;
    let status = res.status().as_u16();
    let b = object(res.body_mut().read_json::<Value>().ok());
    match b
        .as_ref()
        .and_then(|b| b.get("client_id"))
        .and_then(Value::as_str)
    {
        Some(id) if (200..300).contains(&status) => Ok(Client {
            id: id.into(),
            secret: b
                .as_ref()
                .and_then(|b| b.get("client_secret"))
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        _ => Err(format!("클라이언트 등록 실패({status})")),
    }
}

/// 토큰 요청. 성공이면 본문, 아니면 `error` 또는 `http_<status>`.
fn token_request(
    a: &ureq::Agent,
    endpoint: &str,
    form: &[(&str, &str)],
) -> Result<Map<String, Value>, String> {
    let body: Vec<String> = form
        .iter()
        .map(|(k, v)| format!("{}={}", form_encode(k), form_encode(v)))
        .collect();
    let mut res = a
        .post(endpoint)
        .header("content-type", "application/x-www-form-urlencoded")
        .header("accept", "application/json")
        .send(body.join("&"))
        .map_err(|e| format!("network: {e}"))?;
    let status = res.status().as_u16();
    let b = object(res.body_mut().read_json::<Value>().ok());
    if (200..300).contains(&status)
        && let Some(b) = b.as_ref()
        && b.get("access_token").and_then(Value::as_str).is_some()
    {
        return Ok(b.clone());
    }
    Err(b
        .as_ref()
        .and_then(|b| b.get("error"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("http_{status}")))
}

// ── 흐름 ─────────────────────────────────────────────────────────────────────────────────────────────

enum FlowState {
    Pending,
    Error(String),
}

struct Flow {
    url: String,
    stop: AtomicBool,
    state: Mutex<FlowState>,
}

/// 이 프로세스가 든 OAuth 흐름과 토큰 저장소.
pub struct McpOAuth {
    store_path: PathBuf,
    flows: Mutex<HashMap<String, Arc<Flow>>>,
    timeout: Duration,
}

impl std::fmt::Debug for McpOAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpOAuth")
            .field("store_path", &self.store_path)
            .finish()
    }
}

fn random_b64(n: usize) -> Result<String, DaemonError> {
    let mut buf = vec![0u8; n];
    SystemRandom::new()
        .fill(&mut buf)
        .map_err(|_| internal("OS 난수를 얻지 못했다"))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

/// PKCE S256 challenge.
pub fn challenge_of(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(ring::digest::digest(
        &ring::digest::SHA256,
        verifier.as_bytes(),
    ))
}

/// 127.0.0.1 은 꼭, ::1 은 되면. 포트가 겹치면 기다리지 않고 말한다.
fn listen(port: u16) -> Result<Vec<TcpListener>, DaemonError> {
    let v4 = TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            internal(format!(
                "콜백 포트 {port} 를 다른 프로그램이 쓰고 있다 — 다른 창(예: claude 의 /mcp)에서 같은 인증이 열려 있으면 닫고 다시 누른다"
            ))
        } else {
            internal(format!("콜백 포트를 열지 못했다: {e}"))
        }
    })?;
    let actual = v4.local_addr().map_err(|e| internal(e.to_string()))?.port();
    let mut out = vec![v4];
    if let Ok(v6) = TcpListener::bind(("::1", actual)) {
        out.push(v6);
    }
    for l in &out {
        l.set_nonblocking(true)
            .map_err(|e| internal(e.to_string()))?;
    }
    Ok(out)
}

/// 콜백 한 건의 요청줄·Accept-Language.
fn read_request(stream: &TcpStream) -> Option<(String, Option<String>)> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut r = BufReader::new(stream);
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let target = line.split_whitespace().nth(1)?.to_string();
    let mut lang = None;
    for _ in 0..100 {
        let mut h = String::new();
        if r.read_line(&mut h).ok()? == 0 || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':')
            && k.trim().eq_ignore_ascii_case("accept-language")
        {
            lang = Some(v.trim().to_string());
        }
    }
    Some((target, lang))
}

fn respond(mut stream: &TcpStream, status: u16, headers: &[(&str, String)], body: &str) {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Bad Request",
    };
    let mut out = format!("HTTP/1.1 {status} {reason}\r\n");
    for (k, v) in headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str(&format!(
        "content-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    ));
    let _ = stream.write_all(out.as_bytes());
    let _ = stream.flush();
}

struct Exchange {
    name: String,
    url: String,
    state: String,
    verifier: String,
    redirect_uri: String,
    client: Client,
    token_endpoint: String,
}

impl McpOAuth {
    pub fn new(store_path: PathBuf) -> Self {
        McpOAuth {
            store_path,
            flows: Mutex::new(HashMap::new()),
            timeout: FLOW_TIMEOUT,
        }
    }

    #[cfg(test)]
    pub fn with_timeout(mut self, t: Duration) -> Self {
        self.timeout = t;
        self
    }

    fn flows(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Flow>>> {
        self.flows.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn close_flow(&self, name: &str) {
        if let Some(f) = self.flows().remove(name) {
            f.stop.store(true, Ordering::SeqCst);
        }
    }

    fn lock_path(&self) -> PathBuf {
        self.store_path.with_extension("json.lock")
    }

    fn load(&self) -> Result<Map<String, Value>, DaemonError> {
        Ok(read_object(&self.store_path, "mcp-oauth.json")?.unwrap_or_default())
    }

    /// 잠그고 읽어 고친 뒤 쓴다. 깨진 파일은 덮지 않는다(`read_object` 가 거절한다).
    fn update(&self, f: impl FnOnce(&mut Map<String, Value>)) -> Result<(), DaemonError> {
        if let Some(dir) = self.store_path.parent() {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)
                .map_err(|e| internal(format!("secrets 디렉터리를 만들지 못했다: {e}")))?;
        }
        with_file_lock(&self.lock_path(), &FileLockOptions::default(), || {
            let mut s = self.load()?;
            f(&mut s);
            write_object(&self.store_path, &s, "mcp-oauth.json")
        })
        .map_err(|e| internal(format!("mcp-oauth.json 잠금을 잡지 못했다: {e}")))?
    }

    /// `operatorMcpAuthStart`. 돌려준 url 을 앱이 브라우저로 연다. 한 이름에 흐름은 하나다.
    pub fn start(
        self: &Arc<Self>,
        name: &str,
        url: &str,
        client_id: Option<&str>,
        callback_port: Option<u16>,
    ) -> Result<Value, DaemonError> {
        self.close_flow(name);
        let a = agent();
        let as_meta = discover(&a, url).map_err(internal)?;
        let verifier = random_b64(32)?;
        let challenge = challenge_of(&verifier);
        let state = random_b64(16)?;
        let listeners = listen(callback_port.unwrap_or(0))?;
        let port = listeners[0]
            .local_addr()
            .map_err(|e| internal(e.to_string()))?
            .port();
        let redirect_uri = format!("http://localhost:{port}/callback");
        // 정의의 clientId 는 PKCE 공개 클라이언트로 쓴다 — secret 은 받지도 싣지도 않는다.
        let client = match client_id {
            Some(id) => Client {
                id: id.into(),
                secret: None,
            },
            None => register(&a, as_meta.registration_endpoint.as_deref(), &redirect_uri)
                .map_err(internal)?,
        };
        let mut params: Vec<(&str, &str)> = vec![
            ("response_type", "code"),
            ("client_id", &client.id),
            ("redirect_uri", &redirect_uri),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &state),
            ("resource", url),
        ];
        let scope = as_meta.scopes.join(" ");
        if !scope.is_empty() {
            params.push(("scope", &scope));
        }
        let auth_url = with_query(&as_meta.authorization_endpoint, &params)
            .ok_or_else(|| internal("인가 엔드포인트가 http(s) url 이 아니다"))?;
        let flow = Arc::new(Flow {
            url: url.into(),
            stop: AtomicBool::new(false),
            state: Mutex::new(FlowState::Pending),
        });
        self.flows().insert(name.into(), flow.clone());
        let ex = Exchange {
            name: name.into(),
            url: url.into(),
            state,
            verifier,
            redirect_uri,
            client,
            token_endpoint: as_meta.token_endpoint,
        };
        let me = Arc::clone(self);
        std::thread::Builder::new()
            .name(format!("mcp-oauth-{name}"))
            .spawn(move || me.serve(listeners, flow, ex))
            .map_err(|e| internal(format!("콜백 스레드를 띄우지 못했다: {e}")))?;
        Ok(json!({ "authUrl": auth_url }))
    }

    fn fail(&self, flow: &Flow, name: &str, error: String) {
        eprintln!("MCP OAuth: {name} 실패 — {error}");
        *flow.state.lock().unwrap_or_else(|p| p.into_inner()) = FlowState::Error(error);
        flow.stop.store(true, Ordering::SeqCst);
    }

    fn serve(&self, listeners: Vec<TcpListener>, flow: Arc<Flow>, ex: Exchange) {
        let deadline = Instant::now() + self.timeout;
        while !flow.stop.load(Ordering::SeqCst) {
            if Instant::now() >= deadline {
                self.fail(
                    &flow,
                    &ex.name,
                    "시간 초과 — 브라우저에서 인증을 끝내지 않았다".into(),
                );
                break;
            }
            let mut got = false;
            for l in &listeners {
                if let Ok((stream, _)) = l.accept() {
                    got = true;
                    let _ = stream.set_nonblocking(false);
                    self.handle(&stream, &flow, &ex);
                    if flow.stop.load(Ordering::SeqCst) {
                        break;
                    }
                }
            }
            if !got {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }

    fn handle(&self, stream: &TcpStream, flow: &Arc<Flow>, ex: &Exchange) {
        let Some((target, accept_lang)) = read_request(stream) else {
            return;
        };
        let (path, query) = target.split_once('?').unwrap_or((&target, ""));
        if path != "/callback" {
            respond(stream, 404, &[], "");
            return;
        }
        let lang = callback_page::lang_of(accept_lang.as_deref());
        let page = |kind: Kind, code: Option<&str>| {
            let p = callback_page::render(kind, Some(&ex.name), code, lang);
            respond(stream, p.status, &p.headers, &p.body);
        };
        if query_get(query, "state").as_deref() != Some(ex.state.as_str()) {
            page(Kind::Expired, None);
            return;
        }
        let Some(code) = query_get(query, "code") else {
            let e = query_get(query, "error").unwrap_or_else(|| "no_code".into());
            page(Kind::Denied, Some(&e));
            self.fail(flow, &ex.name, format!("인가 거절: {e}"));
            return;
        };
        let mut form: Vec<(&str, &str)> = vec![
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &ex.redirect_uri),
            ("client_id", &ex.client.id),
            ("code_verifier", &ex.verifier),
            ("resource", &ex.url),
        ];
        if let Some(s) = &ex.client.secret {
            form.push(("client_secret", s));
        }
        let body = match token_request(&agent(), &ex.token_endpoint, &form) {
            Ok(b) => b,
            Err(e) => {
                page(Kind::ExchangeFailed, Some(&e));
                self.fail(flow, &ex.name, format!("토큰 교환 실패: {e}"));
                return;
            }
        };
        let now = now_ms();
        let mut rec = Map::new();
        rec.insert("url".into(), json!(ex.url));
        rec.insert("clientId".into(), json!(ex.client.id));
        if let Some(s) = &ex.client.secret {
            rec.insert("clientSecret".into(), json!(s));
        }
        rec.insert("tokenEndpoint".into(), json!(ex.token_endpoint));
        rec.insert("resource".into(), json!(ex.url));
        rec.insert("accessToken".into(), body["access_token"].clone());
        if let Some(r) = body.get("refresh_token").filter(|v| v.is_string()) {
            rec.insert("refreshToken".into(), r.clone());
        }
        if let Some(e) = body
            .get("expires_in")
            .and_then(Value::as_f64)
            .filter(|e| *e > 0.0)
        {
            rec.insert("expiresAt".into(), num(now + e * 1000.0));
        }
        rec.insert("status".into(), json!("ok"));
        rec.insert("updatedAt".into(), num(now));
        let name = ex.name.clone();
        match self.update(|s| {
            s.insert(name, Value::Object(rec));
        }) {
            Ok(()) => {
                page(Kind::Ok, None);
                // 이 흐름이 아직 그 이름의 것일 때만 닫는다(다시 누른 새 흐름을 지우지 않는다).
                let mut flows = self.flows();
                if flows.get(&ex.name).is_some_and(|f| Arc::ptr_eq(f, flow)) {
                    flows.remove(&ex.name);
                }
                flow.stop.store(true, Ordering::SeqCst);
                eprintln!("MCP OAuth: {} 인증됨", ex.name);
            }
            Err(e) => {
                page(Kind::SaveFailed, None);
                self.fail(flow, &ex.name, e.message);
            }
        }
    }

    /// `operatorMcpAuthStatus`·목록의 `auth`. `client_id` 가 다르면 그 토큰은 이 정의의 것이 아니다(`none`).
    pub fn status(
        &self,
        name: &str,
        url: &str,
        client_id: Option<&str>,
    ) -> Result<Value, DaemonError> {
        if let Some(f) = self.flows().get(name).cloned()
            && f.url == url
        {
            return Ok(match &*f.state.lock().unwrap_or_else(|p| p.into_inner()) {
                FlowState::Pending => json!({"state": "pending"}),
                FlowState::Error(e) => json!({"state": "error", "reason": e}),
            });
        }
        let store = self.load()?;
        let Some(rec) = store.get(name).and_then(Value::as_object) else {
            return Ok(json!({"state": "none"}));
        };
        let s = |k: &str| rec.get(k).and_then(Value::as_str);
        if s("url") != Some(url) {
            return Ok(json!({"state": "none"}));
        }
        if let Some(c) = client_id.filter(|c| !c.is_empty())
            && s("clientId") != Some(c)
        {
            return Ok(json!({"state": "none"}));
        }
        let updated = rec.get("updatedAt").and_then(Value::as_f64);
        let expires = rec.get("expiresAt").and_then(Value::as_f64);
        match s("status") {
            Some("expired") => return Ok(json!({"state": "expired"})),
            Some("rejected") => {
                let at = rec
                    .get("rejectedAt")
                    .and_then(Value::as_f64)
                    .or(updated)
                    .unwrap_or(0.0);
                let mut o = json!({"state": "rejected", "at": num(at)});
                if let Some(by) = s("rejectedBy") {
                    o["agentId"] = json!(by);
                }
                return Ok(o);
            }
            _ => {}
        }
        if let Some(e) = expires
            && e <= now_ms()
            && s("refreshToken").is_none()
        {
            return Ok(json!({"state": "expired"}));
        }
        let mut o = json!({"state": "ok"});
        if let Some(u) = updated {
            o["at"] = num(u);
        }
        if let Some(e) = expires {
            o["expiresAt"] = num(e);
        }
        Ok(o)
    }

    /// `operatorMcpAuthForget`. 흐름을 닫고 그 이름의 토큰 칸을 지운다.
    pub fn forget(&self, name: &str) -> Result<(), DaemonError> {
        self.close_flow(name);
        if !self.store_path.exists() {
            return Ok(());
        }
        self.update(|s| {
            s.shift_remove(name);
        })
    }

    pub fn close(&self) {
        let names: Vec<String> = self.flows().keys().cloned().collect();
        for n in names {
            self.close_flow(&n);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_pieces() {
        let u = parse_url("https://Mcp.Example.com:443/v1/mcp?x=1#f").unwrap();
        assert_eq!(u.origin, "https://mcp.example.com");
        assert_eq!(u.path, "/v1/mcp");
        assert_eq!(u.query, "x=1");
        assert_eq!(parse_url("http://h:8080").unwrap().path, "/");
        assert!(parse_url("file:///etc/passwd").is_none());
        assert!(parse_url("https://user@h/").is_none());
    }

    #[test]
    fn form_roundtrip() {
        let s = "a b+c/d?=&é~";
        assert_eq!(form_encode(s), "a+b%2Bc%2Fd%3F%3D%26%C3%A9%7E");
        assert_eq!(form_decode(&form_encode(s)), s);
        assert_eq!(form_decode("%zz%4"), "%zz%4");
        assert_eq!(
            query_get("state=a%2Bb&code=x+y", "code").as_deref(),
            Some("x y")
        );
        assert_eq!(query_get("state=a%2Bb", "state").as_deref(), Some("a+b"));
    }

    #[test]
    fn auth_url_replaces_keys() {
        let u = with_query(
            "https://as.example/authorize?team=T1&state=old",
            &[("state", "s"), ("scope", "a b")],
        )
        .unwrap();
        assert_eq!(u, "https://as.example/authorize?team=T1&state=s&scope=a+b");
    }

    #[test]
    fn www_authenticate() {
        assert_eq!(
            resource_metadata_of(r#"Bearer error="invalid_token", resource_metadata="https://x/.well-known/oauth-protected-resource""#).as_deref(),
            Some("https://x/.well-known/oauth-protected-resource")
        );
        assert_eq!(resource_metadata_of("Bearer"), None);
    }

    #[test]
    fn pkce_rfc7636_vector() {
        // 기대값은 TS 와 같은 계산(node `createHash('sha256').update(v).digest('base64url')`)으로 뽑았다.
        assert_eq!(
            challenge_of("dBjftJeZ4CVP-mJ0tYyS8IzBrsFEhDkiqt3C9wkMtTE"),
            "VlyTBNrg8N4aFDbE7RoS4IerN2bGgfn3yOTVsopmvds"
        );
        assert_eq!(random_b64(32).unwrap().len(), 43);
    }

    /// 가짜 MCP·인가 서버(한 포트). 받은 토큰 요청 본문을 모은다.
    fn mock_server() -> (u16, Arc<Mutex<Vec<String>>>) {
        use std::io::Read;
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        std::thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { continue };
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                let mut len = 0usize;
                loop {
                    let mut h = String::new();
                    r.read_line(&mut h).unwrap();
                    if h.trim().is_empty() {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0u8; len];
                r.read_exact(&mut body).unwrap();
                let body = String::from_utf8(body).unwrap();
                let path = line.split_whitespace().nth(1).unwrap().to_string();
                let base = format!("http://127.0.0.1:{port}");
                let (status, extra, out) = match path.as_str() {
                    "/mcp" => (401, format!("www-authenticate: Bearer resource_metadata=\"{base}/prm\"\r\n"), "{}".to_string()),
                    "/prm" => (200, String::new(), json!({"authorization_servers":[base],"scopes_supported":["a","b"]}).to_string()),
                    "/.well-known/oauth-authorization-server" => (200, String::new(), json!({"authorization_endpoint":format!("{base}/authorize?team=T"),"token_endpoint":format!("{base}/token"),"registration_endpoint":format!("{base}/register")}).to_string()),
                    "/register" => { seen2.lock().unwrap().push(body); (201, String::new(), json!({"client_id":"dyn-1"}).to_string()) }
                    "/token" => { seen2.lock().unwrap().push(body); (200, String::new(), json!({"access_token":"AT","refresh_token":"RT","expires_in":3600}).to_string()) }
                    _ => (404, String::new(), "{}".to_string()),
                };
                let _ = write!(
                    s,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n{extra}content-length: {}\r\nconnection: close\r\n\r\n{out}",
                    out.len()
                );
            }
        });
        (port, seen)
    }

    fn get(url: &str) -> (u16, String) {
        let mut r = agent()
            .get(url)
            .header("accept-language", "en")
            .call()
            .unwrap();
        (r.status().as_u16(), r.body_mut().read_to_string().unwrap())
    }

    #[test]
    fn full_flow_dcr_callback_exchange_status_forget() {
        let (port, seen) = mock_server();
        let dir =
            std::env::temp_dir().join(format!("hk-oauth-{}-{}", std::process::id(), now_ms()));
        let store = dir.join("secrets").join("mcp-oauth.json");
        let o = Arc::new(McpOAuth::new(store.clone()));
        let mcp = format!("http://127.0.0.1:{port}/mcp");
        assert_eq!(o.status("s", &mcp, None).unwrap(), json!({"state":"none"}));
        let r = o.start("s", &mcp, None, None).unwrap();
        let auth = r["authUrl"].as_str().unwrap().to_string();
        assert!(auth.starts_with(&format!("http://127.0.0.1:{port}/authorize?team=T&response_type=code&client_id=dyn-1&redirect_uri=http%3A%2F%2Flocalhost%3A")));
        assert!(auth.contains("&code_challenge_method=S256&") && auth.ends_with("&scope=a+b"));
        assert_eq!(
            o.status("s", &mcp, None).unwrap(),
            json!({"state":"pending"})
        );
        let q = auth.split_once('?').unwrap().1;
        let redirect = query_get(q, "redirect_uri")
            .unwrap()
            .replace("localhost", "127.0.0.1");
        let state = query_get(q, "state").unwrap();
        // 남의 state — 만료 페이지, 흐름은 그대로.
        let (st, body) = get(&format!("{redirect}?code=c&state=nope"));
        assert_eq!(st, 400);
        assert!(body.contains("data-kind=\"expired\""));
        assert_eq!(get(&redirect.replace("/callback", "/other")).0, 404);
        let (st, body) = get(&format!(
            "{redirect}?code=the+code&state={}",
            form_encode(&state)
        ));
        assert_eq!(st, 200, "{body}");
        assert!(body.contains("data-kind=\"ok\""));
        let reg = seen.lock().unwrap()[0].clone();
        assert!(reg.contains("\"token_endpoint_auth_method\":\"none\""));
        let tok = seen.lock().unwrap()[1].clone();
        assert!(tok.contains(
            "grant_type=authorization_code&code=the+code&redirect_uri=http%3A%2F%2Flocalhost%3A"
        ));
        assert!(
            tok.contains("&client_id=dyn-1&code_verifier=")
                && tok.ends_with(&format!("&resource={}", form_encode(&mcp)))
        );
        let st = o.status("s", &mcp, None).unwrap();
        assert_eq!(st["state"], "ok");
        assert!(st["expiresAt"].as_f64().unwrap() > st["at"].as_f64().unwrap());
        // 다른 클라이언트·다른 url 이면 그 토큰은 이 정의의 것이 아니다.
        assert_eq!(
            o.status("s", &mcp, Some("other")).unwrap(),
            json!({"state":"none"})
        );
        assert_eq!(
            o.status("s", "http://x/mcp", None).unwrap(),
            json!({"state":"none"})
        );
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&store).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&store).unwrap()).unwrap();
        let keys: Vec<&String> = saved["s"].as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "url",
                "clientId",
                "tokenEndpoint",
                "resource",
                "accessToken",
                "refreshToken",
                "expiresAt",
                "status",
                "updatedAt"
            ]
        );
        o.forget("s").unwrap();
        assert_eq!(o.status("s", &mcp, None).unwrap(), json!({"state":"none"}));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn denied_timeout_port_in_use_and_broken_store() {
        let (port, _) = mock_server();
        let dir =
            std::env::temp_dir().join(format!("hk-oauth2-{}-{}", std::process::id(), now_ms()));
        let store = dir.join("secrets").join("mcp-oauth.json");
        let o = Arc::new(McpOAuth::new(store.clone()));
        let mcp = format!("http://127.0.0.1:{port}/mcp");
        let auth = o.start("d", &mcp, Some("fixed"), None).unwrap()["authUrl"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(auth.contains("client_id=fixed"));
        let q = auth.split_once('?').unwrap().1;
        let redirect = query_get(q, "redirect_uri")
            .unwrap()
            .replace("localhost", "127.0.0.1");
        let state = query_get(q, "state").unwrap();
        let (st, body) = get(&format!(
            "{redirect}?error=access_denied&state={}",
            form_encode(&state)
        ));
        assert_eq!(st, 400);
        assert!(body.contains("access_denied"));
        assert_eq!(
            o.status("d", &mcp, None).unwrap(),
            json!({"state":"error","reason":"인가 거절: access_denied"})
        );
        // 포트가 겹치면 기다리지 않고 거절.
        let busy = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let bp = busy.local_addr().unwrap().port();
        let e = o.start("p", &mcp, Some("fixed"), Some(bp)).unwrap_err();
        assert!(
            e.message.contains(&format!("콜백 포트 {bp}")),
            "{}",
            e.message
        );
        // 시간 초과.
        let t = Arc::new(McpOAuth::new(store.clone()).with_timeout(Duration::from_millis(200)));
        t.start("t", &mcp, Some("fixed"), None).unwrap();
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(t.status("t", &mcp, None).unwrap()["state"], "error");
        // 깨진 저장소는 덮지 않는다.
        std::fs::create_dir_all(store.parent().unwrap()).unwrap();
        std::fs::write(&store, "{not json").unwrap();
        assert!(o.forget("x").is_err());
        assert_eq!(std::fs::read_to_string(&store).unwrap(), "{not json");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
