//! 실물 짓개(L3c-2) — [`RunnerMaker`] 가 [`CallMaker`] 를 채운다. 정본 `main.ts` 의 턴 deps 조립(멘션 하나의 러너 쪽 재료)이다.
//!
//! **멘션마다 새 값**(security L3c-2 ④): 짓개가 쥐는 것은 러너 수명 값(설정·세션 저장소·기억 캐시·이름 표·묶음 손님)뿐이다.
//! 감시 입력·턴 뒤 설정(`AfterConfig`)·결과 접기 설정(`OutcomeConfig`)·명령 옵션은 `call_inputs` 한 번에 **소유본으로 새로**
//! 짓고, 그 멘션의 닫개가 가져간다. 두 멘션이 동시에 지어도 서로의 값을 빌리지 않는다.
//!
//! - **서버 길은 묶음 하나뿐이다**: 기억은 짓개가 쥔 `Arc<AgentClients>` 의 MCP 로만 읽는다. 몸통(`BodyShared.clients`)은
//!   [`RunnerMaker::clients`] 로 **같은 묶음**을 받아 쥔다(main.rs, L3d). 기억은 계정 단위(core·mem/*)라 채널 인자가 없다 —
//!   그 에이전트 계정 것만 실린다.
//! - **계정 축은 기본 로그인 하나**(`vec![None]`): 계정 폴더는 `None`, 기록 찾기는 홈 기본(`cfg.home`). 계정 풀 배정은 L3c-3.
//! - **지시문 파일 자리는 그대로**(`state_dir`, 카드 답 대기) — `MentionParts::prepare` 가 쓴다.
//! - 정본과 다른 점: 스레드별 기억 고정·recall(`plan_memory`)은 아직 안 이어져 있다 — 지시문에는 기억 캐시 읽기만 실린다.
//!   PTY 옵션은 시도마다 `attempt_pty_options` 가 채우고(T3), 부모 env 는 main.rs 가 채운다.
//! - 마운트한 비밀의 가림 자리는 시도를 준비할 때 임대 장부에서 받는다(`LeaseBook::lease_dir`, T3a).
//!
//! main.rs 가 부른다(L3d). B4-5 스위치는 꺼져 있다. 자리만 채운 곳의 정본 목록은 #2107 PR 본문에 있다.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use crate::adapter::{AgentHarness, MentionPermission};
use crate::memory_cache::MemoryCache;
use crate::memory_pin::MemoryContext;
use crate::mention_body::CallMaker;
use crate::mention_call::{BaseInputs, BundleParts, CallInputs};
use crate::mention_clients::{AgentClients, AgentLink};
use crate::mention_hooks::LeaseBook;
use crate::mention_inputs::{MentionReads, SystemContext, report_promise};
use crate::mention_ledger::thread_key;
use crate::mention_parts::{MentionParts, SystemInputs, no_mount};
use crate::mention_target::{MentionTarget, TargetWake};
use crate::mention_turn_parts::{SilentCaller, silent_turn_caller};
use crate::mention_watch::{MentionWatchInputs, PROBE_MS};
use crate::pty_turn::{PtyTurnOptions, PtyTurnSink};
use crate::session_store::SessionStore;
use crate::turn_after_source::{AfterConfig, after_source_owned};
use crate::turn_command::TurnCommandOptions;
use crate::turn_end::EndConfig;
use crate::turn_notice::NudgeCaller;
use crate::turn_outcome_source::{OutcomeConfig, outcome_source_owned};
use crate::turn_preset::TurnMode;
use crate::turn_success::SuccessTarget;

/// 러너 수명 설정(기동 때 한 번).
#[derive(Clone, Debug)]
pub struct MakerConfig {
    pub operator_bin: String,
    pub command_hook: bool,
    pub post_tool_hook: bool,
    /// 상태 폴더 — 지시문 파일 자리(카드 답 대기, 지금 자리 그대로).
    pub state_dir: PathBuf,
    /// 오퍼레이터가 쓴 기본 MCP 설정(`HARKROOM_MCP_CONFIG`).
    pub mcp_config_path: PathBuf,
    pub runner_env: BTreeMap<String, String>,
    /// 하네스 자식에 물려줄 부모 env(main.rs 가 채운다).
    pub parent_env: BTreeMap<String, String>,
    pub pat: String,
    /// 기본 로그인의 홈 — 기록 찾기의 기준.
    pub home: PathBuf,
    pub turn_timeout_ms: u64,
    pub harness_stall_ms: u64,
    /// 스레드별 작업 폴더의 뿌리(정본 `workspaceBaseDir`) — 멘션마다 그 스레드 폴더를 [`crate::workspace`] 로 짓는다.
    pub workspace_base_dir: PathBuf,
    pub me_id: String,
    /// 이 러너 프로세스의 스레드 임대 holder(기동 때 무작위, `ThreadClaims` 와 같은 값).
    pub claim_holder: String,
    pub can_register_turn_keys: bool,
    /// PTY 원시 출력 녹화 폴더(정본 `config.ptyRecordDir`, `AGENT_PTY_RECORD_DIR` 절대 경로, 기본 `None` = 끔). 폴더 0700·파일 0600.
    pub pty_record_dir: Option<PathBuf>,
}

/// 배치마다 갱신하는 이름 표 — 이름은 바뀔 수 있어 멘션을 지을 때 꺼낸 **사본**을 쓴다.
#[derive(Clone, Debug, Default)]
pub struct Names {
    pub channel_names: HashMap<String, String>,
    /// 계정 id → handle.
    pub handles: HashMap<String, String>,
    pub me_handle: String,
    /// 에이전트 계정 id(모르면 `None` — 침묵 통지는 사람 쪽으로 틀린다).
    pub agent_ids: Option<HashSet<String>>,
}

/// MCP 인증 거절 알림(정본 `mcp.authRejected`) — main.rs 가 링크로 잇는다.
pub type ReportAuth = Box<dyn Fn(&[String], i64) + Send + Sync>;

/// 실물 짓개.
pub struct RunnerMaker<L: AgentLink> {
    cfg: MakerConfig,
    mcp_config: String,
    clients: Arc<AgentClients<L>>,
    store: SessionStore,
    memory: MemoryCache,
    names: RwLock<Names>,
    report_auth: ReportAuth,
}

/// 실물 PTY sink — 기본 메서드만(감시·전달 표지는 `MentionParts` 가 감싼다).
#[derive(Default)]
pub struct RunnerSink;
impl crate::pty_turn::PromptHooks for RunnerSink {}
impl PtyTurnSink for RunnerSink {}

fn now_u64() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_i64() -> i64 {
    i64::try_from(now_u64()).unwrap_or(i64::MAX)
}

fn log_line(l: &str) {
    eprintln!("{l}");
}

fn nudge_caller(c: SilentCaller) -> NudgeCaller {
    match c {
        SilentCaller::Agent => NudgeCaller::Agent,
        SilentCaller::Human => NudgeCaller::Human,
        SilentCaller::Delegated => NudgeCaller::Delegated,
        SilentCaller::Wake => NudgeCaller::Wake,
        SilentCaller::DelegationOutcome => NudgeCaller::DelegationOutcome,
    }
}

/// 그 멘션의 깨움 사유(정본 `target.wake?.reason ?? ''`).
fn wake_reason(t: &MentionTarget) -> String {
    match &t.wake {
        Some(TargetWake::Scheduled(w)) => w.reason.clone(),
        Some(TargetWake::AskAnswered(w)) => w.reason.clone(),
        Some(TargetWake::AskClosed(r)) => (*r).to_string(),
        None => String::new(),
    }
}

/// 그 멘션의 성공 판정 대상(정본 `target.wake`·`scheduledWake`·`wake.watch`·`delegatedBy`·보고처 약속).
fn success_target(t: &MentionTarget, promise: bool) -> SuccessTarget {
    SuccessTarget {
        wake: t.wake.is_some(),
        scheduled_wake: t.scheduled_wake(),
        watch: matches!(&t.wake, Some(TargetWake::Scheduled(w)) if w.watch),
        delegated_by: t.delegated_by.is_some(),
        report_promise: promise,
    }
}

impl<L: AgentLink> RunnerMaker<L> {
    pub fn new(cfg: MakerConfig, clients: Arc<AgentClients<L>>, report_auth: ReportAuth) -> Self {
        Self {
            mcp_config: cfg.mcp_config_path.to_string_lossy().into_owned(),
            store: SessionStore::new(cfg.state_dir.join("sessions.json")),
            memory: MemoryCache::new(&cfg.state_dir),
            names: RwLock::new(Names::default()),
            clients,
            cfg,
            report_auth,
        }
    }

    /// 몸통(`BodyShared.clients`)이 쥘 묶음 — 짓개와 **같은** 묶음이다(서버 길은 하나).
    pub fn clients(&self) -> Arc<AgentClients<L>> {
        Arc::clone(&self.clients)
    }

    /// 배치마다 이름 표를 바꾼다.
    pub fn set_names(&self, n: Names) {
        *self.names.write().unwrap_or_else(|p| p.into_inner()) = n;
    }

    /// 배치 머리의 기억 rev(정본 `noteRev`).
    pub fn note_memory_rev(&self, rev: Option<&str>) {
        self.memory.note_rev(rev);
    }

    fn names(&self) -> Names {
        self.names.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn config(&self) -> &MakerConfig {
        &self.cfg
    }
}

impl<L, S> CallMaker<L, S> for RunnerMaker<L>
where
    L: AgentLink + Send + Sync,
    S: PtyTurnSink + Default,
{
    fn system_context(&self, target: &MentionTarget, reads: &MentionReads) -> SystemContext<'_> {
        let n = self.names();
        // 기억은 짓개가 쥔 묶음으로만 읽는다(그 에이전트 계정 것). 사본도 서버도 못 읽으면 기억 절을 「못 읽음」으로.
        let memory = match self.memory.read(self.clients.mcp()) {
            Ok(r) => MemoryContext::Read(r),
            Err(e) => {
                eprintln!("[mentionTurn] 기억을 못 읽었다 — 기억 절 없이 돈다: {e}");
                MemoryContext::Unavailable
            }
        };
        SystemContext {
            handle: n.me_handle,
            channel_name: n
                .channel_names
                .get(&target.channel_id)
                .cloned()
                .unwrap_or_default(),
            memory,
            operator_bin: &self.cfg.operator_bin,
            harness: harness_of(&reads.def),
            command_hook: self.cfg.command_hook,
            post_tool_hook: self.cfg.post_tool_hook,
            // 기본 로그인만 — API 키 레인은 L3c-3.
            lane_model: None,
            turn_budget_ms: self.cfg.turn_timeout_ms,
        }
    }

    fn call_inputs<'a>(
        &'a self,
        _clients: &'a AgentClients<L>,
        book: &'a LeaseBook,
        target: &MentionTarget,
        reads: MentionReads,
        system: SystemInputs,
    ) -> CallInputs<'a, L, S> {
        let c = &self.cfg;
        let harness = harness_of(&reads.def);
        let n = self.names();
        let key = thread_key(&target.channel_id, Some(&target.thread_root_id));
        let anchor = Some(target.thread_root_id.clone());
        let caller = nudge_caller(silent_turn_caller(
            n.agent_ids.as_ref(),
            target,
            std::slice::from_ref(&target.mention_row),
        ));
        let promise = report_promise(target);
        let home = Some(c.home.clone());

        let watch = MentionWatchInputs {
            key: key.clone(),
            me_id: c.me_id.clone(),
            channel_id: target.channel_id.clone(),
            anchor: anchor.clone(),
            harness,
            home: home.clone(),
            omp_home: None,
            end_cfg: EndConfig {
                stall_ms: i64::try_from(c.harness_stall_ms).unwrap_or(i64::MAX),
                ..EndConfig::new(c.turn_timeout_ms)
            },
            // API 키 레인이 없다(기본 로그인) — 재촉 없음.
            lane_tui: false,
            caller,
            report_auth: &*self.report_auth,
            clock: now_i64,
            probe_ms: PROBE_MS,
        };
        let after = after_source_owned(AfterConfig {
            key: key.clone(),
            me_id: c.me_id.clone(),
            channel_id: target.channel_id.clone(),
            anchor,
            mention_id: target.mention_id.clone(),
            caller,
            // 대리 글은 API 키 연결 턴에만(정본 `recordProxy: providerEnv !== null`) — 기본 로그인은 끈다.
            proxy_head: String::new(),
            record_proxy: false,
            wake_reason: wake_reason(target),
            background_wait_ms: c.turn_timeout_ms,
            target: success_target(target, promise.is_some()),
            harness,
            home: home.clone(),
            promise,
        });
        // 그 스레드의 작업 폴더(정본 `resolveWorkspaceDir`) — 새 스레드마다 다른 폴더, 같은 스레드는 같은 폴더. 짓지 못하면 이 멘션은
        // 띄우지 않는다: 준비 구간 패닉은 몸통 지킴(L3a)이 장부·자리·임대를 놓는다(다음 폴이 다시 받는다).
        let workspace = crate::workspace::resolve_workspace_dir(
            &c.workspace_base_dir,
            &c.me_id,
            &key,
            reads
                .def
                .get("workingDir")
                .and_then(serde_json::Value::as_str),
            &crate::workspace::exec_command,
        )
        .unwrap_or_else(|e| panic!("작업 폴더를 짓지 못했다: {e}"))
        .to_string_lossy()
        .into_owned();
        let argv = owned_argv(
            &key,
            harness,
            system.read_only,
            reads.turn_model.model.clone(),
            reads.turn_model.effort.clone(),
        );
        let outcome = OutcomeConfig {
            harness,
            home,
            turn_timeout_ms: c.turn_timeout_ms,
            harness_stall_ms: c.harness_stall_ms,
            turn_model: Some(reads.turn_model),
            stop_requested_at: reads
                .def
                .get("stopRequestedAt")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
        };
        let (pkey, handles) = (key.clone(), n.handles);
        // 마운트한 비밀을 꼬리·통지·기록에서 가릴 바늘 자리(정본 `secretNeedles(cause)`) — 임대는 부품을 지은 뒤 받으므로 시도
        // 준비 때 묻는다.
        let lease_cause = target.mention_id.clone();
        // 정본 `main.ts:76` `recordDir: config.ptyRecordDir`(`AGENT_PTY_RECORD_DIR`, 기본 끔).
        let record_dir = c.pty_record_dir.clone();
        let build_parts = Box::new(move |b: BundleParts<'a, L>| {
            let perm = if system.read_only {
                MentionPermission::Readonly
            } else {
                MentionPermission::Auto
            };
            let mut base =
                TurnCommandOptions::new(harness, TurnMode::Mention, perm, &c.operator_bin);
            base.mcp_config_path = &self.mcp_config;
            base.command_hook = system.permissions.as_ref().is_some_and(|p| p.command_hook);
            let mut p = MentionParts::with_parts(
                b.io,
                &self.store,
                base,
                system,
                // 작업 폴더는 시도마다 `attempt_pty_options` 가 채운다 — 여기서는 비워 둬, 빠뜨리면 띄우기 직전 검사에 걸린다.
                Box::new(move || PtyTurnOptions {
                    record_dir: record_dir.clone(),
                    ..PtyTurnOptions::at(PathBuf::new())
                }),
                S::default(),
                outcome_source_owned(outcome),
                b.after,
                no_mount(),
            );
            p.key = pkey;
            p.me_id = c.me_id.clone();
            p.handles = handles;
            p.state_dir = c.state_dir.clone();
            p.new_workspace_dir = workspace;
            p.home = c.home.clone();
            p.parent_env = c.parent_env.clone();
            p.slot = b.slot;
            p.watch_loop = Some(b.watch_loop);
            p.argv = argv;
            // 턴 프롬프트의 「지금 시각」 줄 — 시도마다 그 순간을 잰다(정본 `now: new Date()`).
            p.clock = Some(crate::local_clock::turn_clock_now);
            p.lease_dir_of = Some(Box::new(move || book.lease_dir(&lease_cause)));
            p.turn_timeout_ms = c.turn_timeout_ms;
            p
        });
        CallInputs {
            key,
            // 기본 로그인 하나 — 계정 폴더 없음.
            lane: Box::new(|_k, _a| vec![None]),
            now: now_u64,
            claim_holder: Some(&c.claim_holder),
            log: &log_line,
            watch,
            after,
            build_parts,
            base: BaseInputs {
                harness,
                can_register_turn_keys: c.can_register_turn_keys,
                state_dir: &c.state_dir,
                mcp_config_path: &c.mcp_config_path,
                runner_env: &c.runner_env,
                pat: &c.pat,
            },
        }
    }
}

/// 그 멘션이 읽은 정의의 하네스(정본 `mentionTurn` 이 턴마다 `def.harness` 를 쓰는 것과 같다). 기본값은 없다 — 없거나 모르는
/// 값이면 짓지 않는다: 준비 구간 패닉 → 몸통 지킴(L3a)이 장부·자리·턴 끝·임대를 놓는다. 패닉 문구는 상태 한 줄이고 값은 싣지 않는다.
pub fn harness_of(def: &serde_json::Value) -> AgentHarness {
    def.get("harness")
        .and_then(serde_json::Value::as_str)
        .and_then(AgentHarness::parse)
        .unwrap_or_else(|| {
            panic!(
                "에이전트 정의의 하네스를 쓸 수 없다(없거나 모르는 값) — 이 멘션은 띄우지 않는다"
            )
        })
}

/// 그 멘션의 명령 칸 소유본(정본 `buildTurnCommand` 의 `model`·`effort`·`readonlyToolList`). 허용 도구·머지 저장소·API 는
/// 지시문 입력에서 `with_argv` 가 싣는다.
///
/// 읽기 전용 목록: 글롭으로 좁히는 하네스(목록 명령이 없는 것)는 묻지 않고 바로 짓는다. 이름을 하네스에게 물어야 하는
/// 하네스(pi)는 아직 묻는 길이 없어 `None` 으로 둔다 → 그 하네스의 읽기 전용 턴은 `ReadonlyToolListMissing` 으로 **띄우지
/// 않는다**(닫히는 쪽, security L3d ① — 빈 목록이나 내장 도구만 여는 기본값으로 우회하지 않는다).
pub fn owned_argv(
    key: &str,
    harness: AgentHarness,
    read_only: bool,
    model: Option<String>,
    effort: Option<String>,
) -> crate::mention_parts::OwnedArgv {
    let perm = if read_only {
        MentionPermission::Readonly
    } else {
        MentionPermission::Auto
    };
    let asks_harness =
        crate::adapter::readonly_tools_for(harness).is_some_and(|s| s.list.is_some());
    let readonly_tool_list = if asks_harness {
        None
    } else {
        crate::turn_mcp_plan::turn_readonly_tools(key, harness, perm, |_| None)
    };
    crate::mention_parts::OwnedArgv {
        model,
        effort,
        readonly_tool_list,
    }
}

#[cfg(test)]
#[path = "call_maker_tests.rs"]
mod tests;
