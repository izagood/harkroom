//! 하네스 프리셋 표(`packages/agent/src/turn.ts` 의 `HarnessPreset`·`*_PRESET`) — s8 B3d-2a.
//!
//! TS 와 같이 `buildTurnCommand` 는 하네스 이름을 보지 않고 표만 부른다. 이 파일은 **조각**만 낸다 —
//! 조립(순서·세션 검사)은 B3d-2b `turn_command` 몫이다.
//!
//! 진행: claude 프리셋. codex·opencode/kilo·pi·omp 는 다음 커밋.

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
}
