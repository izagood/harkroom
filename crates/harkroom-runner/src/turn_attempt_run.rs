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
//! lane 턴은 아직 받지 않는다 — 정본은 lane env 를 턴 MCP 계획 **앞에서** 받는데(opencode 턴 파일·lane 전용 설정), 그
//! 순서는 다음 조각 몫이다. 그때까지 이 struct 는 lane 열쇠 단계를 켜지 않는다.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::account_assign::ClaudeAccount;
use crate::adapter::AgentHarness;
use crate::mention_run::{TurnAttempt, TurnOk};
use crate::mention_target::MentionTarget;
use crate::rest::{HarkroomRestClient, OpenTurn, RunnerLink, TurnKeys};
use crate::turn_assemble::{Assembled, assemble_attempt, env_turn_keys};
use crate::turn_attempt::{AttemptInput, Attempted, LeaseNotice, TurnSecrets};
use crate::turn_attempt_live::LiveTurn;
use crate::turn_env::TurnKeys as EnvTurnKeys;
use crate::turn_launch::TranscriptHomes;
use crate::turn_launch_io::{LaneEnv, SecretMountError};
use crate::turn_life::TurnLife;
use crate::turn_mcp_plan::TurnMcpInput;
use crate::turn_policy::AttemptError;
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
    fn spawn(
        &mut self,
        turn_id: &str,
        keys: Option<&EnvTurnKeys>,
        mcp_config_path: &Path,
        lane_env: LaneEnv,
        delivered: &mut bool,
    ) -> PtyOut;
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
    /// 새 턴 id(정본 `randomUUID()`).
    pub new_turn_id: Box<dyn FnMut() -> String + 'a>,
    pub parts: RefCell<P>,
}

impl<L: RunnerLink, N: LeaseNotice, P: AttemptParts> PtyTurnAttempt<'_, L, N, P> {
    #[allow(clippy::result_large_err)]
    fn attempt(
        &self,
        turn_id: &str,
        live: &LiveTurn,
        target: &MentionTarget,
        account: Option<&ClaudeAccount>,
        is_last: bool,
        delivered: &mut bool,
    ) -> Result<TurnOk, AttemptError> {
        let parts = &self.parts;
        let prep = parts
            .borrow_mut()
            .prepare(target, account, is_last, turn_id);
        let mcp = TurnMcpInput {
            harness: self.harness,
            can_register_turn_keys: self.can_register_turn_keys,
            provider_env: None,
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
            spawn: Box::new(move |lane_env| {
                parts.borrow_mut().spawn(
                    &spawn_turn_id,
                    keys.as_ref(),
                    &mcp_path,
                    lane_env,
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
            self.notice,
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
        let res = self.attempt(&turn_id, &live, target, account, is_last_account, delivered);
        self.parts.borrow_mut().bind_live(None);
        res
    }
}

#[cfg(test)]
#[path = "turn_attempt_run_tests.rs"]
mod tests;
