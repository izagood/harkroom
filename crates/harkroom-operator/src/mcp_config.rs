//! 하네스 MCP 설정(s21c-1b) — 정본은 `packages/operator/src/mcpConfig.ts` 의 `buildMcpConfig`·`readLocalMcpDefinitions`·
//! `writeAgentMcpConfig` 다. 러너는 완성된 파일의 경로(`HARKROOM_MCP_CONFIG`)만 받는다.
//!
//! 정의를 찾는 순서: `<root>/operator/mcp-servers.json`(오퍼레이터 표) → claude `~/.claude.json` 의 `mcpServers`. 앞이 이긴다.
//! 이름이 이 머신에 없으면 `missing` 으로 돌려주고 조정기가 배정을 거절한다(조용히 도구 없이 뜨지 않게).
//!
//! **TS 와 다른 점**: 쓰는 폴더가 심링크면 거절하고, 파일은 임시 파일(0600) → rename 으로 쓴다(TS 는 `writeFile` 덮어쓰기).
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// 늘 들어가고 정의로 덮어쓸 수 없는 둘(TS `RESERVED_MCP_NAMES`).
pub use crate::local_mcp::RESERVED_MCP_SERVER_NAMES;

/// TS `buildMcpConfig` 의 결과.
#[derive(Clone, PartialEq)]
pub struct BuiltMcpConfig {
    pub mcp_servers: Map<String, Value>,
    pub missing: Vec<String>,
    pub needs_auth: Vec<String>,
}

/// `mcp_servers` 에는 원격 서버의 `Authorization: Bearer <토큰>` 이 구워져 있다 — 이름만 낸다(#1887·#1888 과 같은 가림).
impl std::fmt::Debug for BuiltMcpConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BuiltMcpConfig")
            .field("mcp_servers", &self.mcp_servers.keys().collect::<Vec<_>>())
            .field("missing", &self.missing)
            .field("needs_auth", &self.needs_auth)
            .finish()
    }
}

/// TS `buildMcpConfig`. `tokens` 는 오퍼레이터가 든 OAuth 토큰(이름 → access token), `expired` 는 refresh 가 거절된 이름.
pub fn build_mcp_config(
    operator_bin: &str,
    names: &[String],
    definitions: &Map<String, Value>,
    tokens: &BTreeMap<String, String>,
    expired: &[String],
) -> BuiltMcpConfig {
    let mut mcp_servers = Map::new();
    // alwaysLoad 는 켜지 않는다(TS 주석 2026-10-09 — 늦게 붙으면 이어받은 문맥의 프롬프트 캐시가 깨진다).
    mcp_servers.insert(
        "harkroom".into(),
        json!({"type": "stdio", "command": operator_bin, "args": ["mcp-bridge"]}),
    );
    mcp_servers.insert(
        "avcs".into(),
        json!({"type": "stdio", "command": "avcs", "args": ["mcp"]}),
    );
    let mut missing = Vec::new();
    let mut needs_auth = Vec::new();
    for name in names {
        if RESERVED_MCP_SERVER_NAMES.contains(&name.as_str()) {
            continue;
        }
        let Some(Value::Object(def)) = definitions.get(name) else {
            missing.push(name.clone());
            continue;
        };
        if def.contains_key("url") {
            if let Some(token) = tokens.get(name).filter(|t| !t.is_empty()) {
                let mut rest = def.clone();
                rest.shift_remove("oauth");
                let mut headers = match def.get("headers") {
                    Some(Value::Object(h)) => h.clone(),
                    _ => Map::new(),
                };
                headers.insert(
                    "Authorization".into(),
                    Value::String(format!("Bearer {token}")),
                );
                rest.insert("headers".into(), Value::Object(headers));
                mcp_servers.insert(name.clone(), Value::Object(rest));
                continue;
            }
            // 토큰이 없다 — 정의는 그대로 두고(하네스가 옛 토큰으로라도 붙게) 인증 필요만 알린다.
            if truthy(def.get("oauth")) || expired.contains(name) {
                needs_auth.push(name.clone());
            }
            mcp_servers.insert(name.clone(), Value::Object(def.clone()));
            continue;
        }
        // stdio — claude 표는 type 을 안 적기도 한다(codex 는 transport 가 없으면 설정 전체를 거절). 정의의 키가 뒤에서 이긴다.
        let mut stdio = Map::new();
        stdio.insert("type".into(), Value::String("stdio".into()));
        for (k, v) in def {
            stdio.insert(k.clone(), v.clone());
        }
        mcp_servers.insert(name.clone(), Value::Object(stdio));
    }
    BuiltMcpConfig {
        mcp_servers,
        missing,
        needs_auth,
    }
}

/// JS 참값(`if (def.oauth)`) — null·false·0·"" 가 아니면 참.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// 없으면 `None`, 있는데 JSON 이 아니면 오류(TS `readJsonIfExists`). 객체가 아닌 JSON 은 빈 표로 본다(TS `isRecord`).
fn read_json_if_exists(path: &Path) -> Result<Option<Value>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{} 을 읽지 못했다: {e}", path.display())),
    };
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("{} 을 읽을 수 없다: {e}", path.display()))
}

/// TS `readLocalMcpDefinitions` — 오퍼레이터 표(앞)가 claude 설정(뒤)을 이긴다. 객체가 아닌 항목은 버린다.
pub fn read_local_mcp_definitions(
    registry_path: &Path,
    claude_config_path: Option<&Path>,
) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    if let Some(p) = claude_config_path
        && let Some(Value::Object(raw)) = read_json_if_exists(p)?
        && let Some(Value::Object(servers)) = raw.get("mcpServers")
    {
        for (name, def) in servers {
            if def.is_object() {
                out.insert(name.clone(), def.clone());
            }
        }
    }
    if let Some(Value::Object(registry)) = read_json_if_exists(registry_path)? {
        for (name, def) in registry {
            if def.is_object() {
                out.insert(name, def);
            }
        }
    }
    Ok(out)
}

/// TS `writeAgentMcpConfig` — `<dir>/<agentId>.json` 을 0600 으로. env·headers 에 토큰이 실려 비밀로 다룬다.
/// agent id 에 경로 글자가 있으면 거절한다(서버가 준 값이 폴더 밖을 가리키지 않게).
pub fn write_agent_mcp_config(
    dir: &Path,
    agent_id: &str,
    mcp_servers: &Map<String, Value>,
) -> Result<PathBuf, String> {
    if agent_id.is_empty()
        || agent_id == "."
        || agent_id == ".."
        || !agent_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("agent id 가 파일 이름으로 맞지 않다: {agent_id:?}"));
    }
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("MCP 설정 폴더를 만들지 못했다: {e}"))?;
    match fs::symlink_metadata(dir) {
        Ok(m) if m.file_type().is_symlink() => {
            return Err(format!("MCP 설정 폴더가 심링크다: {}", dir.display()));
        }
        Ok(m) if !m.is_dir() => {
            return Err(format!("MCP 설정 폴더가 폴더가 아니다: {}", dir.display()));
        }
        Ok(_) => {}
        Err(e) => return Err(format!("MCP 설정 폴더를 보지 못했다: {e}")),
    }
    // 폴더가 이미 있었으면 `DirBuilder::mode` 는 권한을 건드리지 않는다 — 끝에서 0700 으로 다시 맞춘다(#1880 `ensure_dir` 과 같다).
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("MCP 설정 폴더 권한을 맞추지 못했다: {e}"))?;
    let path = dir.join(format!("{agent_id}.json"));
    let text = serde_json::to_string_pretty(&json!({ "mcpServers": mcp_servers }))
        .map_err(|e| format!("MCP 설정을 직렬화하지 못했다: {e}"))?;
    let tmp = dir.join(format!(
        ".{agent_id}.json.tmp-{}-{}",
        std::process::id(),
        crate::endpoint::random_hex(4).unwrap_or_default()
    ));
    let res = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, &path)
    })();
    if let Err(e) = res {
        let _ = fs::remove_file(&tmp);
        return Err(format!("MCP 설정을 쓰지 못했다: {e}"));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn defs(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }
    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hk-mcpcfg-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn names(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reserved_always_present_and_not_overridable() {
        let d = defs(json!({"harkroom": {"command": "evil"}}));
        let b = build_mcp_config(
            "/bin/op",
            &names(&["harkroom", "avcs"]),
            &d,
            &BTreeMap::new(),
            &[],
        );
        assert_eq!(
            b.mcp_servers["harkroom"],
            json!({"type": "stdio", "command": "/bin/op", "args": ["mcp-bridge"]})
        );
        assert_eq!(b.mcp_servers["avcs"]["command"], "avcs");
        assert!(b.missing.is_empty());
    }

    #[test]
    fn missing_names_are_reported() {
        let b = build_mcp_config(
            "/b",
            &names(&["x", "y"]),
            &defs(json!({"y": {"command": "c"}})),
            &BTreeMap::new(),
            &[],
        );
        assert_eq!(b.missing, vec!["x".to_string()]);
        assert_eq!(b.mcp_servers["y"], json!({"type": "stdio", "command": "c"}));
    }

    #[test]
    fn remote_with_token_gets_header_and_drops_oauth() {
        let d = defs(
            json!({"r": {"type": "http", "url": "https://m", "headers": {"X": "1"}, "oauth": {"clientId": "c"}}}),
        );
        let mut t = BTreeMap::new();
        t.insert("r".to_string(), "tok".to_string());
        let b = build_mcp_config("/b", &names(&["r"]), &d, &t, &[]);
        assert_eq!(
            b.mcp_servers["r"],
            json!({"type": "http", "url": "https://m", "headers": {"X": "1", "Authorization": "Bearer tok"}})
        );
        assert!(b.needs_auth.is_empty());
    }

    #[test]
    fn remote_without_token_keeps_definition_and_flags_auth() {
        let d = defs(
            json!({"a": {"type": "http", "url": "https://a", "oauth": {}}, "b": {"type": "sse", "url": "https://b"}, "c": {"type": "http", "url": "https://c"}}),
        );
        let b = build_mcp_config(
            "/b",
            &names(&["a", "b", "c"]),
            &d,
            &BTreeMap::new(),
            &names(&["b"]),
        );
        assert_eq!(b.needs_auth, names(&["a", "b"]));
        assert_eq!(b.mcp_servers["a"], d["a"]);
    }

    #[test]
    fn registry_wins_over_claude_and_broken_file_errors() {
        let dir = tmp("read");
        let reg = dir.join("mcp-servers.json");
        let claude = dir.join(".claude.json");
        fs::write(
            &claude,
            r#"{"mcpServers":{"x":{"command":"claude"},"y":{"command":"y"},"z":3}}"#,
        )
        .unwrap();
        fs::write(&reg, r#"{"x":{"command":"op"}}"#).unwrap();
        let d = read_local_mcp_definitions(&reg, Some(&claude)).unwrap();
        assert_eq!(d["x"]["command"], "op");
        assert_eq!(d["y"]["command"], "y");
        assert!(!d.contains_key("z"));
        assert!(
            read_local_mcp_definitions(&dir.join("none.json"), None)
                .unwrap()
                .is_empty()
        );
        fs::write(&reg, "{").unwrap();
        assert!(read_local_mcp_definitions(&reg, Some(&claude)).is_err());
    }

    #[test]
    fn write_is_0600_in_0700_dir_and_refuses_bad_id_and_symlink_dir() {
        let base = tmp("write");
        let dir = base.join("operator").join("mcp");
        let mut m = Map::new();
        m.insert("harkroom".into(), json!({"command": "/b"}));
        let p = write_agent_mcp_config(&dir, "agent-1", &m).unwrap();
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let v: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["harkroom"]["command"], "/b");
        assert!(write_agent_mcp_config(&dir, "../x", &m).is_err());
        assert!(write_agent_mcp_config(&dir, "..", &m).is_err());
        let real = base.join("real");
        fs::create_dir(&real).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(write_agent_mcp_config(&link, "a", &m).is_err());
        assert_eq!(fs::read_dir(&real).unwrap().count(), 0);
    }

    #[test]
    fn existing_loose_dir_is_tightened_to_0700() {
        let dir = tmp("loose").join("mcp");
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let mut m = Map::new();
        m.insert("harkroom".into(), json!({"command": "/b"}));
        write_agent_mcp_config(&dir, "a", &m).unwrap();
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn debug_hides_baked_bearer_token() {
        let mut m = Map::new();
        m.insert(
            "remote".into(),
            json!({"type": "http", "headers": {"Authorization": "Bearer sekret-tok"}}),
        );
        let b = BuiltMcpConfig {
            mcp_servers: m,
            missing: vec![],
            needs_auth: vec![],
        };
        let s = format!("{b:?}");
        assert!(!s.contains("sekret-tok"), "{s}");
        assert!(s.contains("remote"), "{s}");
    }
}
