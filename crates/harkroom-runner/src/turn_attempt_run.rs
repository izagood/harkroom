//! [`TurnAttempt`] 를 구현한 struct — `run_one` 이 계정 축을 돌며 부르는 시도 하나(정본 `runMentionTurn` 한 번).
//!
//! 시도마다 **새로** 만든다(앞 시도의 것을 다시 쓰지 않는다):
//! - 턴 id(정본 `const turnId = randomUUID()` — `runMentionTurn` 이 부를 때마다),
//! - [`LiveTurn`](펜스·[중단] 을 지금 값으로 읽는 자리) — [`AttemptParts::bind_live`] 로 듣기에 걸고, 시도가 끝나면 놓는다,
//! - [`assemble_attempt`] — 턴 열쇠·턴 MCP 설정 파일·가림 재료가 이 시도의 턴 id 로 새로 나온다.
//!
//! `run` 은 [`run_attempt`] 가 돌아온 뒤에야 돌아온다 — 그 안에서 정리 가드(열쇠 거두기·임대 끝)와 턴 설정 파일 지우기가
//! 이미 끝났다. 그래서 계정을 바꿔 다시 부를 때(`with_account_failover`) 다음 시도는 앞 시도의 정리가 끝난 뒤에 시작한다.
//!
//! 대상·계정에 따라 바뀌는 몫(명령 옵션·프롬프트·PTY 띄우기·결과 접기·턴 뒤 IO)은 [`AttemptParts`] 가 쥔다.
//! lane 턴은 정본처럼 lane env 를 턴 MCP 계획 **앞에서** 받는다([`mount_lane_first`] — 관문을 먼저 보고, 가드가 시도 끝에
//! 임대를 끝내고 lane 턴 파일을 거둔다). 그래서 띄우기 순서의 lane 키 단계는 켜지 않고, 받은 env 를 계획과 띄우기에 그대로 쓴다.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::account_assign::ClaudeAccount;
use crate::adapter::AgentHarness;
use crate::link::random_uuid;
use crate::mention_run::{TurnAttempt, TurnOk};
use crate::mention_target::MentionTarget;
use crate::relay_session::SessionHandle;
use crate::rest::{HarkroomRestClient, OpenTurn, RunnerLink, TurnKeys};
use crate::turn_assemble::{Assembled, assemble_attempt, env_turn_keys};
use crate::turn_attempt::{AttemptInput, Attempted, LeaseNotice, TurnSecrets};
use crate::turn_attempt_live::LiveTurn;
use crate::turn_attempt_relay::RelayAttempt;
use crate::turn_env::TurnKeys as EnvTurnKeys;
use crate::turn_lane_first::{LaneFirstError, LaneSource, OnceLease, mount_lane_first};
use crate::turn_launch::LaunchStep;
use crate::turn_launch::TranscriptHomes;
use crate::turn_launch_io::{LaneEnv, SecretMountError};
use crate::turn_life::TurnLife;
use crate::turn_mcp_plan::TurnMcpInput;
use crate::turn_policy::AttemptError;
use crate::turn_probe_records::NoticeSecrets;
use crate::turn_run::{AttemptSetup, PtyOut, RecordScrub, run_attempt};

/// 턴 MCP 설정을 준비하지 못했을 때의 문장(경로·원인은 로컬 로그에만).
pub const TURN_MCP_FAILED: &str = "턴 MCP 설정을 준비하지 못했다";

/// 기록 찾기 자리(소유본) — [`TranscriptHomes`] 로 빌려 준다.
#[derive(Clone, Debug, Default)]
pub struct OwnedHomes {
    pub claude_config_dir: Option<PathBuf>,
    pub home: Option<PathBuf>,
    pub omp_home: Option<PathBuf>,
    pub codex_home: Option<PathBuf>,
}

impl OwnedHomes {
    pub fn view(&self) -> TranscriptHomes<'_> {
        TranscriptHomes {
            claude_config_dir: self.claude_config_dir.as_deref(),
            home: self.home.as_deref(),
            omp_home: self.omp_home.as_deref(),
            codex_home: self.codex_home.as_deref(),
        }
    }
}

/// 이 시도의 준비 — [`AttemptParts::prepare`] 가 대상·계정·턴 id 로 낸다.
#[derive(Clone, Debug)]
pub struct AttemptPrep {
    /// 스레드 열쇠(로그·기록 가리기 이름).
    pub key: String,
    /// 원인 메시지 id — 임대·턴 열쇠의 열쇠.
    pub cause: String,
    /// 이 턴이 비밀을 마운트한다(정본 턴 임대가 `Ready`).
    pub secrets: bool,
    /// 비밀 마운트가 쓰는 자리 — 가림 목록은 하네스가 돈 뒤 여기서 짓는다.
    pub lease_dir: Option<PathBuf>,
    pub session_id: Option<String>,
    pub homes: OwnedHomes,
}

/// [`AttemptParts::spawn`] 이 이 시도에서 받는 것.
pub struct SpawnArgs<'x> {
    pub turn_id: &'x str,
    /// 이 시도의 턴 열쇠(조립에서 온다).
    pub keys: Option<&'x EnvTurnKeys>,
    /// 이 시도의 턴 MCP 설정 경로.
    pub mcp_config_path: &'x Path,
    /// lane 턴이면 계획 앞에서 받은 env, 아니면 빈 env.
    pub lane_env: LaneEnv,
    /// 띄우는 자리(마운트 뒤)에서 지은 감시 통지 가림 목록 — 감시 루프는 이것으로만 가린다(#2045).
    pub notice: NoticeSecrets,
    /// 멘션 중계 세션의 이 시도 가드(있으면 sink 를 감싼다).
    pub relay: Option<&'x RelayAttempt<'x>>,
}

/// 대상·계정에 따라 바뀌는 몫. 부르는 순서: `bind_live(Some)` → `prepare` → (`mount_secrets`) → `spawn` → `outcome` →
/// (성공이면) `after` → `bind_live(None)`. 겹쳐 부르지 않는다.
pub trait AttemptParts {
    /// 이 시도의 [`LiveTurn`] 을 펜스 잃음·[중단] 듣기에 건다. `None` 이면 놓는다(앞 시도의 것이 다음 시도를 막지 않게).
    fn bind_live(&mut self, live: Option<Arc<LiveTurn>>);
    fn prepare(
        &mut self,
        target: &MentionTarget,
        account: Option<&ClaudeAccount>,
        is_last_account: bool,
        turn_id: &str,
    ) -> AttemptPrep;
    /// 이 턴의 비밀을 `lease_dir` 에 마운트한다(`prep.secrets` 일 때만 부른다).
    fn mount_secrets(&mut self, cause: &str) -> Result<(), SecretMountError>;
    /// PTY 턴을 끝까지 돈다 — 열쇠·MCP 설정 경로는 이 시도의 조립에서 온다(`pty_turn_plan`). 프롬프트가 입력창에 닿으면
    /// `delivered` 를 세운다.
    ///
    /// `notice` 는 **띄우는 이 자리(마운트 뒤)** 에서 지은 가림 목록이다 — 턴 sink·감시 루프가 화면·출력에서 거둔 말을
    /// 스레드에 올릴 때 이것으로만 가린다(정본 `secretNeedles(cause)` 를 그때 읽는 것과 같다). 턴 전에 지은 목록을 쓰면
    /// 마운트한 비밀이 빠진다(#2032 꼴).
    fn spawn(&mut self, args: SpawnArgs<'_>, delivered: &mut bool) -> PtyOut;
    /// 이 시도 계정의 칩 순번(계정 순번·풀 순번) — 멘션 세션에 다시 알린다. 이름은 싣지 않는다. 모르면 `(None, None)`.
    fn account_ranks(
        &self,
        _account: Option<&ClaudeAccount>,
    ) -> (Option<Option<u32>>, Option<u32>) {
        (None, None)
    }
    /// 시도 결과를 접는다(`attempt_outcome` — `secrets.pat()`·`secrets.needles()` 로 가린다).
    #[allow(clippy::result_large_err)]
    fn outcome(
        &mut self,
        attempted: Attempted<PtyOut>,
        secrets: &TurnSecrets,
        live: &LiveTurn,
    ) -> Result<TurnOk, AttemptError>;
    /// 성공한 턴 뒤 IO(`apply_after_turn`). 실패는 로그만.
    fn after(&mut self, secrets: &TurnSecrets) -> Result<(), String>;
}

/// [`TurnAttempt`] 구현 — 러너 하나에 하나, 시도마다 `run`.
pub struct PtyTurnAttempt<'a, L: RunnerLink, N: LeaseNotice, P: AttemptParts> {
    pub client: &'a HarkroomRestClient<L>,
    pub notice: &'a N,
    pub harness: AgentHarness,
    pub can_register_turn_keys: bool,
    pub state_dir: &'a Path,
    /// 오퍼레이터가 쓴 기본 MCP 설정.
    pub mcp_config_path: &'a Path,
    pub runner_env: &'a BTreeMap<String, String>,
    pub pat: &'a str,
    /// 새 턴 id — 실물은 [`PtyTurnAttempt::new`] 가 거는 무작위 v4([`random_uuid`], 정본 `randomUUID()`) 하나뿐이다.
    /// 밖에서 바꿀 수 없다(시험만 같은 모듈 안에서 덮는다).
    new_turn_id: Box<dyn FnMut() -> String + 'a>,
    pub parts: RefCell<P>,
    /// lane(API 키 연결) — 있으면 시도마다 턴 MCP 계획 앞에서 env 를 받는다.
    lane: Option<&'a dyn LaneSource>,
    /// 멘션 중계 세션(#2046 — `run_mention` 이 연 것). 있으면 시도마다 [`RelayAttempt`] 로 쥔다.
    relay: Option<&'a SessionHandle>,
}

/// 시도 하나의 재료(`run` → `attempt`).
struct AttemptCtx<'x> {
    turn_id: &'x str,
    live: &'x LiveTurn,
    target: &'x MentionTarget,
    account: Option<&'x ClaudeAccount>,
    is_last: bool,
    relay: Option<&'x RelayAttempt<'x>>,
}

/// 러너 전체에서 한 번 정하는 재료.
pub struct AttemptBase<'a, L: RunnerLink, N: LeaseNotice> {
    pub client: &'a HarkroomRestClient<L>,
    pub notice: &'a N,
    pub harness: AgentHarness,
    pub can_register_turn_keys: bool,
    pub state_dir: &'a Path,
    pub mcp_config_path: &'a Path,
    pub runner_env: &'a BTreeMap<String, String>,
    pub pat: &'a str,
}

impl<'a, L: RunnerLink, N: LeaseNotice, P: AttemptParts> PtyTurnAttempt<'a, L, N, P> {
    /// 턴 id 는 시도마다 무작위 v4 로 새로 뽑는다(카운터·고정값 아님).
    pub fn new(base: AttemptBase<'a, L, N>, parts: P) -> Self {
        Self {
            client: base.client,
            notice: base.notice,
            harness: base.harness,
            can_register_turn_keys: base.can_register_turn_keys,
            state_dir: base.state_dir,
            mcp_config_path: base.mcp_config_path,
            runner_env: base.runner_env,
            pat: base.pat,
            new_turn_id: Box::new(random_uuid),
            parts: RefCell::new(parts),
            lane: None,
            relay: None,
        }
    }

    /// lane 턴으로 돈다 — 시도마다 턴 MCP 계획 앞에서 lane env 를 받는다.
    pub fn with_lane(mut self, lane: &'a dyn LaneSource) -> Self {
        self.lane = Some(lane);
        self
    }

    /// 멘션 중계 세션을 건다 — 시도마다 그 시도 범위에서 [`RelayAttempt`] 를 만든다.
    pub fn with_relay(mut self, session: &'a SessionHandle) -> Self {
        self.relay = Some(session);
        self
    }
}

/// 이 시도의 [`LiveTurn`] 듣기를 **어느 길로 끝나든**(조립·띄우기 중 패닉 포함) 놓는다. 그때 `parts` 를 누가 빌리고
/// 있으면(패닉이 빌린 자리 안에서 났고 아직 안 풀렸으면) 놓지 못한 것을 로그로만 남긴다 — `Drop` 에서 패닉하지 않는다.
struct LiveBinding<'p, P: AttemptParts>(&'p RefCell<P>);

impl<P: AttemptParts> Drop for LiveBinding<'_, P> {
    fn drop(&mut self) {
        match self.0.try_borrow_mut() {
            Ok(mut p) => p.bind_live(None),
            Err(_) => eprintln!("[mentionTurn] LiveTurn 듣기를 놓지 못했다(빌린 채 끝남)"),
        }
    }
}

impl<L: RunnerLink, N: LeaseNotice, P: AttemptParts> PtyTurnAttempt<'_, L, N, P> {
    #[allow(clippy::result_large_err)]
    fn attempt(&self, c: AttemptCtx<'_>, delivered: &mut bool) -> Result<TurnOk, AttemptError> {
        let AttemptCtx {
            turn_id,
            live,
            target,
            account,
            is_last,
            relay,
        } = c;
        let parts = &self.parts;
        // 임대 끝 알림은 이 시도에서 한 번 — 띄우기 정리와 lane 가드가 이 자리를 같이 쓴다.
        let lease_once = OnceLease::new(self.notice);
        let prep = parts
            .borrow_mut()
            .prepare(target, account, is_last, turn_id);
        // lane env 를 계획보다 먼저 받는다(정본 순서). 관문이 막았거나 받기가 실패하면 그 시도로 접는다.
        let lane_hold = match self.lane {
            None => None,
            Some(l) => {
                match mount_lane_first(l, &lease_once, &prep.cause, self.harness, &mut || {
                    live.gate()
                }) {
                    Ok(h) => Some(h),
                    Err(e) => {
                        let attempted = match e {
                            LaneFirstError::Blocked(b) => Attempted::Blocked(b),
                            LaneFirstError::Failed(code) => Attempted::SetupFailed {
                                step: LaunchStep::LaneKeys,
                                code,
                            },
                        };
                        // 하네스도 비밀도 없다 — PAT 만으로 접는다.
                        let s = TurnSecrets::build(self.pat, &[], None);
                        return parts.borrow_mut().outcome(attempted, &s, live);
                    }
                }
            }
        };
        let lane_env = lane_hold.as_ref().map(|h| h.env().clone());
        let mcp = TurnMcpInput {
            harness: self.harness,
            can_register_turn_keys: self.can_register_turn_keys,
            provider_env: lane_env.as_ref(),
            state_dir: self.state_dir,
            mcp_config_path: self.mcp_config_path,
            turn_id,
            runner_env: self.runner_env,
        };
        let assembled =
            match assemble_attempt(&mcp, Some(&prep.cause), self.pat, prep.lease_dir.clone()) {
                Ok(a) => a,
                Err(e) => {
                    eprintln!(
                        "[mentionTurn] {}: {TURN_MCP_FAILED} — {}",
                        prep.key,
                        e.local_detail()
                    );
                    return Err(AttemptError {
                        message: TURN_MCP_FAILED.to_string(),
                        ..AttemptError::default()
                    });
                }
            };
        let keys = env_turn_keys(&assembled.plan);
        let mcp_path = assembled.plan.mcp_config_path.clone();
        let launch = assembled.launch_plan(prep.secrets, false);
        let Assembled {
            files,
            secrets,
            turn,
            ..
        } = assembled;
        // 열쇠를 안 내는 턴은 열쇠 단계가 꺼져 있다(`launch.turn_keys == false`) — 이 자리는 맡기지 않는다.
        let turn = turn.unwrap_or_else(|| OpenTurn {
            turn_id: turn_id.to_string(),
            cause: Some(prep.cause.clone()),
            keys: TurnKeys {
                bridge: String::new(),
                shell: String::new(),
            },
        });
        let cause = prep.cause.clone();
        let spawn_turn_id = turn_id.to_string();
        let spawn_lane_env = lane_env.clone();
        // 띄우는 자리에서 감시용 가림 목록을 지을 재료(값은 이 시도의 조립에서만 온다).
        let notice_keys = secrets.turn_key_values.clone();
        let notice_lease = secrets.lease_dir.clone();
        let pat = self.pat;
        let input = AttemptInput {
            plan: launch,
            client: self.client,
            lane: None,
            harness: self.harness,
            cause: &prep.cause,
            turn,
            mount_secrets: prep.secrets.then(|| {
                Box::new(move || parts.borrow_mut().mount_secrets(&cause))
                    as crate::turn_launch_io::SecretsMount<'_>
            }),
            spawn: Box::new(move |launch_env: LaneEnv| {
                // lane 턴이면 계획 앞에서 받은 env, 아니면 띄우기 순서가 준 것(빈 env).
                let lane_env = spawn_lane_env.unwrap_or(launch_env);
                // 마운트 뒤(띄우기 직전)에 짓는다 — 비밀 단계가 이 닫개보다 먼저 돈다.
                let keys_ref: Vec<&str> = notice_keys.iter().map(String::as_str).collect();
                let notice =
                    TurnSecrets::build(pat, &keys_ref, notice_lease.as_deref()).notice_secrets();
                parts.borrow_mut().spawn(
                    SpawnArgs {
                        turn_id: &spawn_turn_id,
                        keys: keys.as_ref(),
                        mcp_config_path: &mcp_path,
                        lane_env,
                        notice,
                        relay,
                    },
                    delivered,
                )
            }),
            after_run: None,
        };
        let setup = AttemptSetup {
            files,
            secrets,
            scrub: RecordScrub {
                key: &prep.key,
                session_id: prep.session_id.as_deref(),
                homes: prep.homes.view(),
            },
        };
        run_attempt(
            setup,
            input,
            &lease_once,
            live,
            |a, s| parts.borrow_mut().outcome(a, s, live),
            |s| parts.borrow_mut().after(s),
        )
    }
}

impl<L: RunnerLink, N: LeaseNotice, P: AttemptParts> TurnAttempt for PtyTurnAttempt<'_, L, N, P> {
    type Err = AttemptError;

    fn run(
        &mut self,
        target: &MentionTarget,
        account: Option<&ClaudeAccount>,
        is_last_account: bool,
        delivered: &mut bool,
    ) -> Result<TurnOk, AttemptError> {
        let turn_id = (self.new_turn_id)();
        let live = Arc::new(LiveTurn::new(TurnLife::default()));
        self.parts.borrow_mut().bind_live(Some(Arc::clone(&live)));
        let _binding = LiveBinding(&self.parts);
        // 시도 범위 — `_binding` 과 같은 수명이고 먼저 떨어진다(입력 통로 놓기 → 듣기 놓기). 패닉에도 둘 다 지난다.
        let ranks = self.parts.borrow().account_ranks(account);
        let relay = self.relay.map(|s| RelayAttempt::begin(s, ranks.0, ranks.1));
        self.attempt(
            AttemptCtx {
                turn_id: &turn_id,
                live: &live,
                target,
                account,
                is_last: is_last_account,
                relay: relay.as_ref(),
            },
            delivered,
        )
    }
}

#[cfg(test)]
#[path = "turn_attempt_run_tests.rs"]
mod tests;
