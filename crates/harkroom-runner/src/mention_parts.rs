//! 대상별 `AttemptParts` 실물 — `MentionParts`. 앞 조각들을 한 struct 로 잇는다.
//!
//! - `prepare`: [`AttemptAccount::of`] → [`prepare_turn`](기록·세션·스레드·부른 글·턴 프롬프트) + [`turn_wake_of`] →
//!   [`write_turn_system_prompt`](0600·링크 안 따라감) → [`AttemptPrep`](기록 찾기 자리는 이 시도 계정 폴더).
//! - 명령: [`MentionParts::command_for`] = [`attempt_command_for_account`](시도 칸 → 계정 폴더 마지막).
//! - `spawn`: 그 명령으로 [`spawn_pty_turn`]. sink 는 `WatchSink(DeliveredSink(안쪽))`, 중계 세션이 있으면 `RelaySink` 로
//!   한 겹 더. 턴 프롬프트는 주입 글(`inject.text`)로만 간다.
//! - `outcome`·`after`·`mount_secrets`: 부르는 쪽이 넣은 닫개(`fold_outcome`·`run_after_turn`·임대 마운트)에 넘긴다.
//!   `outcome` 은 감시 자리의 끝 상태 사본을 받는다.
//! - `bind_live`: 멘션 슬롯([`LiveSlot`]), `account_ranks`: [`account_ranks`](순번만).
//!
//! - 감시 루프: `spawn` 이 PTY 를 도는 동안 [`run_beside`] 로 옆 스레드에서 `watch_loop` 을 돈다 — 그 시도의 자리와 감시 목록으로.
//!
//! B4-5 스위치는 이 조각 밖이다.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::account_assign::ClaudeAccount;
use crate::memory_pin::MemoryContext;
use crate::mention_run::TurnOk;
use crate::mention_target::MentionTarget;
use crate::prompt_system::{ApiOpts, MergeApproved, MergeOpts, PermissionOpts, SystemPromptOpts};
use crate::prompt_turn::TurnClock;
use crate::pty_turn::{InjectPrompt, PtyTurnOptions, PtyTurnSink};
use crate::session_store::SessionStore;
use crate::turn_assemble::{DeliveredSink, PtyTurnArgs, spawn_pty_turn};
use crate::turn_attempt::{Attempted, TurnSecrets};
use crate::turn_attempt_account::{
    AttemptAccount, LaneSnapshot, LiveSlot, account_ranks as ranks_of,
};
use crate::turn_attempt_live::LiveTurn;
use crate::turn_attempt_relay::RelaySink;
use crate::turn_attempt_run::{AttemptParts, AttemptPrep, OwnedHomes, SpawnArgs};
use crate::turn_command::TurnCommandOptions;
use crate::turn_end::EndState;
use crate::turn_launch_io::SecretMountError;
use crate::turn_parts::{attempt_command_for_account, turn_wake_of, write_turn_system_prompt};
use crate::turn_policy::AttemptError;
use crate::turn_prep::AccountAxis;
use crate::turn_prepare::{PrepareInput, PrepareIo, Prepared, prepare_turn};
use crate::turn_probe_records::NoticeSecrets;
use crate::turn_run::PtyOut;
use crate::turn_watch::{Watch, WatchSink};

/// 준비 실패 문장(종류만).
pub const PREPARE_FAILED: &str = "턴을 준비하지 못했다(스레드 읽기 또는 지시문 파일)";

/// 지시문 재료(서버에서 읽어 둔 것).
pub struct SystemInputs {
    pub handle: String,
    pub channel_name: String,
    pub instructions: String,
    pub guide: String,
    pub memory: MemoryContext,
    pub read_only: bool,
    /// 턴 예산(없으면 예산 문장을 뺀다).
    pub turn_budget_ms: Option<u64>,
    /// 머지 절(없으면 뺀다).
    pub merge: Option<MergeInputs>,
    /// 권한 요청 절(없으면 뺀다).
    pub permissions: Option<PermissionInputs>,
    /// 외부 API 절(없으면 뺀다).
    pub api: Option<ApiInputs>,
    pub secret_create: bool,
    /// API 키 레인의 모델 ID.
    pub lane_model: Option<String>,
}

/// 머지 절 재료(정본 `merge`).
#[derive(Clone, Debug, Default)]
pub struct MergeInputs {
    pub operator_bin: String,
    pub repos: Vec<String>,
    pub approved: Vec<MergeApproved>,
}

/// 권한 요청 절 재료(정본 `permissions`).
#[derive(Clone, Debug, Default)]
pub struct PermissionInputs {
    pub tool_allows: Vec<String>,
    /// 이 에이전트의 모든 채널 승인 규칙의 합(서버 `reach`, 안전한 것만). `None` = 옛 서버 — codex 규칙 파일을 쓰지 않는다.
    pub reach: Option<Vec<String>>,
    pub command_hook: bool,
    pub exact_shell_only: bool,
    pub new_posts_hook: bool,
}

/// 외부 API 절 재료(정본 `api`).
#[derive(Clone, Debug, Default)]
pub struct ApiInputs {
    pub operator_bin: String,
    pub connectors: Vec<String>,
    pub delegatable: Vec<String>,
}

impl SystemInputs {
    /// 정본 `buildSystemPrompt` 의 opts.
    pub fn opts(&self) -> SystemPromptOpts<'_> {
        SystemPromptOpts {
            handle: &self.handle,
            channel_name: &self.channel_name,
            instructions: &self.instructions,
            guide: &self.guide,
            memory: &self.memory,
            turn_budget_ms: self.turn_budget_ms,
            merge: self.merge.as_ref().map(|m| MergeOpts {
                operator_bin: &m.operator_bin,
                repos: &m.repos,
                approved: &m.approved,
            }),
            permissions: self.permissions.as_ref().map(|p| PermissionOpts {
                tool_allows: &p.tool_allows,
                command_hook: p.command_hook,
                exact_shell_only: p.exact_shell_only,
                new_posts_hook: p.new_posts_hook,
            }),
            api: self.api.as_ref().map(|a| ApiOpts {
                operator_bin: &a.operator_bin,
                connectors: &a.connectors,
                delegatable: &a.delegatable,
            }),
            secret_create: self.secret_create,
            lane_model: self.lane_model.as_deref(),
            read_only: self.read_only,
        }
    }
}

/// 감시 루프가 받는 **이 시도의** 문맥 — 시도마다 바뀌는 값은 모두 여기로 인자로 온다(security ②-3c 조건 ①). 루프·짓개는
/// 이 값을 바깥에 붙잡아 두지 않는다.
#[derive(Clone, Debug, Default)]
pub struct LoopCtx {
    pub turn_id: String,
    /// 이 시도가 이어 쓰는(또는 새로 여는) 하네스 세션 id. 첫 턴은 모를 수 있다.
    pub session_id: Option<String>,
    /// 띄운 시각(정본 `turnStartedAtMs`) — 기록은 이 뒤 것만 본다.
    pub turn_started_at_ms: i64,
    /// 이 턴에 먹인 스레드의 마지막 seq(정본 `turnStartSeq`) — 내 발화는 이 뒤 글만 센다.
    pub turn_start_seq: i64,
    /// **이 시도의** 계정 폴더(`AttemptAccount::config_dir`) — 기록 읽개는 이 폴더만 본다(#2039 와 같은 경계).
    pub claude_config_dir: Option<PathBuf>,
    /// **이 시도의** 「턴이 끝났다」 신호 — 시도마다 새로 짓는다. [`run_beside`] 가 PTY 턴이 끝날 때(정상·패닉 모두) 세운다.
    pub ended: Arc<AtomicBool>,
}

/// 정본 `confirmDelivery.withinMs` 기본값 — 주입 뒤 이만큼 증거가 없으면 개행을 한 번 더 친다.
pub const CONFIRM_DELIVERY_WITHIN_MS: u64 = 15_000;

/// 이 시도의 PTY 옵션(정본 `mentionTurn.ts` 가 `runTurn` 에 넘기는 값):
/// - `cwd` = 그 기록의 작업 폴더(`rec.workspaceDir`). 비었거나 상대 경로면 `Err` — 띄우지 않는다. pi·omp 의 턴 집(정본
///   `plan.cwd ?? rec.workspaceDir`)은 계획(`PtyPlan`)이 아직 `cwd` 를 나르지 않아 후속 PR 몫이다.
/// - `timeout_ms` = TUI 면 0(무기한 — 시한은 무발화 시계), 아니면 `turn_timeout_ms`.
/// - `inject` = TUI 면 이 시도의 프롬프트와 어댑터 표의 준비 표지(`injection_facts_for`), 아니면 없음(`exec` 은 stdin 이 프롬프트).
/// - 크기·유예·묶음·기록 자리는 `base`(정본 기본값) 그대로.
pub fn attempt_pty_options(
    base: PtyTurnOptions,
    harness: crate::adapter::AgentHarness,
    workspace_dir: &str,
    prompt: String,
    turn_timeout_ms: u64,
) -> Result<PtyTurnOptions, &'static str> {
    let cwd = PathBuf::from(workspace_dir);
    crate::pty_turn::check_spawn_cwd(&cwd)?;
    let tui =
        crate::adapter::uses_tui_for_mention(harness).map_err(|_| "이 하네스는 어댑터가 없다")?;
    let inject = if tui {
        let facts = crate::adapter::injection_facts_for(harness)
            .map_err(|_| "이 하네스는 어댑터가 없다")?;
        let mut i = InjectPrompt {
            text: prompt,
            ready_pattern: Some(facts.ready_pattern.clone()),
            unsent_hint: facts.unsent_hint.cloned(),
            ..InjectPrompt::default()
        };
        if let Some(ms) = facts.ready_min_ms {
            i.ready_min_ms = ms;
        }
        // 사람을 부를 수 있다(정본 `onAttention: callHuman`) — 준비 대기가 확인 창·선택 화면에서 실패로 접히지 않고 사람을 부른다.
        i.attention = true;
        // 주입이 먹혔는지 잰다(정본 `confirmDelivery`, 기본 `withinMs` 15초) — 증거는 `MarkerSink::confirm` 이 답한다.
        i.confirm = Some(crate::pty_turn::ConfirmDelivery {
            within_ms: CONFIRM_DELIVERY_WITHIN_MS,
            resend_grace_ms: None,
        });
        Some(i)
    } else {
        None
    };
    Ok(PtyTurnOptions {
        cwd,
        timeout_ms: if tui { 0 } else { turn_timeout_ms },
        inject,
        ..base
    })
}

/// 감시 루프 몸통 — 이 시도의 감시 자리·감시 통지 가림 목록·시도 문맥·멈춤 신호를 받아 `run_watch`(실물 `ProbeIo`)를 돈다.
pub type WatchLoopFn<'a> =
    Box<dyn Fn(&Watch, &NoticeSecrets, &LoopCtx, &AtomicBool) + Send + Sync + 'a>;

/// `f`(PTY 턴)를 도는 동안 감시 루프를 옆 스레드에서 돈다 — 넘긴 `watch` 는 **그 시도의 자리**다. `f` 가 끝나면 멈춤 신호를
/// 세우고 루프가 끝날 때까지 기다린다(시도 범위를 넘지 않는다).
pub fn run_beside<R>(
    watch: &Watch,
    notice: &NoticeSecrets,
    ctx: &LoopCtx,
    watch_loop: Option<&WatchLoopFn<'_>>,
    f: impl FnOnce() -> R,
) -> R {
    /// 떨어질 때(정상 끝·패닉 풀림 모두) 멈춤 신호를 세운다 — 패닉이어도 `scope` 가 감시 스레드를 끝없이 기다리지 않게,
    /// 그래서 바깥 정리 가드(열쇠 거두기·임대 끝·입력 놓기·듣기 놓기)까지 풀림이 이어지게.
    struct StopOnDrop<'s>(&'s AtomicBool, &'s AtomicBool);
    impl Drop for StopOnDrop<'_> {
        fn drop(&mut self) {
            // PTY 턴이 끝났다 — 이 시도의 끝 신호를 먼저 세우고(시계·SIGTERM 이 멈춘다) 감시 루프를 멈춘다.
            self.1.store(true, Ordering::SeqCst);
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let stop = AtomicBool::new(false);
    std::thread::scope(|sc| {
        if let Some(lf) = watch_loop {
            let (w, st) = (watch.clone(), &stop);
            sc.spawn(move || lf(&w, notice, ctx, st));
        }
        let _stop = StopOnDrop(&stop, &ctx.ended);
        f()
    })
}

/// 결과 접기 닫개 — 시도 결과·가림 목록·[중단] 자리·끝 상태 사본.
pub type OutcomeFn<'a> = Box<
    dyn FnMut(
            Attempted<PtyOut>,
            &TurnSecrets,
            &LiveTurn,
            &EndState,
            &OutcomeCtx,
        ) -> Result<TurnOk, AttemptError>
        + 'a,
>;

/// 결과 접기가 받는 **그 시도의** 사실 — 시도 문맥, 감시 자리의 화면 꼬리(판정용), 서버 스레드를 못 읽었는가.
#[derive(Clone, Debug, Default)]
pub struct OutcomeCtx {
    pub ctx: LoopCtx,
    pub screen: String,
    pub thread_unreadable: bool,
    /// 「확인을 기다려 멈춤」 신호 파일의 그 시도 끝 값(T4c) — 신호를 심지 않은 시도는 `None`. 정지 화면 판정이 쓴다.
    pub gate_signal: Option<crate::mention_turn_parts::GateSignal>,
}
/// 턴 뒤 IO 닫개.
pub type AfterFn<'a> = Box<dyn FnMut(&TurnSecrets, &AfterCtx) -> Result<(), String> + 'a>;

/// 턴 뒤 IO 가 받는 **그 시도의** 사실 — 시도 문맥과 끝 상태에서 꺼낸 거둔 하위 에이전트 수.
#[derive(Clone, Debug, Default)]
pub struct AfterCtx {
    pub ctx: LoopCtx,
    /// 하위 에이전트를 기다리다 거뒀다면 그 수(정본 `end.backgroundCut`).
    pub background_cut: Option<usize>,
}
/// 비밀 마운트 닫개.
pub type MountFn<'a> = Box<dyn FnMut(&str) -> Result<(), SecretMountError> + 'a>;

/// 마운트 단계 실물 — **아무것도 하지 않는다.** 비밀 마운트는 오퍼레이터가 한다: 에이전트가 `secret.mount` 를 부르면
/// 오퍼레이터가 임대 폴더에 0600 파일을 쓴다(`harkroom-operator/src/turn_secrets.rs` `mount`). 정본 러너에도 마운트 단계가 없다.
/// 비밀 단계는 「이 턴에 임대가 있다」만 뜻한다 — 단계 자체를 빼면 띄우기 순서·실패 코드(#2018)가 바뀌어 남겨 둔다.
pub fn no_mount<'a>() -> MountFn<'a> {
    Box::new(|_cause: &str| Ok(()))
}
/// 관문 통지 닫개.
pub type PostGateFailFn<'a> = Box<dyn Fn(&crate::turn_notice::GateFail) -> Result<(), String> + 'a>;

/// 사람 부르기의 바깥 일(정본 `callHuman` 둘레) — 기본 로그인 길: 원장·계정 표식·관문 감시 없음, 통지는 스레드에, 화면은 앱으로.
struct HumanIo<'x> {
    post: Option<&'x PostGateFailFn<'x>>,
    relay: Option<&'x crate::turn_attempt_relay::RelayAttempt<'x>>,
    key: &'x str,
}

impl crate::turn_gate::GateIo for HumanIo<'_> {
    fn mark_account_gate(&mut self) {}
    fn post_gate_fail(&mut self, fail: crate::turn_notice::GateFail) {
        if let Some(post) = self.post
            && let Err(e) = post(&fail)
        {
            eprintln!(
                "[mentionTurn] {}: 관문 통지 발화 실패(턴은 그대로 기다린다) — {e}",
                self.key
            );
        }
    }
    fn ledger_claim(&mut self, _account_label: &str, _session_key: &str) -> Option<bool> {
        None
    }
    fn reclaim(&mut self, _end: &mut crate::turn_end::EndState) {}
    fn can_watch_gate(&self) -> bool {
        false
    }
    fn arm_gate_watch(&mut self) {}
    fn needs_attention(&mut self, screen: &str, ranks: crate::turn_notice::GateRanks) {
        if let Some(r) = self.relay {
            let (pool, account) = crate::turn_io::attention_ranks(ranks);
            r.session().needs_attention(screen, pool, account);
        }
    }
    fn log(&mut self, line: &str) {
        eprintln!("[mentionTurn] {}: {line}", self.key);
    }
}

/// `memory.search`(recall 모드) 닫개.
pub type RecallSearchFn<'a> = Box<
    dyn Fn(&str, &crate::memory_pin::RecallOpts) -> Result<crate::memory_pin::RecallResult, String>
        + 'a,
>;
/// `thread.note` 읽기 닫개(스레드 루트 id).
pub type ReadNoteFn<'a> = Box<dyn Fn(&str) -> Result<Option<crate::mcp::ThreadNote>, String> + 'a>;
/// `thread.plan` 읽기 닫개(스레드 루트 id) — 응답의 `plan` 그대로.
pub type ReadPlanFn<'a> = Box<dyn Fn(&str) -> Result<Option<serde_json::Value>, String> + 'a>;
/// 승인된 스킬 목록 닫개(정본 `harkroom.listApprovedSkills`). 실패는 던진다 — 빈 목록으로 뭉개면 있는 스킬이 지워진다.
pub type ListSkillsFn<'a> = Box<dyn Fn() -> Result<Vec<crate::skills_sync::Skill>, String> + 'a>;
/// 진행 줄 닫개(`message.progress` — channel·body·anchor). lane 판 경고 한 줄에 쓴다.
pub type PostProgressFn<'a> = Box<dyn Fn(&str, &str, Option<&str>) -> Result<(), String> + 'a>;
/// `memory.recalled` 닫개.
pub type RecordRecallFn<'a> = Box<dyn Fn(&[String]) -> Result<(), String> + 'a>;

/// 정본 `recallQuery` — 앞 턴이 먹인 뒤의 남(나 아님·진행 글 아님)의 새 말 끝 셋, 1000자. 깨움 턴은 찾지 않는다(빈 값).
pub fn recall_query(
    thread: &[serde_json::Value],
    last_fed_seq: u64,
    me_id: &str,
    wake: bool,
) -> String {
    if wake {
        return String::new();
    }
    let picked: Vec<&str> = thread
        .iter()
        .filter(|m| {
            m.get("seq")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0)
                > last_fed_seq
                && m.get("authorId").and_then(serde_json::Value::as_str) != Some(me_id)
                && m.get("kind").and_then(serde_json::Value::as_str) != Some("progress")
        })
        .filter_map(|m| m.get("body").and_then(serde_json::Value::as_str))
        .collect();
    let start = picked.len().saturating_sub(3);
    picked[start..].join("\n").chars().take(1000).collect()
}

/// 이 멘션의 임대 폴더를 묻는 닫개.
pub type LeaseDirFn<'a> = Box<dyn Fn() -> Option<PathBuf> + 'a>;

/// 시도마다 PTY 옵션(주입 글 틀 포함)을 새로 짓는다.
pub type PtyOptsFn<'a> = Box<dyn Fn() -> PtyTurnOptions + 'a>;

/// 이 시도의 준비 결과.
struct Current {
    account: AttemptAccount,
    prepared: Prepared,
    system_prompt_file: String,
    cause: String,
    /// 이 시도에 실은 기억 고정·recall — 성공한 턴 뒤 `commit`·`memory.recalled`.
    memory: crate::memory_pin::MemoryPlan,
    /// 이 시도에 실은 스레드 계획판·메모 — 성공한 턴 뒤 `commit`.
    plan_pin: crate::thread_plan_pin::ThreadPlanPlan,
    note_pin: crate::thread_note_pin::ThreadNotePlan,
    /// 이 시도에 실은 하네스 메모리 알림(없으면 그 하네스는 자리를 모른다) — 성공한 턴 뒤 `commit`.
    harness_notice: Option<crate::harness_memory::HarnessMemoryNotice>,
}

/// 멘션마다 바뀌는 명령 칸의 소유본(지시문 입력에 없는 것). 띄울 때 [`with_argv`] 가 명령 옵션에 빌려 싣는다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OwnedArgv {
    pub model: Option<String>,
    pub effort: Option<String>,
    /// 읽기 전용 턴의 닫힌 도구 목록(목록을 쓰는 하네스만). 없으면 그 하네스의 읽기 전용 턴은 **띄우지 않는다**
    /// (`ReadonlyToolListMissing` — 닫히는 쪽, 빈 목록으로 채우지 않는다).
    pub readonly_tool_list: Option<String>,
}

/// 기본 명령 옵션에 그 멘션의 칸을 싣는다(정본 `buildTurnCommand` 의 `toolAllows`·`mergeRepos`·`apiConnectors`·
/// `apiDelegatable`·`model`·`effort`·`readonlyToolList`). 허용 도구·머지 저장소·API 는 그 멘션 지시문 입력(`system`)의 것을
/// 그대로 쓴다 — 지시문에 적힌 것과 argv 가 같은 출처다. 필드를 따로 빌려 `inner` 의 `&mut` 빌림과 겹치지 않는다.
pub fn with_argv<'s>(
    base: &TurnCommandOptions<'s>,
    system: &'s SystemInputs,
    argv: &'s OwnedArgv,
) -> TurnCommandOptions<'s> {
    let mut b = base.clone();
    if let Some(p) = &system.permissions {
        b.tool_allows = &p.tool_allows;
    }
    if let Some(m) = &system.merge {
        b.merge_repos = &m.repos;
    }
    if let Some(a) = &system.api {
        b.api_connectors = &a.connectors;
        b.api_delegatable = &a.delegatable;
    }
    if argv.model.is_some() {
        b.model = argv.model.as_deref();
    }
    if argv.effort.is_some() {
        b.effort = argv.effort.as_deref();
    }
    if argv.readonly_tool_list.is_some() {
        b.readonly_tool_list = argv.readonly_tool_list.as_deref();
    }
    b
}

/// 대상별 `AttemptParts` 실물.
pub struct MentionParts<'a, P: PrepareIo, S: PtyTurnSink> {
    pub io: P,
    pub store: &'a SessionStore,
    pub key: String,
    pub harness: crate::adapter::AgentHarness,
    pub me_id: String,
    pub handles: HashMap<String, String>,
    pub state_dir: PathBuf,
    pub new_workspace_dir: String,
    pub system: SystemInputs,
    pub base: TurnCommandOptions<'a>,
    pub parent_env: BTreeMap<String, String>,
    pub home: PathBuf,
    pub omp_home: Option<PathBuf>,
    pub codex_home: Option<PathBuf>,
    /// codex 턴 준비(c1 로그인 링크·남은 규칙 지우기, c2 승인 명령 규칙·hook). 없으면 하지 않는다(시험용).
    pub codex: Option<crate::codex_prep::CodexTurn>,
    pub pty_opts: PtyOptsFn<'a>,
    pub inner: S,
    pub watch: Watch,
    pub slot: LiveSlot,
    pub lane: LaneSnapshot,
    pub secrets: bool,
    pub lease_dir: Option<PathBuf>,
    /// 이 멘션의 임대 폴더를 **시도를 준비할 때** 묻는다(임대는 짓개가 부품을 지은 뒤 받는다 — `LeaseBook::lease_dir`).
    /// `lease_dir` 가 있으면 그것이 먼저다.
    pub lease_dir_of: Option<LeaseDirFn<'a>>,
    /// 관문 통지(정본 `harkroom.fail(gateNotice…)`) — 사람 부르기가 턴마다 한 번 스레드에 남긴다. 없으면 남기지 않는다.
    pub post_gate_fail: Option<PostGateFailFn<'a>>,
    /// 정본 `harkroom.searchMemory`(recall 모드) — 없으면 recall 을 하지 않는다(기억 고정은 그대로).
    pub recall_search: Option<RecallSearchFn<'a>>,
    /// 정본 `harkroom.recordRecall`(`memory.recalled`) — 성공한 턴 뒤, 실제로 실은 recall 만. 실패는 로그만.
    pub record_recall: Option<RecordRecallFn<'a>>,
    /// 정본 `harkroom.readThreadNote`(`thread.note`) — 없거나 실패하면 이번 턴은 메모를 싣지 않는다.
    pub read_note: Option<ReadNoteFn<'a>>,
    /// 정본 `harkroom.readThreadPlan`(`thread.plan`) — 없거나 실패하면 이번 턴은 계획판을 싣지 않는다.
    pub read_plan: Option<ReadPlanFn<'a>>,
    /// 정본 `syncSkills` 의 목록 읽기 — 있으면 띄우기 전에 스킬을 깔고 작업 폴더 설정을 걷는다(`scrubWorkspaceSettings`).
    /// 없으면 둘 다 하지 않는다(시험용).
    pub list_skills: Option<ListSkillsFn<'a>>,
    /// API 키 연결(lane) 턴 — 허용 목록(`name`·`description`) 밖 frontmatter 를 가진 스킬은 깔지 않는다
    /// (정본 `dropToolGrants: Boolean(deps.providerEnv)`, security 2026-10-23: `allowed-tools` 가 카드 없이 도구를 연다).
    pub drop_tool_grants: bool,
    /// lane 판 경고를 스레드에 올리는 길(정본 `deps.harkroom.progress`). 없으면 로그만.
    pub post_progress: Option<PostProgressFn<'a>>,
    pub now: Option<TurnClock>,
    /// 시도를 준비할 때 그 순간의 시계를 잰다(정본 `now: new Date()` — 시도마다). `now` 가 있으면 그것이 먼저(시험용).
    pub clock: Option<fn() -> TurnClock>,
    pub outcome: OutcomeFn<'a>,
    pub after: AfterFn<'a>,
    pub mount: MountFn<'a>,
    /// 띄우는 동안 옆에서 돌 감시 루프(없으면 돌지 않는다 — 시험용).
    pub watch_loop: Option<WatchLoopFn<'a>>,
    /// 멘션마다 바뀌는 명령 칸 중 지시문 입력에 없는 것(모델·effort·읽기 전용 목록)의 소유본.
    pub argv: OwnedArgv,
    /// 정본 `deps.turnTimeoutMs` — TUI 가 아닌(`exec`) 하네스의 PTY 시한. TUI 는 0(무기한, 시한은 무발화 시계가 잰다).
    pub turn_timeout_ms: u64,
    /// 이 멘션이 쓴 스레드별 지시문 파일 — 멘션이 끝나면(값이 떨어지면) 지운다.
    prompt_file: Option<PathBuf>,
    cur: Option<Current>,
    /// 이 시도가 띄울 때 지은 문맥 — 턴 뒤 IO 에 넘긴다(`spawn` 이 시도마다 새로 적는다).
    last_ctx: Option<LoopCtx>,
    /// 이 시도의 신호 파일을 PTY 턴이 끝난 직후(지우기 전) 읽은 값(T4c).
    last_gate: Option<crate::mention_turn_parts::GateSignal>,
}

impl<'a, P: PrepareIo, S: PtyTurnSink> MentionParts<'a, P, S> {
    /// 빈 준비 자리로 만든다(나머지 칸은 부르는 쪽이 채운다).
    #[allow(clippy::too_many_arguments)]
    pub fn with_parts(
        io: P,
        store: &'a SessionStore,
        base: TurnCommandOptions<'a>,
        system: SystemInputs,
        pty_opts: PtyOptsFn<'a>,
        inner: S,
        outcome: OutcomeFn<'a>,
        after: AfterFn<'a>,
        mount: MountFn<'a>,
    ) -> Self {
        Self {
            io,
            store,
            key: String::new(),
            harness: base.harness,
            me_id: String::new(),
            handles: HashMap::new(),
            state_dir: PathBuf::new(),
            new_workspace_dir: String::new(),
            system,
            base,
            parent_env: BTreeMap::new(),
            home: PathBuf::new(),
            omp_home: None,
            codex_home: None,
            codex: None,
            pty_opts,
            turn_timeout_ms: 0,
            inner,
            watch: Watch::default(),
            slot: LiveSlot::default(),
            lane: LaneSnapshot::default(),
            secrets: false,
            lease_dir: None,
            lease_dir_of: None,
            post_gate_fail: None,
            recall_search: None,
            record_recall: None,
            read_note: None,
            read_plan: None,
            list_skills: None,
            drop_tool_grants: false,
            post_progress: None,
            now: None,
            clock: None,
            outcome,
            after,
            mount,
            watch_loop: None,
            argv: OwnedArgv::default(),
            prompt_file: None,
            cur: None,
            last_ctx: None,
            last_gate: None,
        }
    }

    /// 이 시도의 명령 옵션 — 시도 칸 → 계정 폴더(마지막). 준비 전이면 `None`. `spawn` 과 같은 조립([`attempt_cmd`])이다.
    pub fn command_for<'s>(&'s self, turn_id: &'s str) -> Option<TurnCommandOptions<'s>> {
        let c = self.cur.as_ref()?;
        Some(attempt_cmd(
            &self.base,
            &self.system,
            &self.argv,
            c,
            self.codex_home.as_deref(),
            turn_id,
        ))
    }

    /// 이 시도의 감시 자리 — `spawn` 이 sink 와 감시 루프에 넘기는 것. `bind_live(Some)` 이 시도마다 새로 만든다.
    pub fn attempt_watch(&self) -> Watch {
        self.watch.clone()
    }

    /// 이 시도의 스레드 계획판·메모 고정(정본 `planThreadPlan`·`planThreadNote`). 채널 최상위(앵커 없음)는 둘 다 없다.
    /// 못 읽으면 그쪽만 「못 읽음」 — 싣지 않고 알린 판도 건드리지 않는다.
    fn plan_thread_pins_for(
        &self,
        prepared: &Prepared,
        target: &MentionTarget,
    ) -> (
        crate::thread_plan_pin::ThreadPlanPlan,
        crate::thread_note_pin::ThreadNotePlan,
        crate::thread_plan_pin::ThreadPlanState,
    ) {
        use crate::thread_note_pin::ThreadNoteState;
        use crate::thread_plan_pin::ThreadPlanState;
        let s = &prepared.session;
        let anchor = Some(target.thread_root_id.as_str()).filter(|a| !a.is_empty());
        let note = match (anchor, &self.read_note) {
            (Some(a), Some(read)) => match read(a) {
                Ok(Some(n)) => ThreadNoteState::Note(n),
                Ok(None) => ThreadNoteState::Missing,
                Err(e) => {
                    eprintln!(
                        "[mentionTurn] {}: 스레드 메모 조회 실패 — 이번 턴은 싣지 않는다: {e}",
                        self.key
                    );
                    ThreadNoteState::Unavailable
                }
            },
            _ => ThreadNoteState::Unavailable,
        };
        let plan = match (anchor, &self.read_plan) {
            (Some(a), Some(read)) => match read(a) {
                Ok(Some(v)) => match serde_json::from_value(v) {
                    Ok(p) => ThreadPlanState::Plan(Box::new(p)),
                    Err(_) => {
                        // 오류 원문에는 남이 쓴 계획판 글자가 섞일 수 있다 — 종류만 남긴다(security #2114 nit).
                        eprintln!(
                            "[mentionTurn] {}: 계획판 모양이 틀렸다 — 이번 턴은 싣지 않는다",
                            self.key
                        );
                        ThreadPlanState::Unavailable
                    }
                },
                Ok(None) => ThreadPlanState::Missing,
                Err(e) => {
                    eprintln!(
                        "[mentionTurn] {}: 계획판 조회 실패 — 이번 턴은 싣지 않는다: {e}",
                        self.key
                    );
                    ThreadPlanState::Unavailable
                }
            },
            _ => ThreadPlanState::Unavailable,
        };
        let sid = s.rec.session_id.as_deref();
        (
            crate::thread_plan_pin::plan_thread_plan(
                &self.state_dir,
                &self.key,
                sid,
                s.is_first_turn,
                &self.me_id,
                &plan,
            ),
            crate::thread_note_pin::plan_thread_note(
                &self.state_dir,
                &self.key,
                sid,
                s.is_first_turn,
                &note,
            ),
            plan,
        )
    }

    /// 부른 글이 가리키는 계획 단계를 펼친다(정본 `planRefLines`) — 이 스레드의 계획판은 이미 받은 판을, 다른 스레드는
    /// 뿌리마다 한 번 읽는다(같은 채널만). 고정이 없다 — 부른 글마다 싣는다.
    fn plan_ref_lines_for(
        &self,
        prepared: &Prepared,
        target: &MentionTarget,
        anchor_plan: &crate::thread_plan_pin::ThreadPlanState,
    ) -> Vec<String> {
        let body = prepared
            .fed
            .thread
            .iter()
            .find(|m| {
                m.get("id").and_then(serde_json::Value::as_str) == Some(target.mention_id.as_str())
            })
            .and_then(|m| m.get("body").and_then(serde_json::Value::as_str))
            .unwrap_or("");
        let anchor = Some(target.thread_root_id.as_str()).filter(|a| !a.is_empty());
        let read = self.read_plan.as_ref().map(|f| {
            move |root: &str| -> Result<Option<crate::thread_plan_pin::ThreadPlanSnapshot>, String> {
                match f(root)? {
                    // 모양 오류 원문에는 남이 쓴 계획판 글자가 섞일 수 있다 — 종류만(#2114 nit 와 같은 선).
                    Some(v) => serde_json::from_value(v)
                        .map(Some)
                        .map_err(|_| "계획판 모양이 틀렸다".to_string()),
                    None => Ok(None),
                }
            }
        });
        crate::thread_plan_pin::plan_ref_lines(
            body,
            anchor,
            anchor_plan,
            &target.channel_id,
            read.as_ref()
                .map(|r| r as crate::thread_plan_pin::ReadPlan<'_>),
            &self.me_id,
        )
    }

    /// 이 시도의 기억 고정·recall(정본 `planMemory` 부르기).
    fn plan_memory_for(
        &self,
        prepared: &Prepared,
        target: &MentionTarget,
    ) -> crate::memory_pin::MemoryPlan {
        let s = &prepared.session;
        let query = recall_query(
            &prepared.fed.thread,
            s.rec.last_fed_seq,
            &self.me_id,
            turn_wake_of(target, None).is_some(),
        );
        let root_head = prepared
            .fed
            .thread
            .iter()
            .find(|m| {
                m.get("id").and_then(serde_json::Value::as_str)
                    == Some(target.thread_root_id.as_str())
            })
            .and_then(|m| m.get("body").and_then(serde_json::Value::as_str))
            .map(|b| {
                b.chars()
                    .take(crate::memory_pin::RECALL_ROOT_HEAD_CHARS)
                    .collect::<String>()
            });
        let search = self
            .recall_search
            .as_ref()
            .map(|f| move |q: &str, o: &crate::memory_pin::RecallOpts| f(q, o));
        let recall = match (&search, query.is_empty()) {
            (Some(f), false) => Some(crate::memory_pin::Recall {
                query,
                search: f,
                root_head,
            }),
            _ => None,
        };
        crate::memory_pin::plan_memory(
            &self.state_dir,
            &self.key,
            s.rec.session_id.as_deref(),
            s.is_first_turn,
            &self.system.memory,
            recall.as_ref(),
            s.fresh_wake,
        )
    }

    /// 이 시도의 턴 프롬프트(주입 글). 준비 전이면 `None`.
    pub fn prompt(&self) -> Option<&str> {
        self.cur.as_ref().map(|c| c.prepared.prompt.prompt.as_str())
    }
}

impl<P: PrepareIo, S: PtyTurnSink> AttemptParts for MentionParts<'_, P, S> {
    fn lane_notice(&mut self, target: &MentionTarget, body: &str) {
        let anchor = Some(target.thread_root_id.as_str()).filter(|a| !a.is_empty());
        let Some(post) = &self.post_progress else {
            return;
        };
        // 정본 `.catch(...)` — 경고를 못 남겨도 턴은 간다. 오류 원문은 로그에만.
        if let Err(e) = post(
            &target.channel_id,
            crate::turn_after::clip_body(body),
            anchor,
        ) {
            eprintln!(
                "[mentionTurn] {}: 하네스 판 경고를 못 남겼다 — {e}",
                self.key
            );
        }
    }

    fn bind_live(&mut self, live: Option<Arc<LiveTurn>>) {
        if live.is_some() {
            // 시도마다 새 감시 자리 — 앞 시도의 끝 상태(API 오류·종료·발화·정지 표지)와 화면 꼬리가 이 시도 판정에
            // 섞이지 않게(#2036·#2042 와 같은 경계). sink·감시 루프·결과 접기는 이 시도 것을 쥔다.
            self.watch = Watch::default();
            // 앞 시도의 문맥이 이 시도의 턴 뒤 IO 에 가지 않게(mem/runner/per-attempt-state).
            self.last_ctx = None;
            self.last_gate = None;
        }
        self.slot.bind(live);
    }

    #[allow(clippy::result_large_err)]
    fn prepare(
        &mut self,
        target: &MentionTarget,
        account: Option<&ClaudeAccount>,
        is_last_account: bool,
        _turn_id: &str,
    ) -> Result<AttemptPrep, AttemptError> {
        let acc = AttemptAccount::of(account, is_last_account);
        let fail = || AttemptError {
            message: PREPARE_FAILED.to_string(),
            ..AttemptError::default()
        };
        let mut new_id = crate::link::random_uuid;
        let prepared = prepare_turn(
            &mut self.io,
            PrepareInput {
                target,
                harness: self.harness,
                axis: AccountAxis {
                    account: acc.name.as_deref(),
                    pool: acc.pool.as_deref(),
                },
                record: self.store.get(&self.key),
                new_workspace_dir: &self.new_workspace_dir,
                me_id: &self.me_id,
                handles: &self.handles,
                now: self.now.clone().or_else(|| self.clock.map(|f| f())),
                wake: turn_wake_of(target, None),
            },
            &mut new_id,
        )
        .map_err(|_| fail())?;
        // 기억 고정·recall(정본 `planMemory`) — 지시문에는 고정된 기억(core)을, 턴 프롬프트 앞머리에는 목록·recall 을 싣는다.
        let mut prepared = prepared;
        let memory = self.plan_memory_for(&prepared, target);
        // 스레드 계획판·메모(정본 `planThreadPlan`·`planThreadNote`) — 새 세션 전문, 이어받으면 바뀐 때만. 앞머리 차례는
        // 정본과 같다: 기억 → 계획판 → 메모.
        let (plan_pin, note_pin, plan_state) = self.plan_thread_pins_for(&prepared, target);
        let plan_refs = self.plan_ref_lines_for(&prepared, target, &plan_state);
        // 하네스 파일 메모리 수확 알림(정본 U5 `planHarnessMemoryNotice`) — 그 자리를 아는 하네스만(claude). 깨움 세션은 싣지 않는다.
        let harness_notice = match crate::adapter::file_memory_dir_under_config(self.harness) {
            Some(root) if !prepared.session.fresh_wake => {
                let dir = crate::harness_memory::claude_memory_dir(
                    acc.config_dir.as_deref(),
                    &self.home,
                    &prepared.session.rec.workspace_dir,
                    root,
                );
                Some(crate::harness_memory::plan_harness_memory_notice(
                    &self.state_dir,
                    &self.key,
                    &crate::harness_memory::scan_harness_memory(&dir),
                ))
            }
            _ => None,
        };
        let empty: Vec<String> = Vec::new();
        let notice_lines = harness_notice.as_ref().map_or(&empty, |n| &n.lines);
        let mut head: Vec<String> = memory.turn_lines.clone();
        // 앞머리 차례는 정본과 같다: 기억 → 계획판 → 계획 단계 펼치기 → 메모 → 하네스 메모리 알림.
        for lines in [&plan_pin.lines, &plan_refs, &note_pin.lines, notice_lines] {
            if !lines.is_empty() {
                head.push(String::new());
                head.extend(lines.iter().cloned());
            }
        }
        if !head.is_empty() {
            let head = head.join("\n");
            prepared.prompt.prompt = format!(
                "{}\n\n{}",
                head.trim_start_matches('\n'),
                prepared.prompt.prompt
            );
        }
        let mut sys = self.system.opts();
        sys.memory = &memory.system;
        let file = write_turn_system_prompt(&self.state_dir, &self.key, &sys).map_err(|e| {
            eprintln!("[mentionTurn] {}: 지시문 파일 쓰기 실패 — {e}", self.key);
            fail()
        })?;
        // 승인된 스킬 동기화(#140) → 작업 폴더 설정 걷기 — 하네스가 뜨기 **전에** 끝나야 이 턴에 붙는다(정본 차례: 지시문 파일 →
        // `syncSkills` → `scrubWorkspaceSettings`). 실패는 안에서 삼키고 stderr 로만 — 턴은 그대로 간다.
        if let Some(list) = self.list_skills.as_ref() {
            let ws = Path::new(&prepared.session.rec.workspace_dir);
            crate::skills_sync::sync_skills(
                &self.state_dir,
                ws,
                list,
                crate::skills_sync::SyncSkillsOpts {
                    drop_tool_grants: self.drop_tool_grants,
                    builtins: None,
                },
            );
            crate::skills_sync::scrub_workspace_settings(ws);
        }
        // codex 턴 직전 준비(c1, 정본 `syncCodexAuth` → `sweepCodexRules`) — 로그인 링크는 실패해도 가고, 규칙 지우기 실패는 띄우지 않는다.
        if self.harness == crate::adapter::AgentHarness::Codex
            && let Some(cx) = self.codex.as_ref()
        {
            cx.before_turn().map_err(|e| {
                eprintln!("[mentionTurn] {}: {e}", self.key);
                fail()
            })?;
        }
        // 하네스를 띄우기 전, **이 시도의 계정 폴더**로 작업 폴더 신뢰·bypass 수락을 적는다(정본 `mentionTurn.ts` 의 차례).
        crate::workspace_trust::prepare_harness_gates(
            self.harness,
            &prepared.session.rec.workspace_dir,
            acc.config_dir.as_deref(),
            self.codex_home.as_deref(),
            &self.home,
        );
        let homes = acc.homes(
            Some(&self.home),
            self.omp_home.as_deref(),
            self.codex_home.as_deref(),
        );
        let session_id = prepared.session.rec.session_id.clone();
        // lane 턴의 키 받기 전 판정 재료 — 시도 경로가 lane 일 때만 쓴다. pi 스레드 홈은 Rust 러너가 아직 짓지 않는다(None).
        let lane_pre = Some(crate::turn_attempt_run::LanePre {
            model: self
                .argv
                .model
                .clone()
                .or_else(|| self.base.model.map(str::to_string)),
            workspace_dir: PathBuf::from(&prepared.session.rec.workspace_dir),
            home: self.home.clone(),
            turn_pi_home: None,
        });
        self.prompt_file = Some(file.clone());
        self.cur = Some(Current {
            account: acc,
            prepared,
            system_prompt_file: file.to_string_lossy().into_owned(),
            cause: target.mention_id.clone(),
            memory,
            plan_pin,
            note_pin,
            harness_notice,
        });
        Ok(AttemptPrep {
            key: self.key.clone(),
            cause: target.mention_id.clone(),
            secrets: self.secrets,
            lease_dir: self
                .lease_dir
                .clone()
                .or_else(|| self.lease_dir_of.as_ref().and_then(|f| f())),
            session_id,
            homes: OwnedHomes { ..homes },
            lane_pre,
        })
    }

    fn mount_secrets(&mut self, cause: &str) -> Result<(), SecretMountError> {
        (self.mount)(cause)
    }

    fn spawn(&mut self, args: SpawnArgs<'_>, delivered: &mut bool) -> PtyOut {
        let base_opts = (self.pty_opts)();
        let text = self.prompt().unwrap_or_default().to_string();
        let watch = self.attempt_watch();
        let now = || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        };
        // 필드를 따로 빌린다(명령은 `cur`·`base`, sink 는 `inner`) — `command_for` 와 같은 차례(시도 칸 → 계정 폴더).
        let Some(c) = self.cur.as_ref() else {
            return Err(crate::pty_turn::PtyTurnError::Spawn(std::io::Error::other(
                "준비 없이 띄우려 했다",
            )));
        };
        // 이 시도의 표식 파일(T4c, 정본 `mcpReadyFile`·`gateFile`) — 시도가 끝나면 `markers` 가 떨어지며 지운다.
        let tui = crate::adapter::uses_tui_for_mention(self.harness).unwrap_or(false);
        let markers = crate::turn_markers::TurnMarkers::plan(
            &self.state_dir,
            &self.key,
            self.harness,
            tui,
            self.base.mention_permission,
            !args.lane_env.is_empty(),
            &mut crate::link::random_uuid,
        );
        // 승인 명령 규칙·hook(c2, 정본 `mentionTurn.ts` 1690) — 턴 열쇠가 있는 auto codex 턴에만. 규칙은 **서버 승인 목록**
        // (`permissions.tool_allows`·`reach`)에서만 온다. hook 신뢰를 확인하지 못하면 띄우지 않는다. 쓴 규칙 파일은 시도가 끝나면 지운다.
        let codex_rules = if self.harness == crate::adapter::AgentHarness::Codex
            && args.keys.is_some()
            && self.base.mention_permission == crate::adapter::MentionPermission::Auto
            && let Some(cx) = self.codex.as_ref()
        {
            let perms = self.system.permissions.clone().unwrap_or_default();
            let spec = cx
                .rules(
                    Path::new(&c.prepared.session.rec.workspace_dir),
                    &perms.tool_allows,
                    perms.reach.as_deref(),
                    self.base.operator_bin,
                )
                .map_err(|e| {
                    eprintln!("[mentionTurn] {}: codex 승인 명령 규칙 — {e}", self.key);
                    crate::pty_turn::PtyTurnError::Spawn(std::io::Error::other(
                        "codex_rules_unavailable",
                    ))
                })?;
            Some((cx.clone(), spec))
        } else {
            None
        };
        let mut cmd = attempt_cmd(
            &self.base,
            &self.system,
            &self.argv,
            c,
            self.codex_home.as_deref(),
            args.turn_id,
        );
        cmd.gate_file = markers.gate.as_deref();
        cmd.mcp_ready_file = markers.mcp_ready.as_deref();
        cmd.codex_hook_spec = codex_rules.as_ref().and_then(|(_, s)| s.as_deref());
        // PTY 옵션은 **이 시도의 값으로** 채운다(정본 `mentionTurn.ts` 의 `deps.runTurn(plan, {...})`) — 기본값(`/`·주입 없음)으로
        // 하네스가 뜨는 길을 남기지 않는다. 작업 폴더가 비었거나 상대 경로면 띄우지 않는다.
        let mut opts = attempt_pty_options(
            base_opts,
            self.harness,
            &c.prepared.session.rec.workspace_dir,
            text,
            self.turn_timeout_ms,
        )
        .map_err(|why| crate::pty_turn::PtyTurnError::Spawn(std::io::Error::other(why)))?;
        markers.apply(opts.inject.as_mut());
        let marker_key = self.key.clone();
        let mcp = args.mcp_config_path.to_string_lossy().into_owned();
        let pargs = PtyTurnArgs {
            lane_env: &args.lane_env,
            keys: args.keys,
            mcp_config_path: &mcp,
            parent_env: &self.parent_env,
            home: Path::new(&self.home),
        };
        // 감시 루프는 **이 시도의 자리**(`self.watch`, `bind_live(Some)` 가 새로 만든 것)와 띄우는 자리에서 지은 감시 목록
        // (`args.notice`)을 받아 PTY 옆에서 돈다.
        let inner = &mut self.inner;
        let slot = self.slot.clone();
        let pty_slot = self.slot.clone();
        let stop_on_spawn = move || slot.stop_requested();
        let ctx = LoopCtx {
            turn_id: args.turn_id.to_string(),
            session_id: c.prepared.session.rec.session_id.clone(),
            turn_started_at_ms: now(),
            turn_start_seq: i64::try_from(crate::turn_prep::turn_start_seq(&c.prepared.fed.thread))
                .unwrap_or(i64::MAX),
            claude_config_dir: c.account.config_dir.clone(),
            ended: Arc::new(AtomicBool::new(false)),
        };
        self.last_ctx = Some(ctx.clone());
        // 정본 `sessionTranscriptGrewSince(harness, sessionId, turnStartedAtMs, { configDir })` — 이 시도의 계정 폴더·세션·시작 시각.
        let (probe_harness, probe_session, probe_since, probe_config, probe_home) = (
            self.harness,
            ctx.session_id.clone(),
            ctx.turn_started_at_ms,
            ctx.claude_config_dir.clone(),
            self.home.clone(),
        );
        let confirm_probe = move || {
            crate::harness_errors::session_transcript_grew_since(
                probe_harness,
                probe_session.as_deref(),
                probe_since,
                crate::harness_errors::TranscriptDirs {
                    config_dir: probe_config.as_deref(),
                    home: Some(probe_home.as_path()),
                },
            )
        };
        // 사람 부르기(정본 `callHuman`) — 이 시도의 감시 자리·멘션·계정 순번으로. 통지는 턴마다 한 번(`GateState`).
        let gate_state = std::cell::RefCell::new(crate::turn_gate::GateState::default());
        let human_ctx = crate::turn_gate::CallHumanCtx {
            account_label: c
                .account
                .name
                .clone()
                .unwrap_or_else(|| "(기본)".to_string()),
            ranks: crate::turn_notice::GateRanks {
                pool: None,
                account: if c.account.config_dir.is_none() {
                    crate::turn_notice::GateAccountRank::DefaultLogin
                } else {
                    crate::turn_notice::GateAccountRank::Unknown
                },
            },
            mention_id: c.cause.clone(),
            session_key: ctx.session_id.clone().unwrap_or_else(|| self.key.clone()),
        };
        let (human_watch, human_post, human_relay, human_key) = (
            watch.clone(),
            self.post_gate_fail.as_ref(),
            args.relay,
            self.key.clone(),
        );
        let human = move |screen: &str, kind: crate::pty::AttentionKind| {
            let mut w = human_watch.lock().unwrap_or_else(|e| e.into_inner());
            let mut io = HumanIo {
                post: human_post,
                relay: human_relay,
                key: &human_key,
            };
            crate::turn_gate::call_human(
                &mut w.end,
                &mut gate_state.borrow_mut(),
                &human_ctx,
                screen,
                kind,
                &mut io,
            );
        };
        let out = run_beside(&watch, &args.notice, &ctx, self.watch_loop.as_ref(), || {
            // 띄운 PTY 손잡이를 슬롯에 적는다 — 물러날 때 유예가 지나면 그 프로세스 그룹에 SIGKILL 한다(P2). 시도가 끝나면 비운다.
            let mut pty_sink = SlotPtySink {
                inner,
                slot: &pty_slot,
            };
            let mut delivered_sink = DeliveredSink {
                inner: &mut pty_sink,
                delivered,
            };
            let mut watch_sink = WatchSink {
                inner: &mut delivered_sink,
                watch: watch.clone(),
                now_ms: &now,
                stop_on_spawn: Some(&stop_on_spawn),
            };
            // 표식(MCP 준비·관문 신호)을 답하는 자리 — 나머지 갈래는 안쪽으로 넘긴다.
            let mut marker_sink = crate::turn_markers::MarkerSink {
                inner: &mut watch_sink,
                markers: &markers,
                key: &marker_key,
                confirm: Some(&confirm_probe),
                human: Some(&human),
            };
            match args.relay {
                Some(r) => {
                    let mut s = RelaySink {
                        inner: &mut marker_sink,
                        relay: r,
                    };
                    spawn_pty_turn(&cmd, pargs, opts, &mut s)
                }
                None => spawn_pty_turn(&cmd, pargs, opts, &mut marker_sink),
            }
        });
        self.slot.set_pty(None);
        // 이 시도가 쓴 승인 명령 규칙 파일을 지운다(c2) — 다음 턴은 그 턴의 서버 목록으로 다시 쓴다.
        if let Some((cx, _)) = &codex_rules {
            cx.end_turn();
        }
        // 정지 화면 판정용 — 지우기(`markers` 떨어짐) 전에 읽는다(정본은 지운 뒤 읽어 늘 0, 모듈 머리 주석).
        self.last_gate = markers.gate_snapshot();
        out
    }

    fn outcome(
        &mut self,
        attempted: Attempted<PtyOut>,
        secrets: &TurnSecrets,
        live: &LiveTurn,
    ) -> Result<TurnOk, AttemptError> {
        let (end, screen, thread_unreadable) = {
            let w = self.watch.lock().unwrap_or_else(|e| e.into_inner());
            (w.end.clone(), w.screen_text(), w.thread_unreadable)
        };
        let o = OutcomeCtx {
            // 띄우지 못한 시도(문맥 없음)는 빈 문맥 — 기록을 읽을 세션도 없다.
            ctx: self.last_ctx.clone().unwrap_or_default(),
            screen,
            thread_unreadable,
            gate_signal: self.last_gate,
        };
        (self.outcome)(attempted, secrets, live, &end, &o)
    }

    fn after(&mut self, secrets: &TurnSecrets) -> Result<(), String> {
        let Some(ctx) = self.last_ctx.clone() else {
            return Err("띄우지 않은 시도의 턴 뒤 IO".to_string());
        };
        let background_cut = self
            .watch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .end
            .background_cut
            .map(|n| n as usize);
        let res = (self.after)(
            secrets,
            &AfterCtx {
                ctx: ctx.clone(),
                background_cut,
            },
        );
        // 성공한 턴만(턴 뒤 IO 까지 끝난 때) — 알린 기억을 저장하고(깨움 세션은 저장하지 않는다) 실은 recall 을 센다(정본
        // `commit`·`recordRecall`). `run_attempt` 는 성공한 시도에만 `after` 를 부른다.
        if res.is_ok()
            && let Some(c) = &self.cur
        {
            if !c.prepared.session.fresh_wake {
                c.memory.commit(ctx.session_id.as_deref());
                c.plan_pin.commit(ctx.session_id.as_deref());
                c.note_pin.commit(ctx.session_id.as_deref());
                if let Some(n) = &c.harness_notice {
                    n.commit();
                }
            }
            if !c.memory.recalled.is_empty()
                && let Some(f) = &self.record_recall
                && let Err(e) = f(&c.memory.recalled)
            {
                eprintln!(
                    "[mentionTurn] {}: recall 집계 실패(턴은 계속한다) — {e}",
                    self.key
                );
            }
        }
        res
    }

    fn account_ranks(&self, account: Option<&ClaudeAccount>) -> (Option<Option<u32>>, Option<u32>) {
        ranks_of(&self.lane, account)
    }
}

/// 시도 하나의 명령 옵션(`spawn`·`command_for` 가 같이 쓴다) — 지시문 입력 칸(argv) → 시도 칸 → 계정 폴더 → codex 격리 홈.
/// codex 홈을 여기서 싣지 않으면 codex 턴은 조립에서 `codexHome` 이 비어 뜨지 않는다(실물 턴에서 잡힘, #2142).
fn attempt_cmd<'s>(
    base: &TurnCommandOptions<'s>,
    system: &'s SystemInputs,
    argv: &'s OwnedArgv,
    c: &'s Current,
    codex_home: Option<&'s Path>,
    turn_id: &'s str,
) -> TurnCommandOptions<'s> {
    let mut cmd = attempt_command_for_account(
        &with_argv(base, system, argv),
        &c.account,
        &c.prepared.session,
        &c.system_prompt_file,
        &c.cause,
        turn_id,
    );
    cmd.codex_home = codex_home;
    cmd
}

#[cfg(test)]
#[path = "mention_parts_tests.rs"]
mod tests;

/// 띄운 순간의 PTY 손잡이를 멘션 슬롯에 적는 sink 덧씌우개(P2 물러나기 SIGKILL). 나머지 갈래는 안쪽 sink 로 넘긴다.
struct SlotPtySink<'s, S: PtyTurnSink> {
    inner: &'s mut S,
    slot: &'s LiveSlot,
}

impl<S: PtyTurnSink> crate::pty_turn::PromptHooks for SlotPtySink<'_, S> {
    fn wait_for_ready(&mut self) -> bool {
        self.inner.wait_for_ready()
    }
    fn wait_for_settled(&mut self, ready: bool, waited_ms: u64) {
        self.inner.wait_for_settled(ready, waited_ms)
    }
    fn gate_signal(&mut self) -> u64 {
        self.inner.gate_signal()
    }
    fn confirm_probe(&mut self) -> bool {
        self.inner.confirm_probe()
    }
}

impl<S: PtyTurnSink> PtyTurnSink for SlotPtySink<'_, S> {
    fn on_spawn(&mut self, controls: crate::pty_turn::PtyControls) {
        self.slot.set_pty(Some(controls.clone()));
        self.inner.on_spawn(controls)
    }
    fn on_output(&mut self, frame: &[u8]) {
        self.inner.on_output(frame)
    }
    fn on_injected(&mut self) {
        self.inner.on_injected()
    }
    fn on_attention(&mut self, screen: &str, kind: crate::pty::AttentionKind) {
        self.inner.on_attention(screen, kind)
    }
    fn on_turn_gate(&mut self, screen: &str) {
        self.inner.on_turn_gate(screen)
    }
}

impl<P: PrepareIo, S: PtyTurnSink> Drop for MentionParts<'_, P, S> {
    /// 멘션(턴)이 끝나면 그 스레드의 지시문 파일을 지운다 — 정상·패닉 풀림 모두.
    fn drop(&mut self) {
        if let Some(p) = self.prompt_file.take() {
            crate::turn_files::remove_system_prompt_file(&p);
        }
    }
}
