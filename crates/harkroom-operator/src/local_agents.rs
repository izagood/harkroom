//! 오퍼레이터 로컬 설정의 에이전트 항목(S2 A5a) — `operatorAgentsList`·`operatorAgentSet`·`operatorAgentProviderLaneSet`·
//! `operatorAgentRemove`. 정본은 `packages/operator/src/localAgents.ts`·`config.ts`, 요청 검사는
//! `packages/shared/src/daemonProtocol.ts`(`readOperatorAgent*Payload`)·`providerLane.ts`(`readProviderLaneConfig`)다.
//!
//! 파일은 커뮤니티 뿌리의 `operator/operator.json`(TS `run.ts` 의 `join(appDataDir, 'operator', 'operator.json')`)이고
//! 토큰은 `operator/secrets/operator-token.<sha256(baseUrl) 앞 16자>`(TS `secrets.ts`)다. 이 판은 토큰을 **있는지만** 본다.
//!
//! TS 와 다른 곳(일부러):
//! - **커뮤니티 하나만 쓴다.** Rust 오퍼레이터는 커뮤니티마다 프로세스라, 쓰기는 TS `assertSingleCommunity`(커뮤니티마다
//!   모드)와 같은 규칙으로 막는다 — 자기 커뮤니티가 아닌 칸을 넣거나, 쓴 뒤 칸이 둘 이상이면 쓰지 않는다.
//! - **깨진 `operator.json` 을 덮어쓰지 않는다.** TS `readConfig` 는 깨진 파일을 빈 설정으로 읽고 다음 쓰기가 덮는다(머리 주석은
//!   덮지 않는다고 말한다). 여기서는 읽기는 빈 설정으로, 쓰기는 거절(`internal`)로 한다 — 손으로 고치던 내용은 되돌릴 수 없다.
//! - 읽고-고치고-쓰기를 `operator.json.lock`(P5 잠금, `file_lock.rs`)으로 묶는다. 프로세스 안에서 요청이 동시에 와도 한쪽 변경이
//!   지워지지 않는다. TS 는 잠그지 않는다(같은 뿌리에 writer 가 둘이 되는 일은 점유 규칙이 막는다).
//! - lane base URL 은 TS 처럼 `new URL` 로 정규화하지 않고, 정규화가 필요 없는 꼴만 받는다(`normalize_provider_base_url`).
//!   TS 가 받는 이상한 꼴(퍼센트 인코딩될 글자·IDN 등)은 거절될 수 있다 — 키가 갈 주소라 좁은 쪽을 골랐다.
//! - `laneStatus`·`lanePending` 은 싣지 않는다(러너 링크가 아직 없다 — 옛 오퍼레이터와 같은 모양). 바뀐 뒤 능력을 다시 내는
//!   `onChanged` 도 없다(서버 링크가 아직 없다).
use crate::file_lock::{FileLockOptions, with_file_lock};
use harkroom_proto::p3::{DaemonError, DaemonErrorCode};
use harkroom_roots::{community_root_hash, community_root_key};
use serde_json::{Map, Value, json};
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

fn err(code: DaemonErrorCode, message: impl Into<String>) -> DaemonError {
    DaemonError {
        code,
        message: message.into(),
    }
}

fn internal(message: impl Into<String>) -> DaemonError {
    err(DaemonErrorCode::Internal, message)
}

fn bad(message: impl Into<String>) -> DaemonError {
    err(DaemonErrorCode::BadPayload, message)
}

/// 이 프로세스가 맡은 커뮤니티의 로컬 설정.
#[derive(Debug, Clone)]
pub struct LocalAgents {
    /// 정규화한 커뮤니티 키(끝 `/` 없음).
    community: String,
    config_path: PathBuf,
    secrets_dir: PathBuf,
}

/// 파일을 읽은 결과. `Broken` 은 있는데 JSON 이 아니거나 `communities` 객체가 없다.
enum Loaded {
    Ok(Map<String, Value>),
    Missing,
    Broken,
}

impl LocalAgents {
    pub fn new(root: &str, base_url: &str) -> Self {
        let dir = Path::new(root).join("operator");
        LocalAgents {
            community: community_root_key(base_url).to_string(),
            config_path: dir.join("operator.json"),
            secrets_dir: dir.join("secrets"),
        }
    }

    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    fn load(&self) -> Result<Loaded, DaemonError> {
        let text = match fs::read_to_string(&self.config_path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Loaded::Missing),
            Err(e) => return Err(internal(format!("operator.json 을 읽지 못했다: {e}"))),
        };
        Ok(match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(m)) if m.get("communities").is_some_and(Value::is_object) => {
                Loaded::Ok(m)
            }
            _ => Loaded::Broken,
        })
    }

    /// 토큰 파일이 있고 비어 있지 않은가(TS `getToken() !== null`).
    fn registered(&self, base_url: &str) -> bool {
        let file = self.secrets_dir.join(format!(
            "operator-token.{}",
            community_root_hash(base_url, 16)
        ));
        fs::read_to_string(file).is_ok_and(|t| !t.trim().is_empty())
    }

    /// `operatorAgentsList`.
    pub fn list(&self) -> Result<Value, DaemonError> {
        let config = self.read_config()?;
        let mut out = Vec::new();
        if let Some(Value::Object(communities)) = config.get("communities") {
            for (raw, section) in communities {
                let base_url = community_root_key(raw);
                let operator_id = section
                    .get("operatorId")
                    .and_then(Value::as_str)
                    .map_or(Value::Null, |s| Value::String(s.to_string()));
                let agents = section.get("agents").cloned().unwrap_or_else(|| json!({}));
                out.push(json!({
                    "baseUrl": base_url,
                    "registered": self.registered(base_url),
                    "operatorId": operator_id,
                    "agents": agents,
                }));
            }
        }
        Ok(json!({ "communities": out }))
    }

    /// 잠그고 읽어 `f` 로 고친 뒤 쓴다. `f` 가 `false` 를 돌려주면 쓰지 않는다.
    fn modify(
        &self,
        raw_url: &str,
        f: impl FnOnce(&mut Map<String, Value>) -> Result<bool, DaemonError>,
    ) -> Result<(), DaemonError> {
        let key = community_root_key(raw_url);
        if key != self.community {
            return Err(internal(format!(
                "이 뿌리는 {} 의 것이다 — 다른 커뮤니티({key})를 넣을 수 없다",
                self.community
            )));
        }
        self.modify_config(f)
    }

    /// 깨진 파일·없는 파일은 빈 설정으로 읽는다(TS `readConfig`) — 읽기 전용 길(`operatorMergeGet` 등)이 쓴다.
    pub(crate) fn read_config(&self) -> Result<Map<String, Value>, DaemonError> {
        Ok(match self.load()? {
            Loaded::Ok(m) => m,
            Loaded::Missing | Loaded::Broken => Map::new(),
        })
    }

    /// 잠그고 읽어 `f` 로 고친 뒤 쓴다(커뮤니티 키 검사 없음 — 칸을 더하지 않는 쓰기용, `local_merge`).
    /// `f` 가 `false` 를 돌려주면 쓰지 않는다. 쓰기 전에 커뮤니티 칸이 하나뿐인지는 그대로 본다.
    pub(crate) fn modify_config(
        &self,
        f: impl FnOnce(&mut Map<String, Value>) -> Result<bool, DaemonError>,
    ) -> Result<(), DaemonError> {
        let dir = self
            .config_path
            .parent()
            .ok_or_else(|| internal("operator.json 의 디렉터리를 모른다"))?;
        fs::create_dir_all(dir)
            .map_err(|e| internal(format!("설정 디렉터리를 만들지 못했다: {e}")))?;
        let lock = self.config_path.with_extension("json.lock");
        with_file_lock(&lock, &FileLockOptions::default(), || {
            let mut config = match self.load()? {
                Loaded::Ok(m) => m,
                Loaded::Missing => {
                    let mut m = Map::new();
                    m.insert("communities".into(), json!({}));
                    m
                }
                Loaded::Broken => {
                    return Err(internal(
                        "operator.json 이 깨져 있어 덮어쓰지 않는다 — 파일을 고치거나 치운 뒤 다시 하라",
                    ));
                }
            };
            if !f(&mut config)? {
                return Ok(());
            }
            self.check_single(&config)?;
            self.write(&config)
        })
        .map_err(|e| internal(format!("operator.json 잠금을 잡지 못했다: {e}")))?
    }

    /// TS `assertSingleCommunity`(커뮤니티마다 모드).
    fn check_single(&self, config: &Map<String, Value>) -> Result<(), DaemonError> {
        let Some(Value::Object(c)) = config.get("communities") else {
            return Ok(());
        };
        if c.len() > 1 {
            let keys: Vec<&str> = c.keys().map(String::as_str).collect();
            return Err(internal(format!(
                "커뮤니티마다 오퍼레이터 모드에서 operator.json 에 커뮤니티가 둘 이상이다: {}",
                keys.join(", ")
            )));
        }
        if let Some(k) = c.keys().next()
            && community_root_key(k) != self.community
        {
            return Err(internal(format!(
                "이 뿌리는 {} 의 것이다 — 다른 커뮤니티({k})를 넣을 수 없다",
                self.community
            )));
        }
        Ok(())
    }

    /// TS `writeConfig`: 임시 파일(0600)에 2칸 들여쓰기 JSON + 개행을 쓰고 rename 한다.
    fn write(&self, config: &Map<String, Value>) -> Result<(), DaemonError> {
        let mut text = serde_json::to_string_pretty(config)
            .map_err(|e| internal(format!("설정을 직렬화하지 못했다: {e}")))?;
        text.push('\n');
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let tmp = PathBuf::from(format!(
            "{}.tmp-{}-{ms}",
            self.config_path.display(),
            std::process::id()
        ));
        let res = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?;
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
            fs::rename(&tmp, &self.config_path)
        })();
        if let Err(e) = res {
            let _ = fs::remove_file(&tmp);
            return Err(internal(format!("operator.json 을 쓰지 못했다: {e}")));
        }
        Ok(())
    }

    /// `operatorAgentSet` — workingDir·claudePool 만 바꾸고 있던 providerLane 은 그대로 옮긴다.
    pub fn set(
        &self,
        raw_url: &str,
        agent_id: &str,
        cfg: &AgentSetConfig,
    ) -> Result<(), DaemonError> {
        self.modify(raw_url, |config| {
            let agents = agents_of(config, &self.community, true).expect("만들었다");
            let lane = agents
                .get(agent_id)
                .and_then(|a| a.get("providerLane"))
                .filter(|l| truthy(l))
                .cloned();
            let mut entry = Map::new();
            if let Some(w) = &cfg.working_dir {
                entry.insert("workingDir".into(), Value::String(w.clone()));
            }
            if let Some(p) = &cfg.claude_pool {
                entry.insert("claudePool".into(), Value::String(p.clone()));
            }
            if let Some(l) = lane {
                entry.insert("providerLane".into(), l);
            }
            agents.insert(agent_id.to_string(), Value::Object(entry));
            Ok(true)
        })
    }

    /// `operatorAgentProviderLaneSet` — lane 칸만 넣고(`Some`) 뺀다(`None`). 다른 칸은 그대로 둔다.
    pub fn set_provider_lane(
        &self,
        raw_url: &str,
        agent_id: &str,
        lane: Option<&ProviderLane>,
    ) -> Result<(), DaemonError> {
        self.modify(raw_url, |config| {
            let agents = agents_of(config, &self.community, true).expect("만들었다");
            let mut entry = match agents.get(agent_id) {
                Some(Value::Object(m)) => m.clone(),
                _ => Map::new(),
            };
            match lane {
                Some(l) => {
                    entry.insert(
                        "providerLane".into(),
                        json!({ "baseUrl": l.base_url, "secretName": l.secret_name }),
                    );
                }
                None => {
                    entry.remove("providerLane");
                }
            }
            agents.insert(agent_id.to_string(), Value::Object(entry));
            Ok(true)
        })
    }

    /// `operatorAgentRemove` — 없으면 아무것도 쓰지 않는다.
    pub fn remove(&self, raw_url: &str, agent_id: &str) -> Result<(), DaemonError> {
        self.modify(raw_url, |config| {
            let Some(agents) = agents_of(config, &self.community, false) else {
                return Ok(false);
            };
            Ok(agents.remove(agent_id).is_some())
        })
    }
}

/// JS 의 참 값 판정(`lane ? …`) — 객체는 늘 참이고, null·false·0·"" 는 거짓.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// 그 커뮤니티 칸의 `agents`. `create` 면 칸·`agents` 를 만든다(TS `??= { agents: {} }`). 끝 `/` 가 다른 같은 키도 찾는다.
fn agents_of<'a>(
    config: &'a mut Map<String, Value>,
    community: &str,
    create: bool,
) -> Option<&'a mut Map<String, Value>> {
    if !config.get("communities").is_some_and(Value::is_object) {
        config.insert("communities".into(), json!({}));
    }
    let communities = config.get_mut("communities")?.as_object_mut()?;
    let key = communities
        .keys()
        .find(|k| community_root_key(k) == community)
        .cloned();
    let key = match key {
        Some(k) => k,
        None if create => {
            communities.insert(community.to_string(), json!({ "agents": {} }));
            community.to_string()
        }
        None => return None,
    };
    let section = communities.get_mut(&key)?;
    if !section.is_object() {
        if !create {
            return None;
        }
        *section = json!({ "agents": {} });
    }
    let section = section.as_object_mut()?;
    if !section.get("agents").is_some_and(Value::is_object) {
        if !create {
            return None;
        }
        section.insert("agents".into(), json!({}));
    }
    section.get_mut("agents")?.as_object_mut()
}

/// `operatorAgentSet` 의 `config`(TS `OperatorLocalAgent` 중 이 길로 바뀌는 둘).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct AgentSetConfig {
    pub working_dir: Option<String>,
    pub claude_pool: Option<String>,
}

/// TS `ProviderLaneConfig`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderLane {
    pub base_url: String,
    pub secret_name: String,
}

fn base_and_agent<'a>(
    payload: Option<&'a Value>,
    ty: &str,
) -> Result<(&'a Map<String, Value>, String, String), DaemonError> {
    let need = || bad(format!("{ty} 에는 baseUrl·agentId 가 필요하다"));
    let obj = payload.and_then(Value::as_object).ok_or_else(need)?;
    let base = obj
        .get("baseUrl")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(need)?;
    let agent = obj
        .get("agentId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(need)?;
    // agentId 는 설정 파일의 키가 된다 — 서버가 주는 uuid 꼴만 받는다(경로·제어문자가 키로 들어가지 않게).
    if !is_uuid_shape(agent) {
        return Err(bad(format!("{ty} 의 agentId 는 uuid 꼴이어야 한다")));
    }
    Ok((obj, base.to_string(), agent.to_string()))
}

/// `8-4-4-4-12` 16진 꼴(대소문자 무시). 판(version) 숫자는 따지지 않는다.
fn is_uuid_shape(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// 설정에 그대로 적히는 값 — 제어문자(줄바꿈·NUL 등)는 거절한다.
fn reject_control(field: &str, v: &str) -> Result<(), DaemonError> {
    if v.chars().any(char::is_control) {
        return Err(bad(format!("{field} 에 제어문자가 있다")));
    }
    Ok(())
}

/// JS `String.prototype.trim` 과 같은 공백(유니코드 White_Space + BOM).
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// TS `readOperatorAgentSetPayload`.
pub fn read_set_payload(
    payload: Option<&Value>,
) -> Result<(String, String, AgentSetConfig), DaemonError> {
    let (obj, base, agent) = base_and_agent(payload, "operatorAgentSet")?;
    let c = match obj.get("config") {
        None | Some(Value::Null) => return Ok((base, agent, AgentSetConfig::default())),
        Some(Value::Object(m)) => m,
        // TS `typeof c === 'object'` — 배열은 지나고(칸이 없어 빈 설정), 원시값은 거절된다.
        Some(Value::Array(_)) => return Ok((base, agent, AgentSetConfig::default())),
        Some(_) => return Err(bad("config 는 객체여야 한다")),
    };
    let mut out = AgentSetConfig::default();
    if let Some(v) = c.get("workingDir") {
        let Some(s) = v.as_str() else {
            return Err(bad("workingDir 는 문자열이어야 한다"));
        };
        let t = js_trim(s);
        reject_control("workingDir", t)?;
        if !t.is_empty() {
            out.working_dir = Some(t.to_string());
        }
    }
    if let Some(v) = c.get("claudePool") {
        let Some(s) = v.as_str() else {
            return Err(bad("claudePool 은 문자열이어야 한다"));
        };
        let t = js_trim(s);
        reject_control("claudePool", t)?;
        if !t.is_empty() {
            out.claude_pool = Some(t.to_string());
        }
    }
    Ok((base, agent, out))
}

/// TS `readOperatorAgentProviderLanePayload`.
pub fn read_lane_payload(
    payload: Option<&Value>,
) -> Result<(String, String, Option<ProviderLane>), DaemonError> {
    let (obj, base, agent) = base_and_agent(payload, "operatorAgentProviderLaneSet")?;
    if obj.get("lane") == Some(&Value::Null) {
        return Ok((base, agent, None));
    }
    let lane = obj
        .get("lane")
        .and_then(read_provider_lane_config)
        .ok_or_else(|| bad("lane 은 { baseUrl: https URL, secretName: 비밀 이름 } 이어야 한다"))?;
    Ok((base, agent, Some(lane)))
}

/// TS `readOperatorAgentRemovePayload`.
pub fn read_remove_payload(payload: Option<&Value>) -> Result<(String, String), DaemonError> {
    let (_, base, agent) = base_and_agent(payload, "operatorAgentRemove")?;
    Ok((base, agent))
}

/// TS `readProviderLaneConfig`.
pub fn read_provider_lane_config(raw: &Value) -> Option<ProviderLane> {
    let obj = raw.as_object()?;
    let base_url = normalize_provider_base_url(obj.get("baseUrl")?.as_str()?)?;
    let secret_name = obj.get("secretName")?.as_str()?;
    valid_secret_name(secret_name).then(|| ProviderLane {
        base_url,
        secret_name: secret_name.to_string(),
    })
}

/// TS `PROVIDER_SECRET_NAME` = `/^[a-z0-9][a-z0-9_-]{0,63}$/`.
fn valid_secret_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// TS `normalizeProviderBaseUrl` 의 좁은 판. `https://<호스트>[:포트][/경로]`(루프백만 `http:`)를 받아
/// `scheme://host[:port]<경로, 끝 / 없음>` 을 돌려준다. 받지 않는 것: 사용자 정보·쿼리·조각, 호스트에 ASCII 영숫자·`.`·`-`
/// 밖의 글자(IPv6 는 `[::1]` 만), 경로에 퍼센트 인코딩이 필요한 글자. scheme·호스트는 소문자로, 기본 포트는 뗀다(URL 과 같게).
pub fn normalize_provider_base_url(raw: &str) -> Option<String> {
    let s = js_trim(raw);
    if s.is_empty() || s.len() > 512 {
        return None;
    }
    let (scheme, rest) = s.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return None;
    }
    if rest.contains(['?', '#', '@', '\\']) {
        return None;
    }
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']')?;
        let host = &authority[..=end];
        let tail = &authority[end + 1..];
        let port = match tail {
            "" => None,
            t => Some(t.strip_prefix(':')?),
        };
        if host != "[::1]" {
            return None;
        }
        (host.to_string(), port)
    } else {
        let (h, p) = match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        };
        if h.is_empty()
            || !h
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
        {
            return None;
        }
        (h.to_ascii_lowercase(), p)
    };
    let port = match port {
        None | Some("") => None,
        Some(p) => {
            if !p.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let n: u32 = p.parse().ok()?;
            if n > 65535 {
                return None;
            }
            let default = if scheme == "https" { 443 } else { 80 };
            (n != default).then_some(n)
        }
    };
    let loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]");
    if scheme == "http" && !loopback {
        return None;
    }
    if !path
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'/' | b'-' | b'.' | b'_' | b'~'))
    {
        return None;
    }
    // `.`·`..` 조각은 URL 이 접는다 — 접지 않고 거절한다.
    if path.split('/').any(|seg| seg == "." || seg == "..") {
        return None;
    }
    let path = path.trim_end_matches('/');
    let port = port.map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!("{scheme}://{host}{port}{path}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn root() -> String {
        let r = std::env::temp_dir().join(format!(
            "hk-la-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&r);
        fs::create_dir_all(&r).unwrap();
        r.to_string_lossy().into_owned()
    }

    const URL: &str = "https://a.example.com";

    fn read(la: &LocalAgents) -> Value {
        serde_json::from_str(&fs::read_to_string(la.config_path()).unwrap()).unwrap()
    }

    #[test]
    fn set_creates_section_and_keeps_lane_and_other_fields() {
        let r = root();
        let la = LocalAgents::new(&r, URL);
        fs::create_dir_all(Path::new(&r).join("operator")).unwrap();
        fs::write(
            la.config_path(),
            r#"{"communities":{"https://a.example.com/":{"agents":{"x":{"workingDir":"/old","providerLane":{"baseUrl":"https://g.example.com","secretName":"k"},"extra":1}},"operatorId":"op1"}},"merge":{"ghUser":"u"}}"#,
        )
        .unwrap();
        la.set(
            "https://a.example.com/",
            "x",
            &AgentSetConfig {
                working_dir: Some("/new".into()),
                claude_pool: None,
            },
        )
        .unwrap();
        let v = read(&la);
        assert_eq!(v["merge"], json!({"ghUser":"u"}));
        let sec = &v["communities"]["https://a.example.com/"];
        assert_eq!(sec["operatorId"], "op1");
        // TS 처럼 workingDir·claudePool·providerLane 만 남는다(extra 는 빠진다).
        assert_eq!(
            sec["agents"]["x"],
            json!({"workingDir":"/new","providerLane":{"baseUrl":"https://g.example.com","secretName":"k"}})
        );
        let text = fs::read_to_string(la.config_path()).unwrap();
        assert!(text.ends_with("}\n") && text.contains("\n  \"communities\""));
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(la.config_path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn missing_file_set_then_list_then_remove() {
        let r = root();
        let la = LocalAgents::new(&r, URL);
        assert_eq!(la.list().unwrap(), json!({"communities": []}));
        la.set(URL, "a1", &AgentSetConfig::default()).unwrap();
        assert_eq!(
            la.list().unwrap(),
            json!({"communities":[{"baseUrl":URL,"registered":false,"operatorId":null,"agents":{"a1":{}}}]})
        );
        // 토큰 파일 이름은 TS secrets.ts 와 같은 해시다.
        let sec = Path::new(&r).join("operator/secrets");
        fs::create_dir_all(&sec).unwrap();
        fs::write(
            sec.join(format!("operator-token.{}", community_root_hash(URL, 16))),
            "t\n",
        )
        .unwrap();
        assert_eq!(la.list().unwrap()["communities"][0]["registered"], true);
        la.remove(URL, "a1").unwrap();
        assert_eq!(read(&la)["communities"][URL]["agents"], json!({}));
        // 없는 것을 빼면 쓰지 않는다.
        let before = fs::metadata(la.config_path()).unwrap().modified().unwrap();
        la.remove(URL, "nope").unwrap();
        assert_eq!(
            fs::metadata(la.config_path()).unwrap().modified().unwrap(),
            before
        );
    }

    #[test]
    fn lane_set_and_clear_keep_other_fields() {
        let r = root();
        let la = LocalAgents::new(&r, URL);
        la.set(
            URL,
            "x",
            &AgentSetConfig {
                working_dir: Some("/w".into()),
                claude_pool: Some("p".into()),
            },
        )
        .unwrap();
        let lane = ProviderLane {
            base_url: "https://g.example.com/anthropic".into(),
            secret_name: "key-1".into(),
        };
        la.set_provider_lane(URL, "x", Some(&lane)).unwrap();
        assert_eq!(
            read(&la)["communities"][URL]["agents"]["x"],
            json!({"workingDir":"/w","claudePool":"p","providerLane":{"baseUrl":"https://g.example.com/anthropic","secretName":"key-1"}})
        );
        la.set_provider_lane(URL, "x", None).unwrap();
        assert_eq!(
            read(&la)["communities"][URL]["agents"]["x"],
            json!({"workingDir":"/w","claudePool":"p"})
        );
    }

    #[test]
    fn other_community_and_broken_file_are_refused() {
        let r = root();
        let la = LocalAgents::new(&r, URL);
        let e = la
            .set("https://b.example.com", "x", &AgentSetConfig::default())
            .unwrap_err();
        assert_eq!(e.code, DaemonErrorCode::Internal);
        assert!(!la.config_path().exists());
        // 옛 단일 설정에서 넘어온 다른 칸이 있으면 쓰지 않는다.
        fs::create_dir_all(Path::new(&r).join("operator")).unwrap();
        fs::write(
            la.config_path(),
            r#"{"communities":{"https://b.example.com":{"agents":{}}}}"#,
        )
        .unwrap();
        assert!(la.set(URL, "x", &AgentSetConfig::default()).is_err());
        // 깨진 파일은 읽기는 빈 설정, 쓰기는 거절하고 그대로 둔다.
        fs::write(la.config_path(), "{broken").unwrap();
        assert_eq!(la.list().unwrap(), json!({"communities": []}));
        assert!(la.set(URL, "x", &AgentSetConfig::default()).is_err());
        assert_eq!(fs::read_to_string(la.config_path()).unwrap(), "{broken");
    }

    #[test]
    fn concurrent_sets_do_not_lose_updates() {
        let r = root();
        let la = std::sync::Arc::new(LocalAgents::new(&r, URL));
        let hs: Vec<_> = (0..8)
            .map(|i| {
                let la = la.clone();
                std::thread::spawn(move || {
                    la.set(URL, &format!("a{i}"), &AgentSetConfig::default())
                        .unwrap()
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        assert_eq!(
            read(&la)["communities"][URL]["agents"]
                .as_object()
                .unwrap()
                .len(),
            8
        );
    }

    #[test]
    fn payload_checks_match_ts() {
        const AID: &str = "0b9c6f1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
        for bad_id in [
            "x",
            "../x",
            "0b9c6f1e-2a3d-4e5f-8a9b-0c1d2e3f4a5g",
            "0b9c6f1e2a3d4e5f8a9b0c1d2e3f4a5b",
        ] {
            let e =
                read_set_payload(Some(&json!({"baseUrl": URL, "agentId": bad_id}))).unwrap_err();
            assert_eq!(
                e.message,
                "operatorAgentSet 의 agentId 는 uuid 꼴이어야 한다"
            );
        }
        let e = read_set_payload(Some(
            &json!({"baseUrl": URL, "agentId": AID, "config": {"workingDir": "/w\n/x"}}),
        ))
        .unwrap_err();
        assert_eq!(e.message, "workingDir 에 제어문자가 있다");
        let e = read_set_payload(Some(
            &json!({"baseUrl": URL, "agentId": AID, "config": {"claudePool": "p\u{0}"}}),
        ))
        .unwrap_err();
        assert_eq!(e.message, "claudePool 에 제어문자가 있다");
        let e = read_set_payload(Some(&json!({"baseUrl": "", "agentId": AID}))).unwrap_err();
        assert_eq!(
            e.message,
            "operatorAgentSet 에는 baseUrl·agentId 가 필요하다"
        );
        let e = read_set_payload(Some(
            &json!({"baseUrl": URL, "agentId": AID, "config": {"workingDir": 1}}),
        ))
        .unwrap_err();
        assert_eq!(e.message, "workingDir 는 문자열이어야 한다");
        let e = read_set_payload(Some(
            &json!({"baseUrl": URL, "agentId": AID, "config": "w"}),
        ))
        .unwrap_err();
        assert_eq!(e.message, "config 는 객체여야 한다");
        let (_, _, c) = read_set_payload(Some(
            &json!({"baseUrl": URL, "agentId": AID, "config": {"workingDir": "  /w ", "claudePool": "   "}}),
        ))
        .unwrap();
        assert_eq!(
            c,
            AgentSetConfig {
                working_dir: Some("/w".into()),
                claude_pool: None
            }
        );
        assert_eq!(
            read_lane_payload(Some(&json!({"baseUrl": URL, "agentId": AID, "lane": null})))
                .unwrap()
                .2,
            None
        );
        let e = read_lane_payload(Some(&json!({"baseUrl": URL, "agentId": AID}))).unwrap_err();
        assert_eq!(
            e.message,
            "lane 은 { baseUrl: https URL, secretName: 비밀 이름 } 이어야 한다"
        );
        let e = read_remove_payload(None).unwrap_err();
        assert_eq!(
            e.message,
            "operatorAgentRemove 에는 baseUrl·agentId 가 필요하다"
        );
        assert!(
            read_provider_lane_config(
                &json!({"baseUrl": "https://g.example.com", "secretName": "Bad"})
            )
            .is_none()
        );
        assert!(
            read_provider_lane_config(
                &json!({"baseUrl": "https://g.example.com", "secretName": "a".repeat(65)})
            )
            .is_none()
        );
    }

    #[test]
    fn base_url_normalization() {
        let ok = |s: &str| normalize_provider_base_url(s);
        assert_eq!(
            ok(" https://G.Example.com/anthropic/ ").as_deref(),
            Some("https://g.example.com/anthropic")
        );
        assert_eq!(
            ok("HTTPS://g.example.com:443").as_deref(),
            Some("https://g.example.com")
        );
        assert_eq!(
            ok("https://g.example.com:8443/").as_deref(),
            Some("https://g.example.com:8443")
        );
        assert_eq!(
            ok("http://127.0.0.1:8080/v1").as_deref(),
            Some("http://127.0.0.1:8080/v1")
        );
        assert_eq!(ok("http://[::1]:9").as_deref(), Some("http://[::1]:9"));
        assert_eq!(ok("http://localhost").as_deref(), Some("http://localhost"));
        for bad in [
            "http://g.example.com",
            "https://u:p@g.example.com",
            "https://g.example.com/?k=1",
            "https://g.example.com/#x",
            "ftp://g.example.com",
            "https://",
            "https://g.example.com:99999",
            "https://g.example.com/a b",
            "https://g.example.com/a/../b",
            "https://[::2]",
            "g.example.com",
        ] {
            assert_eq!(ok(bad), None, "{bad}");
        }
    }
}
