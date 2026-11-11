//! 러너 자체의 설정 — 정본 `packages/agent/src/config.ts` 의 이식.
//!
//! 모델·effort·지시문은 여기 없다(서버의 에이전트 정의에 있다). 오퍼레이터가 spawn 때 심는 env 만 읽는다.

use std::collections::HashMap;

/// 오퍼레이터 링크 env 이름(`@harkroom/shared/runnerLink` 의 `RUNNER_LINK_ENV`). 순서는 오류 문구의 순서다.
pub const RUNNER_LINK_ENV_KEYS: [&str; 3] = [
    "HARKROOM_OPERATOR_SOCKET",
    "HARKROOM_RUNNER_ID",
    "HARKROOM_RUNNER_SECRET",
];

pub const PER_COMMUNITY_ENV: &str = "HARKROOM_OPERATOR_PER_COMMUNITY";
pub const OPERATOR_ROOT_ENV: &str = "HARKROOM_OPERATOR_ROOT";
pub const OPERATOR_LEGACY_ENV: &str = "HARKROOM_OPERATOR_LEGACY";

#[derive(Clone, PartialEq, Eq)]
pub struct OperatorLink {
    pub socket_path: String,
    pub runner_id: String,
    pub secret: String,
}

/// `secret` 은 링크 비밀이다 — `{:?}` 로 config 를 찍어도 로그에 나가지 않게 손으로 가린다(security #1866 낮음).
impl std::fmt::Debug for OperatorLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OperatorLink")
            .field("socket_path", &self.socket_path)
            .field("runner_id", &self.runner_id)
            .field("secret", &"<redacted>")
            .finish()
    }
}

/// TS `RunnerConfig` 와 칸이 같다. 각 칸의 뜻은 정본 주석에 있다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerConfig {
    pub operator_link: OperatorLink,
    pub operator_bin: String,
    pub command_hook: bool,
    pub post_tool_hook: bool,
    pub chrome_host: bool,
    pub mcp_config_path: String,
    pub poll_timeout_ms: u64,
    pub inbox_lease: bool,
    pub turn_timeout_ms: u64,
    pub harness_stall_ms: u64,
    pub pty_record_dir: Option<String>,
    pub state_dir: String,
    pub agent_instance: Option<String>,
    pub interactive_orphan_ms: u64,
}

pub type Env = HashMap<String, String>;

pub fn process_env() -> Env {
    std::env::vars().collect()
}

/// 기동 로그에 적는 러너 이름(#174). 인스턴스가 없어도 `[default]` 를 적는다(정본 주석).
pub fn runner_label(handle: &str, instance: Option<&str>) -> String {
    format!("@{handle}[{}]", instance.unwrap_or("default"))
}

/// `[a-z0-9-]{1,32}` — 경로 세그먼트가 되므로 문법에서 `..`·`/` 를 끊는다. 틀리면 기동을 실패시킨다.
fn validate_instance(instance: Option<&String>) -> Result<Option<String>, String> {
    let Some(v) = instance.filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let ok = (1..=32).contains(&v.len())
        && v.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !ok {
        return Err(format!(
            "HARKROOM_AGENT_INSTANCE 가 유효하지 않다: \"{v}\". 문자 집합은 [a-z0-9-]{{1,32}} 이다."
        ));
    }
    Ok(Some(v.clone()))
}

fn non_empty<'a>(env: &'a Env, key: &str) -> Option<&'a String> {
    env.get(key).filter(|v| !v.is_empty())
}

fn required(env: &Env, key: &str) -> Result<String, String> {
    non_empty(env, key)
        .cloned()
        .ok_or_else(|| format!("{key} 가 필요하다"))
}

fn operator_link(env: &Env) -> Result<OperatorLink, String> {
    match (
        non_empty(env, RUNNER_LINK_ENV_KEYS[0]),
        non_empty(env, RUNNER_LINK_ENV_KEYS[1]),
        non_empty(env, RUNNER_LINK_ENV_KEYS[2]),
    ) {
        (Some(s), Some(r), Some(k)) => Ok(OperatorLink {
            socket_path: s.clone(),
            runner_id: r.clone(),
            secret: k.clone(),
        }),
        _ => Err(format!(
            "{} 이 필요하다 — 러너는 오퍼레이터가 띄운다 (설정 › Operators 에서 등록하고 에이전트를 배정하라)",
            RUNNER_LINK_ENV_KEYS.join("·")
        )),
    }
}

/// 밀리초 env. TS 는 `Number(...)` 라 숫자가 아니면 NaN 이 흘러간다 — 여기서는 기동을 실패시킨다(조용한 NaN 대신).
fn millis(env: &Env, key: &str, default: u64) -> Result<u64, String> {
    match env.get(key) {
        None => Ok(default),
        Some(v) => v
            .trim()
            .parse::<u64>()
            .map_err(|_| format!("{key} 는 0 이상의 정수(밀리초)여야 한다: \"{v}\"")),
    }
}

/// node `path.resolve` 처럼 `.`·`..`·겹친 `/` 를 글자로만 접는다(절대 경로 입력만).
fn resolve_abs(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    format!("/{}", parts.join("/"))
}

/// `@harkroom/shared/agentStateRoot` 의 `agentStateBaseDir` — 커뮤니티마다 오퍼레이터면 그 뿌리의 `agents`.
fn agent_state_base_dir(default_dir: String, env: &Env) -> Result<String, String> {
    if env.get(PER_COMMUNITY_ENV).map(String::as_str) != Some("1") {
        return Ok(default_dir);
    }
    if env.get(OPERATOR_LEGACY_ENV).map(String::as_str) == Some("1") {
        return Ok(default_dir);
    }
    match env.get(OPERATOR_ROOT_ENV) {
        Some(root) if root.starts_with('/') => Ok(format!(
            "{}/agents",
            resolve_abs(root).trim_end_matches('/')
        )),
        _ => Err(format!(
            "{PER_COMMUNITY_ENV}=1 인데 {OPERATOR_ROOT_ENV} 가 절대 경로가 아니다"
        )),
    }
}

pub fn load_config(env: &Env) -> Result<RunnerConfig, String> {
    let flag_on = |k: &str| env.get(k).map(String::as_str) == Some("1");
    let flag_not_off = |k: &str| env.get(k).map(String::as_str) != Some("0");
    let state_dir = match env.get("AGENT_STATE_DIR") {
        Some(d) => d.clone(),
        None => {
            let home = env.get("HOME").cloned().unwrap_or_default();
            agent_state_base_dir(format!("{home}/.harkroom-agent"), env)?
        }
    };
    Ok(RunnerConfig {
        operator_link: operator_link(env)?,
        operator_bin: required(env, "HARKROOM_OPERATOR_BIN")?,
        command_hook: flag_on("HARKROOM_COMMAND_HOOK"),
        post_tool_hook: flag_not_off("HARKROOM_POST_TOOL_HOOK"),
        chrome_host: flag_on("HARKROOM_CHROME_HOST"),
        mcp_config_path: required(env, "HARKROOM_MCP_CONFIG")?,
        poll_timeout_ms: millis(env, "AGENT_POLL_TIMEOUT_MS", 25_000)?,
        inbox_lease: flag_not_off("AGENT_INBOX_LEASE"),
        turn_timeout_ms: millis(env, "AGENT_TURN_TIMEOUT_MS", 30 * 60_000)?,
        harness_stall_ms: millis(env, "AGENT_HARNESS_STALL_MS", 10 * 60_000)?,
        pty_record_dir: env
            .get("AGENT_PTY_RECORD_DIR")
            .filter(|d| d.starts_with('/'))
            .cloned(),
        state_dir,
        agent_instance: validate_instance(env.get("HARKROOM_AGENT_INSTANCE"))?,
        interactive_orphan_ms: millis(env, "AGENT_INTERACTIVE_ORPHAN_MS", 60_000)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Env {
        [
            ("HOME", "/home/u"),
            ("HARKROOM_OPERATOR_SOCKET", "/tmp/op.sock"),
            ("HARKROOM_RUNNER_ID", "r1"),
            ("HARKROOM_RUNNER_SECRET", "s1"),
            ("HARKROOM_OPERATOR_BIN", "/bin/op"),
            ("HARKROOM_MCP_CONFIG", "/tmp/mcp.json"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    #[test]
    fn defaults_match_ts() {
        let c = load_config(&base()).unwrap();
        assert_eq!(c.operator_link.runner_id, "r1");
        assert!(!c.command_hook && c.post_tool_hook && !c.chrome_host && c.inbox_lease);
        assert_eq!(c.poll_timeout_ms, 25_000);
        assert_eq!(c.turn_timeout_ms, 1_800_000);
        assert_eq!(c.harness_stall_ms, 600_000);
        assert_eq!(c.interactive_orphan_ms, 60_000);
        assert_eq!(c.pty_record_dir, None);
        assert_eq!(c.state_dir, "/home/u/.harkroom-agent");
        assert_eq!(c.agent_instance, None);
    }

    #[test]
    fn link_env_all_three_required() {
        for k in RUNNER_LINK_ENV_KEYS {
            let mut e = base();
            e.remove(k);
            let err = load_config(&e).unwrap_err();
            assert!(
                err.starts_with(
                    "HARKROOM_OPERATOR_SOCKET·HARKROOM_RUNNER_ID·HARKROOM_RUNNER_SECRET 이 필요하다"
                ),
                "{err}"
            );
        }
        let mut e = base();
        e.remove("HARKROOM_MCP_CONFIG");
        assert_eq!(
            load_config(&e).unwrap_err(),
            "HARKROOM_MCP_CONFIG 가 필요하다"
        );
    }

    #[test]
    fn flags_and_numbers() {
        let mut e = base();
        for (k, v) in [
            ("HARKROOM_COMMAND_HOOK", "1"),
            ("HARKROOM_POST_TOOL_HOOK", "0"),
            ("HARKROOM_CHROME_HOST", "1"),
            ("AGENT_INBOX_LEASE", "0"),
            ("AGENT_POLL_TIMEOUT_MS", "1000"),
            ("AGENT_PTY_RECORD_DIR", "/rec"),
        ] {
            e.insert(k.into(), v.into());
        }
        let c = load_config(&e).unwrap();
        assert!(c.command_hook && !c.post_tool_hook && c.chrome_host && !c.inbox_lease);
        assert_eq!(c.poll_timeout_ms, 1000);
        assert_eq!(c.pty_record_dir.as_deref(), Some("/rec"));
        e.insert("AGENT_PTY_RECORD_DIR".into(), "rel/dir".into());
        e.insert("AGENT_TURN_TIMEOUT_MS".into(), "abc".into());
        assert!(
            load_config(&e)
                .unwrap_err()
                .starts_with("AGENT_TURN_TIMEOUT_MS")
        );
        e.remove("AGENT_TURN_TIMEOUT_MS");
        assert_eq!(load_config(&e).unwrap().pty_record_dir, None);
    }

    #[test]
    fn instance_grammar() {
        let mut e = base();
        e.insert("HARKROOM_AGENT_INSTANCE".into(), "b-2".into());
        assert_eq!(
            load_config(&e).unwrap().agent_instance.as_deref(),
            Some("b-2")
        );
        for bad in ["../x", "A", "a/b", &"a".repeat(33)] {
            e.insert("HARKROOM_AGENT_INSTANCE".into(), bad.to_string());
            assert!(load_config(&e).is_err(), "{bad}");
        }
        assert_eq!(runner_label("bot", None), "@bot[default]");
        assert_eq!(runner_label("bot", Some("b")), "@bot[b]");
    }

    #[test]
    fn state_dir_per_community() {
        let mut e = base();
        e.insert(PER_COMMUNITY_ENV.into(), "1".into());
        assert!(load_config(&e).is_err());
        e.insert(OPERATOR_ROOT_ENV.into(), "/r/./c//x/../y/".into());
        assert_eq!(load_config(&e).unwrap().state_dir, "/r/c/y/agents");
        e.insert(OPERATOR_LEGACY_ENV.into(), "1".into());
        assert_eq!(
            load_config(&e).unwrap().state_dir,
            "/home/u/.harkroom-agent"
        );
        e.insert("AGENT_STATE_DIR".into(), "/s".into());
        assert_eq!(load_config(&e).unwrap().state_dir, "/s");
    }
}

#[cfg(test)]
mod debug_redaction_tests {
    use super::OperatorLink;

    #[test]
    fn debug_hides_link_secret() {
        let link = OperatorLink {
            socket_path: "/s".into(),
            runner_id: "r1".into(),
            secret: "top-secret-value".into(),
        };
        let shown = format!("{link:?}");
        assert!(!shown.contains("top-secret-value"), "{shown}");
        assert!(
            shown.contains("<redacted>") && shown.contains("r1"),
            "{shown}"
        );
    }
}
