//! 턴 조립에 쓰는 파일·추가 MCP·codex lane 조각(`turn.ts` 의 `readMcpServers`·`readExtraMcpServers`·`codexBearerEnv`·
//! `codexMcpFlags`·`writeSystemPromptFile`·`writePromptFile`, `providerLane.ts` 의 `codexLaneArgs`) — s8 B3d-4.
//!
//! 오류 Display 에는 경로·파일 내용·토큰을 싣지 않는다(security B3d 낮음 「오류 Display 경로」) — 경로는 `local_detail` 로만 꺼낸다.

use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write as _};
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::opencode_home::LANE_REPLY_INSTRUCTIONS;
use crate::turn_env::RUNNER_TURN_KEY_BRIDGE_ENV;

/// 정본 `CODEX_LANE_KEY_ENV`.
pub const CODEX_LANE_KEY_ENV: &str = "HARKROOM_LANE_API_KEY";
/// 정본 `CODEX_LANE_BASE_URL_ENV`.
pub const CODEX_LANE_BASE_URL_ENV: &str = "HARKROOM_LANE_BASE_URL";
/// 정본 `CODEX_LANE_PROVIDER`.
pub const CODEX_LANE_PROVIDER: &str = "harkroom-lane";

/// 정본 `McpServerEntry`. 판정은 정본과 같이 `url` 칸의 유무다(`'url' in entry`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpServerEntry {
    Stdio {
        command: String,
        args: Vec<String>,
        /// `None` = 칸 없음(정본은 `env` 칸이 있을 때만 `-c …env=` 를 붙인다 — 빈 표도 붙인다).
        env: Option<Vec<(String, String)>>,
    },
    Http {
        sse: bool,
        url: String,
        headers: Vec<(String, String)>,
    },
}

/// 읽기·쓰기 거절. Display 에 경로·내용을 싣지 않는다.
#[derive(Debug)]
pub enum TurnFileError {
    /// `HARKROOM_MCP_CONFIG` 를 읽거나 해석할 수 없다.
    McpConfigUnreadable {
        path: PathBuf,
        detail: String,
    },
    /// 항목 모양이 정본 `McpServerEntry` 가 아니다(그 이름만 싣는다).
    McpEntryInvalid {
        name: String,
    },
    /// 상태 디렉터리가 도는 중에 사라졌다(정본 `상태디렉터리사라짐`).
    StateDirGone {
        dir: PathBuf,
    },
    Io {
        path: PathBuf,
        source: io::Error,
    },
}

impl TurnFileError {
    /// 로컬 로그 전용 — 경로·원인 문구. 채팅·서버로 보내지 않는다.
    pub fn local_detail(&self) -> String {
        match self {
            Self::McpConfigUnreadable { path, detail } => format!("{}: {detail}", path.display()),
            Self::McpEntryInvalid { name } => name.clone(),
            Self::StateDirGone { dir } => dir.display().to_string(),
            Self::Io { path, source } => format!("{}: {source}", path.display()),
        }
    }
}

impl fmt::Display for TurnFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::McpConfigUnreadable { .. } => f.write_str(
                "HARKROOM_MCP_CONFIG 를 읽을 수 없다 — 오퍼레이터가 spawn 전에 쓰는 파일이다",
            ),
            Self::McpEntryInvalid { .. } => f.write_str(
                "HARKROOM_MCP_CONFIG 의 MCP 항목 모양이 틀렸다 — command 또는 url 이 문자열이어야 한다",
            ),
            Self::StateDirGone { .. } => f.write_str(
                "상태 디렉터리가 사라졌다. 러너는 뜰 때 이 경로를 한 번 정하고 사는 동안 그대로 쓴다 — 도는 중에 그 디렉터리를 옮기면 없는 경로를 계속 붙잡는다. 앱을 재시작하면 새 경로로 다시 잡는다.",
            ),
            Self::Io { source, .. } => write!(f, "턴 파일을 쓸 수 없다({:?})", source.kind()),
        }
    }
}

impl std::error::Error for TurnFileError {}

fn read_table(path: &Path) -> Result<Map<String, Value>, TurnFileError> {
    let unreadable = |detail: String| TurnFileError::McpConfigUnreadable {
        path: path.to_path_buf(),
        detail,
    };
    let text = fs::read_to_string(path).map_err(|e| unreadable(e.to_string()))?;
    let parsed: Value = serde_json::from_str(&text).map_err(|e| unreadable(e.to_string()))?;
    // 정본: `parsed.mcpServers ?? {}`. 최상위가 객체가 아니면 TS 는 undefined → {} 로 간다.
    match parsed.get("mcpServers") {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(m)) => Ok(m.clone()),
        Some(_) => Err(unreadable("mcpServers 가 객체가 아니다".into())),
    }
}

/// 정본 `readMcpServers` — 표를 **통째로**(harkroom·avcs 포함). opencode 가 제 설정으로 번역한다.
pub fn read_mcp_servers(path: &Path) -> Result<Map<String, Value>, TurnFileError> {
    read_table(path)
}

fn string_map(
    v: Option<&Value>,
    name: &str,
) -> Result<Option<Vec<(String, String)>>, TurnFileError> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(m)) => m
            .iter()
            .map(|(k, v)| match v {
                Value::String(s) => Ok((k.clone(), s.clone())),
                _ => Err(TurnFileError::McpEntryInvalid { name: name.into() }),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Some(_) => Err(TurnFileError::McpEntryInvalid { name: name.into() }),
    }
}

/// 값 하나를 `McpServerEntry` 로. 정본은 타입 단언만 하고 거르지 않지만, Rust 는 argv 에 넣기 전에 문자열임을 확인한다.
pub fn parse_entry(name: &str, v: &Value) -> Result<McpServerEntry, TurnFileError> {
    let bad = || TurnFileError::McpEntryInvalid { name: name.into() };
    let obj = v.as_object().ok_or_else(bad)?;
    if let Some(url) = obj.get("url") {
        let url = url.as_str().ok_or_else(bad)?.to_owned();
        let sse = obj.get("type").and_then(Value::as_str) == Some("sse");
        let headers = string_map(obj.get("headers"), name)?.unwrap_or_default();
        return Ok(McpServerEntry::Http { sse, url, headers });
    }
    let command = obj
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(bad)?
        .to_owned();
    let args = match obj.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| x.as_str().map(str::to_owned).ok_or_else(bad))
            .collect::<Result<_, _>>()?,
        Some(_) => return Err(bad()),
    };
    let env = string_map(obj.get("env"), name)?;
    Ok(McpServerEntry::Stdio { command, args, env })
}

/// 정본 `readExtraMcpServers` — harkroom·avcs(프리셋이 굽는다)를 뺀 추가 항목. 파일 순서를 지킨다.
pub fn read_extra_mcp_servers(path: &Path) -> Result<Vec<(String, McpServerEntry)>, TurnFileError> {
    let table = read_table(path)?;
    table
        .iter()
        .filter(|(name, _)| name.as_str() != "harkroom" && name.as_str() != "avcs")
        .map(|(name, v)| Ok((name.clone(), parse_entry(name, v)?)))
        .collect()
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).expect("문자열 직렬화는 실패하지 않는다")
}

/// 정본 `tomlInlineTable` — `{ "K" = "v" }`(JSON 의 `{"K":"v"}` 는 TOML 인라인 표가 아니다).
fn toml_inline_table(record: &[(String, String)]) -> String {
    let body: Vec<String> = record
        .iter()
        .map(|(k, v)| format!("{} = {}", json_str(k), json_str(v)))
        .collect();
    format!("{{ {} }}", body.join(", "))
}

/// JS 정규식 `\s`(u 플래그 없음).
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

/// JS 정규식 `.` 이 못 넘는 줄 끝.
fn js_line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// 정본 `/^Bearer\s+(.+)$/i.exec(v)?.[1]` — `\s+` 는 욕심껏, `(.+)` 는 줄 끝 없이 하나 이상.
fn bearer_of(v: &str) -> Option<&str> {
    let head = v.get(..6)?;
    if !head.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let tail = &v[6..];
    // 가장 긴 공백 앞부분(하나 이상) 뒤에 줄 끝 없는 나머지(하나 이상)가 오는 자리를 뒤에서부터 찾는다.
    let bounds: Vec<usize> = tail.char_indices().map(|(i, _)| i).skip(1).collect();
    for &i in bounds.iter().rev() {
        let (w, r) = tail.split_at(i);
        if w.chars().all(js_space) && !r.chars().any(js_line_end) {
            return Some(r);
        }
    }
    None
}

/// 정본 `splitBearer` — `Authorization: Bearer <t>` 를 떼어 낸다(헤더 이름 대소문자 무시). 같은 이름이 여럿이면 뒤의 것이 이긴다.
fn split_bearer(headers: &[(String, String)]) -> (Option<String>, Vec<(String, String)>) {
    let mut bearer = None;
    let mut rest = Vec::new();
    for (k, v) in headers {
        let m = if k.to_lowercase() == "authorization" {
            bearer_of(v)
        } else {
            None
        };
        match m {
            Some(t) => bearer = Some(t.to_owned()),
            None => rest.push((k.clone(), v.clone())),
        }
    }
    (bearer, rest)
}

/// 정본 `codexBearerEnvName`. MCP 이름 문법은 `[a-z0-9-]` 다.
pub fn codex_bearer_env_name(name: &str) -> String {
    let up: String = name
        .to_uppercase()
        .chars()
        .map(|c| {
            if c.is_ascii_uppercase() || c.is_ascii_digit() {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("HARKROOM_MCP_BEARER_{up}")
}

/// 정본 `codexBearerEnv` — codex 자식 env 에 얹을 bearer 토큰(argv 에는 이름만).
pub fn codex_bearer_env(servers: &[(String, McpServerEntry)]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (name, entry) in servers {
        if let McpServerEntry::Http { headers, .. } = entry
            && let (Some(b), _) = split_bearer(headers)
        {
            out.push((codex_bearer_env_name(name), b));
        }
    }
    out
}

/// 정본 `codexMcpFlags` — `-c mcp_servers.<name>.*`. transport 를 늘 적는다. Bearer 토큰은 argv 에 굽지 않는다.
pub fn codex_mcp_flags(name: &str, entry: &McpServerEntry) -> Vec<String> {
    let key = format!("mcp_servers.{name}");
    let mut out = Vec::new();
    let mut c = |v: String| {
        out.push("-c".to_owned());
        out.push(v);
    };
    match entry {
        McpServerEntry::Http { sse, url, headers } => {
            let (bearer, rest) = split_bearer(headers);
            c(format!(
                "{key}.transport={}",
                json_str(if *sse { "sse" } else { "streamable_http" })
            ));
            c(format!("{key}.url={}", json_str(url)));
            if !rest.is_empty() {
                c(format!("{key}.http_headers={}", toml_inline_table(&rest)));
            }
            if bearer.is_some() {
                c(format!(
                    "{key}.bearer_token_env_var={}",
                    json_str(&codex_bearer_env_name(name))
                ));
            }
        }
        McpServerEntry::Stdio { command, args, env } => {
            c(format!("{key}.transport=\"stdio\""));
            c(format!("{key}.command={}", json_str(command)));
            c(format!(
                "{key}.args={}",
                serde_json::to_string(args).expect("문자열 배열 직렬화는 실패하지 않는다")
            ));
            if let Some(env) = env {
                c(format!("{key}.env={}", toml_inline_table(env)));
            }
        }
    }
    out
}

/// 정본 `codexLaneArgs` — codex API 키 연결 턴의 `-c` 덮어쓰기(키는 env 이름만, 셸 env 걷기, 업데이트 확인 끔).
pub fn codex_lane_args(base_url: &str) -> Vec<String> {
    let p = format!("model_providers.{CODEX_LANE_PROVIDER}");
    let exclude = serde_json::to_string(&[
        CODEX_LANE_KEY_ENV,
        CODEX_LANE_BASE_URL_ENV,
        RUNNER_TURN_KEY_BRIDGE_ENV,
    ])
    .expect("문자열 배열 직렬화는 실패하지 않는다");
    let flags = [
        format!("model_provider={}", json_str(CODEX_LANE_PROVIDER)),
        format!("{p}.name={}", json_str(CODEX_LANE_PROVIDER)),
        format!("{p}.base_url={}", json_str(&format!("{base_url}/v1"))),
        format!("{p}.env_key={}", json_str(CODEX_LANE_KEY_ENV)),
        format!("{p}.wire_api=\"responses\""),
        "check_for_update_on_startup=false".to_owned(),
        format!(
            "developer_instructions={}",
            json_str(LANE_REPLY_INSTRUCTIONS)
        ),
        "features.shell_snapshot=false".to_owned(),
        "allow_login_shell=false".to_owned(),
        "features.unified_exec_tty=false".to_owned(),
        "shell_environment_policy.ignore_default_excludes=false".to_owned(),
        format!("shell_environment_policy.exclude={exclude}"),
    ];
    flags
        .into_iter()
        .flat_map(|f| ["-c".to_owned(), f])
        .collect()
}

/// 0600 으로 만들고(없을 때) 이미 있으면 chmod 로 다시 0600 — 정본과 같이 둘 다 한다.
fn write_private(path: &Path, body: &str) -> io::Result<()> {
    let mut f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(body.as_bytes())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

/// 정본 `writeSystemPromptFile` — 매 턴 최신 지시문을 `system-prompt.txt` 에(0600). 디렉터리가 사라졌으면 다시 만들지 않고 말한다.
pub fn write_system_prompt_file(dir: &Path, system_prompt: &str) -> Result<PathBuf, TurnFileError> {
    let path = dir.join("system-prompt.txt");
    match write_private(&path, system_prompt) {
        Ok(()) => Ok(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Err(TurnFileError::StateDirGone {
            dir: dir.to_path_buf(),
        }),
        Err(source) => Err(TurnFileError::Io { path, source }),
    }
}

/// 정본 `writePromptFile` — stdin 리다이렉션용 `stdin-prompt.txt`(0600, #92).
pub fn write_prompt_file(dir: &Path, prompt: &str) -> Result<PathBuf, TurnFileError> {
    let path = dir.join("stdin-prompt.txt");
    write_private(&path, prompt).map_err(|source| TurnFileError::Io {
        path: path.clone(),
        source,
    })?;
    Ok(path)
}

#[cfg(test)]
#[path = "turn_files_tests.rs"]
mod tests;
