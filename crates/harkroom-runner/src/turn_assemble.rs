//! `TurnAttempt` struct 의 입력 조립 — 턴 MCP 계획 → 턴 설정 파일·가림 재료·맡길 열쇠, 그리고 명령 → PTY 띄우기 닫개.
//!
//! - [`assemble_attempt`]: [`turn_mcp_plan`] 로 이 턴의 열쇠와 MCP 설정 자리를 정하고, 그 계획에서 [`TurnFiles`](턴 끝에
//!   지울 설정 파일)·[`SecretsSource`](가림 목록 재료 — 목록은 `run_attempt` 가 마운트 뒤에 짓는다)·맡길 [`OpenTurn`] 을 낸다.
//! - [`pty_turn_plan`]: 띄우기 때 받은 lane env 와 계획의 열쇠·MCP 설정 경로를 **기본 명령 옵션 위에만** 얹어
//!   [`build_turn_command`] → [`TurnPlan::into_pty_plan`] 으로 PTY 계획을 만든다. 열쇠·lane env 는 자식 env 로만 간다
//!   (argv 아님 — `turn_command` 시험이 붙잡는다).
//! - [`pty_spawn`]: 그 계획으로 [`run_pty_turn`] 을 도는 `SpawnFn`. 명령 조립 실패는 종류만 담은 오류로 접는다.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::provider_lane::LaneFileError;
use crate::pty::AttentionKind;
use crate::pty_turn::{
    PromptHooks, PtyControls, PtyPlan, PtyTurnError, PtyTurnOptions, PtyTurnSink, run_pty_turn,
};
use crate::rest::OpenTurn;
use crate::turn_command::{TurnCommandError, TurnCommandOptions, build_turn_command};
use crate::turn_env::TurnKeys as EnvTurnKeys;
use crate::turn_launch::LaunchPlan;
use crate::turn_launch_io::{LaneEnv, SpawnFn};
use crate::turn_mcp_plan::{TurnFiles, TurnMcpInput, TurnMcpPlan, turn_mcp_plan};
use crate::turn_run::{PtyOut, SecretsSource};

/// 조립한 시도 재료.
pub struct Assembled<'a> {
    pub plan: TurnMcpPlan,
    pub files: TurnFiles,
    pub secrets: SecretsSource<'a>,
    /// 맡길 열쇠(계획이 열쇠를 냈을 때만).
    pub turn: Option<OpenTurn>,
}

impl Assembled<'_> {
    /// 띄우기 순서의 계획 — 열쇠가 있으면 맡기고, 비밀·lane 은 부르는 쪽이 정한다.
    pub fn launch_plan(&self, secrets: bool, lane_keys: bool) -> LaunchPlan {
        LaunchPlan {
            turn_keys: self.turn.is_some(),
            secrets,
            lane_keys,
        }
    }
}

/// 턴 MCP 계획 → 시도 재료. `pat`·`lease_dir` 는 가림 재료로만 쥔다.
pub fn assemble_attempt<'a>(
    mcp: &TurnMcpInput<'_>,
    cause: Option<&str>,
    pat: &'a str,
    lease_dir: Option<PathBuf>,
) -> Result<Assembled<'a>, LaneFileError> {
    let plan = turn_mcp_plan(mcp)?;
    let files = TurnFiles::of(&plan, mcp.state_dir, mcp.turn_id);
    let turn_key_values = plan
        .turn_keys
        .as_ref()
        .map(|k| vec![k.bridge.clone(), k.shell.clone()])
        .unwrap_or_default();
    let turn = plan.turn_keys.clone().map(|keys| OpenTurn {
        turn_id: mcp.turn_id.to_string(),
        cause: cause.map(str::to_string),
        keys,
    });
    Ok(Assembled {
        plan,
        files,
        secrets: SecretsSource {
            pat,
            turn_key_values,
            lease_dir,
        },
        turn,
    })
}

/// 기본 명령 옵션에 이 시도의 lane env·열쇠·MCP 설정 경로를 얹어 PTY 계획을 만든다.
pub fn pty_turn_plan(
    base: &TurnCommandOptions<'_>,
    lane_env: &LaneEnv,
    keys: Option<&EnvTurnKeys>,
    mcp_config_path: &str,
    parent_env: &BTreeMap<String, String>,
    home: &Path,
) -> Result<PtyPlan, TurnCommandError> {
    let mut o = base.clone();
    o.provider_env = (!lane_env.is_empty()).then_some(lane_env);
    o.turn_keys = keys;
    o.mcp_config_path = mcp_config_path;
    Ok(build_turn_command(&o, parent_env, home)?.into_pty_plan())
}

/// 계획의 열쇠(`rest::TurnKeys`)를 명령 조립의 꼴(`turn_env::TurnKeys`)로.
pub fn env_turn_keys(plan: &TurnMcpPlan) -> Option<EnvTurnKeys> {
    plan.turn_keys.as_ref().map(|k| EnvTurnKeys {
        shell: k.shell.clone(),
        bridge: k.bridge.clone(),
    })
}

/// 띄우기 닫개 — lane env 를 받아 PTY 턴을 끝까지 돈다. 명령 조립 실패는 종류만 담은 오류로 접는다(값·경로 없음).
pub fn pty_spawn<'a, S: PtyTurnSink + 'a>(
    base: TurnCommandOptions<'a>,
    keys: Option<EnvTurnKeys>,
    mcp_config_path: String,
    parent_env: &'a BTreeMap<String, String>,
    home: &'a Path,
    opts: PtyTurnOptions,
    sink: &'a mut S,
) -> SpawnFn<'a, PtyOut> {
    Box::new(move |lane_env: LaneEnv| {
        spawn_pty_turn(
            &base,
            PtyTurnArgs {
                lane_env: &lane_env,
                keys: keys.as_ref(),
                mcp_config_path: &mcp_config_path,
                parent_env,
                home,
            },
            opts,
            sink,
        )
    })
}

/// [`spawn_pty_turn`] 이 이 시도에서 받는 것.
pub struct PtyTurnArgs<'x> {
    pub lane_env: &'x LaneEnv,
    pub keys: Option<&'x EnvTurnKeys>,
    pub mcp_config_path: &'x str,
    pub parent_env: &'x BTreeMap<String, String>,
    pub home: &'x Path,
}

/// 이 시도의 PTY 턴 한 번 — `AttemptParts::spawn` 의 실물 몸통. 명령 조립 실패는 종류만 담은 오류로 접는다.
pub fn spawn_pty_turn<S: PtyTurnSink>(
    base: &TurnCommandOptions<'_>,
    a: PtyTurnArgs<'_>,
    opts: PtyTurnOptions,
    sink: &mut S,
) -> PtyOut {
    let plan = pty_turn_plan(
        base,
        a.lane_env,
        a.keys,
        a.mcp_config_path,
        a.parent_env,
        a.home,
    )
    .map_err(|e| PtyTurnError::Spawn(std::io::Error::other(format!("명령 조립 실패: {e}"))))?;
    run_pty_turn(&plan, opts, sink)
}

/// 프롬프트가 입력창에 들어간 순간(정본 `onInjected: () => deps.onPromptDelivered?.()`) `delivered` 를 세우는 sink 덧씌우개.
/// 나머지 갈래는 안쪽 sink 에 그대로 넘긴다. `delivered` 는 관문 표식 지우기의 근거다(`run_one`).
pub struct DeliveredSink<'s, S: PtyTurnSink> {
    pub inner: &'s mut S,
    pub delivered: &'s mut bool,
}

impl<S: PtyTurnSink> PromptHooks for DeliveredSink<'_, S> {
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

impl<S: PtyTurnSink> PtyTurnSink for DeliveredSink<'_, S> {
    fn on_spawn(&mut self, controls: PtyControls) {
        self.inner.on_spawn(controls)
    }
    fn on_output(&mut self, frame: &[u8]) {
        self.inner.on_output(frame)
    }
    fn on_injected(&mut self) {
        *self.delivered = true;
        self.inner.on_injected()
    }
    fn on_attention(&mut self, screen: &str, kind: AttentionKind) {
        self.inner.on_attention(screen, kind)
    }
    fn on_turn_gate(&mut self, screen: &str) {
        self.inner.on_turn_gate(screen)
    }
}

#[cfg(test)]
#[path = "turn_assemble_tests.rs"]
mod tests;
