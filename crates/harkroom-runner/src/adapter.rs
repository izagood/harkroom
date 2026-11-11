//! 하네스 어댑터 표(정본 `packages/agent/src/adapters/*` — contract·claudeCode·codex·opencode·kilo·pi·omp·index).
//!
//! 러너가 하네스에 대해 아는 **값**(실행 파일·화면 정규식·신뢰 장부·계정 축·XDG 이름·읽기 전용 도구)만 담는다.
//! 판정 로직은 쓰는 자리(`pty.rs` 등)에 두고, 이 표는 그 재료만 선언한다 — 정본 `contract.ts` 의 약속과 같다.
//! 정규식은 정본 문자열을 그대로 옮겼고 동일성은 아래 시험이 실물 화면 조각으로 잰다(같은 판정을 내는가).
//! 하네스 홈(codex·opencode·pi·omp)과 작업 폴더 신뢰는 B3c 다음 조각이다.

use std::sync::LazyLock;

use regex::Regex;

use crate::pty::DEFAULT_GATE_PATTERN;

/// 하네스 값(`@harkroom/shared` 의 `AgentHarness`). 와이어 이름은 [`AgentHarness::as_str`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentHarness {
    ClaudeCode,
    Codex,
    Opencode,
    Kilo,
    Pi,
    Omp,
    Gemini,
}

impl AgentHarness {
    pub const ALL: [AgentHarness; 7] = [
        Self::ClaudeCode,
        Self::Codex,
        Self::Opencode,
        Self::Kilo,
        Self::Pi,
        Self::Omp,
        Self::Gemini,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::Kilo => "kilo",
            Self::Pi => "pi",
            Self::Omp => "omp",
            Self::Gemini => "gemini",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|h| h.as_str() == s)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionModel {
    Tui,
    Exec,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Mention,
    Interactive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MentionPermission {
    Auto,
    Readonly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustKind {
    ClaudeJson,
    CodexToml,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustRoot {
    AccountConfigDir,
    CodexHome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustLedger {
    pub kind: TrustKind,
    pub root: TrustRoot,
    pub file: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptLayout {
    Flat,
    ByDate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptSource {
    Files {
        dir_under_config: &'static str,
        layout: TranscriptLayout,
        file_name: &'static str,
        parsed: bool,
    },
    Cli {
        list: &'static [&'static str],
        export: &'static [&'static str],
        stats: Option<&'static [&'static str]>,
        parsed: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadonlyTools {
    pub builtins: &'static [&'static str],
    pub mcp_servers: &'static [&'static str],
    pub list: Option<&'static [&'static str]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct XdgApp {
    pub dir: &'static str,
    pub config_file: &'static str,
    pub schema: &'static str,
    pub user_config_files: &'static [&'static str],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountAxis {
    pub config_dir_env: &'static [&'static str],
    pub pooled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpRegistration {
    ConfigFile,
    CliOverrides,
    AccountConfig,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnKeyDelivery {
    McpConfigEnv,
    EnvVars,
    TurnConfigEnv,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandRules {
    CodexExecpolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemPromptDelivery {
    FlagFile,
    PromptPrefix,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LastSaidRecord {
    CodexRollout,
    OpencodeExport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnEndRecord {
    CodexRollout,
    OmpSession,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effort {
    Flag(&'static str),
    ConfigOverride(&'static str),
}

/// 화면 계약(정본 `HarnessAdapter.screen`). 정규식은 프로세스 수명 동안 한 번만 만든다.
pub struct Screen {
    pub ready: &'static Regex,
    pub gate: &'static Regex,
    pub gate_measured: bool,
    pub busy: Option<&'static Regex>,
    pub ready_min_ms: Option<u64>,
    pub unsent_hint: Option<&'static Regex>,
}

/// 하네스 하나에 대해 러너가 아는 사실 전부(정본 `HarnessAdapter`). 필드 뜻은 정본 주석을 따른다.
pub struct HarnessAdapter {
    pub harness: AgentHarness,
    pub command: &'static str,
    pub execution_mention: ExecutionModel,
    pub execution_interactive: ExecutionModel,
    pub screen: Screen,
    pub trust: Option<TrustLedger>,
    pub mcp_registration: McpRegistration,
    pub waits_for_mcp_before_prompt: bool,
    pub turn_key_delivery: Option<TurnKeyDelivery>,
    pub command_rules: Option<CommandRules>,
    pub system_prompt_delivery: SystemPromptDelivery,
    pub allows_null_session_on_first_turn: bool,
    pub supported_mention_permissions: &'static [MentionPermission],
    pub transcript: Option<TranscriptSource>,
    pub last_said_record: Option<LastSaidRecord>,
    pub turn_end_record: Option<TurnEndRecord>,
    pub file_memory_dir_under_config: Option<&'static str>,
    pub account: Option<AccountAxis>,
    pub xdg_app: Option<XdgApp>,
    pub readonly_tools: Option<ReadonlyTools>,
    pub effort: Option<Effort>,
    pub skill_dirs: &'static [&'static str],
    pub interactive_handoff: bool,
    pub review_fork: bool,
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("adapter pattern")
}

static CLAUDE_READY: LazyLock<Regex> = LazyLock::new(|| re(r"[❯›]\x{a0}"));
static CLAUDE_UNSENT: LazyLock<Regex> = LazyLock::new(|| re(r"❯\s*\[Pasted\s*text\s*#\d+[^❯]*$"));
static CODEX_READY: LazyLock<Regex> = LazyLock::new(|| re(r"Ask\s+\S+\s+to\s+do\s+anything"));
static CODEX_BUSY: LazyLock<Regex> = LazyLock::new(|| re(r"esc to interrupt"));
static CODEX_UNSENT: LazyLock<Regex> = LazyLock::new(|| re(r"tab to queue message"));
static OPENCODE_READY: LazyLock<Regex> = LazyLock::new(|| re(r"Ask anything|ctrl\+p"));
static OPENCODE_BUSY: LazyLock<Regex> = LazyLock::new(|| re(r"esc interrupt"));
static PI_READY: LazyLock<Regex> = LazyLock::new(|| re(r"\d+(?:\.\d+)?%/\d+(?:\.\d+)?[kM]\b"));
static PI_BUSY: LazyLock<Regex> = LazyLock::new(|| re(r"─+ [\x{2800}-\x{28ff}] Working"));
static OMP_READY: LazyLock<Regex> =
    LazyLock::new(|| re(r"\d+(?:\.\d+)?%[^\n]*?\b\d+(?:\.\d+)?[KM]\b"));
static OMP_BUSY: LazyLock<Regex> = LazyLock::new(|| re(r"Working…|[\x{2800}-\x{28ff}] \d+s >"));
/// 정본 `screenGateFor` 의 `/(?!)/` — 어떤 화면에도 안 맞는다.
static NEVER: LazyLock<Regex> = LazyLock::new(|| re(r"[^\s\S]"));

const AUTO_READONLY: &[MentionPermission] = &[MentionPermission::Auto, MentionPermission::Readonly];
const XDG_ENV: &[&str] = &["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"];
const OPENCODE_CLI: TranscriptSource = TranscriptSource::Cli {
    list: &["session", "list", "--format", "json"],
    export: &["export", "<id>"],
    stats: Some(&["stats"]),
    parsed: false,
};

static CLAUDE_CODE: LazyLock<HarnessAdapter> = LazyLock::new(|| HarnessAdapter {
    harness: AgentHarness::ClaudeCode,
    command: "claude",
    execution_mention: ExecutionModel::Tui,
    execution_interactive: ExecutionModel::Tui,
    screen: Screen {
        ready: &CLAUDE_READY,
        gate: &DEFAULT_GATE_PATTERN,
        gate_measured: true,
        busy: None,
        ready_min_ms: None,
        unsent_hint: Some(&CLAUDE_UNSENT),
    },
    trust: Some(TrustLedger {
        kind: TrustKind::ClaudeJson,
        root: TrustRoot::AccountConfigDir,
        file: ".claude.json",
    }),
    mcp_registration: McpRegistration::ConfigFile,
    waits_for_mcp_before_prompt: true,
    turn_key_delivery: Some(TurnKeyDelivery::McpConfigEnv),
    command_rules: None,
    system_prompt_delivery: SystemPromptDelivery::FlagFile,
    allows_null_session_on_first_turn: false,
    supported_mention_permissions: AUTO_READONLY,
    transcript: Some(TranscriptSource::Files {
        dir_under_config: "projects",
        layout: TranscriptLayout::Flat,
        file_name: "<id>.jsonl",
        parsed: true,
    }),
    last_said_record: None,
    turn_end_record: None,
    file_memory_dir_under_config: Some("projects"),
    account: Some(AccountAxis {
        config_dir_env: &["CLAUDE_CONFIG_DIR"],
        pooled: true,
    }),
    xdg_app: None,
    readonly_tools: None,
    effort: Some(Effort::Flag("--effort")),
    skill_dirs: &[".claude/skills"],
    interactive_handoff: true,
    review_fork: true,
});

static CODEX: LazyLock<HarnessAdapter> = LazyLock::new(|| HarnessAdapter {
    harness: AgentHarness::Codex,
    command: "codex",
    execution_mention: ExecutionModel::Tui,
    execution_interactive: ExecutionModel::Tui,
    screen: Screen {
        ready: &CODEX_READY,
        gate: &DEFAULT_GATE_PATTERN,
        gate_measured: false,
        busy: Some(&CODEX_BUSY),
        ready_min_ms: Some(2_500),
        unsent_hint: Some(&CODEX_UNSENT),
    },
    trust: Some(TrustLedger {
        kind: TrustKind::CodexToml,
        root: TrustRoot::CodexHome,
        file: "config.toml",
    }),
    mcp_registration: McpRegistration::CliOverrides,
    waits_for_mcp_before_prompt: false,
    turn_key_delivery: Some(TurnKeyDelivery::EnvVars),
    command_rules: Some(CommandRules::CodexExecpolicy),
    system_prompt_delivery: SystemPromptDelivery::PromptPrefix,
    allows_null_session_on_first_turn: true,
    supported_mention_permissions: AUTO_READONLY,
    transcript: Some(TranscriptSource::Files {
        dir_under_config: "sessions",
        layout: TranscriptLayout::ByDate,
        file_name: "rollout-<ts>-<id>.jsonl",
        parsed: false,
    }),
    last_said_record: Some(LastSaidRecord::CodexRollout),
    turn_end_record: Some(TurnEndRecord::CodexRollout),
    file_memory_dir_under_config: None,
    account: Some(AccountAxis {
        config_dir_env: &["CODEX_HOME"],
        pooled: false,
    }),
    xdg_app: None,
    readonly_tools: None,
    effort: Some(Effort::ConfigOverride("model_reasoning_effort")),
    skill_dirs: &[".agents/skills"],
    interactive_handoff: false,
    review_fork: false,
});

fn opencode_like(
    harness: AgentHarness,
    command: &'static str,
    turn_key_delivery: Option<TurnKeyDelivery>,
    last_said_record: Option<LastSaidRecord>,
    xdg_app: XdgApp,
) -> HarnessAdapter {
    HarnessAdapter {
        harness,
        command,
        execution_mention: ExecutionModel::Tui,
        execution_interactive: ExecutionModel::Tui,
        screen: Screen {
            ready: &OPENCODE_READY,
            gate: &DEFAULT_GATE_PATTERN,
            gate_measured: false,
            busy: Some(&OPENCODE_BUSY),
            ready_min_ms: None,
            unsent_hint: None,
        },
        trust: None,
        mcp_registration: McpRegistration::AccountConfig,
        waits_for_mcp_before_prompt: false,
        turn_key_delivery,
        command_rules: None,
        system_prompt_delivery: SystemPromptDelivery::PromptPrefix,
        allows_null_session_on_first_turn: true,
        supported_mention_permissions: AUTO_READONLY,
        transcript: Some(OPENCODE_CLI),
        last_said_record,
        turn_end_record: None,
        file_memory_dir_under_config: None,
        account: Some(AccountAxis {
            config_dir_env: XDG_ENV,
            pooled: false,
        }),
        xdg_app: Some(xdg_app),
        readonly_tools: None,
        effort: Some(Effort::Flag("--variant")),
        skill_dirs: &[],
        interactive_handoff: false,
        review_fork: false,
    }
}

static OPENCODE: LazyLock<HarnessAdapter> = LazyLock::new(|| {
    opencode_like(
        AgentHarness::Opencode,
        "opencode",
        Some(TurnKeyDelivery::TurnConfigEnv),
        Some(LastSaidRecord::OpencodeExport),
        XdgApp {
            dir: "opencode",
            config_file: "opencode.jsonc",
            schema: "https://opencode.ai/config.json",
            user_config_files: &["opencode.json"],
        },
    )
});

/// opencode 포크. 정본 `KILO_ADAPTER` 가 `turnKeyDelivery`·`lastSaidRecord` 를 비우고 XDG 이름만 바꾼 것과 같다.
static KILO: LazyLock<HarnessAdapter> = LazyLock::new(|| {
    opencode_like(
        AgentHarness::Kilo,
        "kilo",
        None,
        None,
        XdgApp {
            dir: "kilo",
            config_file: "kilo.jsonc",
            schema: "https://app.kilo.ai/config.json",
            user_config_files: &["kilo.jsonc", "kilo.json"],
        },
    )
});

static PI: LazyLock<HarnessAdapter> = LazyLock::new(|| HarnessAdapter {
    harness: AgentHarness::Pi,
    command: "pi",
    execution_mention: ExecutionModel::Tui,
    execution_interactive: ExecutionModel::Tui,
    screen: Screen {
        ready: &PI_READY,
        gate: &DEFAULT_GATE_PATTERN,
        gate_measured: false,
        busy: Some(&PI_BUSY),
        ready_min_ms: Some(1_000),
        unsent_hint: None,
    },
    trust: None,
    mcp_registration: McpRegistration::AccountConfig,
    waits_for_mcp_before_prompt: false,
    turn_key_delivery: None,
    command_rules: None,
    system_prompt_delivery: SystemPromptDelivery::FlagFile,
    allows_null_session_on_first_turn: false,
    supported_mention_permissions: AUTO_READONLY,
    transcript: None,
    last_said_record: None,
    turn_end_record: None,
    file_memory_dir_under_config: None,
    account: Some(AccountAxis {
        config_dir_env: &["PI_CODING_AGENT_DIR"],
        pooled: false,
    }),
    xdg_app: None,
    readonly_tools: Some(ReadonlyTools {
        builtins: &["read", "grep", "find", "ls"],
        mcp_servers: &["harkroom"],
        list: Some(&["mcp", "list", "--json"]),
    }),
    effort: Some(Effort::Flag("--thinking")),
    skill_dirs: &[],
    interactive_handoff: false,
    review_fork: false,
});

static OMP: LazyLock<HarnessAdapter> = LazyLock::new(|| HarnessAdapter {
    harness: AgentHarness::Omp,
    command: "omp",
    execution_mention: ExecutionModel::Tui,
    execution_interactive: ExecutionModel::Tui,
    screen: Screen {
        ready: &OMP_READY,
        gate: &DEFAULT_GATE_PATTERN,
        gate_measured: false,
        busy: Some(&OMP_BUSY),
        ready_min_ms: Some(1_000),
        unsent_hint: None,
    },
    trust: None,
    mcp_registration: McpRegistration::AccountConfig,
    waits_for_mcp_before_prompt: false,
    turn_key_delivery: None,
    command_rules: None,
    system_prompt_delivery: SystemPromptDelivery::FlagFile,
    allows_null_session_on_first_turn: false,
    supported_mention_permissions: AUTO_READONLY,
    transcript: None,
    last_said_record: None,
    turn_end_record: Some(TurnEndRecord::OmpSession),
    file_memory_dir_under_config: None,
    account: Some(AccountAxis {
        config_dir_env: &["PI_CODING_AGENT_DIR", "HOME"],
        pooled: false,
    }),
    xdg_app: None,
    readonly_tools: Some(ReadonlyTools {
        builtins: &["read", "grep", "glob"],
        mcp_servers: &["harkroom"],
        list: None,
    }),
    effort: Some(Effort::Flag("--thinking")),
    skill_dirs: &[],
    interactive_handoff: false,
    review_fork: false,
});

/// 표 조회(정본 `ADAPTERS[harness]`). `None` 은 `'unsupported'`(gemini).
pub fn adapter(harness: AgentHarness) -> Option<&'static HarnessAdapter> {
    match harness {
        AgentHarness::ClaudeCode => Some(&CLAUDE_CODE),
        AgentHarness::Codex => Some(&CODEX),
        AgentHarness::Opencode => Some(&OPENCODE),
        AgentHarness::Kilo => Some(&KILO),
        AgentHarness::Pi => Some(&PI),
        AgentHarness::Omp => Some(&OMP),
        AgentHarness::Gemini => None,
    }
}

/// 어댑터가 없는 하네스를 부른 오류(정본 `adapterFor` 의 throw). 문구에 경로·화면 원문은 없다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unsupported(pub AgentHarness);

impl std::fmt::Display for Unsupported {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "adapter_for: {} has no adapter (caller did not check runnable harnesses)",
            self.0.as_str()
        )
    }
}

impl std::error::Error for Unsupported {}

/// 정본 `adapterFor`.
pub fn adapter_for(harness: AgentHarness) -> Result<&'static HarnessAdapter, Unsupported> {
    adapter(harness).ok_or(Unsupported(harness))
}

// ── 정본 index.ts 의 조회 함수들. 어댑터 없는 하네스의 값은 정본과 같게 둔다. ──────────

pub fn reads_session_transcript(h: AgentHarness) -> bool {
    matches!(
        adapter(h).and_then(|a| a.transcript),
        Some(TranscriptSource::Files { parsed: true, .. })
    )
}

pub fn execution_model_for(h: AgentHarness, mode: Mode) -> Result<ExecutionModel, Unsupported> {
    let a = adapter_for(h)?;
    Ok(match mode {
        Mode::Mention => a.execution_mention,
        Mode::Interactive => a.execution_interactive,
    })
}

pub fn uses_tui_for_mention(h: AgentHarness) -> Result<bool, Unsupported> {
    Ok(execution_model_for(h, Mode::Mention)? == ExecutionModel::Tui)
}

pub fn prefixes_system_prompt(h: AgentHarness) -> Result<bool, Unsupported> {
    Ok(adapter_for(h)?.system_prompt_delivery == SystemPromptDelivery::PromptPrefix)
}

pub fn file_memory_dir_under_config(h: AgentHarness) -> Option<&'static str> {
    adapter(h).and_then(|a| a.file_memory_dir_under_config)
}

pub fn supports_review_fork(h: AgentHarness) -> bool {
    adapter(h).is_some_and(|a| a.review_fork)
}

pub fn has_account_pool(h: AgentHarness) -> Result<bool, Unsupported> {
    Ok(adapter_for(h)?.account.is_some_and(|a| a.pooled))
}

pub fn discovers_session_id_after_turn(h: AgentHarness) -> Result<bool, Unsupported> {
    Ok(adapter_for(h)?.allows_null_session_on_first_turn)
}

/// 정본 `injectionFactsFor`. `readyMinMs` 0 은 정본처럼 "없음"으로 친다.
pub struct InjectionFacts {
    pub ready_pattern: &'static Regex,
    pub ready_min_ms: Option<u64>,
    pub unsent_hint: Option<&'static Regex>,
}

pub fn injection_facts_for(h: AgentHarness) -> Result<InjectionFacts, Unsupported> {
    let s = &adapter_for(h)?.screen;
    Ok(InjectionFacts {
        ready_pattern: s.ready,
        ready_min_ms: s.ready_min_ms.filter(|ms| *ms > 0),
        unsent_hint: s.unsent_hint,
    })
}

pub struct ScreenIdleFacts {
    pub ready: &'static Regex,
    pub busy: &'static Regex,
    pub gate: &'static Regex,
}

/// 정본 `screenIdleFactsFor` — `busy` 가 있는 하네스만 화면으로 끝을 읽는다.
pub fn screen_idle_facts_for(h: AgentHarness) -> Option<ScreenIdleFacts> {
    let s = &adapter(h)?.screen;
    Some(ScreenIdleFacts {
        ready: s.ready,
        busy: s.busy?,
        gate: s.gate,
    })
}

pub fn screen_gate_for(h: AgentHarness) -> &'static Regex {
    adapter(h).map_or(&*NEVER, |a| a.screen.gate)
}

pub fn command_rules_of(h: AgentHarness) -> Option<CommandRules> {
    adapter(h).and_then(|a| a.command_rules)
}

pub fn turn_key_delivery_of(h: AgentHarness) -> Option<TurnKeyDelivery> {
    adapter(h).and_then(|a| a.turn_key_delivery)
}

pub fn waits_for_mcp_before_prompt(h: AgentHarness) -> Result<bool, Unsupported> {
    Ok(adapter_for(h)?.waits_for_mcp_before_prompt)
}

pub fn harness_command(h: AgentHarness) -> Result<&'static str, Unsupported> {
    Ok(adapter_for(h)?.command)
}

pub fn last_said_record_of(h: AgentHarness) -> Option<LastSaidRecord> {
    adapter(h).and_then(|a| a.last_said_record)
}

pub fn turn_end_record_of(h: AgentHarness) -> Option<TurnEndRecord> {
    adapter(h).and_then(|a| a.turn_end_record)
}

fn config_dir_env_of(h: AgentHarness) -> &'static [&'static str] {
    adapter(h)
        .and_then(|a| a.account)
        .map_or(&[], |a| a.config_dir_env)
}

pub fn uses_xdg_home(h: AgentHarness) -> bool {
    config_dir_env_of(h).contains(&"XDG_CONFIG_HOME")
}

pub fn reads_builtin_skills(h: AgentHarness, read_only: bool) -> bool {
    !read_only && adapter(h).is_some_and(|a| !a.skill_dirs.is_empty())
}

pub fn readonly_tools_for(h: AgentHarness) -> Option<ReadonlyTools> {
    adapter(h).and_then(|a| a.readonly_tools)
}

pub fn uses_pi_home(h: AgentHarness) -> bool {
    let env = config_dir_env_of(h);
    env.contains(&"PI_CODING_AGENT_DIR") && !env.contains(&"HOME")
}

pub fn uses_omp_home(h: AgentHarness) -> bool {
    let env = config_dir_env_of(h);
    env.contains(&"PI_CODING_AGENT_DIR") && env.contains(&"HOME")
}

pub fn xdg_app_for(h: AgentHarness) -> Option<XdgApp> {
    adapter(h).and_then(|a| a.xdg_app)
}

/// 정본 `allXdgApps` — 표 순서대로.
pub fn all_xdg_apps() -> Vec<XdgApp> {
    AgentHarness::ALL
        .into_iter()
        .filter_map(xdg_app_for)
        .collect()
}

#[cfg(test)]
mod tests;
