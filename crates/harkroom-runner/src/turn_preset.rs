//! 하네스 프리셋 표(`packages/agent/src/turn.ts` 의 `HarnessPreset`·`*_PRESET`) — s8 B3d-2a.
//!
//! TS 와 같이 `buildTurnCommand` 는 하네스 이름을 보지 않고 표만 부른다. 이 파일은 **조각**만 낸다 —
//! 조립(순서·세션 검사)은 B3d-2b `turn_command` 몫이다.
//!
//! 진행: claude·codex·opencode/kilo·pi·omp 조각(codex lane 덮어쓰기·추가 MCP 조각은 B3d-4). 세션 판정·chrome 헬퍼는 다음 커밋.

use crate::adapter::MentionPermission;
use crate::turn_rules::{
    self, GRANT_DELEGATE_TOOL, LANE_BASE_ALLOW, LANE_DENY, MENTION_DENY_TOOLS, MERGE_DENY_RULES,
    PERMISSION_REQUEST_TOOL, POST_TOOLS, READONLY_RULES, SETTINGS_SELF_EDIT_DENY_RULES,
    TurnRulesError,
};

/// TS `TurnMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnMode {
    Mention,
    Interactive,
}

/// 프리셋 조각 거절. 경로·본문 값은 싣지 않는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnPresetError {
    /// claude 는 지시문을 파일로만 받는다(#92) — 파일 경로 없이 지시문이 왔다.
    SystemPromptNeedsFile,
    Rules(TurnRulesError),
}

impl std::fmt::Display for TurnPresetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SystemPromptNeedsFile => f.write_str(
                "claude 는 지시문을 파일로만 받는다 — systemPromptFile 이 비어 있다(argv 는 ps 로 샌다)",
            ),
            Self::Rules(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for TurnPresetError {}

impl From<TurnRulesError> for TurnPresetError {
    fn from(e: TurnRulesError) -> Self {
        Self::Rules(e)
    }
}

/// TS `permissionRules` 의 인자 묶음.
#[derive(Debug, Clone, Default)]
pub struct RuleArgs<'a> {
    pub operator_bin: &'a str,
    pub merge_repos: &'a [String],
    pub api_connectors: &'a [String],
    pub api_delegatable: &'a [String],
    pub tool_allows: &'a [String],
    pub claude_config_dir: Option<&'a str>,
    pub command_hook: bool,
    pub provider_lane: bool,
    pub post_tool_since_seq: Option<i64>,
}

fn v(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

/// claude 프리셋(TS `CLAUDE_PRESET`).
pub mod claude {
    use super::*;

    pub const COMMAND: &str = "claude";
    pub const ALLOWS_NULL_SESSION_ON_FIRST_TURN: bool = false;

    /// 첫 턴은 `--session-id`, 이후는 `-r`. mode 는 보지 않는다(멘션도 TUI).
    pub fn session(session_id: &str, is_first_turn: bool) -> Vec<String> {
        if is_first_turn {
            v(&["--session-id", session_id])
        } else {
            v(&["-r", session_id])
        }
    }

    /// 멘션 턴 권한 플래그. API 키 연결(lane) auto 는 `dontAsk`(classifier 안내 화면·gateway 거절 회피).
    pub fn permission(p: MentionPermission, provider_lane: bool) -> Vec<String> {
        match p {
            MentionPermission::Auto if provider_lane => v(&["--permission-mode", "dontAsk"]),
            MentionPermission::Auto => v(&["--permission-mode", "auto"]),
            MentionPermission::Readonly => v(&["--permission-mode", "dontAsk"]),
        }
    }

    /// `--strict-mcp-config` 는 늘 — 운영자 전역 MCP 상속을 막는다(spec §7).
    pub fn mcp(mcp_config_path: &str) -> Vec<String> {
        v(&["--mcp-config", mcp_config_path, "--strict-mcp-config"])
    }

    pub fn model(model: Option<&str>) -> Vec<String> {
        model.map(|m| v(&["--model", m])).unwrap_or_default()
    }

    pub fn effort(effort: Option<&str>) -> Vec<String> {
        effort.map(|e| v(&["--effort", e])).unwrap_or_default()
    }

    /// 지시문은 파일로만. 대화 본문은 argv 에 싣지 않는다(stdin 파일, #117).
    pub fn prompt(
        system_prompt: &str,
        system_prompt_file: Option<&str>,
    ) -> Result<Vec<String>, TurnPresetError> {
        match system_prompt_file {
            Some(f) => Ok(v(&["--append-system-prompt-file", f])),
            None if !system_prompt.is_empty() => Err(TurnPresetError::SystemPromptNeedsFile),
            None => Ok(Vec::new()),
        }
    }

    pub fn always_args(_mode: TurnMode) -> Vec<String> {
        Vec::new()
    }

    /// 꺼짐도 플래그로 말한다(계정 기억으로 스스로 켜지는 것을 막는다).
    pub fn chrome(enabled: bool) -> Vec<String> {
        v(&[if enabled { "--chrome" } else { "--no-chrome" }])
    }

    /// TS `CLAUDE_PRESET.permissionRules`.
    pub fn permission_rules(
        mode: TurnMode,
        mention_permission: MentionPermission,
        a: &RuleArgs<'_>,
    ) -> Result<Vec<String>, TurnPresetError> {
        if mode == TurnMode::Mention && mention_permission == MentionPermission::Readonly {
            return Ok(READONLY_RULES.clone());
        }
        if mode != TurnMode::Mention || mention_permission != MentionPermission::Auto {
            return Ok(Vec::new());
        }
        let bin = a.operator_bin;
        let mut allow = vec![format!("Bash({bin} merge:*)")];
        if !a.api_connectors.is_empty() {
            allow.push(format!("Bash({bin} api:*)"));
        }
        if !a.api_delegatable.is_empty() {
            allow.push(GRANT_DELEGATE_TOOL.into());
        }
        allow.push(PERMISSION_REQUEST_TOOL.into());
        allow.extend(POST_TOOLS.iter().map(|s| s.to_string()));
        allow.extend(turn_rules::safe_tool_allows(a.tool_allows));
        if a.provider_lane {
            allow.extend(LANE_BASE_ALLOW.iter().map(|s| s.to_string()));
        }

        let mut out = vec!["--disallowedTools".to_string()];
        out.extend(MERGE_DENY_RULES.iter().map(|s| s.to_string()));
        out.extend(SETTINGS_SELF_EDIT_DENY_RULES.iter().map(|s| s.to_string()));
        out.extend(turn_rules::config_settings_deny_rules(a.claude_config_dir));
        out.extend(MENTION_DENY_TOOLS.iter().map(|s| s.to_string()));
        if a.provider_lane {
            out.extend(LANE_DENY.iter().map(|s| s.to_string()));
        }
        // allow 는 머지 래퍼가 늘 있어 비지 않는다.
        out.push("--allowedTools".into());
        out.extend(allow.iter().cloned());

        let pre = if a.provider_lane {
            Some(turn_rules::lane_hook_settings(bin, &allow)?)
        } else if a.command_hook {
            Some(turn_rules::command_hook_settings(bin)?)
        } else {
            None
        };
        out.extend(turn_rules::settings_args(
            pre.as_deref(),
            bin,
            a.post_tool_since_seq,
            !a.provider_lane,
        )?);
        Ok(out)
    }
}

/// codex 프리셋(TS `CODEX_PRESET`). 세션·항상 붙는 플래그는 **실행 방식**(exec/tui)으로 갈린다 — 모드가 아니다.
pub mod codex {
    use super::*;
    use crate::adapter::{AgentHarness, ExecutionModel, Mode, execution_model_for};
    use crate::config::RUNNER_LINK_ENV_KEYS;
    use crate::turn_env::{RUNNER_TURN_CAUSE_ENV, RUNNER_TURN_ID_ENV, RUNNER_TURN_KEY_BRIDGE_ENV};

    pub const COMMAND: &str = "codex";
    pub const ALLOWS_NULL_SESSION_ON_FIRST_TURN: bool = true;
    /// TS `MCP_BRIDGE_ARGS`.
    pub const MCP_BRIDGE_ARGS: [&str; 1] = ["mcp-bridge"];

    fn exec_model(mode: TurnMode) -> ExecutionModel {
        let m = match mode {
            TurnMode::Mention => Mode::Mention,
            TurnMode::Interactive => Mode::Interactive,
        };
        // codex 는 어댑터 표에 늘 있다 — 없으면 표가 깨진 것이라 exec(옛 답)로 둔다.
        execution_model_for(AgentHarness::Codex, m).unwrap_or(ExecutionModel::Exec)
    }

    /// tui: 첫 턴 맨 `codex`, 이후 `resume <id>`. exec: 첫 턴 `exec`(id 는 rollout 에서 나중에), 이후 `exec resume <id>`.
    pub fn session(session_id: Option<&str>, mode: TurnMode) -> Vec<String> {
        match (exec_model(mode), session_id) {
            (ExecutionModel::Tui, None) => Vec::new(),
            (ExecutionModel::Tui, Some(id)) => v(&["resume", id]),
            (ExecutionModel::Exec, None) => v(&["exec"]),
            (ExecutionModel::Exec, Some(id)) => v(&["exec", "resume", id]),
        }
    }

    /// `-s` 가 아니라 `-c sandbox_mode=` — `-s` 는 `exec resume` 에서 파싱 오류(codex-cli 0.148 실측).
    pub fn permission(p: MentionPermission) -> Vec<String> {
        match p {
            MentionPermission::Auto => v(&[
                "-c",
                "sandbox_mode=\"workspace-write\"",
                "-c",
                "mcp_servers.harkroom.default_tools_approval_mode=\"approve\"",
            ]),
            MentionPermission::Readonly => v(&["-c", "sandbox_mode=\"read-only\""]),
        }
    }

    fn json<T: serde::Serialize + ?Sized>(x: &T) -> String {
        serde_json::to_string(x).expect("문자열·문자열 배열 직렬화는 실패하지 않는다")
    }

    /// avcs·harkroom 브릿지는 늘. `transport` 를 반드시 적는다(빠지면 MCP 설정 전체가 로드 실패, 0.154 실측).
    /// `env` 가 아니라 `env_vars`(이름만 — 값은 argv 에 안 오른다). `extra` 는 `codexMcpFlags` 결과(B3d-4)를 그대로 잇는다.
    pub fn mcp(operator_bin: &str, turn_keys: bool, extra: &[String]) -> Vec<String> {
        let mut env_vars: Vec<&str> = RUNNER_LINK_ENV_KEYS.to_vec();
        env_vars.push(RUNNER_TURN_CAUSE_ENV);
        env_vars.push(RUNNER_TURN_ID_ENV);
        if turn_keys {
            env_vars.push(RUNNER_TURN_KEY_BRIDGE_ENV);
        }
        let mut out = v(&[
            "-c",
            "mcp_servers.avcs.transport=\"stdio\"",
            "-c",
            "mcp_servers.avcs.command=\"avcs\"",
            "-c",
            "mcp_servers.avcs.args=[\"mcp\"]",
            "-c",
            "mcp_servers.harkroom.transport=\"stdio\"",
        ]);
        out.push("-c".into());
        out.push(format!(
            "mcp_servers.harkroom.command={}",
            json(operator_bin)
        ));
        out.push("-c".into());
        out.push(format!(
            "mcp_servers.harkroom.args={}",
            json(&MCP_BRIDGE_ARGS)
        ));
        out.push("-c".into());
        out.push(format!("mcp_servers.harkroom.env_vars={}", json(&env_vars)));
        if turn_keys {
            // 다리 열쇠는 브릿지에만 — 셸에는 거른다. 스냅숏·로그인 셸·코드 모드·tty 실행은 이 거르기를 지나므로 끈다.
            out.push("-c".into());
            out.push(format!(
                "shell_environment_policy.exclude={}",
                json(&[RUNNER_TURN_KEY_BRIDGE_ENV])
            ));
            out.extend(v(&[
                "-c",
                "features.shell_snapshot=false",
                "-c",
                "allow_login_shell=false",
                "-c",
                "features.code_mode=false",
                "-c",
                "features.unified_exec_tty=false",
            ]));
        }
        out.extend(extra.iter().cloned());
        out
    }

    pub fn model(model: Option<&str>) -> Vec<String> {
        model.map(|m| v(&["--model", m])).unwrap_or_default()
    }

    /// TOML 문자열로 인용한다(security #968 ③) — JSON 문자열과 이스케이프가 같다.
    pub fn effort(effort: Option<&str>) -> Vec<String> {
        effort
            .map(|e| vec!["-c".into(), format!("model_reasoning_effort={}", json(e))])
            .unwrap_or_default()
    }

    /// exec 계열에만 있는 두 플래그(`codex resume`·TUI 는 파싱 오류).
    pub fn always_args(mode: TurnMode) -> Vec<String> {
        match exec_model(mode) {
            ExecutionModel::Exec => v(&["--skip-git-repo-check", "--ignore-user-config"]),
            ExecutionModel::Tui => Vec::new(),
        }
    }

    /// 지시문·본문 모두 stdin 파일(#117) — argv 에는 아무것도 없다.
    pub fn prompt() -> Vec<String> {
        Vec::new()
    }
}

/// opencode·kilo 프리셋(TS `OPENCODE_PRESET`·`KILO_PRESET` — kilo 는 실행 파일 이름만 다르다).
/// MCP·지시문·본문은 argv 에 없다(설정 파일·PTY 주입). `--auto` 와 읽기 전용 에이전트를 **같이 주지 않는 것**이 보안 경계다(kilo 실측).
pub mod opencode {
    use super::*;
    use crate::opencode_home::{OPENCODE_LANE_AGENT, OPENCODE_READONLY_AGENT};

    pub const OPENCODE_COMMAND: &str = "opencode";
    pub const KILO_COMMAND: &str = "kilo";
    pub const ALLOWS_NULL_SESSION_ON_FIRST_TURN: bool = true;

    pub fn session(session_id: Option<&str>) -> Vec<String> {
        session_id.map(|id| v(&["-s", id])).unwrap_or_default()
    }

    pub fn permission(p: MentionPermission) -> Vec<String> {
        match p {
            MentionPermission::Auto => v(&["--auto"]),
            MentionPermission::Readonly => v(&["--agent", OPENCODE_READONLY_AGENT]),
        }
    }

    /// API 키 연결 턴의 auto — `--auto` 없이 권한 표를 박은 lane 에이전트만. 읽기 전용 lane 은 `permission(Readonly)`.
    pub fn lane_permission_auto() -> Vec<String> {
        v(&["--agent", OPENCODE_LANE_AGENT])
    }

    /// 채널별 lane 에이전트(U3).
    pub fn lane_agent_args(agent: &str) -> Vec<String> {
        v(&["--agent", agent])
    }

    pub fn model(model: Option<&str>) -> Vec<String> {
        model.map(|m| v(&["-m", m])).unwrap_or_default()
    }

    pub fn effort(effort: Option<&str>) -> Vec<String> {
        effort.map(|e| v(&["--variant", e])).unwrap_or_default()
    }
}

/// pi·omp 공통: 지시문은 파일 경로로만(`--append-system-prompt <파일>` 은 파일 내용을 붙인다).
fn pi_family_prompt(
    system_prompt: &str,
    system_prompt_file: Option<&str>,
) -> Result<Vec<String>, TurnPresetError> {
    match system_prompt_file {
        Some(f) => Ok(v(&["--append-system-prompt", f])),
        None if !system_prompt.is_empty() => Err(TurnPresetError::SystemPromptNeedsFile),
        None => Ok(Vec::new()),
    }
}

/// pi 프리셋(TS `PI_PRESET`). 세션 인자 하나(있으면 잇고 없으면 만든다). 권한 플래그 없음 — 읽기 전용 `--tools` 는 조립 몫.
pub mod pi {
    use super::*;

    pub const COMMAND: &str = "pi";
    pub const ALLOWS_NULL_SESSION_ON_FIRST_TURN: bool = false;

    pub fn session(session_id: &str) -> Vec<String> {
        v(&["--session-id", session_id])
    }

    pub fn model(model: Option<&str>) -> Vec<String> {
        model.map(|m| v(&["--model", m])).unwrap_or_default()
    }

    pub fn effort(effort: Option<&str>) -> Vec<String> {
        effort.map(|e| v(&["--thinking", e])).unwrap_or_default()
    }

    /// 워크스페이스 `.pi/`(확장·설정)를 들이지 않는다.
    pub fn always_args() -> Vec<String> {
        v(&["--no-approve"])
    }

    /// API 키 연결 턴은 context 파일을 읽지 않는다.
    pub fn lane_args() -> Vec<String> {
        v(&["--no-context-files"])
    }

    pub fn prompt(
        system_prompt: &str,
        system_prompt_file: Option<&str>,
    ) -> Result<Vec<String>, TurnPresetError> {
        pi_family_prompt(system_prompt, system_prompt_file)
    }
}

/// omp 프리셋(TS `OMP_PRESET`, pi 포크). 첫 턴부터 `--resume`(헤더 파일을 러너가 미리 쓴다). `--add-dir`·`--config`·`--session-dir` 은 조립 몫.
pub mod omp {
    use super::*;

    pub const COMMAND: &str = "omp";
    pub const ALLOWS_NULL_SESSION_ON_FIRST_TURN: bool = false;

    pub fn session(session_id: &str) -> Vec<String> {
        v(&["--resume", session_id])
    }

    pub fn model(model: Option<&str>) -> Vec<String> {
        model.map(|m| v(&["--model", m])).unwrap_or_default()
    }

    pub fn effort(effort: Option<&str>) -> Vec<String> {
        effort.map(|e| v(&["--thinking", e])).unwrap_or_default()
    }

    pub fn always_args() -> Vec<String> {
        v(&["--no-extensions", "--no-title"])
    }

    pub fn prompt(
        system_prompt: &str,
        system_prompt_file: Option<&str>,
    ) -> Result<Vec<String>, TurnPresetError> {
        pi_family_prompt(system_prompt, system_prompt_file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_session_first_and_resume() {
        assert_eq!(claude::session("u1", true), ["--session-id", "u1"]);
        assert_eq!(claude::session("u1", false), ["-r", "u1"]);
    }

    #[test]
    fn claude_permission_lane_auto_is_dont_ask() {
        assert_eq!(
            claude::permission(MentionPermission::Auto, false),
            ["--permission-mode", "auto"]
        );
        assert_eq!(
            claude::permission(MentionPermission::Auto, true),
            ["--permission-mode", "dontAsk"]
        );
        assert_eq!(
            claude::permission(MentionPermission::Readonly, false),
            ["--permission-mode", "dontAsk"]
        );
    }

    #[test]
    fn claude_prompt_refuses_argv_system_prompt() {
        assert_eq!(
            claude::prompt("지시", None),
            Err(TurnPresetError::SystemPromptNeedsFile)
        );
        assert!(claude::prompt("", None).unwrap().is_empty());
        assert_eq!(
            claude::prompt("지시", Some("/x/sp")).unwrap(),
            ["--append-system-prompt-file", "/x/sp"]
        );
    }

    #[test]
    fn claude_chrome_off_is_explicit() {
        assert_eq!(claude::chrome(false), ["--no-chrome"]);
        assert_eq!(claude::chrome(true), ["--chrome"]);
    }

    #[test]
    fn claude_rules_readonly_fixed_and_interactive_empty() {
        let a = RuleArgs {
            operator_bin: "/op",
            tool_allows: &["Bash(ls:*)".to_string()],
            ..Default::default()
        };
        assert_eq!(
            claude::permission_rules(TurnMode::Mention, MentionPermission::Readonly, &a).unwrap(),
            *READONLY_RULES
        );
        assert!(
            claude::permission_rules(TurnMode::Interactive, MentionPermission::Auto, &a)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn claude_rules_auto_order_and_wrapper() {
        let a = RuleArgs {
            operator_bin: "/op",
            ..Default::default()
        };
        let r = claude::permission_rules(TurnMode::Mention, MentionPermission::Auto, &a).unwrap();
        assert_eq!(r[0], "--disallowedTools");
        let allow_at = r.iter().position(|x| x == "--allowedTools").unwrap();
        assert_eq!(r[allow_at + 1], "Bash(/op merge:*)");
        assert!(!r.iter().any(|x| x == "Bash(/op api:*)"));
        assert!(!r.iter().any(|x| x == GRANT_DELEGATE_TOOL));
        assert!(r.iter().any(|x| x == PERMISSION_REQUEST_TOOL));
        // 구독형 auto 는 하네스 물음 hook 이 붙는다.
        assert!(r.iter().any(|x| x == "--settings"));
    }

    #[test]
    fn claude_rules_lane_adds_deny_and_base_allow() {
        let a = RuleArgs {
            operator_bin: "/op",
            provider_lane: true,
            ..Default::default()
        };
        let r = claude::permission_rules(TurnMode::Mention, MentionPermission::Auto, &a).unwrap();
        let allow_at = r.iter().position(|x| x == "--allowedTools").unwrap();
        for d in LANE_DENY {
            let i = r.iter().position(|x| x == d).unwrap();
            assert!(i < allow_at);
        }
        for b in LANE_BASE_ALLOW {
            let i = r.iter().position(|x| x == b).unwrap();
            assert!(i > allow_at);
        }
    }

    #[test]
    fn codex_session_follows_execution_model() {
        use crate::adapter::{AgentHarness, ExecutionModel, Mode, execution_model_for};
        let em = execution_model_for(AgentHarness::Codex, Mode::Mention).unwrap();
        let (first, next) = (
            codex::session(None, TurnMode::Mention),
            codex::session(Some("s1"), TurnMode::Mention),
        );
        match em {
            ExecutionModel::Tui => {
                assert!(first.is_empty());
                assert_eq!(next, ["resume", "s1"]);
                assert!(codex::always_args(TurnMode::Mention).is_empty());
            }
            ExecutionModel::Exec => {
                assert_eq!(first, ["exec"]);
                assert_eq!(next, ["exec", "resume", "s1"]);
                assert_eq!(
                    codex::always_args(TurnMode::Mention),
                    ["--skip-git-repo-check", "--ignore-user-config"]
                );
            }
        }
    }

    #[test]
    fn codex_permission_uses_c_not_s() {
        let a = codex::permission(MentionPermission::Auto);
        assert!(!a.iter().any(|x| x == "-s"));
        assert_eq!(a[1], "sandbox_mode=\"workspace-write\"");
        assert_eq!(
            codex::permission(MentionPermission::Readonly),
            ["-c", "sandbox_mode=\"read-only\""]
        );
    }

    #[test]
    fn codex_mcp_bridge_and_env_vars_names_only() {
        let r = codex::mcp("/a b/op", false, &[]);
        assert!(r.contains(&"mcp_servers.avcs.transport=\"stdio\"".to_string()));
        assert!(r.contains(&"mcp_servers.harkroom.command=\"/a b/op\"".to_string()));
        assert!(r.contains(&"mcp_servers.harkroom.args=[\"mcp-bridge\"]".to_string()));
        let ev = r
            .iter()
            .find(|x| x.starts_with("mcp_servers.harkroom.env_vars="))
            .unwrap();
        assert!(ev.contains("HARKROOM_TURN_CAUSE") && ev.contains("HARKROOM_TURN_ID"));
        assert!(!ev.contains("HARKROOM_TURN_BRIDGE_KEY"));
        assert!(!r.iter().any(|x| x.starts_with("shell_environment_policy")));

        let k = codex::mcp(
            "/op",
            true,
            &["-c".into(), "mcp_servers.x.url=\"u\"".into()],
        );
        let ev = k
            .iter()
            .find(|x| x.starts_with("mcp_servers.harkroom.env_vars="))
            .unwrap();
        assert!(ev.contains("HARKROOM_TURN_BRIDGE_KEY"));
        assert!(k.contains(
            &"shell_environment_policy.exclude=[\"HARKROOM_TURN_BRIDGE_KEY\"]".to_string()
        ));
        assert!(k.contains(&"features.unified_exec_tty=false".to_string()));
        assert_eq!(k.last().unwrap(), "mcp_servers.x.url=\"u\"");
    }

    #[test]
    fn codex_effort_quotes_toml() {
        assert_eq!(
            codex::effort(Some("hi\"\nx=1")),
            ["-c", "model_reasoning_effort=\"hi\\\"\\nx=1\""]
        );
        assert!(codex::effort(None).is_empty());
        assert!(codex::prompt().is_empty());
    }

    #[test]
    fn opencode_auto_and_readonly_never_together() {
        assert_eq!(opencode::permission(MentionPermission::Auto), ["--auto"]);
        let ro = opencode::permission(MentionPermission::Readonly);
        assert_eq!(ro, ["--agent", "harkroom-readonly"]);
        assert!(!ro.iter().any(|x| x == "--auto"));
        assert_eq!(
            opencode::lane_permission_auto(),
            ["--agent", "harkroom-lane"]
        );
        assert!(opencode::session(None).is_empty());
        assert_eq!(opencode::session(Some("s")), ["-s", "s"]);
        assert_eq!(opencode::model(Some("m")), ["-m", "m"]);
        assert_eq!(opencode::effort(Some("high")), ["--variant", "high"]);
    }

    #[test]
    fn pi_and_omp_fragments() {
        assert_eq!(pi::session("u"), ["--session-id", "u"]);
        assert_eq!(omp::session("u"), ["--resume", "u"]);
        assert_eq!(pi::always_args(), ["--no-approve"]);
        assert_eq!(omp::always_args(), ["--no-extensions", "--no-title"]);
        assert_eq!(pi::lane_args(), ["--no-context-files"]);
        assert_eq!(pi::effort(Some("low")), ["--thinking", "low"]);
        for f in [pi::prompt, omp::prompt] {
            assert_eq!(f("지시", None), Err(TurnPresetError::SystemPromptNeedsFile));
            assert!(f("", None).unwrap().is_empty());
            assert_eq!(
                f("지시", Some("/p")).unwrap(),
                ["--append-system-prompt", "/p"]
            );
        }
    }
}
