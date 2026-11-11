//! pi 의 API 키 연결(lane) 턴 홈 — 정본 `packages/agent/src/piHome.ts` 의 lane 절반 이식(s8 B3c-2c-2).
//!
//! - `pi_lane_thread_home`: 스레드마다 가른 `PI_CODING_AGENT_DIR`(`<laneRoot>/threads/<sha256 앞 24자>`).
//!   `models.json` 이 그 턴의 키 파일 경로를 담으므로 한 파일을 여러 스레드가 같이 쓰면 동시 턴이 서로의 경로를 덮는다.
//! - `pi_lane_models_json`: 주소는 https 또는 루프백 http 만, 키는 파일 경로를 `!cat '<경로>'` 로만 가리킨다.
//!   `!` 로 시작하는 값은 pi 가 `/bin/sh -c` 로 **실행**한다 — 경로는 `[A-Za-z0-9/._ -]` 의 절대 경로만 받는다(정본과 같은 목록).
//! - `write_pi_lane_models`·`ensure_pi_lane_thread`: 0600 임시 파일 → rename 으로 쓴다(`pi_home::write_private`).
//!
//! 정본과 다른 점(모두 좁히는 쪽):
//! - 주소는 WHATWG `URL` 대신 좁게 읽는다 — 사용자 정보(`@`)·빈칸·제어 문자·따옴표·역슬래시가 있으면 거절한다.
//! - 파일은 링크를 따라가지 않고 링크째 바꾼다(정본 `writeFile` 은 따라간다).
//!
//! 아직 연결되지 않았다 — 오퍼레이터는 계속 node 러너를 띄운다(B4 스위치).

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use crate::pi_home::{
    LINKED_FILES, PiHomeError, ensure_private_dir, io_err, is_symlink, pi_sessions_dir, pretty,
    write_private,
};

/// lane 턴의 provider 이름(`models.json`). 모델은 `harkroom-lane/<gateway 모델 id>` 로 부른다.
pub const PI_LANE_PROVIDER: &str = "harkroom-lane";

/// lane 설정 거절. `Display` 에는 입력 값을 싣지 않는다(키 파일 경로·주소가 채팅으로 가지 않게).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaneConfigError {
    BaseUrl,
    KeyPath,
    ModelName,
}

impl fmt::Display for LaneConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::BaseUrl => "pi lane models.json: https 또는 로컬 주소만 받는다",
            Self::KeyPath => "pi lane models.json: 키 파일 경로가 이상하다",
            Self::ModelName => "pi lane models.json: 모델 이름이 이상하다",
        })
    }
}

impl std::error::Error for LaneConfigError {}

/// lane 한 턴의 연결 값.
#[derive(Debug, Clone)]
pub struct PiLane<'a> {
    pub base_url: &'a str,
    pub key_path: &'a str,
    pub models: &'a [String],
}

/// 스레드 키의 sha256 16진 앞 24자.
pub fn thread_hash(thread_key: &str) -> String {
    let digest = Sha256::digest(thread_key.as_bytes());
    let mut hex = String::with_capacity(64);
    for b in digest {
        hex.push_str(&format!("{b:02x}"));
    }
    hex.truncate(24);
    hex
}

/// 정본 `piLaneThreadHome`.
pub fn pi_lane_thread_home(lane_root: &Path, thread_key: &str) -> PathBuf {
    lane_root.join("threads").join(thread_hash(thread_key))
}

/// 주소가 https 이거나 루프백 http 인가. 정본은 `new URL` 의 protocol·hostname 을 본다 — 여기서는 그 둘만 좁게 읽는다.
pub fn lane_base_url_ok(base_url: &str) -> bool {
    // 출력 칸(JSON 문자열)에 들어갈 값이라 보이는 ASCII 만 받는다. 따옴표·역슬래시·`@`(사용자 정보)는 거절한다.
    if base_url.is_empty()
        || !base_url
            .bytes()
            .all(|b| b.is_ascii_graphic() && !matches!(b, b'"' | b'\'' | b'\\' | b'@' | b'`'))
    {
        return false;
    }
    let Some((scheme, rest)) = base_url.split_once("://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = if authority.starts_with('[') {
        match authority.find(']') {
            Some(i) => &authority[..=i],
            None => return false,
        }
    } else {
        authority.split(':').next().unwrap_or("")
    };
    if host.is_empty() {
        return false;
    }
    let host = host.to_ascii_lowercase();
    let local = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]");
    match scheme.to_ascii_lowercase().as_str() {
        "https" => true,
        "http" => local,
        _ => false,
    }
}

/// `!cat '<경로>'` 에 넣을 키 파일 경로인가 — 절대 경로이고 `[A-Za-z0-9/._ -]` 만(정본과 같은 목록).
pub fn lane_key_path_ok(key_path: &str) -> bool {
    key_path.starts_with('/')
        && key_path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b' ' | b'-'))
}

/// 모델 id 가 `^[A-Za-z0-9._:/-]{1,128}$` 인가.
pub fn lane_model_ok(m: &str) -> bool {
    (1..=128).contains(&m.len())
        && m.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'/' | b'-'))
}

/// 정본 `piLaneModelsJson`.
pub fn pi_lane_models_json(lane: &PiLane<'_>) -> Result<String, LaneConfigError> {
    if !lane_base_url_ok(lane.base_url) {
        return Err(LaneConfigError::BaseUrl);
    }
    if !lane_key_path_ok(lane.key_path) {
        return Err(LaneConfigError::KeyPath);
    }
    if !lane.models.iter().all(|m| lane_model_ok(m)) {
        return Err(LaneConfigError::ModelName);
    }
    let models: Vec<Value> = lane.models.iter().map(|id| json!({ "id": id })).collect();
    let doc = json!({
        "providers": {
            PI_LANE_PROVIDER: {
                // gateway 의 OpenAI 꼴 경로는 `/v1/chat/completions` 다 — lane 주소는 claude·opencode 와 같은 뿌리라 `/v1` 을 붙인다.
                "baseUrl": format!("{}/v1", lane.base_url),
                "api": "openai-completions",
                "apiKey": format!("!cat '{}'", lane.key_path),
                "models": models,
            }
        }
    });
    Ok(pretty(&doc))
}

/// `write_pi_lane_models`·`ensure_pi_lane_thread` 의 실패.
#[derive(Debug)]
pub enum PiLaneError {
    Config(LaneConfigError),
    Home(PiHomeError),
}

impl fmt::Display for PiLaneError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Config(e) => e.fmt(f),
            Self::Home(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for PiLaneError {}

impl PiLaneError {
    /// 로컬 로그 전용 — 경로까지 싣는다.
    pub fn local_detail(&self) -> String {
        match self {
            Self::Config(e) => e.to_string(),
            Self::Home(e) => e.local_detail(),
        }
    }
}

impl From<PiHomeError> for PiLaneError {
    fn from(e: PiHomeError) -> Self {
        Self::Home(e)
    }
}

/// 정본 `writePiLaneModels` — 그 홈의 `models.json` 을 0600 으로 쓴다. 링크였으면(지난 비-lane 홈) 링크부터 뗀다.
pub fn write_pi_lane_models(pi_home: &Path, lane: &PiLane<'_>) -> Result<PathBuf, PiLaneError> {
    let body = pi_lane_models_json(lane).map_err(PiLaneError::Config)?;
    let path = pi_home.join("models.json");
    if is_symlink(&path) {
        fs::remove_file(&path).map_err(io_err("링크 떼기", &path))?;
    }
    write_private(&path, &body)?;
    Ok(path)
}

/// 정본 `ensurePiLaneThread` — lane 스레드 홈을 마련한다(멱등). 루트(`ensure_pi_home(.., lane: true)`)의
/// `settings.json`·`mcp.json` 을 턴마다 다시 베낀다. 링크로 남은 로그인·제공자는 뗀다. `models.json` 은 그 턴이 쓴다.
pub fn ensure_pi_lane_thread(lane_root: &Path, thread_key: &str) -> Result<PathBuf, PiLaneError> {
    let home = pi_lane_thread_home(lane_root, thread_key);
    for dir in [
        lane_root.join("threads"),
        home.clone(),
        pi_sessions_dir(&home),
    ] {
        ensure_private_dir(&dir)?;
    }
    for name in ["settings.json", "mcp.json"] {
        let from = lane_root.join(name);
        let body = fs::read_to_string(&from).map_err(io_err("lane 루트 읽기", &from))?;
        write_private(&home.join(name), &body)?;
    }
    for file in LINKED_FILES {
        let to = home.join(file);
        if is_symlink(&to) {
            fs::remove_file(&to).map_err(io_err("링크 떼기", &to))?;
        }
    }
    Ok(home)
}

#[cfg(test)]
mod tests;
