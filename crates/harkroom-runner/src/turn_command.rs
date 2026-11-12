//! 턴 명령 조립(`packages/agent/src/turn.ts` 의 `buildTurnCommand`) — s8 B3d-2b.
//!
//! 하네스 이름이 아니라 표(`turn_preset`·`adapter`)에 묻고, 조각을 정본과 **같은 순서**로 잇는다:
//! 세션 → 항상 → 멘션 권한 → 권한 규칙 → 읽기 전용 `--tools` → chrome → pi/omp 자리 → MCP → lane → 모델 → effort → 지시문.
//! env 는 `turn_env::child_env` 위에 하네스 MCP env·명령 규칙 env 를 얹는다.
//!
//! 아직 없는 것(B3d-4): codex lane 덮어쓰기(`codexLaneArgs`)·에이전트 추가 MCP(`codexMcpFlags`·`codexBearerEnv`).
//! 그 길에 들어오면 조용히 빼지 않고 거절한다(`CodexLanePending`).

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

use crate::adapter::{
    AgentHarness, MentionPermission, TurnKeyDelivery, readonly_tools_for, turn_key_delivery_of,
    uses_omp_home, uses_pi_home, uses_xdg_home,
};
use crate::omp_home::omp_dirs;
use crate::pi_home::pi_sessions_dir;
use crate::turn_env::{ChildEnvError, ChildEnvInput, TurnKeys, child_env, lane_gh_config_dir};
use crate::turn_preset::{
    PresetCheckError, RuleArgs, TurnMode, TurnPresetError, assert_valid_session, claude, codex,
    omp, opencode, pi, preset_of,
};

/// omp 스레드 자리(TS `ompThread`).
#[derive(Debug, Clone, Copy)]
pub struct OmpThread<'a> {
    pub cwd: &'a Path,
    pub agent_dir: &'a Path,
}

/// TS `BuildTurnCommandOptions`. `promptCtx` 는 어느 프리셋도 argv 에 싣지 않아(#117 stdin 파일) 받지 않는다.
#[derive(Debug, Clone)]
pub struct TurnCommandOptions<'a> {
    pub harness: AgentHarness,
    pub mode: TurnMode,
    pub session_id: Option<&'a str>,
    pub is_first_turn: bool,
    pub system_prompt: &'a str,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub mention_permission: MentionPermission,
    pub mcp_config_path: &'a str,
    pub system_prompt_file: Option<&'a str>,
    pub stdin_file: Option<&'a Path>,
    pub operator_bin: &'a str,
    pub merge_repos: &'a [String],
    pub tool_allows: &'a [String],
    pub command_hook: bool,
    pub post_tool_since_seq: Option<i64>,
    pub chrome: bool,
    pub api_connectors: &'a [String],
    pub api_delegatable: &'a [String],
    pub codex_home: Option<&'a Path>,
    pub opencode_home: Option<&'a Path>,
    pub pi_home: Option<&'a Path>,
    pub readonly_tool_list: Option<&'a str>,
    pub omp_home: Option<&'a Path>,
    pub omp_thread: Option<OmpThread<'a>>,
    pub workspace_dir: Option<&'a Path>,
    pub claude_config_dir: Option<&'a Path>,
    pub cause_message_id: Option<&'a str>,
    pub turn_id: Option<&'a str>,
    pub lane_agent: Option<&'a str>,
    pub provider_env: Option<&'a BTreeMap<String, String>>,
    pub turn_keys: Option<&'a TurnKeys>,
    pub opencode_turn_config: Option<&'a Path>,
    pub command_rule_env: Option<&'a BTreeMap<String, String>>,
}

impl<'a> TurnCommandOptions<'a> {
    /// 빈 값으로 채운 시작점 — 호출부·시험이 필요한 칸만 덮는다.
    pub fn new(
        harness: AgentHarness,
        mode: TurnMode,
        mention_permission: MentionPermission,
        operator_bin: &'a str,
    ) -> Self {
        Self {
            harness,
            mode,
            session_id: None,
            is_first_turn: true,
            system_prompt: "",
            model: None,
            effort: None,
            mention_permission,
            mcp_config_path: "",
            system_prompt_file: None,
            stdin_file: None,
            operator_bin,
            merge_repos: &[],
            tool_allows: &[],
            command_hook: false,
            post_tool_since_seq: None,
            chrome: false,
            api_connectors: &[],
            api_delegatable: &[],
            codex_home: None,
            opencode_home: None,
            pi_home: None,
            readonly_tool_list: None,
            omp_home: None,
            omp_thread: None,
            workspace_dir: None,
            claude_config_dir: None,
            cause_message_id: None,
            turn_id: None,
            lane_agent: None,
            provider_env: None,
            turn_keys: None,
            opencode_turn_config: None,
            command_rule_env: None,
        }
    }
}

/// TS `TurnPlan`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnPlan {
    pub command: &'static str,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub stdin_file: Option<PathBuf>,
    pub cwd: Option<PathBuf>,
}

/// 조립 거절. 하네스·빠진 칸 이름만 싣는다 — 값·경로는 싣지 않는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnCommandError {
    Check(PresetCheckError),
    EmptyOperatorBin,
    /// 하네스 홈 칸이 비었다(`codexHome`·`opencodeHome`·`piHome`·`omp`).
    MissingHome {
        harness: AgentHarness,
        field: &'static str,
    },
    /// omp 의 cwd 가 작업 폴더 안 — 저장소 설정이 실린다(security B4·C2).
    OmpCwdInsideWorkspace,
    /// 읽기 전용 턴에 허용 도구 목록이 없다 — 그대로 뜨면 쓰기·셸이 열린다.
    ReadonlyToolListMissing(AgentHarness),
    TurnKeysNoDelivery(AgentHarness),
    TurnKeysNeedTurnConfig(AgentHarness),
    /// codex API 키 연결 턴(lane 덮어쓰기)은 B3d-4 전까지 조립하지 않는다.
    CodexLanePending,
    Preset(TurnPresetError),
    Env(ChildEnvError),
}

impl fmt::Display for TurnCommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Check(e) => write!(f, "{e}"),
            Self::EmptyOperatorBin => f.write_str(
                "buildTurnCommand: operatorBin 이 비어 있다 — harkroom MCP(mcp-bridge) 없이는 에이전트가 답할 방법이 없다",
            ),
            Self::MissingHome { harness, field } => write!(
                f,
                "buildTurnCommand: {} 의 {field} 가 비어 있다 — 개인 설정을 격리할 수 없다",
                harness.as_str()
            ),
            Self::OmpCwdInsideWorkspace => f.write_str(
                "buildTurnCommand: omp 의 cwd 가 작업 폴더 안에 있다 — 저장소 설정이 실린다(security B4·C2)",
            ),
            Self::ReadonlyToolListMissing(h) => write!(
                f,
                "buildTurnCommand: {} 의 읽기 전용 턴에 허용 도구 목록이 없다 — 그대로 뜨면 쓰기·셸이 열린다",
                h.as_str()
            ),
            Self::TurnKeysNoDelivery(h) => write!(
                f,
                "buildTurnCommand: {} 에는 다리 열쇠를 셸 밖으로 줄 길이 없다 — 턴 열쇠를 주지 마라",
                h.as_str()
            ),
            Self::TurnKeysNeedTurnConfig(h) => write!(
                f,
                "buildTurnCommand: {} 턴 열쇠에는 턴 설정 파일이 있어야 한다",
                h.as_str()
            ),
            Self::CodexLanePending => f.write_str(
                "buildTurnCommand: codex API 키 연결 턴은 아직 Rust 러너가 조립하지 않는다(B3d-4)",
            ),
            Self::Preset(e) => write!(f, "{e}"),
            Self::Env(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for TurnCommandError {}

impl From<PresetCheckError> for TurnCommandError {
    fn from(e: PresetCheckError) -> Self {
        Self::Check(e)
    }
}
impl From<TurnPresetError> for TurnCommandError {
    fn from(e: TurnPresetError) -> Self {
        Self::Preset(e)
    }
}
impl From<ChildEnvError> for TurnCommandError {
    fn from(e: ChildEnvError) -> Self {
        Self::Env(e)
    }
}

fn s(x: &Path) -> String {
    x.to_string_lossy().into_owned()
}

/// 정본 `buildTurnCommand`. `parent_env` 는 러너 env 전체, `home` 은 러너의 홈(`child_env`·gh 자리용).
pub fn build_turn_command(
    o: &TurnCommandOptions<'_>,
    parent_env: &BTreeMap<String, String>,
    home: &Path,
) -> Result<TurnPlan, TurnCommandError> {
    let h = o.harness;
    if preset_of(h).is_none() {
        return Err(PresetCheckError::Unsupported(h).into());
    }
    assert_valid_session(h, o.mode, o.session_id, o.is_first_turn)?;
    if o.operator_bin.is_empty() {
        return Err(TurnCommandError::EmptyOperatorBin);
    }
    let missing = |field| TurnCommandError::MissingHome { harness: h, field };
    if uses_xdg_home(h) && o.opencode_home.is_none() {
        return Err(missing("opencodeHome"));
    }
    if uses_pi_home(h) && o.pi_home.is_none() {
        return Err(missing("piHome"));
    }
    let omp_on = uses_omp_home(h);
    let omp_parts = if omp_on {
        match (o.omp_home, o.omp_thread, o.workspace_dir) {
            (Some(oh), Some(t), Some(ws))
                if !t.cwd.as_os_str().is_empty() && !t.agent_dir.as_os_str().is_empty() =>
            {
                // 정본은 `${cwd}/`.startsWith(`${ws}/`) — 같은 폴더도 안으로 친다. Path::starts_with 는 낱말 단위라 같다.
                if t.cwd.starts_with(ws) {
                    return Err(TurnCommandError::OmpCwdInsideWorkspace);
                }
                Some((oh, t, ws))
            }
            _ => return Err(missing("ompHome·ompThread·workspaceDir")),
        }
    } else {
        None
    };
    let readonly_by_list = readonly_tools_for(h).is_some()
        && o.mode == TurnMode::Mention
        && o.mention_permission == MentionPermission::Readonly;
    if readonly_by_list && o.readonly_tool_list.is_none() {
        return Err(TurnCommandError::ReadonlyToolListMissing(h));
    }
    if h == AgentHarness::Codex && o.codex_home.is_none() {
        return Err(missing("codexHome"));
    }

    let provider_lane = o.provider_env.is_some();
    if o.turn_keys.is_some() {
        match turn_key_delivery_of(h) {
            None => return Err(TurnCommandError::TurnKeysNoDelivery(h)),
            Some(TurnKeyDelivery::TurnConfigEnv) if o.opencode_turn_config.is_none() => {
                return Err(TurnCommandError::TurnKeysNeedTurnConfig(h));
            }
            Some(_) => {}
        }
    }
    let turn_keys = o.turn_keys.is_some();
    let mention = o.mode == TurnMode::Mention;
    let p = o.mention_permission;
    let is_auto = p == MentionPermission::Auto;

    // 하네스별 조각(정본 PRESETS 의 칸). 순서는 아래 `args` 가 정한다.
    struct Parts {
        command: &'static str,
        session: Vec<String>,
        always: Vec<String>,
        permission: Vec<String>,
        rules: Vec<String>,
        chrome: Vec<String>,
        mcp: Vec<String>,
        lane: Vec<String>,
        model: Vec<String>,
        effort: Vec<String>,
        prompt: Vec<String>,
    }
    let rule_args = RuleArgs {
        operator_bin: o.operator_bin,
        merge_repos: o.merge_repos,
        api_connectors: o.api_connectors,
        api_delegatable: o.api_delegatable,
        tool_allows: o.tool_allows,
        claude_config_dir: o.claude_config_dir.and_then(|d| d.to_str()),
        command_hook: o.command_hook,
        provider_lane,
        post_tool_since_seq: o.post_tool_since_seq,
    };
    // 세션 id 없음은 위 `assert_valid_session` 이 「null 이 되는 하네스의 첫 턴」으로만 남겼다.
    let sid = o.session_id.unwrap_or_default();
    let parts = match h {
        AgentHarness::ClaudeCode => Parts {
            command: claude::COMMAND,
            session: claude::session(sid, o.is_first_turn),
            always: claude::always_args(o.mode),
            permission: if mention {
                claude::permission(p, provider_lane)
            } else {
                Vec::new()
            },
            rules: claude::permission_rules(o.mode, p, &rule_args)?,
            chrome: claude::chrome(o.chrome),
            mcp: claude::mcp(o.mcp_config_path),
            lane: Vec::new(),
            model: claude::model(o.model),
            effort: claude::effort(o.effort),
            prompt: claude::prompt(o.system_prompt, o.system_prompt_file)?,
        },
        AgentHarness::Codex => {
            if provider_lane {
                return Err(TurnCommandError::CodexLanePending);
            }
            Parts {
                command: codex::COMMAND,
                session: codex::session(o.session_id, o.mode),
                always: codex::always_args(o.mode),
                permission: if mention {
                    codex::permission(p)
                } else {
                    Vec::new()
                },
                rules: Vec::new(),
                chrome: Vec::new(),
                mcp: codex::mcp(o.operator_bin, turn_keys, &[]),
                lane: Vec::new(),
                model: codex::model(o.model),
                effort: codex::effort(o.effort),
                prompt: codex::prompt(),
            }
        }
        AgentHarness::Opencode | AgentHarness::Kilo => Parts {
            command: if h == AgentHarness::Kilo {
                opencode::KILO_COMMAND
            } else {
                opencode::OPENCODE_COMMAND
            },
            session: opencode::session(o.session_id),
            always: Vec::new(),
            permission: match (mention, provider_lane && is_auto, o.lane_agent) {
                (false, _, _) => Vec::new(),
                (true, true, Some(agent)) => opencode::lane_agent_args(agent),
                (true, true, None) => opencode::lane_permission_auto(),
                (true, false, _) => opencode::permission(p),
            },
            rules: Vec::new(),
            chrome: Vec::new(),
            mcp: Vec::new(),
            lane: Vec::new(),
            model: opencode::model(o.model),
            effort: opencode::effort(o.effort),
            prompt: Vec::new(),
        },
        AgentHarness::Pi => Parts {
            command: pi::COMMAND,
            session: pi::session(sid),
            always: pi::always_args(),
            permission: Vec::new(),
            rules: Vec::new(),
            chrome: Vec::new(),
            mcp: Vec::new(),
            lane: if provider_lane {
                pi::lane_args()
            } else {
                Vec::new()
            },
            model: pi::model(o.model),
            effort: pi::effort(o.effort),
            prompt: pi::prompt(o.system_prompt, o.system_prompt_file)?,
        },
        AgentHarness::Omp => Parts {
            command: omp::COMMAND,
            session: omp::session(sid),
            always: omp::always_args(),
            permission: Vec::new(),
            rules: Vec::new(),
            chrome: Vec::new(),
            mcp: Vec::new(),
            lane: Vec::new(),
            model: omp::model(o.model),
            effort: omp::effort(o.effort),
            prompt: omp::prompt(o.system_prompt, o.system_prompt_file)?,
        },
        AgentHarness::Gemini => return Err(PresetCheckError::Unsupported(h).into()),
    };

    let mut args = Vec::new();
    args.extend(parts.session);
    args.extend(parts.always);
    args.extend(parts.permission);
    args.extend(parts.rules);
    if readonly_by_list {
        args.push("--tools".into());
        args.push(o.readonly_tool_list.unwrap_or_default().into());
    }
    args.extend(parts.chrome);
    // pi 의 세션 자리는 저장소가 정할 수 있다 — CLI 인자로 러너 루트에 못박는다(security U1).
    if let (true, Some(ph)) = (uses_pi_home(h), o.pi_home) {
        args.push("--session-dir".into());
        args.push(s(&pi_sessions_dir(ph)));
    }
    // omp: 세션 자리·오버레이·작업 폴더를 상태 루트로 못박는다(security B4·C4).
    if let Some((oh, t, ws)) = omp_parts {
        let d = omp_dirs(oh);
        args.extend([
            "--session-dir".into(),
            s(&d.sessions_dir),
            "--config".into(),
            s(&d.overlay),
            "--cwd".into(),
            s(t.cwd),
            "--add-dir".into(),
            s(ws),
        ]);
    }
    args.extend(parts.mcp);
    args.extend(parts.lane);
    args.extend(parts.model);
    args.extend(parts.effort);
    args.extend(parts.prompt);

    // PAT·턴 열쇠는 argv 에 올리지 않는다 — 자식 env 로만(spec §7).
    let gh = lane_gh_config_dir(
        h,
        provider_lane,
        o.tool_allows,
        parent_env.get("XDG_CONFIG_HOME").map(String::as_str),
        home,
    );
    let mut input = ChildEnvInput::new(h);
    input.codex_home = if h == AgentHarness::Codex {
        o.codex_home
    } else {
        None
    };
    input.opencode_home = if uses_xdg_home(h) {
        o.opencode_home
    } else {
        None
    };
    input.pi_home = if uses_pi_home(h) { o.pi_home } else { None };
    input.omp_home = omp_parts.map(|(oh, _, _)| oh);
    input.omp_agent_dir = omp_parts.map(|(_, t, _)| t.agent_dir);
    input.claude_config_dir = if h == AgentHarness::ClaudeCode {
        o.claude_config_dir
    } else {
        None
    };
    input.cause_message_id = o.cause_message_id;
    input.turn_id = o.turn_id;
    input.provider_env = o.provider_env;
    input.gh_config_dir = gh.as_deref();
    input.turn_keys = o.turn_keys;
    input.opencode_turn_config = o.opencode_turn_config;
    let mut env = child_env(&input, parent_env, home)?;
    // 하네스 MCP env(codex `codexBearerEnv`)는 추가 MCP 와 함께 B3d-4 — 지금은 추가 MCP 를 받지 않으므로 비어 있다.
    if let Some(extra) = o.command_rule_env {
        env.extend(extra.iter().map(|(k, v)| (k.clone(), v.clone())));
    }

    Ok(TurnPlan {
        command: parts.command,
        args,
        env,
        stdin_file: o.stdin_file.map(Path::to_path_buf),
        cwd: omp_parts.map(|(_, t, _)| t.cwd.to_path_buf()),
    })
}

#[cfg(test)]
#[path = "turn_command_tests.rs"]
mod tests;
