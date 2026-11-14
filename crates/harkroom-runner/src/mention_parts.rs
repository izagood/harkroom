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
    pub now: Option<TurnClock>,
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
            pty_opts,
            turn_timeout_ms: 0,
            inner,
            watch: Watch::default(),
            slot: LiveSlot::default(),
            lane: LaneSnapshot::default(),
            secrets: false,
            lease_dir: None,
            lease_dir_of: None,
            now: None,
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

    /// 이 시도의 명령 옵션 — 시도 칸 → 계정 폴더(마지막). 준비 전이면 `None`.
    pub fn command_for<'s>(&'s self, turn_id: &'s str) -> Option<TurnCommandOptions<'s>> {
        let c = self.cur.as_ref()?;
        Some(attempt_command_for_account(
            &with_argv(&self.base, &self.system, &self.argv),
            &c.account,
            &c.prepared.session,
            &c.system_prompt_file,
            &c.cause,
            turn_id,
        ))
    }

    /// 이 시도의 감시 자리 — `spawn` 이 sink 와 감시 루프에 넘기는 것. `bind_live(Some)` 이 시도마다 새로 만든다.
    pub fn attempt_watch(&self) -> Watch {
        self.watch.clone()
    }

    /// 이 시도의 턴 프롬프트(주입 글). 준비 전이면 `None`.
    pub fn prompt(&self) -> Option<&str> {
        self.cur.as_ref().map(|c| c.prepared.prompt.prompt.as_str())
    }
}

impl<P: PrepareIo, S: PtyTurnSink> AttemptParts for MentionParts<'_, P, S> {
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
                now: self.now.clone(),
                wake: turn_wake_of(target, None),
            },
            &mut new_id,
        )
        .map_err(|_| fail())?;
        let file = write_turn_system_prompt(&self.state_dir, &self.key, &self.system.opts())
            .map_err(|e| {
                eprintln!("[mentionTurn] {}: 지시문 파일 쓰기 실패 — {e}", self.key);
                fail()
            })?;
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
        self.prompt_file = Some(file.clone());
        self.cur = Some(Current {
            account: acc,
            prepared,
            system_prompt_file: file.to_string_lossy().into_owned(),
            cause: target.mention_id.clone(),
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
        let mut cmd = attempt_command_for_account(
            &with_argv(&self.base, &self.system, &self.argv),
            &c.account,
            &c.prepared.session,
            &c.system_prompt_file,
            &c.cause,
            args.turn_id,
        );
        cmd.gate_file = markers.gate.as_deref();
        cmd.mcp_ready_file = markers.mcp_ready.as_deref();
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
        (self.after)(
            secrets,
            &AfterCtx {
                ctx,
                background_cut,
            },
        )
    }

    fn account_ranks(&self, account: Option<&ClaudeAccount>) -> (Option<Option<u32>>, Option<u32>) {
        ranks_of(&self.lane, account)
    }
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
