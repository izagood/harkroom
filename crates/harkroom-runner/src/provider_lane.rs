//! 전용 제공사 경로(provider lane) — 러너 쪽. 정본 `packages/agent/src/providerLane.ts` 의 이식(흐름은 shared `providerLane.ts` 머리 주석).
//!
//! - 계정 축은 에이전트 전용 config 디렉터리 하나다. 계정 풀·`~/.claude` 로그인을 쓰지 않는다(security ⓒ).
//! - 턴마다 PTY 직전에 [`ProviderLane::env_for`] 가 오퍼레이터에서 base URL 과 값 파일 경로를 받아 그 턴 하네스 env 에 넣을
//!   키를 돌려준다. 못 받으면 실패한다 — 계정 로그인으로 떨어지지 않는다(fail-closed).
//! - 값은 이 프로세스 env 에 두지 않는다. 키 값은 claude·codex 의 그 턴 env 맵에만 실리고, 그 밖의 하네스는 키 **파일 경로**만 받는다.
//!
//! 이미 이식된 표는 다시 정의하지 않고 쓴다: env 이름 표(`turn_env`), `codexLaneArgs`(`turn_files::codex_lane_args`),
//! opencode provider 이름·모델 문법·MCP 번역(`opencode_home`).
//!
//! 정본과 다른 점:
//! - `mount` 는 던지는 대신 `HttpReply` 를 돌려준다 — `status == 0`(링크 끊김, `rest::mount_provider_lane` 규약)이 정본의 던짐이다.
//! - 파일 쓰기는 `turn_files::write_private`(0600 `create_new`·`O_NOFOLLOW` 임시 파일 → rename)다. 그 자리의 링크는 따라가지 않고 링크째 바뀐다.
//! - 오류 `Display` 에는 경로·이름을 싣지 않는다 — 경로는 `local_detail` 로만 꺼낸다.
//!
//! 아직 연결되지 않았다 — 오퍼레이터는 계속 node 러너를 띄운다.

pub mod shared;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::fs;
use std::io;
use std::os::unix::fs::DirBuilderExt as _;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::adapter::AgentHarness;
use crate::opencode_home::{
    PROVIDER_LANE_OPENCODE_PROVIDER, provider_lane_model_id, to_opencode_mcp,
};
use crate::rest::HttpReply;
use crate::turn_env::{RUNNER_LINK_SECRET_ENV, RUNNER_TURN_KEY_BRIDGE_ENV};
use crate::turn_files::write_private;
use shared::{
    CODEX_LANE_MEASURED_VERSIONS, KILO_LANE_MEASURED_VERSIONS, OMP_LANE_MEASURED_VERSIONS,
    OPENCODE_LANE_MEASURED_VERSIONS, PI_LANE_MEASURED_VERSIONS, js_trim,
    normalize_provider_base_url, provider_lane_failure_code,
};

pub use crate::opencode_home::LANE_REPLY_INSTRUCTIONS as CODEX_LANE_DEVELOPER_INSTRUCTIONS;
pub use crate::turn_env::{
    lane_test_home_env, provider_lane_argv_only_keys, provider_lane_fixed_env, provider_lane_keys,
};
pub use crate::turn_files::{
    CODEX_LANE_BASE_URL_ENV, CODEX_LANE_KEY_ENV, CODEX_LANE_PROVIDER, codex_lane_args,
};

/// omp lane 의 주소·키 파일 경로를 조립까지 실어 나르는 이름(자식 env 에는 넣지 않는다).
pub const OMP_LANE_BASE_URL_ENV: &str = "HARKROOM_OMP_LANE_BASE_URL";
pub const OMP_LANE_KEY_FILE_ENV: &str = "HARKROOM_OMP_LANE_KEY_FILE";
/// pi lane 의 주소·키 파일 경로를 조립까지 실어 나르는 이름(자식 env 에는 넣지 않는다).
pub const PI_LANE_BASE_URL_ENV: &str = "HARKROOM_PI_LANE_BASE_URL";
pub const PI_LANE_KEY_FILE_ENV: &str = "HARKROOM_PI_LANE_KEY_FILE";

/// lane 턴 파일 자리(러너 상태 폴더, 작업 폴더 밖, 0700).
pub const LANE_TURN_DIR: &str = "lane-turn";
/// 하위 프로세스 env 걷기가 브릿지에서 빼는 이름 — lane MCP 설정 `env` 칸으로 따로 준다. lane 키는 싣지 않는다(security X2).
pub const LANE_BRIDGE_ENV_KEYS: [&str; 1] = [RUNNER_LINK_SECRET_ENV];
/// lane 턴 전용 MCP 설정 파일 이름(러너 상태 폴더, 0600 — security X1).
pub const LANE_MCP_CONFIG_FILE: &str = "lane-mcp.json";
/// 턴 MCP 설정 자리(러너 상태 폴더, 0700). 파일은 턴마다 하나(0600).
pub const TURN_MCP_DIR: &str = "turn-mcp";

/// 정본 `PROVIDER_LANE_NEEDS_MODEL` 를 보는 `laneModelMissing` — 모델이 비었거나 문법에 안 맞는가.
pub fn lane_model_missing(lane: bool, harness: AgentHarness, model: Option<&str>) -> bool {
    lane && matches!(harness, AgentHarness::Codex | AgentHarness::Pi)
        && provider_lane_model_id(model).is_none()
}

/// 정본 `LANE_TURN_FILE_ENV` — 키 대신 턴 파일 경로를 받는 env 이름.
pub fn lane_turn_file_env_name(harness: AgentHarness) -> Option<&'static str> {
    match harness {
        AgentHarness::Opencode => Some("OPENCODE_CONFIG"),
        AgentHarness::Kilo => Some("KILO_CONFIG"),
        _ => None,
    }
}

/// 정본 `laneTurnFileEnv` — 이름이 허용 목록에도 있을 때만.
fn lane_turn_file_env(harness: AgentHarness) -> Option<&'static str> {
    let name = lane_turn_file_env_name(harness)?;
    provider_lane_keys(harness)
        .is_some_and(|keys| keys.contains(&name))
        .then_some(name)
}

/// 정본 `providerLaneKeys` 와 같다(`turn_env::provider_lane_keys`).
fn keys_include(harness: AgentHarness, name: &str) -> bool {
    provider_lane_keys(harness).is_some_and(|k| k.contains(&name))
}

fn measured_has(list: &[&str], v: &str) -> bool {
    list.contains(&v)
}

/// opencode — 출력은 숫자 판 한 줄. 잰 판과 정확히 같을 때만 참.
pub fn opencode_lane_version_ok(raw: Option<&str>) -> bool {
    measured_has(OPENCODE_LANE_MEASURED_VERSIONS, js_trim(raw.unwrap_or("")))
}

/// codex — 출력은 `codex-cli <판>` 한 줄.
pub fn codex_lane_version_ok(raw: Option<&str>) -> bool {
    js_trim(raw.unwrap_or(""))
        .strip_prefix("codex-cli ")
        .is_some_and(|v| measured_has(CODEX_LANE_MEASURED_VERSIONS, v))
}

/// omp — 출력은 `omp/<판>` 한 줄.
pub fn omp_lane_version_ok(raw: Option<&str>) -> bool {
    js_trim(raw.unwrap_or(""))
        .strip_prefix("omp/")
        .is_some_and(|v| measured_has(OMP_LANE_MEASURED_VERSIONS, v))
}

/// kilo — 출력은 숫자 판 한 줄.
pub fn kilo_lane_version_ok(raw: Option<&str>) -> bool {
    measured_has(KILO_LANE_MEASURED_VERSIONS, js_trim(raw.unwrap_or("")))
}

/// pi — 출력은 숫자 판 한 줄.
pub fn pi_lane_version_ok(raw: Option<&str>) -> bool {
    measured_has(PI_LANE_MEASURED_VERSIONS, js_trim(raw.unwrap_or("")))
}

type VersionOk = fn(Option<&str>) -> bool;

/// 정본 `PROVIDER_LANE_MEASURED` — 판을 묻는 하네스만.
fn provider_lane_measured(harness: AgentHarness) -> Option<(VersionOk, &'static [&'static str])> {
    use AgentHarness::*;
    match harness {
        Opencode => Some((opencode_lane_version_ok, OPENCODE_LANE_MEASURED_VERSIONS)),
        Kilo => Some((kilo_lane_version_ok, KILO_LANE_MEASURED_VERSIONS)),
        Codex => Some((codex_lane_version_ok, CODEX_LANE_MEASURED_VERSIONS)),
        Omp => Some((omp_lane_version_ok, OMP_LANE_MEASURED_VERSIONS)),
        Pi => Some((pi_lane_version_ok, PI_LANE_MEASURED_VERSIONS)),
        ClaudeCode | Gemini => None,
    }
}

/// 잰 판 밖(또는 판을 못 읽음)일 때 스레드에 남기는 한 줄(security G1). 판 출력은 첫 줄 64자(UTF-16 단위)까지, 보이는 ASCII 만.
pub fn lane_unmeasured_notice(
    harness: AgentHarness,
    raw: Option<&str>,
    measured: &[&str],
) -> String {
    let first = js_trim(raw.unwrap_or("")).split('\n').next().unwrap_or("");
    let mut units = 0usize;
    let seen: String = first
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 64
        })
        .filter(|c| (' '..='~').contains(c))
        .collect();
    let seen = if seen.is_empty() {
        "판을 읽지 못함"
    } else {
        &seen
    };
    format!(
        "⚠ {} {seen} — 이 판에서 API 키 연결 격리를 확인하지 않았다(확인한 판: {}). 턴은 그대로 진행한다.",
        harness.as_str(),
        measured.join(" · ")
    )
}

/// 정본 `laneScrubsSubprocessEnv` — 이 하네스가 lane 턴에서 하위 프로세스 env 를 걷는가.
pub fn lane_scrubs_subprocess_env(harness: AgentHarness) -> bool {
    provider_lane_fixed_env(harness).contains(&("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "1"))
}

/// 그 턴의 주소·키를 못 받았다. 코드는 허용 목록으로 접어서 든다(1c, security ③) — 문장에도 코드만 싣는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderLaneError {
    code: &'static str,
}

impl ProviderLaneError {
    pub fn new(code: &str) -> Self {
        Self {
            code: provider_lane_failure_code(code),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Display for ProviderLaneError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "API 키 연결을 준비하지 못했다({}) — 데스크톱의 에이전트 설정에서 API 주소·키를 확인하라",
            self.code
        )
    }
}

impl std::error::Error for ProviderLaneError {}

/// 이 모듈의 실패. `Display` 에는 경로·이름·값을 싣지 않는다.
#[derive(Debug)]
pub enum LaneFileError {
    /// 접힌 코드 실패(정본 `ProviderLaneError`).
    Lane(ProviderLaneError),
    /// 턴 파일 이름·턴 id 가 `[A-Za-z0-9-]{1,64}` 가 아니다.
    BadName {
        what: &'static str,
    },
    /// MCP 설정·lane 턴 파일을 읽거나 해석하지 못했다.
    Unreadable {
        path: PathBuf,
        detail: String,
    },
    /// MCP 설정에 harkroom 항목이 없다.
    NoHarkroom {
        what: &'static str,
    },
    /// harkroom 항목이 stdio 가 아니다(opencode 턴 설정).
    NotStdio,
    /// 러너 env 에 브릿지 값이 없다(이름만 싣는다).
    MissingRunnerEnv {
        key: &'static str,
    },
    Io {
        path: PathBuf,
        source: io::Error,
    },
}

impl LaneFileError {
    /// 로컬 로그 전용 — 경로·원인 문구. 채팅·서버로 보내지 않는다.
    pub fn local_detail(&self) -> String {
        match self {
            Self::Unreadable { path, detail } => format!("{}: {detail}", path.display()),
            Self::Io { path, source } => format!("{}: {source}", path.display()),
            other => other.to_string(),
        }
    }

    /// 접힌 lane 코드(있으면).
    pub fn lane_code(&self) -> Option<&'static str> {
        match self {
            Self::Lane(e) => Some(e.code()),
            _ => None,
        }
    }
}

impl From<ProviderLaneError> for LaneFileError {
    fn from(e: ProviderLaneError) -> Self {
        Self::Lane(e)
    }
}

impl fmt::Display for LaneFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Lane(e) => e.fmt(f),
            Self::BadName { what } => write!(f, "{what}: 이름이 이상하다"),
            Self::Unreadable { .. } => f.write_str("lane 설정 파일을 읽거나 해석할 수 없다"),
            Self::NoHarkroom { what } => write!(f, "{what}: MCP 설정에 harkroom 이 없다"),
            Self::NotStdio => {
                f.write_str("writeOpencodeTurnMcpConfig: harkroom 항목이 stdio 가 아니다")
            }
            Self::MissingRunnerEnv { key } => {
                write!(f, "writeLaneMcpConfig: {key} 가 러너 env 에 없다")
            }
            Self::Io { source, .. } => write!(f, "lane 파일 입출력 실패: {}", source.kind()),
        }
    }
}

impl std::error::Error for LaneFileError {}

fn io_err(path: &Path) -> impl FnOnce(io::Error) -> LaneFileError + '_ {
    move |source| LaneFileError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// 정본 `/^[A-Za-z0-9-]{1,64}$/`.
fn name_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn has_brace_or_newline(s: &str) -> bool {
    s.contains(['{', '}', '\r', '\n', '\0'])
}

/// `mkdir(dir, { recursive: true, mode: 0o700 })` — 새로 만드는 폴더만 0700(이미 있으면 그대로).
fn mkdir_private(dir: &Path) -> Result<(), LaneFileError> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(io_err(dir))
}

fn write_atomic(path: &Path, body: &str) -> Result<(), LaneFileError> {
    write_private(path, body).map_err(io_err(path))
}

fn read_json(path: &Path) -> Result<Value, LaneFileError> {
    let text = fs::read_to_string(path).map_err(|e| LaneFileError::Unreadable {
        path: path.to_path_buf(),
        detail: e.to_string(),
    })?;
    serde_json::from_str(&text).map_err(|e| LaneFileError::Unreadable {
        path: path.to_path_buf(),
        detail: e.to_string(),
    })
}

fn to_json(v: &Value) -> String {
    serde_json::to_string(v).expect("JSON 값 직렬화는 실패하지 않는다")
}

/// opencode lane 턴 파일에 들어가는 두 값 — 주소와 **키 파일 경로**뿐이다.
#[derive(Debug, Clone, Copy)]
pub struct OpencodeLaneTarget<'a> {
    pub base_url: &'a str,
    pub key_path: &'a str,
}

/// 정본 `writeOpencodeLaneTurnConfig` — opencode·kilo lane 턴 파일(`OPENCODE_CONFIG`·`KILO_CONFIG`)을 쓴다.
/// 키 값도, 권한·에이전트·MCP 칸도 이 파일에 들 수 없다(Z2). opencode 가 본문의 `{env:…}`·`{file:…}` 를 바꿔 넣으므로
/// 중괄호·줄바꿈이 섞인 값은 거절한다.
pub fn write_opencode_lane_turn_config(
    dir: &Path,
    name: &str,
    lane: OpencodeLaneTarget<'_>,
) -> Result<PathBuf, LaneFileError> {
    if has_brace_or_newline(lane.base_url) {
        return Err(ProviderLaneError::new("bad_base_url").into());
    }
    if !lane.key_path.starts_with('/') || has_brace_or_newline(lane.key_path) {
        return Err(ProviderLaneError::new("bad_path").into());
    }
    if !name_ok(name) {
        return Err(LaneFileError::BadName {
            what: "writeOpencodeLaneTurnConfig",
        });
    }
    let mut provider = Map::new();
    provider.insert(
        PROVIDER_LANE_OPENCODE_PROVIDER.into(),
        serde_json::json!({
            // @ai-sdk/anthropic 의 baseURL 은 `/v1` 까지다 — claude-code(`ANTHROPIC_BASE_URL`)와 같은 뿌리.
            "options": {
                "baseURL": format!("{}/v1", lane.base_url),
                "apiKey": format!("{{file:{}}}", lane.key_path),
            }
        }),
    );
    let mut doc = Map::new();
    doc.insert("provider".into(), Value::Object(provider));
    mkdir_private(dir)?;
    let path = dir.join(format!("{name}.json"));
    write_atomic(&path, &to_json(&Value::Object(doc)))?;
    Ok(path)
}

/// 폴더 안 항목을 지운다(폴더는 두고, 하위 폴더는 못 지우면 그대로). 실패는 삼킨다 — 다음 기동이 다시 걷는다.
fn sweep_dir(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let _ = fs::remove_file(e.path());
    }
}

/// 정본 `sweepLaneTurnDir` — 기동 때 지난 러너가 남긴 턴 파일을 걷는다(키 값은 없고 키 파일 경로만 있다).
pub fn sweep_lane_turn_dir(state_dir: &Path) {
    sweep_dir(&state_dir.join(LANE_TURN_DIR));
}

/// 정본 `sweepTurnMcpDir` — 기동 때 지난 러너가 남긴 턴 MCP 설정을 걷는다.
pub fn sweep_turn_mcp_dir(state_dir: &Path) {
    sweep_dir(&state_dir.join(TURN_MCP_DIR));
}

/// `doc.mcpServers.harkroom` 이 객체면 그 사본.
fn harkroom_entry(doc: &Value) -> Option<Map<String, Value>> {
    doc.get("mcpServers")?.get("harkroom")?.as_object().cloned()
}

/// `{ ...(obj.<key> ?? {}) }` — 객체가 아니면 빈 표.
fn object_or_empty(v: Option<&Value>) -> Map<String, Value> {
    match v {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    }
}

/// 정본 `writeLaneMcpConfig` — 오퍼레이터 MCP 설정을 바탕으로 lane 턴 전용 설정을 쓴다: harkroom 항목 `env` 칸에
/// `LANE_BRIDGE_ENV_KEYS` 값을 싣고 `alwaysLoad` 를 단다. `env` 는 러너 env(정본 기본값 `process.env`)다.
/// 같은 내용이면 다시 쓰지 않는다(n2).
pub fn write_lane_mcp_config(
    state_dir: &Path,
    source_path: &Path,
    env: &BTreeMap<String, String>,
) -> Result<PathBuf, LaneFileError> {
    let doc = read_json(source_path)?;
    let mut harkroom = harkroom_entry(&doc).ok_or(LaneFileError::NoHarkroom {
        what: "writeLaneMcpConfig",
    })?;
    let mut bridge_env = object_or_empty(harkroom.get("env"));
    for key in LANE_BRIDGE_ENV_KEYS {
        let value = env
            .get(key)
            .filter(|v| !v.is_empty())
            .ok_or(LaneFileError::MissingRunnerEnv { key })?;
        bridge_env.insert(key.into(), Value::String(value.clone()));
    }
    harkroom.insert("alwaysLoad".into(), Value::Bool(true));
    harkroom.insert("env".into(), Value::Object(bridge_env));
    let out = with_harkroom_in_place(doc, harkroom);
    let path = state_dir.join(LANE_MCP_CONFIG_FILE);
    let body = to_json(&out);
    if fs::read_to_string(&path).ok().as_deref() == Some(body.as_str()) {
        return Ok(path);
    }
    write_atomic(&path, &body)?;
    Ok(path)
}

/// `{ ...doc, mcpServers: { ...doc.mcpServers, harkroom } }` — 있는 열쇠는 자리를 지킨다(`preserve_order` 의 insert).
fn with_harkroom_in_place(doc: Value, harkroom: Map<String, Value>) -> Value {
    let mut doc = match doc {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    let mut servers = object_or_empty(doc.get("mcpServers"));
    servers.insert("harkroom".into(), Value::Object(harkroom));
    doc.insert("mcpServers".into(), Value::Object(servers));
    Value::Object(doc)
}

/// 정본 `writeTurnMcpConfig` — 그 턴만의 MCP 설정: harkroom 항목 `env` 칸에 다리 열쇠를 싣는다.
pub fn write_turn_mcp_config(
    state_dir: &Path,
    source_path: &Path,
    turn_id: &str,
    bridge_key: &str,
    always_load: bool,
) -> Result<PathBuf, LaneFileError> {
    if !name_ok(turn_id) {
        return Err(LaneFileError::BadName {
            what: "writeTurnMcpConfig",
        });
    }
    let doc = read_json(source_path)?;
    let mut harkroom = harkroom_entry(&doc).ok_or(LaneFileError::NoHarkroom {
        what: "writeTurnMcpConfig",
    })?;
    if always_load {
        harkroom.insert("alwaysLoad".into(), Value::Bool(true));
    }
    let mut bridge_env = object_or_empty(harkroom.get("env"));
    bridge_env.insert(
        RUNNER_TURN_KEY_BRIDGE_ENV.into(),
        Value::String(bridge_key.into()),
    );
    harkroom.insert("env".into(), Value::Object(bridge_env));
    let out = with_harkroom_in_place(doc, harkroom);
    let dir = state_dir.join(TURN_MCP_DIR);
    mkdir_private(&dir)?;
    let path = dir.join(format!("{turn_id}.json"));
    write_atomic(&path, &to_json(&out))?;
    Ok(path)
}

/// 정본 `writeOpencodeTurnMcpConfig` — opencode 턴의 다리 열쇠 자리. harkroom 항목을 통째로 턴 설정 파일의 `mcp` 칸에 쓰고
/// `environment` 에 다리 열쇠를 싣는다. lane 턴은 이미 쓴 lane 턴 파일에 더해 쓰고, 그 밖은 턴 MCP 자리에 새 파일을 쓴다.
pub fn write_opencode_turn_mcp_config(
    state_dir: &Path,
    source_path: &Path,
    turn_id: &str,
    bridge_key: &str,
    lane_turn_file: Option<&Path>,
) -> Result<PathBuf, LaneFileError> {
    if !name_ok(turn_id) {
        return Err(LaneFileError::BadName {
            what: "writeOpencodeTurnMcpConfig",
        });
    }
    let doc = read_json(source_path)?;
    let source = doc
        .get("mcpServers")
        .and_then(|s| s.get("harkroom"))
        .filter(|v| js_truthy(v))
        .ok_or(LaneFileError::NoHarkroom {
            what: "writeOpencodeTurnMcpConfig",
        })?;
    let mut one = Map::new();
    one.insert("harkroom".into(), source.clone());
    let mut entry = match to_opencode_mcp(&one).remove("harkroom") {
        Some(Value::Object(e)) if e.get("type").and_then(Value::as_str) == Some("local") => e,
        _ => return Err(LaneFileError::NotStdio),
    };
    let mut environment = object_or_empty(entry.get("environment"));
    environment.insert(
        RUNNER_TURN_KEY_BRIDGE_ENV.into(),
        Value::String(bridge_key.into()),
    );
    entry.insert("environment".into(), Value::Object(environment));
    if let Some(lane_path) = lane_turn_file {
        let mut lane = match read_json(lane_path)? {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        let mut mcp = object_or_empty(lane.get("mcp"));
        mcp.insert("harkroom".into(), Value::Object(entry));
        lane.insert("mcp".into(), Value::Object(mcp));
        write_atomic(lane_path, &to_json(&Value::Object(lane)))?;
        return Ok(lane_path.to_path_buf());
    }
    let dir = state_dir.join(TURN_MCP_DIR);
    mkdir_private(&dir)?;
    let path = dir.join(format!("{turn_id}.opencode.json"));
    let mut mcp = Map::new();
    mcp.insert("harkroom".into(), Value::Object(entry));
    let mut out = Map::new();
    out.insert("mcp".into(), Value::Object(mcp));
    write_atomic(&path, &to_json(&Value::Object(out)))?;
    Ok(path)
}

/// JS 참값 판정.
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// 마운트 호출 — 원인 메시지 id 를 받아 오퍼레이터 답을 돌려준다. `status == 0` 은 링크 끊김(정본의 던짐).
pub type MountFn = Box<dyn Fn(&str) -> HttpReply + Send + Sync>;
/// 결과 통지(정본 `report`) — 성공은 `(true, None)`, 실패는 접힌 코드.
pub type ReportFn = Box<dyn Fn(bool, Option<&'static str>) + Send + Sync>;
/// 하네스 판(`<하네스> --version` 출력). 못 읽으면 None.
pub type HarnessVersionFn = Box<dyn Fn(AgentHarness) -> Option<String> + Send + Sync>;

/// 정본 `ProviderLaneDeps`.
pub struct ProviderLaneDeps {
    pub mount: MountFn,
    /// 오퍼레이터의 턴 비밀 루트(`HARKROOM_TURN_SECRETS_DIR`). 값 파일은 이 아래에만 있어야 한다.
    pub turn_secrets_dir: Option<PathBuf>,
    pub report: Option<ReportFn>,
    /// 러너 상태 폴더. 턴 파일은 그 아래 `LANE_TURN_DIR` 에 둔다.
    pub state_dir: Option<PathBuf>,
    pub harness_version: Option<HarnessVersionFn>,
    /// codex lane 전용 `CODEX_HOME`. 여기에 `auth.json` 이 있으면 띄우지 않는다(`harness_login_present`).
    pub codex_home: Option<PathBuf>,
}

impl ProviderLaneDeps {
    pub fn new(mount: MountFn) -> Self {
        Self {
            mount,
            turn_secrets_dir: None,
            report: None,
            state_dir: None,
            harness_version: None,
            codex_home: None,
        }
    }
}

/// 정본 `createProviderLane` 의 반환값.
pub struct ProviderLane {
    deps: ProviderLaneDeps,
    /// 잰 판 밖 경고를 이미 스레드에 실은 (하네스, 판).
    noticed: Mutex<HashSet<String>>,
    pending_notice: Mutex<HashMap<String, String>>,
}

/// 비어 있으면 None(정본 `!deps.x`).
fn non_empty(p: &Option<PathBuf>) -> Option<&Path> {
    p.as_deref().filter(|p| !p.as_os_str().is_empty())
}

/// `path.resolve` 와 같은 낱말 정리 — 절대 경로로 만들고 `.`·`..` 를 접는다(파일 시스템은 보지 않는다).
fn lexical_absolute(p: &Path) -> Option<PathBuf> {
    let abs = std::path::absolute(p).ok()?;
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    Some(out)
}

impl ProviderLane {
    pub fn new(deps: ProviderLaneDeps) -> Self {
        Self {
            deps,
            noticed: Mutex::new(HashSet::new()),
            pending_notice: Mutex::new(HashMap::new()),
        }
    }

    /// 그 턴 하네스 env 에 넣을 키. 결과를 알린다(2a) — 성공·실패 모두.
    pub fn env_for(
        &self,
        cause: &str,
        harness: AgentHarness,
    ) -> Result<BTreeMap<String, String>, LaneFileError> {
        let res = self.prepare(cause, harness);
        if let Some(report) = &self.deps.report {
            match &res {
                Ok(_) => report(true, None),
                Err(LaneFileError::Lane(e)) => report(false, Some(e.code())),
                Err(_) => {}
            }
        }
        res
    }

    /// 턴 파일은 이 러너의 턴 파일 자리 바로 안의 것만 지운다 — env 에 실린 다른 경로는 건드리지 않는다.
    pub fn release(&self, env: &BTreeMap<String, String>) -> io::Result<()> {
        let path = [AgentHarness::Opencode, AgentHarness::Kilo]
            .into_iter()
            .filter_map(lane_turn_file_env_name)
            .filter_map(|name| env.get(name))
            .find(|v| !v.is_empty());
        let (Some(path), Some(state_dir)) = (path, non_empty(&self.deps.state_dir)) else {
            return Ok(());
        };
        let (Some(dir), Some(file)) = (
            lexical_absolute(&state_dir.join(LANE_TURN_DIR)),
            lexical_absolute(Path::new(path)),
        ) else {
            return Ok(());
        };
        let Ok(rel) = file.strip_prefix(&dir) else {
            return Ok(());
        };
        let mut comps = rel.components();
        let one = matches!(
            (comps.next(), comps.next()),
            (Some(Component::Normal(n)), None) if !n.to_string_lossy().starts_with("..")
        );
        if !one {
            return Ok(());
        }
        match fs::remove_file(&file) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }

    /// 그 멘션의 `env_for` 가 남긴 잰 판 밖 경고(있으면 한 번만 돌려주고 지운다).
    pub fn take_notice(&self, cause: &str) -> Option<String> {
        self.pending_notice.lock().unwrap().remove(cause)
    }

    fn prepare(
        &self,
        cause: &str,
        harness: AgentHarness,
    ) -> Result<BTreeMap<String, String>, LaneFileError> {
        let fail = |code: &str| Err(LaneFileError::Lane(ProviderLaneError::new(code)));
        if provider_lane_keys(harness).is_none() {
            return fail("harness_unsupported");
        }
        let Some(turn_secrets_dir) = non_empty(&self.deps.turn_secrets_dir) else {
            return fail("no_turn_secrets_dir");
        };
        let via_turn_file = lane_turn_file_env(harness);
        let state_dir = non_empty(&self.deps.state_dir);
        if via_turn_file.is_some() && state_dir.is_none() {
            return fail("no_turn_secrets_dir");
        }
        // 판으로 막지 않는다. 잰 판 밖이면 러너 로그에 매 턴, 스레드에는 처음 볼 때 한 번 경고한다.
        if let Some((ok, versions)) = provider_lane_measured(harness) {
            let version = self.deps.harness_version.as_ref().and_then(|f| f(harness));
            if !ok(version.as_deref()) {
                let notice = lane_unmeasured_notice(harness, version.as_deref(), versions);
                eprintln!("[providerLane] {notice}");
                let key = format!(
                    "{}\0{}",
                    harness.as_str(),
                    js_trim(version.as_deref().unwrap_or(""))
                );
                if self.noticed.lock().unwrap().insert(key) {
                    self.pending_notice
                        .lock()
                        .unwrap()
                        .insert(cause.to_owned(), notice);
                }
            }
        }
        // codex lane 홈 검사는 키를 꺼내기 **전에** 한다 — 띄우지 않을 턴이 임대를 받지 않게(security n1).
        let uses_codex_key = keys_include(harness, CODEX_LANE_KEY_ENV);
        if uses_codex_key {
            let Some(codex_home) = non_empty(&self.deps.codex_home) else {
                return fail("no_turn_secrets_dir");
            };
            if fs::symlink_metadata(codex_home.join("auth.json")).is_ok() {
                return fail("harness_login_present");
            }
        }
        let res = (self.deps.mount)(cause);
        if res.status == 0 {
            return fail("operator_unreachable");
        }
        let body: Value = serde_json::from_str(&res.body).unwrap_or(Value::Null);
        if res.status != 200 {
            let code = body
                .get("error")
                .and_then(|e| e.get("code"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("http_{}", res.status));
            return fail(&code);
        }
        let Some(lane) = body.get("lane").filter(|l| js_truthy(l)) else {
            return fail("lane_unset");
        };
        let Some(base_url) = lane
            .get("baseUrl")
            .and_then(Value::as_str)
            .and_then(normalize_provider_base_url)
        else {
            return fail("bad_base_url");
        };
        // 값 파일은 오퍼레이터의 턴 비밀 루트 아래에만 있어야 한다.
        let path = lane.get("path").and_then(Value::as_str).unwrap_or("");
        let real = if path.is_empty() {
            None
        } else {
            fs::canonicalize(path).ok()
        };
        let root = fs::canonicalize(turn_secrets_dir).ok();
        let inside = match (&real, &root) {
            (Some(real), Some(root)) => real.strip_prefix(root).is_ok_and(|rel| {
                !rel.as_os_str().is_empty() && !rel.to_string_lossy().starts_with("..")
            }),
            _ => false,
        };
        let (true, Some(real)) = (inside, real) else {
            return fail("bad_path");
        };
        let Some(real_str) = real.to_str().map(str::to_owned) else {
            return fail("bad_path");
        };
        let raw = fs::read(&real).unwrap_or_default();
        let raw = String::from_utf8_lossy(&raw);
        let value = raw
            .strip_suffix("\r\n")
            .or_else(|| raw.strip_suffix('\n'))
            .unwrap_or(&raw);
        if value.is_empty() || value.contains(['\r', '\n', '\0']) {
            return fail("bad_value");
        }
        let pair = |a: &str, av: String, b: &str, bv: String| {
            BTreeMap::from([(a.to_owned(), av), (b.to_owned(), bv)])
        };
        if uses_codex_key {
            return Ok(pair(
                CODEX_LANE_KEY_ENV,
                value.to_owned(),
                CODEX_LANE_BASE_URL_ENV,
                base_url,
            ));
        }
        // omp·pi: 값은 읽어 검사만 한다 — 설정 파일에는 키 파일 경로만 간다(K1·K3a).
        if keys_include(harness, OMP_LANE_KEY_FILE_ENV) {
            return Ok(pair(
                OMP_LANE_BASE_URL_ENV,
                base_url,
                OMP_LANE_KEY_FILE_ENV,
                real_str,
            ));
        }
        if keys_include(harness, PI_LANE_KEY_FILE_ENV) {
            return Ok(pair(
                PI_LANE_BASE_URL_ENV,
                base_url,
                PI_LANE_KEY_FILE_ENV,
                real_str,
            ));
        }
        if let (Some(name_env), Some(state_dir)) = (via_turn_file, state_dir) {
            // 값은 읽어 검사만 한다 — opencode·kilo 에는 키 파일 경로만 간다.
            let name: String = cause
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
                .take(64)
                .collect();
            let name = if name.is_empty() {
                "turn".to_owned()
            } else {
                name
            };
            let file = write_opencode_lane_turn_config(
                &state_dir.join(LANE_TURN_DIR),
                &name,
                OpencodeLaneTarget {
                    base_url: &base_url,
                    key_path: &real_str,
                },
            )?;
            return Ok(BTreeMap::from([(
                name_env.to_owned(),
                file.to_string_lossy().into_owned(),
            )]));
        }
        Ok(pair(
            "ANTHROPIC_BASE_URL",
            base_url,
            "ANTHROPIC_AUTH_TOKEN",
            value.to_owned(),
        ))
    }
}

#[cfg(test)]
#[path = "provider_lane_tests.rs"]
mod tests;
