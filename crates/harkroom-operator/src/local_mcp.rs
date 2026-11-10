//! 이 머신의 MCP 정의(S2 A5c) — `operatorMcpList`·`operatorMcpSet`·`operatorMcpSetStdio`·`operatorMcpRemove`.
//! 정본은 `packages/operator/src/localMcp.ts`, 요청 검사는 `packages/shared/src/daemonProtocol.ts`
//! (`readOperatorMcp*Payload`·`readMcpName`)와 `packages/shared/src/mcpStdio.ts`(`checkMcpStdioCommand`·`checkMcpEnvKey`·
//! `sameMcpProgram`)다.
//!
//! 정의 파일은 커뮤니티 뿌리의 `operator/mcp-servers.json`(TS `run.ts` 의 `registryPath`)이고, 읽기만 하는 사람 설정은
//! `$CLAUDE_CONFIG_DIR/.claude.json`(없으면 `~/.claude.json`, TS `mcpConfig.ts::claudeConfigPath`)이다.
//! 목록은 env·headers 의 **값을 돌려주지 않는다**(키만). 로그에도 이름만 남긴다 — 정의 본문·env·headers 에 토큰이 실린다.
//!
//! TS 와 다른 곳(일부러):
//! - 읽고-고치고-쓰기를 `mcp-servers.json.lock`(P5 잠금, `file_lock.rs`)으로 묶는다. TS 는 잠그지 않는다 — 동시에 온 두 저장 중
//!   하나가 지워질 수 있다(후속 후보).
//! - 임시 파일 이름에 프로세스 안 순번을 더한다(TS 는 pid+ms 라 같은 ms 의 두 쓰기가 부딪힌다).
//! - OAuth(`auth` 칸·`operatorMcpAuth*`)는 A5d 다. 그래서 목록에 `auth` 를 싣지 않는다(옛 오퍼레이터와 같은 모양 — 「모른다」).
//!   다만 TS 가 토큰을 버리는 자리(클라이언트·콜백 포트를 바꿈·stdio 로 바꿈·정의를 뺌)에서는 `secrets/mcp-oauth.json` 의 그
//!   이름 칸을 **지운다** — 정의가 바뀐 뒤 옛 토큰이 남아 Node 오퍼레이터로 돌아갔을 때 다시 쓰이지 않게(security F2).
//! - 이름순 정렬은 `localeCompare` 대신 소문자 비교 뒤 원래 글자 비교다. 오퍼레이터 표의 이름(`[a-z0-9-]`)에서는 같다 —
//!   `~/.claude.json` 에 대문자·`_` 가 섞인 이름이 있으면 순서가 다를 수 있다.
use crate::file_lock::{FileLockOptions, with_file_lock};
use harkroom_proto::p3::{DaemonError, DaemonErrorCode};
use serde_json::{Map, Value, json};
use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

fn internal(message: impl Into<String>) -> DaemonError {
    DaemonError {
        code: DaemonErrorCode::Internal,
        message: message.into(),
    }
}

fn bad(message: impl Into<String>) -> DaemonError {
    DaemonError {
        code: DaemonErrorCode::BadPayload,
        message: message.into(),
    }
}

// ── 문법(mcpStdio.ts·daemonProtocol.ts) ────────────────────────────────────────────────────────────

/// TS `MCP_STDIO_LIMITS`. 길이는 JS `.length`(UTF-16 단위)로 잰다.
pub const LIMIT_COMMAND: usize = 512;
pub const LIMIT_ARG: usize = 512;
pub const LIMIT_ARGS: usize = 24;
pub const LIMIT_TOTAL: usize = 1500;
pub const LIMIT_ENVS: usize = 32;
pub const LIMIT_ENV_VALUE: usize = 8192;

pub const RESERVED_MCP_SERVER_NAMES: [&str; 2] = ["harkroom", "avcs"];

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `\s`(그리고 `String.prototype.trim` 이 치우는 글자).
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// `\p{Cf}`(서식 글자) — Unicode 15 표.
fn is_format(c: char) -> bool {
    matches!(c as u32,
        0xAD | 0x600..=0x605 | 0x61C | 0x6DD | 0x70F | 0x890..=0x891 | 0x8E2 | 0x180E
        | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF
        | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3
        | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

/// TS `INVISIBLE` = `[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]`.
fn is_invisible(c: char) -> bool {
    c.is_control() || is_format(c) || c == '\u{2028}' || c == '\u{2029}'
}

/// TS `visibleProblem`.
fn visible_problem(text: &str) -> Option<&'static str> {
    if text.chars().any(is_invisible) {
        return Some("text-invisible");
    }
    let mut run = 0;
    for c in text.chars() {
        run = if js_space(c) { run + 1 } else { 0 };
        if run >= 4 {
            return Some("text-spacing");
        }
    }
    None
}

fn bare_command(s: &str) -> bool {
    let mut it = s.chars();
    it.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && it.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

/// TS `checkMcpStdioCommand` — 문제 이름(그대로 오류 문구에 실린다) 또는 `None`.
pub fn check_mcp_stdio_command(command: &str, args: &[String]) -> Option<&'static str> {
    if command.is_empty() {
        return Some("command-empty");
    }
    if js_len(command) > LIMIT_COMMAND {
        return Some("command-too-long");
    }
    if let Some(p) = visible_problem(command) {
        return Some(p);
    }
    if command != js_trim(command) {
        return Some("command-shape");
    }
    let absolute = command.starts_with('/') && !command.split('/').any(|s| s == "..");
    if !absolute && !bare_command(command) {
        return Some("command-shape");
    }
    if args.len() > LIMIT_ARGS {
        return Some("args-too-many");
    }
    let mut total = js_len(command);
    for arg in args {
        let n = js_len(arg);
        if n > LIMIT_ARG {
            return Some("arg-too-long");
        }
        if let Some(p) = visible_problem(arg) {
            return Some(p);
        }
        total += n;
    }
    (total > LIMIT_TOTAL).then_some("total-too-long")
}

/// TS `CODE_LOADING_ENV`(대소문자 무시).
fn code_loading_env(key: &str) -> bool {
    let k = key.to_ascii_uppercase();
    const EXACT: [&str; 17] = [
        "NODE_OPTIONS",
        "NODE_PATH",
        "PYTHONPATH",
        "PYTHONSTARTUP",
        "PYTHONHOME",
        "PERL5OPT",
        "PERL5LIB",
        "RUBYOPT",
        "RUBYLIB",
        "BASH_ENV",
        "ENV",
        "ZDOTDIR",
        "PATH",
        "JAVA_TOOL_OPTIONS",
        "_JAVA_OPTIONS",
        "JDK_JAVA_OPTIONS",
        "HOME",
    ];
    const PREFIX: [&str; 8] = [
        "DYLD_",
        "LD_",
        "NPM_CONFIG_",
        "PIP_",
        "UV_",
        "LUA_",
        "GIT_",
        "XDG_",
    ];
    EXACT.contains(&k.as_str()) || PREFIX.iter().any(|p| k.starts_with(p)) || k.ends_with("_PROXY")
}

/// TS `checkMcpEnvKey`.
pub fn check_mcp_env_key(key: &str) -> Option<&'static str> {
    let mut it = key.chars();
    let ok = it
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && key.len() <= 128
        && it.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !ok {
        return Some("env-key");
    }
    code_loading_env(key).then_some("env-code-loading")
}

/// TS `readMcpName`.
fn read_mcp_name(v: Option<&Value>, method: &str) -> Result<String, DaemonError> {
    let Some(s) = v.and_then(Value::as_str).filter(|s| {
        (1..=32).contains(&s.len())
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    }) else {
        return Err(bad(format!("{method} 의 name 은 [a-z0-9-] 1~32자다")));
    };
    if RESERVED_MCP_SERVER_NAMES.contains(&s) {
        return Err(bad(format!(
            "{s} 는 오퍼레이터가 늘 넣는 이름이다 — 정의를 덮을 수 없다"
        )));
    }
    Ok(s.to_string())
}

/// 문자열만 든 객체(TS `isStringRecord`).
fn string_record(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object().filter(|m| m.values().all(Value::is_string))
}

/// JS `Number.isInteger` 인 수.
fn js_integer(v: &Value) -> Option<f64> {
    v.as_f64().filter(|f| f.fract() == 0.0 && f.is_finite())
}

fn int_value(f: f64) -> Value {
    if f >= 0.0 && f <= u64::MAX as f64 {
        json!(f as u64)
    } else {
        json!(f as i64)
    }
}

/// `operatorMcpSet` 의 검사를 지난 원격 정의. `oauth` 는 `clientId`(trim 뒤 비지 않으면)·`callbackPort` 만.
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteDefinition {
    pub transport: String,
    pub url: String,
    pub headers: Option<Map<String, Value>>,
    pub oauth: Option<OAuthDef>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct OAuthDef {
    pub client_id: Option<String>,
    pub callback_port: Option<u64>,
}

/// TS `readOperatorMcpSetPayload`.
pub fn read_set_payload(
    payload: Option<&Value>,
) -> Result<(String, RemoteDefinition), DaemonError> {
    let p = match payload {
        None | Some(Value::Null) => {
            return Err(bad("operatorMcpSet 에는 name·definition 이 필요하다"));
        }
        Some(p) => p,
    };
    let name = read_mcp_name(p.get("name"), "operatorMcpSet")?;
    let Some(d) = p.get("definition").and_then(Value::as_object) else {
        return Err(bad("definition 은 객체여야 한다"));
    };
    let ty = d.get("type").and_then(Value::as_str);
    let (Some("http") | Some("sse")) = ty else {
        return Err(bad(
            "operatorMcpSet 은 http·sse 정의만 받는다 — stdio 는 operatorMcpSetStdio 로 넣는다",
        ));
    };
    let url = match d.get("url").and_then(Value::as_str).map(js_trim) {
        Some(u) if u.starts_with("http://") || u.starts_with("https://") => u.to_string(),
        _ => return Err(bad("http/sse 정의에는 http(s) url 이 필요하다")),
    };
    let headers = match d.get("headers") {
        None => None,
        Some(h) => match string_record(h) {
            Some(m) if m.is_empty() => None,
            Some(m) => Some(m.clone()),
            None => return Err(bad("headers 는 문자열 표여야 한다")),
        },
    };
    let oauth = match d.get("oauth") {
        None => None,
        Some(o) => {
            // TS 는 `typeof o === 'object'` 만 본다 — 배열도 빈 oauth 로 지나간다.
            if !(o.is_object() || o.is_array()) {
                return Err(bad("oauth 는 객체여야 한다"));
            }
            let client_id = o.get("clientId");
            if client_id.is_some_and(|c| !c.is_string()) {
                return Err(bad("oauth.clientId 는 문자열이어야 한다"));
            }
            let port = match o.get("callbackPort") {
                None => None,
                Some(v) => match js_integer(v) {
                    Some(f) if f > 0.0 && f < 65536.0 => Some(f as u64),
                    _ => return Err(bad("oauth.callbackPort 는 1~65535 정수여야 한다")),
                },
            };
            // client secret 은 받지 않는다 — 정의 파일·러너 설정에 실리는 값이라 비밀을 둘 자리가 아니다.
            if o.get("clientSecret").is_some() {
                return Err(bad(
                    "oauth.clientSecret 은 받지 않는다 — PKCE 공개 클라이언트의 clientId 만 넣는다",
                ));
            }
            let client_id = client_id
                .and_then(Value::as_str)
                .map(js_trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            Some(OAuthDef {
                client_id,
                callback_port: port,
            })
        }
    };
    Ok((
        name,
        RemoteDefinition {
            transport: ty.unwrap_or("http").to_string(),
            url,
            headers,
            oauth,
        },
    ))
}

/// `operatorMcpSetStdio` 의 검사를 지난 값.
#[derive(Debug, Clone, PartialEq)]
pub struct StdioDefinition {
    pub command: String,
    pub args: Vec<String>,
    pub env: Map<String, Value>,
    pub keep_env: Vec<String>,
}

/// TS `readOperatorMcpSetStdioPayload`.
pub fn read_set_stdio_payload(
    payload: Option<&Value>,
) -> Result<(String, StdioDefinition), DaemonError> {
    let p = match payload {
        None | Some(Value::Null) => {
            return Err(bad("operatorMcpSetStdio 에는 name·command 가 필요하다"));
        }
        Some(p) => p,
    };
    let name = read_mcp_name(p.get("name"), "operatorMcpSetStdio")?;
    let Some(command) = p.get("command").and_then(Value::as_str) else {
        return Err(bad("command 는 문자열이어야 한다"));
    };
    let args: Vec<String> = match p.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) if a.iter().all(Value::is_string) => a
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        Some(_) => return Err(bad("args 는 문자열 배열이어야 한다")),
    };
    if let Some(problem) = check_mcp_stdio_command(command, &args) {
        return Err(bad(format!("명령·인자를 받을 수 없다: {problem}")));
    }
    let env = match p.get("env") {
        None | Some(Value::Null) => Map::new(),
        Some(e) => match string_record(e) {
            Some(m) => m.clone(),
            None => return Err(bad("env 는 문자열 표여야 한다")),
        },
    };
    let keep_env: Vec<String> = match p.get("keepEnv") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) if a.iter().all(Value::is_string) => a
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        Some(_) => return Err(bad("keepEnv 는 문자열 배열이어야 한다")),
    };
    if env.len() + keep_env.len() > LIMIT_ENVS {
        return Err(bad(format!("env 는 {LIMIT_ENVS}개까지다")));
    }
    for (key, value) in &env {
        if let Some(b) = check_mcp_env_key(key) {
            return Err(bad(format!("env {key} 를 받을 수 없다: {b}")));
        }
        let v = value.as_str().unwrap_or_default();
        if js_len(v) > LIMIT_ENV_VALUE || v.contains('\0') {
            return Err(bad(format!("env {key} 의 값을 받을 수 없다")));
        }
    }
    // 그대로 둘 이름은 사람이 전에 적은 값이라 코드 적재 변수도 막지 않는다 — 있는 이름인지는 파일에서 잰다.
    for key in &keep_env {
        if check_mcp_env_key(key) == Some("env-key") || env.contains_key(key) {
            return Err(bad(format!("keepEnv {key} 를 받을 수 없다")));
        }
    }
    Ok((
        name,
        StdioDefinition {
            command: command.to_string(),
            args,
            env,
            keep_env,
        },
    ))
}

/// TS `readOperatorMcpRemovePayload`.
pub fn read_remove_payload(payload: Option<&Value>) -> Result<String, DaemonError> {
    read_mcp_name(payload.and_then(|p| p.get("name")), "operatorMcpRemove")
}

// ── 표 ────────────────────────────────────────────────────────────────────────────────────────────

/// TS `describeMcpDefinition`.
pub fn describe_mcp_definition(name: &str, source: &str, def: &Map<String, Value>) -> Value {
    let keys = |v: Option<&Value>| -> Vec<String> {
        let mut k: Vec<String> = v
            .and_then(Value::as_object)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        k.sort();
        k
    };
    if let Some(url) = def.get("url").and_then(Value::as_str) {
        let transport = if def.get("type").and_then(Value::as_str) == Some("sse") {
            "sse"
        } else {
            "http"
        };
        let oauth = def.get("oauth").and_then(Value::as_object);
        let mut out = json!({
            "name": name, "source": source, "transport": transport, "target": url, "args": [],
            "envKeys": [], "headerKeys": keys(def.get("headers")), "oauth": oauth.is_some(),
        });
        let o = out.as_object_mut().expect("객체");
        if let Some(id) = oauth
            .and_then(|o| o.get("clientId"))
            .and_then(Value::as_str)
        {
            o.insert("oauthClientId".into(), json!(id));
        }
        if let Some(port) = oauth
            .and_then(|o| o.get("callbackPort"))
            .and_then(js_integer)
        {
            o.insert("oauthCallbackPort".into(), int_value(port));
        }
        return out;
    }
    let args: Vec<&str> = def
        .get("args")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    json!({
        "name": name, "source": source, "transport": "stdio",
        "target": def.get("command").and_then(Value::as_str).unwrap_or(""),
        "args": args, "envKeys": keys(def.get("env")), "headerKeys": [], "oauth": false,
    })
}

/// 이 프로세스가 맡은 뿌리의 MCP 정의.
#[derive(Debug, Clone)]
pub struct LocalMcp {
    registry_path: PathBuf,
    claude_config_path: Option<PathBuf>,
    oauth_store_path: PathBuf,
}

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// TS `claudeConfigPath(env, home)` — `CLAUDE_CONFIG_DIR` 가 비어 있지 않으면 그 아래, 아니면 집 아래.
pub fn claude_config_path(claude_config_dir: Option<&str>, home: &str) -> PathBuf {
    match claude_config_dir.filter(|d| !d.is_empty()) {
        Some(d) => Path::new(d).join(".claude.json"),
        None => Path::new(home).join(".claude.json"),
    }
}

/// 없으면 `None`, 있는데 객체가 아니거나 JSON 이 아니면 오류(덮어쓰지 않는다).
fn read_object(path: &Path, label: &str) -> Result<Option<Map<String, Value>>, DaemonError> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(internal(format!("{label} 을 읽지 못했다: {e}"))),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(m)) => Ok(Some(m)),
        Ok(_) => Err(internal(format!("{label} 는 객체여야 한다"))),
        Err(e) => Err(internal(format!("{label} 을 읽을 수 없다: {e}"))),
    }
}

/// 임시 파일(0600)에 2칸 들여쓰기 JSON + 개행을 쓰고 rename 한다 — env·headers·토큰이 실린다.
fn write_object(path: &Path, table: &Map<String, Value>, label: &str) -> Result<(), DaemonError> {
    let dir = path
        .parent()
        .ok_or_else(|| internal(format!("{label} 의 디렉터리를 모른다")))?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| internal(format!("{label} 의 디렉터리를 만들지 못했다: {e}")))?;
    let mut text = serde_json::to_string_pretty(table)
        .map_err(|e| internal(format!("{label} 을 직렬화하지 못했다: {e}")))?;
    text.push('\n');
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = PathBuf::from(format!(
        "{}.tmp-{}-{ms}-{}",
        path.display(),
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let res = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if let Err(e) = res {
        let _ = fs::remove_file(&tmp);
        return Err(internal(format!("{label} 을 쓰지 못했다: {e}")));
    }
    Ok(())
}

fn str_field<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a str> {
    v.and_then(|v| v.get(key)).and_then(Value::as_str)
}

fn string_args(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

impl LocalMcp {
    /// `root` 는 커뮤니티 뿌리(TS `appDataDir`).
    pub fn new(root: &str, claude_config_path: Option<PathBuf>) -> Self {
        let dir = Path::new(root).join("operator");
        LocalMcp {
            registry_path: dir.join("mcp-servers.json"),
            claude_config_path,
            oauth_store_path: dir.join("secrets").join("mcp-oauth.json"),
        }
    }

    pub fn registry_path(&self) -> &Path {
        &self.registry_path
    }

    fn read_table(&self) -> Result<Map<String, Value>, DaemonError> {
        Ok(read_object(&self.registry_path, "mcp-servers.json")?.unwrap_or_default())
    }

    /// 잠그고 읽어 `f` 로 고친 뒤 쓴다. `f` 가 `Ok(None)` 이면 쓰지 않는다. `Some(forget)` 이면 쓴 뒤 그 이름의 토큰을 버린다.
    fn modify(
        &self,
        name: &str,
        f: impl FnOnce(&mut Map<String, Value>) -> Result<Option<bool>, DaemonError>,
    ) -> Result<(), DaemonError> {
        let dir = self
            .registry_path
            .parent()
            .ok_or_else(|| internal("mcp-servers.json 의 디렉터리를 모른다"))?;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| internal(format!("설정 디렉터리를 만들지 못했다: {e}")))?;
        let lock = self.registry_path.with_extension("json.lock");
        let forget = with_file_lock(&lock, &FileLockOptions::default(), || {
            let mut table = self.read_table()?;
            match f(&mut table)? {
                None => Ok(false),
                Some(forget) => {
                    write_object(&self.registry_path, &table, "mcp-servers.json")?;
                    Ok(forget)
                }
            }
        })
        .map_err(|e| internal(format!("mcp-servers.json 잠금을 잡지 못했다: {e}")))??;
        if forget {
            self.forget_token(name)?;
        }
        Ok(())
    }

    /// TS `mcpOAuth.forget` 의 파일 쪽 — 그 이름의 토큰 칸을 지운다. 없는 파일·없는 칸이면 할 일이 없다.
    /// 깨진 파일은 덮지 않는다(TS `load` 와 같은 규칙 — 다른 인증이 다 사라진다).
    fn forget_token(&self, name: &str) -> Result<(), DaemonError> {
        let lock = self.oauth_store_path.with_extension("json.lock");
        if let Some(dir) = self.oauth_store_path.parent()
            && !dir.exists()
        {
            return Ok(());
        }
        with_file_lock(&lock, &FileLockOptions::default(), || {
            let Some(mut store) = read_object(&self.oauth_store_path, "mcp-oauth.json")? else {
                return Ok(());
            };
            if store.shift_remove(name).is_none() {
                return Ok(());
            }
            write_object(&self.oauth_store_path, &store, "mcp-oauth.json")?;
            eprintln!("MCP OAuth: {name} 의 토큰을 버렸다(정의가 바뀌었다)");
            Ok(())
        })
        .map_err(|e| internal(format!("mcp-oauth.json 잠금을 잡지 못했다: {e}")))?
    }

    /// `operatorMcpList`. claude 정의 먼저, 같은 이름은 오퍼레이터 표가 이긴다. 깨진 claude 설정은 건너뛴다.
    pub fn list(&self) -> Result<Value, DaemonError> {
        let mut out: Map<String, Value> = Map::new();
        if let Some(path) = &self.claude_config_path
            && let Ok(text) = fs::read_to_string(path)
            && let Ok(Value::Object(claude)) = serde_json::from_str::<Value>(&text)
            && let Some(Value::Object(servers)) = claude.get("mcpServers")
        {
            for (name, def) in servers {
                if let Value::Object(d) = def {
                    out.insert(name.clone(), describe_mcp_definition(name, "claude", d));
                }
            }
        }
        for (name, def) in &self.read_table()? {
            if let Value::Object(d) = def {
                out.insert(name.clone(), describe_mcp_definition(name, "operator", d));
            }
        }
        let mut servers: Vec<(String, Value)> = out.into_iter().collect();
        servers.sort_by(|a, b| {
            a.0.to_lowercase()
                .cmp(&b.0.to_lowercase())
                .then_with(|| b.0.cmp(&a.0))
        });
        let servers: Vec<Value> = servers.into_iter().map(|(_, v)| v).collect();
        Ok(json!({ "servers": servers }))
    }

    /// `operatorMcpSet` — http·sse 만.
    pub fn set(&self, name: &str, def: &RemoteDefinition) -> Result<(), DaemonError> {
        self.modify(name, |table| {
            let prev = table.get(name);
            let prev_oauth = prev.and_then(|p| p.get("oauth")).filter(|o| o.is_object());
            let prev_client_id = str_field(prev_oauth, "clientId").map(str::to_string);
            let prev_url = str_field(prev, "url");
            let prev_port = prev_oauth
                .and_then(|o| o.get("callbackPort"))
                .and_then(Value::as_f64);
            let given_client_id = def.oauth.as_ref().and_then(|o| o.client_id.clone());
            // Client ID 칸을 비워 보냈으면 **같은 URL 일 때만** 지금 값을 유지한다(security #1244 n1·#1453 n4).
            let keep = given_client_id.is_none()
                && prev_client_id.is_some()
                && prev_url == Some(def.url.as_str());
            let next_client_id = if keep {
                prev_client_id.clone()
            } else {
                given_client_id
            };
            let o = if keep {
                Some(OAuthDef {
                    client_id: prev_client_id.clone(),
                    callback_port: def.oauth.as_ref().and_then(|o| o.callback_port),
                })
            } else {
                def.oauth.clone()
            };
            let mut entry = Map::new();
            entry.insert("type".into(), json!(def.transport));
            entry.insert("url".into(), json!(def.url));
            if let Some(h) = &def.headers {
                entry.insert("headers".into(), Value::Object(h.clone()));
            }
            if let Some(o) = o {
                let mut m = Map::new();
                if let Some(id) = o.client_id.filter(|s| !s.is_empty()) {
                    m.insert("clientId".into(), json!(id));
                }
                if let Some(p) = o.callback_port.filter(|p| *p != 0) {
                    m.insert("callbackPort".into(), json!(p));
                }
                entry.insert("oauth".into(), Value::Object(m));
            }
            // 클라이언트를 갈아탔거나 콜백 포트를 고쳤으면 옛 토큰을 버린다(security F2). oauth 블록 없이 온 저장은 포트를
            // 고친 것이 아니다.
            let port_changed = def
                .oauth
                .as_ref()
                .is_some_and(|g| prev_port != g.callback_port.map(|p| p as f64));
            let forget = prev.is_some() && (prev_client_id != next_client_id || port_changed);
            table.insert(name.to_string(), Value::Object(entry));
            Ok(Some(forget))
        })
    }

    /// `operatorMcpSetStdio`. `keep_env` 는 **명령·인자가 그대로일 때만** 지금 값을 둔다 — 옛 토큰을 다른 프로그램에 넘기지 않는다.
    pub fn set_stdio(&self, name: &str, def: &StdioDefinition) -> Result<(), DaemonError> {
        self.modify(name, |table| {
            let prev = table.get(name).and_then(Value::as_object);
            let was_remote = prev.is_some_and(|p| p.get("url").is_some_and(Value::is_string));
            let prev_stdio = prev.filter(|_| !was_remote);
            let mut env = Map::new();
            if !def.keep_env.is_empty() {
                let prev_command = prev_stdio
                    .and_then(|p| p.get("command"))
                    .and_then(Value::as_str);
                let prev_args = string_args(prev_stdio.and_then(|p| p.get("args")));
                // TS `sameMcpProgram`.
                if prev_command != Some(def.command.as_str()) || prev_args != def.args {
                    return Err(internal("명령이나 인자가 바뀌면 env 값을 다시 넣어야 한다"));
                }
                let prev_env = prev_stdio
                    .and_then(|p| p.get("env"))
                    .and_then(Value::as_object);
                for key in &def.keep_env {
                    let Some(v) = prev_env.and_then(|e| e.get(key)).filter(|v| v.is_string())
                    else {
                        return Err(internal(format!("지금 정의에 env {key} 가 없다")));
                    };
                    env.insert(key.clone(), v.clone());
                }
            }
            for (k, v) in &def.env {
                env.insert(k.clone(), v.clone());
            }
            // 사람이 파일에 적어 둔, 앱이 모르는 칸(`alwaysLoad` 등)은 지킨다. 원격 정의의 칸은 이어받지 않는다.
            let mut entry = Map::new();
            if let Some(p) = prev_stdio {
                for (k, v) in p {
                    if !matches!(k.as_str(), "command" | "args" | "env" | "type") {
                        entry.insert(k.clone(), v.clone());
                    }
                }
            }
            entry.insert("type".into(), json!("stdio"));
            entry.insert("command".into(), json!(def.command));
            if !def.args.is_empty() {
                entry.insert("args".into(), json!(def.args));
            }
            if !env.is_empty() {
                entry.insert("env".into(), Value::Object(env));
            }
            table.insert(name.to_string(), Value::Object(entry));
            // 원격에서 바꿨으면 그 토큰을 들고 있을 이유가 없다.
            Ok(Some(was_remote))
        })
    }

    /// `operatorMcpRemove`. 없는 이름이면 아무것도 하지 않는다.
    pub fn remove(&self, name: &str) -> Result<(), DaemonError> {
        self.modify(name, |table| {
            if table.shift_remove(name).is_none() {
                return Ok(None);
            }
            Ok(Some(true))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "hk-mcp-{}-{}",
            std::process::id(),
            TMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn read(p: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
    }

    #[test]
    fn stdio_command_rules() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(check_mcp_stdio_command("npx", &a(&["-y", "pkg"])), None);
        assert_eq!(check_mcp_stdio_command("/usr/bin/x", &[]), None);
        assert_eq!(check_mcp_stdio_command("", &[]), Some("command-empty"));
        assert_eq!(check_mcp_stdio_command("./x", &[]), Some("command-shape"));
        assert_eq!(check_mcp_stdio_command("a/b", &[]), Some("command-shape"));
        assert_eq!(
            check_mcp_stdio_command("/a/../b", &[]),
            Some("command-shape")
        );
        assert_eq!(check_mcp_stdio_command(" npx", &[]), Some("command-shape"));
        assert_eq!(
            check_mcp_stdio_command("np\u{202E}x", &[]),
            Some("text-invisible")
        );
        assert_eq!(
            check_mcp_stdio_command("npx", &a(&["a\nb"])),
            Some("text-invisible")
        );
        assert_eq!(
            check_mcp_stdio_command("npx", &a(&["a    b"])),
            Some("text-spacing")
        );
        assert_eq!(check_mcp_stdio_command("npx", &a(&["a   b"])), None);
        assert_eq!(
            check_mcp_stdio_command("npx", &vec!["a".into(); 25]),
            Some("args-too-many")
        );
        assert_eq!(
            check_mcp_stdio_command("npx", &a(&[&"x".repeat(513)])),
            Some("arg-too-long")
        );
        assert_eq!(
            check_mcp_stdio_command("npx", &vec!["x".repeat(500); 3]),
            Some("total-too-long")
        );
        // JS `\s` 는 유니코드 공백도 센다 · BOM 은 서식 글자다(TS 판정과 대조함).
        assert_eq!(
            check_mcp_stdio_command("npx", &a(&["a\u{a0}\u{3000}\u{2002} b"])),
            Some("text-spacing")
        );
        assert_eq!(
            check_mcp_stdio_command("npx\u{FEFF}", &[]),
            Some("text-invisible")
        );
        // JS 길이(UTF-16): 이모지 하나가 2다.
        assert_eq!(
            check_mcp_stdio_command(&format!("/{}", "😀".repeat(256)), &[]),
            Some("command-too-long")
        );
    }

    #[test]
    fn env_key_rules() {
        assert_eq!(check_mcp_env_key("API_TOKEN"), None);
        assert_eq!(check_mcp_env_key("1A"), Some("env-key"));
        assert_eq!(check_mcp_env_key("A-B"), Some("env-key"));
        assert_eq!(check_mcp_env_key(&"A".repeat(129)), Some("env-key"));
        for k in [
            "PATH",
            "path",
            "dyld_insert_libraries",
            "NODE_OPTIONS",
            "HTTPS_PROXY",
            "npm_config_registry",
            "XDG_CONFIG_HOME",
            "ENV",
            "_JAVA_OPTIONS",
        ] {
            assert_eq!(check_mcp_env_key(k), Some("env-code-loading"), "{k}");
        }
        assert_eq!(check_mcp_env_key("ENVX"), None);
        assert_eq!(check_mcp_env_key("PATHS"), None);
    }

    #[test]
    fn set_payload_checks() {
        let ok = read_set_payload(Some(&json!({"name": "gh", "definition": {"type": "http", "url": " https://x/mcp ", "headers": {}, "oauth": {"clientId": "  ", "callbackPort": 8080.0}}}))).unwrap();
        assert_eq!(ok.1.url, "https://x/mcp");
        assert_eq!(ok.1.headers, None);
        assert_eq!(
            ok.1.oauth,
            Some(OAuthDef {
                client_id: None,
                callback_port: Some(8080)
            })
        );
        for (p, msg) in [
            (
                json!({"name": "harkroom", "definition": {}}),
                "늘 넣는 이름",
            ),
            (json!({"name": "A", "definition": {}}), "[a-z0-9-]"),
            (json!({"name": "x", "definition": []}), "객체여야"),
            (
                json!({"name": "x", "definition": {"type": "stdio", "command": "x"}}),
                "http·sse 정의만",
            ),
            (
                json!({"name": "x", "definition": {"type": "http", "url": "ftp://x"}}),
                "http(s) url",
            ),
            (
                json!({"name": "x", "definition": {"type": "http", "url": "https://x", "headers": {"a": 1}}}),
                "headers",
            ),
            (
                json!({"name": "x", "definition": {"type": "http", "url": "https://x", "oauth": {"callbackPort": 0}}}),
                "1~65535",
            ),
            (
                json!({"name": "x", "definition": {"type": "http", "url": "https://x", "oauth": {"clientSecret": "s"}}}),
                "clientSecret",
            ),
            (
                json!({"name": "x", "definition": {"type": "http", "url": "https://x", "oauth": "x"}}),
                "oauth 는 객체",
            ),
        ] {
            let e = read_set_payload(Some(&p)).unwrap_err();
            assert!(e.message.contains(msg), "{p} → {}", e.message);
        }
        assert!(
            read_set_payload(None)
                .unwrap_err()
                .message
                .contains("필요하다")
        );
    }

    #[test]
    fn stdio_payload_checks() {
        let (_, d) = read_set_stdio_payload(Some(&json!({"name": "x", "command": "npx", "args": ["-y"], "env": {"T": "v"}, "keepEnv": ["PATH"]}))).unwrap();
        assert_eq!(d.keep_env, vec!["PATH".to_string()]);
        for (p, msg) in [
            (
                json!({"name": "x", "command": "npx", "env": {"PATH": "/x"}}),
                "env-code-loading",
            ),
            (
                json!({"name": "x", "command": "npx", "env": {"T": "a\u{0}b"}}),
                "값을 받을 수 없다",
            ),
            (
                json!({"name": "x", "command": "npx", "env": {"T": "v"}, "keepEnv": ["T"]}),
                "keepEnv T",
            ),
            (
                json!({"name": "x", "command": "npx", "keepEnv": ["1x"]}),
                "keepEnv 1x",
            ),
            (json!({"name": "x", "command": "./npx"}), "command-shape"),
            (json!({"name": "x", "command": 1}), "command 는 문자열"),
            (
                json!({"name": "x", "command": "npx", "args": [1]}),
                "args 는",
            ),
        ] {
            let e = read_set_stdio_payload(Some(&p)).unwrap_err();
            assert!(e.message.contains(msg), "{p} → {}", e.message);
        }
        let many: Map<String, Value> = (0..33).map(|i| (format!("K{i}"), json!("v"))).collect();
        let e = read_set_stdio_payload(Some(&json!({"name": "x", "command": "npx", "env": many})))
            .unwrap_err();
        assert!(e.message.contains("32개까지"));
    }

    #[test]
    fn list_merges_and_hides_values() {
        let root = tmp_root();
        let claude = root.join(".claude.json");
        fs::write(&claude, json!({"mcpServers": {"b": {"command": "c1", "env": {"Z": "secret", "A": "s"}}, "a": {"type": "sse", "url": "https://s", "headers": {"Auth": "tok"}}}}).to_string()).unwrap();
        let mcp = LocalMcp::new(root.to_str().unwrap(), Some(claude));
        mcp.set("b", &read_set_payload(Some(&json!({"name": "b", "definition": {"type": "http", "url": "https://b", "oauth": {"clientId": "cid", "callbackPort": 3000}}}))).unwrap().1).unwrap();
        let got = mcp.list().unwrap();
        let text = got.to_string();
        assert!(!text.contains("secret") && !text.contains("tok"));
        assert_eq!(
            got,
            json!({"servers": [
                {"name": "a", "source": "claude", "transport": "sse", "target": "https://s", "args": [], "envKeys": [], "headerKeys": ["Auth"], "oauth": false},
                {"name": "b", "source": "operator", "transport": "http", "target": "https://b", "args": [], "envKeys": [], "headerKeys": [], "oauth": true, "oauthClientId": "cid", "oauthCallbackPort": 3000},
            ]})
        );
        let mode = fs::metadata(mcp.registry_path()).unwrap().permissions();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(mode.mode() & 0o777, 0o600);
    }

    #[test]
    fn broken_registry_is_not_overwritten() {
        let root = tmp_root();
        let mcp = LocalMcp::new(root.to_str().unwrap(), None);
        fs::create_dir_all(mcp.registry_path().parent().unwrap()).unwrap();
        fs::write(mcp.registry_path(), "{ 깨짐").unwrap();
        assert!(mcp.list().is_err());
        let def = read_set_payload(Some(
            &json!({"name": "x", "definition": {"type": "http", "url": "https://x"}}),
        ))
        .unwrap()
        .1;
        assert!(mcp.set("x", &def).is_err());
        assert_eq!(fs::read_to_string(mcp.registry_path()).unwrap(), "{ 깨짐");
    }

    #[test]
    fn set_keeps_client_id_only_for_same_url_and_forgets_tokens() {
        let root = tmp_root();
        let mcp = LocalMcp::new(root.to_str().unwrap(), None);
        let store = root.join("operator/secrets/mcp-oauth.json");
        let put_tokens = || {
            fs::create_dir_all(store.parent().unwrap()).unwrap();
            fs::write(
                &store,
                json!({"s": {"accessToken": "t"}, "other": {"accessToken": "u"}}).to_string(),
            )
            .unwrap();
        };
        let set = |v: Value| {
            mcp.set(
                "s",
                &read_set_payload(Some(&json!({"name": "s", "definition": v})))
                    .unwrap()
                    .1,
            )
            .unwrap()
        };
        set(
            json!({"type": "http", "url": "https://a", "oauth": {"clientId": "c1", "callbackPort": 3000}}),
        );
        put_tokens();
        // 같은 url·비운 clientId·같은 포트 → 유지, 토큰 그대로.
        set(json!({"type": "http", "url": "https://a", "oauth": {"callbackPort": 3000}}));
        assert_eq!(
            read(mcp.registry_path())["s"]["oauth"],
            json!({"clientId": "c1", "callbackPort": 3000})
        );
        assert!(read(&store).get("s").is_some());
        // oauth 블록 없이 → 포트를 고친 것이 아니다. clientId 는 없어지므로(keep 은 비운 oauth 에서도 같은 url 이면 산다) 확인.
        set(json!({"type": "http", "url": "https://a"}));
        assert_eq!(
            read(mcp.registry_path())["s"]["oauth"],
            json!({"clientId": "c1"})
        );
        assert!(read(&store).get("s").is_some());
        // url 을 바꾸면 clientId 를 따라가지 않고 토큰을 버린다 — 다른 이름 칸은 남는다.
        set(json!({"type": "http", "url": "https://b", "oauth": {}}));
        assert_eq!(
            read(mcp.registry_path())["s"],
            json!({"type": "http", "url": "https://b", "oauth": {}})
        );
        assert_eq!(read(&store), json!({"other": {"accessToken": "u"}}));
        // 포트만 바꿔도 버린다.
        put_tokens();
        set(json!({"type": "http", "url": "https://b", "oauth": {"callbackPort": 4000}}));
        assert!(read(&store).get("s").is_none());
    }

    #[test]
    fn set_stdio_keep_env_and_extra_fields() {
        let root = tmp_root();
        let mcp = LocalMcp::new(root.to_str().unwrap(), None);
        fs::create_dir_all(mcp.registry_path().parent().unwrap()).unwrap();
        fs::write(mcp.registry_path(), json!({"x": {"command": "npx", "args": ["-y", "p"], "env": {"TOKEN": "old", "B": "b"}, "alwaysLoad": true}, "r": {"type": "http", "url": "https://r", "headers": {"H": "v"}}}).to_string()).unwrap();
        let st = |v: Value| read_set_stdio_payload(Some(&v)).unwrap();
        let (n, d) = st(
            json!({"name": "x", "command": "npx", "args": ["-y", "p"], "env": {"N": "new"}, "keepEnv": ["TOKEN"]}),
        );
        mcp.set_stdio(&n, &d).unwrap();
        assert_eq!(
            read(mcp.registry_path())["x"],
            json!({"alwaysLoad": true, "type": "stdio", "command": "npx", "args": ["-y", "p"], "env": {"TOKEN": "old", "N": "new"}})
        );
        // 인자가 바뀌면 옛 값을 넘기지 않는다 — 파일도 그대로.
        let before = fs::read_to_string(mcp.registry_path()).unwrap();
        let (n, d) = st(
            json!({"name": "x", "command": "npx", "args": ["-y", "evil"], "keepEnv": ["TOKEN"]}),
        );
        assert!(
            mcp.set_stdio(&n, &d)
                .unwrap_err()
                .message
                .contains("다시 넣어야")
        );
        assert_eq!(fs::read_to_string(mcp.registry_path()).unwrap(), before);
        let (n, d) =
            st(json!({"name": "x", "command": "npx", "args": ["-y", "p"], "keepEnv": ["NOPE"]}));
        assert!(
            mcp.set_stdio(&n, &d)
                .unwrap_err()
                .message
                .contains("env NOPE")
        );
        // 원격 → stdio: 원격 칸은 이어받지 않고 keepEnv 는 거절된다.
        let (n, d) = st(json!({"name": "r", "command": "/bin/x", "keepEnv": ["H"]}));
        assert!(mcp.set_stdio(&n, &d).is_err());
        let (n, d) = st(json!({"name": "r", "command": "/bin/x"}));
        mcp.set_stdio(&n, &d).unwrap();
        assert_eq!(
            read(mcp.registry_path())["r"],
            json!({"type": "stdio", "command": "/bin/x"})
        );
        // 키 순서가 지켜진다(x 가 먼저).
        let keys: Vec<String> = read(mcp.registry_path())
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys, vec!["x", "r"]);
    }

    #[test]
    fn remove_and_concurrent_writes() {
        let root = tmp_root();
        let mcp = LocalMcp::new(root.to_str().unwrap(), None);
        mcp.remove("none").unwrap();
        assert!(!mcp.registry_path().exists());
        std::thread::scope(|s| {
            for i in 0..16 {
                let mcp = &mcp;
                s.spawn(move || {
                    let name = format!("n{i}");
                    let def = read_set_payload(Some(
                        &json!({"name": name, "definition": {"type": "http", "url": "https://x"}}),
                    ))
                    .unwrap()
                    .1;
                    mcp.set(&name, &def).unwrap();
                });
            }
        });
        assert_eq!(read(mcp.registry_path()).as_object().unwrap().len(), 16);
        mcp.remove("n3").unwrap();
        assert!(read(mcp.registry_path()).get("n3").is_none());
        assert_eq!(read(mcp.registry_path()).as_object().unwrap().len(), 15);
    }

    #[test]
    fn claude_config_path_rule() {
        assert_eq!(
            claude_config_path(Some("/c"), "/h"),
            PathBuf::from("/c/.claude.json")
        );
        assert_eq!(
            claude_config_path(Some(""), "/h"),
            PathBuf::from("/h/.claude.json")
        );
        assert_eq!(
            claude_config_path(None, "/h"),
            PathBuf::from("/h/.claude.json")
        );
    }
}
