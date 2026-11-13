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
//! 감시 루프(`run_watch`)를 띄우는 일과 B4-5 스위치는 이 조각 밖이다.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::account_assign::ClaudeAccount;
use crate::memory_pin::MemoryContext;
use crate::mention_run::TurnOk;
use crate::mention_target::MentionTarget;
use crate::prompt_system::SystemPromptOpts;
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
}

/// 결과 접기 닫개 — 시도 결과·가림 목록·[중단] 자리·끝 상태 사본.
pub type OutcomeFn<'a> = Box<
    dyn FnMut(Attempted<PtyOut>, &TurnSecrets, &LiveTurn, &EndState) -> Result<TurnOk, AttemptError>
        + 'a,
>;
/// 턴 뒤 IO 닫개.
pub type AfterFn<'a> = Box<dyn FnMut(&TurnSecrets) -> Result<(), String> + 'a>;
/// 비밀 마운트 닫개.
pub type MountFn<'a> = Box<dyn FnMut(&str) -> Result<(), SecretMountError> + 'a>;
/// 시도마다 PTY 옵션(주입 글 틀 포함)을 새로 짓는다.
pub type PtyOptsFn<'a> = Box<dyn Fn() -> PtyTurnOptions + 'a>;

/// 이 시도의 준비 결과.
struct Current {
    account: AttemptAccount,
    prepared: Prepared,
    system_prompt_file: String,
    cause: String,
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
    pub now: Option<TurnClock>,
    pub outcome: OutcomeFn<'a>,
    pub after: AfterFn<'a>,
    pub mount: MountFn<'a>,
    cur: Option<Current>,
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
            inner,
            watch: Watch::default(),
            slot: LiveSlot::default(),
            lane: LaneSnapshot::default(),
            secrets: false,
            lease_dir: None,
            now: None,
            outcome,
            after,
            mount,
            cur: None,
        }
    }

    /// 이 시도의 명령 옵션 — 시도 칸 → 계정 폴더(마지막). 준비 전이면 `None`.
    pub fn command_for<'s>(&'s self, turn_id: &'s str) -> Option<TurnCommandOptions<'s>> {
        let c = self.cur.as_ref()?;
        Some(attempt_command_for_account(
            &self.base,
            &c.account,
            &c.prepared.session,
            &c.system_prompt_file,
            &c.cause,
            turn_id,
        ))
    }

    /// 이 시도의 턴 프롬프트(주입 글). 준비 전이면 `None`.
    pub fn prompt(&self) -> Option<&str> {
        self.cur.as_ref().map(|c| c.prepared.prompt.prompt.as_str())
    }
}

impl<P: PrepareIo, S: PtyTurnSink> AttemptParts for MentionParts<'_, P, S> {
    fn bind_live(&mut self, live: Option<Arc<LiveTurn>>) {
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
        let sys = &self.system;
        let file = write_turn_system_prompt(
            &self.state_dir,
            &SystemPromptOpts {
                handle: &sys.handle,
                channel_name: &sys.channel_name,
                instructions: &sys.instructions,
                guide: &sys.guide,
                memory: &sys.memory,
                turn_budget_ms: None,
                merge: None,
                permissions: None,
                api: None,
                secret_create: false,
                lane_model: None,
                read_only: sys.read_only,
            },
        )
        .map_err(|e| {
            eprintln!("[mentionTurn] {}: 지시문 파일 쓰기 실패 — {e}", self.key);
            fail()
        })?;
        let homes = acc.homes(
            Some(&self.home),
            self.omp_home.as_deref(),
            self.codex_home.as_deref(),
        );
        let session_id = prepared.session.rec.session_id.clone();
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
            lease_dir: self.lease_dir.clone(),
            session_id,
            homes: OwnedHomes { ..homes },
        })
    }

    fn mount_secrets(&mut self, cause: &str) -> Result<(), SecretMountError> {
        (self.mount)(cause)
    }

    fn spawn(&mut self, args: SpawnArgs<'_>, delivered: &mut bool) -> PtyOut {
        let mut opts = (self.pty_opts)();
        let text = self.prompt().unwrap_or_default().to_string();
        // (`text` 는 소유본 — 아래에서 `inner` 를 빌리기 전에 꺼낸다.)
        opts.inject = opts.inject.map(|i| InjectPrompt { text, ..i });
        let watch = self.watch.clone();
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
        let cmd = attempt_command_for_account(
            &self.base,
            &c.account,
            &c.prepared.session,
            &c.system_prompt_file,
            &c.cause,
            args.turn_id,
        );
        let mcp = args.mcp_config_path.to_string_lossy().into_owned();
        let pargs = PtyTurnArgs {
            lane_env: &args.lane_env,
            keys: args.keys,
            mcp_config_path: &mcp,
            parent_env: &self.parent_env,
            home: Path::new(&self.home),
        };
        // 감시 목록(`args.notice`)은 감시 루프가 쓴다 — 여기서는 sink 를 쌓기만 한다.
        let _ = &args.notice;
        let mut delivered_sink = DeliveredSink {
            inner: &mut self.inner,
            delivered,
        };
        let mut watch_sink = WatchSink {
            inner: &mut delivered_sink,
            watch,
            now_ms: &now,
        };
        match args.relay {
            Some(r) => {
                let mut s = RelaySink {
                    inner: &mut watch_sink,
                    relay: r,
                };
                spawn_pty_turn(&cmd, pargs, opts, &mut s)
            }
            None => spawn_pty_turn(&cmd, pargs, opts, &mut watch_sink),
        }
    }

    fn outcome(
        &mut self,
        attempted: Attempted<PtyOut>,
        secrets: &TurnSecrets,
        live: &LiveTurn,
    ) -> Result<TurnOk, AttemptError> {
        let end = self
            .watch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .end
            .clone();
        (self.outcome)(attempted, secrets, live, &end)
    }

    fn after(&mut self, secrets: &TurnSecrets) -> Result<(), String> {
        (self.after)(secrets)
    }

    fn account_ranks(&self, account: Option<&ClaudeAccount>) -> (Option<Option<u32>>, Option<u32>) {
        ranks_of(&self.lane, account)
    }
}

#[cfg(test)]
#[path = "mention_parts_tests.rs"]
mod tests;
