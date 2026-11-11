//! 하네스 자식 env 조립(S3 B3d-3). 정본 `packages/agent/src/turn.ts` 의 `childEnv`·`HARNESS_ENV_DENYLIST`·`LANE_ENV_ALLOW`·
//! `laneGhConfigDir`·`harnessPath` 와 `providerLane.ts` 의 lane env 표.
//!
//! 정본과 다른 점(security 낮음 닫기): 턴마다 바뀌는 이름(`HARKROOM_TURN_ID`·`HARKROOM_TURN_CAUSE`·`HARKROOM_GATE_FILE`·
//! `HARKROOM_CODEX_HOOK`·턴 열쇠 둘)은 **부모 env 에서 먼저 지우고** 이 턴이 받은 값만 얹는다. 정본은 관문 파일·codex hook 을
//! 받은 턴에만 덮어써, 러너 env 에 남은 옛 값이 그 값을 안 받은 턴에 그대로 흘렀다.
//!
//! 부모 env 와 홈은 인자로 받는다 — 프로세스 env 를 읽는 자리는 부르는 쪽 하나로 둔다(시험이 프로세스 env 를 건드리지 않게).

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

use crate::adapter::{AgentHarness, TurnKeyDelivery, turn_key_delivery_of};
use crate::omp_home::omp_dirs;
use crate::opencode_home::{opencode_dirs, opencode_lane_home};

/// 자식에 물려주지 않는 키(#374·인증 주입 넷). 근거는 정본 상수 주석에 있다 — 지우려거든 거기부터 읽어라.
pub const HARNESS_ENV_DENYLIST: [&str; 5] = [
    "CLAUDE_CODE_CHILD_SESSION",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
];

/// API 키 연결 턴은 물려받지 않고 이 목록으로 짓는다(security W2, L1b).
pub const LANE_ENV_ALLOW: [&str; 26] = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "COLORTERM",
    "LANG",
    "TMPDIR",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HARKROOM_OPERATOR_SOCKET",
    "HARKROOM_RUNNER_ID",
    "HARKROOM_RUNNER_SECRET",
    "HARKROOM_MCP_READY_FILE",
    "HARKROOM_OPERATOR_VERSION",
];
const LANE_ENV_ALLOW_PREFIXES: [&str; 2] = ["LC_", "XDG_"];

pub fn lane_env_allowed(key: &str) -> bool {
    LANE_ENV_ALLOW.contains(&key) || LANE_ENV_ALLOW_PREFIXES.iter().any(|p| key.starts_with(p))
}

pub const RUNNER_TURN_CAUSE_ENV: &str = "HARKROOM_TURN_CAUSE";
pub const RUNNER_TURN_ID_ENV: &str = "HARKROOM_TURN_ID";
pub const RUNNER_GATE_FILE_ENV: &str = "HARKROOM_GATE_FILE";
pub const CODEX_HOOK_SPEC_ENV: &str = "HARKROOM_CODEX_HOOK";
pub const RUNNER_TURN_KEY_SHELL_ENV: &str = "HARKROOM_TURN_GRANT";
pub const RUNNER_TURN_KEY_BRIDGE_ENV: &str = "HARKROOM_TURN_BRIDGE_KEY";
pub const RUNNER_LINK_SECRET_ENV: &str = "HARKROOM_RUNNER_SECRET";
pub const GH_CONFIG_DIR_ENV: &str = "GH_CONFIG_DIR";

/// 정본 `PROVIDER_LANE_ENV_KEYS` — lane 이 넣을 수 있는 키. 없는 하네스는 lane 을 못 쓴다.
pub fn provider_lane_keys(h: AgentHarness) -> Option<&'static [&'static str]> {
    use AgentHarness::*;
    match h {
        ClaudeCode => Some(&["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]),
        Opencode => Some(&["OPENCODE_CONFIG"]),
        Kilo => Some(&["KILO_CONFIG"]),
        Codex => Some(&["HARKROOM_LANE_API_KEY", "HARKROOM_LANE_BASE_URL"]),
        Omp => Some(&["HARKROOM_OMP_LANE_BASE_URL", "HARKROOM_OMP_LANE_KEY_FILE"]),
        Pi => Some(&["HARKROOM_PI_LANE_BASE_URL", "HARKROOM_PI_LANE_KEY_FILE"]),
        Gemini => None,
    }
}

/// 정본 `PROVIDER_LANE_ARGV_ONLY_KEYS` — 허용되지만 하네스 env 에는 넣지 않는다(argv 조립에만).
pub fn provider_lane_argv_only_keys(h: AgentHarness) -> &'static [&'static str] {
    use AgentHarness::*;
    match h {
        Codex => &["HARKROOM_LANE_BASE_URL"],
        Omp => &["HARKROOM_OMP_LANE_BASE_URL", "HARKROOM_OMP_LANE_KEY_FILE"],
        Pi => &["HARKROOM_PI_LANE_BASE_URL", "HARKROOM_PI_LANE_KEY_FILE"],
        _ => &[],
    }
}

/// 정본 `PROVIDER_LANE_FIXED_ENV` — lane 턴에 늘 얹는 동작 스위치.
pub fn provider_lane_fixed_env(h: AgentHarness) -> &'static [(&'static str, &'static str)] {
    use AgentHarness::*;
    match h {
        ClaudeCode => &[("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "1")],
        Opencode => &[
            ("OPENCODE_DISABLE_CLAUDE_CODE", "1"),
            ("OPENCODE_DISABLE_EXTERNAL_SKILLS", "1"),
            ("OPENCODE_DISABLE_AUTOUPDATE", "1"),
            ("OPENCODE_DISABLE_PROJECT_CONFIG", "1"),
        ],
        Kilo => &[
            ("KILO_DISABLE_PROJECT_CONFIG", "1"),
            ("KILO_DISABLE_CLAUDE_CODE", "1"),
            ("KILO_DISABLE_EXTERNAL_SKILLS", "1"),
            ("KILO_DISABLE_AUTOUPDATE", "1"),
        ],
        _ => &[],
    }
}

/// 정본 `LANE_TEST_HOME_ENV` — lane 턴의 홈 표지 자리 이름.
pub fn lane_test_home_env(h: AgentHarness) -> Option<&'static str> {
    match h {
        AgentHarness::Opencode => Some("OPENCODE_TEST_HOME"),
        AgentHarness::Kilo => Some("KILO_TEST_HOME"),
        _ => None,
    }
}

/// 정본 shared `harnessFallbackBinDirs` — PATH 밖 설치 자리(홈 기준).
pub fn harness_fallback_bin_dirs(h: AgentHarness) -> &'static [&'static str] {
    use AgentHarness::*;
    match h {
        Opencode => &[".opencode/bin"],
        Kilo => &[".kilo/bin"],
        Pi => &[".pi/agent/bin"],
        Omp => &[".local/bin"],
        _ => &[],
    }
}

/// 정본 `harnessPath` — 주어진 PATH **뒤에** 설치 관례 자리를 붙인다(사람이 둔 것이 이긴다).
pub fn harness_path(h: AgentHarness, base_path: Option<&str>, home: &Path) -> String {
    let fallback: Vec<String> = harness_fallback_bin_dirs(h)
        .iter()
        .map(|d| home.join(d).to_string_lossy().into_owned())
        .collect();
    if fallback.is_empty() {
        return base_path.unwrap_or("").to_owned();
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(p) = base_path.filter(|p| !p.is_empty()) {
        parts.push(p.to_owned());
    }
    parts.extend(fallback);
    parts.join(":")
}

/// 정본 `laneGhConfigDir` — API 키 연결 opencode 턴에 `gh` 승인 규칙이 있을 때만 gh 설정 자리.
pub fn lane_gh_config_dir(
    h: AgentHarness,
    provider_lane: bool,
    tool_allows: &[String],
    xdg_config_home: Option<&str>,
    home: &Path,
) -> Option<PathBuf> {
    if h != AgentHarness::Opencode || !provider_lane {
        return None;
    }
    if !tool_allows.iter().any(|r| gh_rule(r)) {
        return None;
    }
    let base = match xdg_config_home {
        Some(x) if x.starts_with('/') => PathBuf::from(x),
        _ => home.join(".config"),
    };
    Some(base.join("gh"))
}

/// 정본 정규식 `/^Bash\(gh(\s|:\*\)$|\)$)/`.
fn gh_rule(rule: &str) -> bool {
    let Some(rest) = rule.strip_prefix("Bash(gh") else {
        return false;
    };
    rest.starts_with(|c: char| c.is_whitespace()) || rest == ":*)" || rest == ")"
}

/// 턴 열쇠 둘(정본 `TurnKeys`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnKeys {
    pub shell: String,
    pub bridge: String,
}

/// 정본 `childEnv` 의 `homes` 인자 + 이 조각에서 턴마다 덮어쓰는 두 값(`gate_file`·`codex_hook_spec`).
#[derive(Debug, Clone)]
pub struct ChildEnvInput<'a> {
    pub harness: AgentHarness,
    pub codex_home: Option<&'a Path>,
    pub claude_config_dir: Option<&'a Path>,
    pub opencode_home: Option<&'a Path>,
    pub pi_home: Option<&'a Path>,
    pub omp_home: Option<&'a Path>,
    pub omp_agent_dir: Option<&'a Path>,
    pub cause_message_id: Option<&'a str>,
    pub turn_id: Option<&'a str>,
    pub provider_env: Option<&'a BTreeMap<String, String>>,
    pub gh_config_dir: Option<&'a Path>,
    pub turn_keys: Option<&'a TurnKeys>,
    pub opencode_turn_config: Option<&'a Path>,
    pub gate_file: Option<&'a Path>,
    pub codex_hook_spec: Option<&'a str>,
}

impl<'a> ChildEnvInput<'a> {
    pub fn new(harness: AgentHarness) -> Self {
        Self {
            harness,
            codex_home: None,
            claude_config_dir: None,
            opencode_home: None,
            pi_home: None,
            omp_home: None,
            omp_agent_dir: None,
            cause_message_id: None,
            turn_id: None,
            provider_env: None,
            gh_config_dir: None,
            turn_keys: None,
            opencode_turn_config: None,
            gate_file: None,
            codex_hook_spec: None,
        }
    }
}

/// 조립 거절. 값·경로는 싣지 않는다 — 하네스와 env **이름**만.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChildEnvError {
    /// lane 이 그 하네스에 허용되지 않은 env 를 넣으려 했다(조용히 버리면 계정 로그인으로 돈다).
    LaneKeyNotAllowed { harness: AgentHarness, key: String },
    /// lane 턴의 홈 표지 이름을 모른다 — 사람 홈 설정이 실린다.
    LaneTestHomeUnknown { harness: AgentHarness },
}

impl fmt::Display for ChildEnvError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LaneKeyNotAllowed { harness, key } => {
                write!(
                    f,
                    "전용 제공사 경로가 {harness:?} 에 허용되지 않은 env 를 넣으려 했다: {key}"
                )
            }
            Self::LaneTestHomeUnknown { harness } => {
                write!(
                    f,
                    "{harness:?} lane 턴의 홈 표지 이름을 모른다 — 사람 홈 설정이 실린다"
                )
            }
        }
    }
}

impl std::error::Error for ChildEnvError {}

fn set(env: &mut BTreeMap<String, String>, k: &str, v: &Path) {
    env.insert(k.to_owned(), v.to_string_lossy().into_owned());
}

/// 정본 `childEnv`. `parent` 는 러너 env 전체, `home` 은 러너의 홈(PATH 뒤 자리를 지을 때만 쓴다).
pub fn child_env(
    input: &ChildEnvInput<'_>,
    parent: &BTreeMap<String, String>,
    home: &Path,
) -> Result<BTreeMap<String, String>, ChildEnvError> {
    let h = input.harness;
    let mut env = parent.clone();
    for k in HARNESS_ENV_DENYLIST {
        env.remove(k);
    }
    // 턴마다 바뀌는 이름은 옛 값을 먼저 지운다 — 아래에서 이 턴의 값만 얹는다(security 낮음: 남의 턴 값 상속).
    for k in [
        RUNNER_TURN_CAUSE_ENV,
        RUNNER_TURN_ID_ENV,
        RUNNER_GATE_FILE_ENV,
        CODEX_HOOK_SPEC_ENV,
        RUNNER_TURN_KEY_SHELL_ENV,
        RUNNER_TURN_KEY_BRIDGE_ENV,
    ] {
        env.remove(k);
    }
    if let Some(lane) = input.provider_env {
        env.retain(|k, _| lane_env_allowed(k));
        let allowed = provider_lane_keys(h).unwrap_or(&[]);
        for (k, v) in lane {
            if !allowed.contains(&k.as_str()) {
                return Err(ChildEnvError::LaneKeyNotAllowed {
                    harness: h,
                    key: k.clone(),
                });
            }
            env.insert(k.clone(), v.clone());
        }
        for k in provider_lane_argv_only_keys(h) {
            env.remove(*k);
        }
        for (k, v) in provider_lane_fixed_env(h) {
            env.insert((*k).to_owned(), (*v).to_owned());
        }
    }
    if let Some(p) = input.codex_home {
        set(&mut env, "CODEX_HOME", p);
    }
    if let Some(oh) = input.opencode_home {
        let d = opencode_dirs(oh);
        set(&mut env, "XDG_CONFIG_HOME", &d.xdg_config_home);
        set(&mut env, "XDG_DATA_HOME", &d.xdg_data_home);
        set(&mut env, "XDG_STATE_HOME", &d.xdg_state_home);
        if input.provider_env.is_some() {
            let name =
                lane_test_home_env(h).ok_or(ChildEnvError::LaneTestHomeUnknown { harness: h })?;
            set(&mut env, name, &opencode_lane_home(oh));
        }
    }
    if let Some(p) = input.gh_config_dir {
        set(&mut env, GH_CONFIG_DIR_ENV, p);
    }
    if let Some(p) = input.pi_home {
        set(&mut env, "PI_CODING_AGENT_DIR", p);
        env.remove("PI_CODING_AGENT_SESSION_DIR");
    }
    if let Some(oh) = input.omp_home {
        let d = omp_dirs(oh);
        set(&mut env, "HOME", &d.home);
        set(
            &mut env,
            "PI_CODING_AGENT_DIR",
            input.omp_agent_dir.unwrap_or(&d.agent_dir),
        );
        env.remove("PI_CODING_AGENT_SESSION_DIR");
        env.remove("OMP_PROFILE");
    }
    // null 이면 키 자체를 넣지 않는다 — 빈 문자열은 claude 가 경로로 읽는다.
    if let Some(p) = input.claude_config_dir {
        set(&mut env, "CLAUDE_CONFIG_DIR", p);
    }
    // 원인·턴 id 는 없으면 빈 값으로 덮는다 — 브릿지는 빈 값을 "없음"으로 읽는다.
    env.insert(
        RUNNER_TURN_CAUSE_ENV.into(),
        input.cause_message_id.unwrap_or("").into(),
    );
    env.insert(
        RUNNER_TURN_ID_ENV.into(),
        input.turn_id.unwrap_or("").into(),
    );
    if let Some(p) = input.gate_file {
        set(&mut env, RUNNER_GATE_FILE_ENV, p);
    }
    if let Some(spec) = input.codex_hook_spec {
        env.insert(CODEX_HOOK_SPEC_ENV.into(), spec.into());
    }
    if let Some(keys) = input.turn_keys {
        env.remove(RUNNER_LINK_SECRET_ENV);
        env.insert(RUNNER_TURN_KEY_SHELL_ENV.into(), keys.shell.clone());
        match turn_key_delivery_of(h) {
            Some(TurnKeyDelivery::EnvVars) => {
                env.insert(RUNNER_TURN_KEY_BRIDGE_ENV.into(), keys.bridge.clone());
            }
            Some(TurnKeyDelivery::TurnConfigEnv) => {
                if let Some(p) = input.opencode_turn_config {
                    set(&mut env, "OPENCODE_CONFIG", p);
                }
            }
            _ => {}
        }
    }
    let path = harness_path(h, env.get("PATH").map(String::as_str), home);
    if !path.is_empty() {
        env.insert("PATH".into(), path);
    }
    Ok(env)
}

#[cfg(test)]
#[path = "turn_env/tests.rs"]
mod tests;
