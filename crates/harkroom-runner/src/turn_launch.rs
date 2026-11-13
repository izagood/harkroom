//! TurnAttempt 연결 셋째 조각 — 하네스를 띄우는 **순서**와 턴 끝 **기록 가리기 경로**.
//!
//! 정본 `mentionTurn.ts` 의 스폰 구간(`canceledBeforeSpawn` → `registerTurnKeys` → `runTurn`)과 턴 끝
//! `scrubTurnKeys([transcript, <sessionId>/])` 를 옮긴다. 정본보다 엄격한 점(security 조건 ④): 관문
//! [`spawn_gate`] 를 **턴 열쇠 맡기기·비밀 받기·lane 키 받기·하네스 띄우기 각각의 바로 앞**에서 다시 본다 — 준비
//! 도중 임대를 잃거나 사람이 [중단] 하면 그 뒤 단계는 하나도 하지 않는다(정본은 열쇠 맡기기와 띄우기 앞에서만 본다).
//!
//! 단계 실패는 닫히는 쪽이다 — 열쇠를 못 맡기면 열쇠 없이 띄우지 않고 실패로 간다. 실패 사유는 단계 이름만
//! 돌려준다(오류 원문은 호출자가 로그로만 다룬다, 결과 글에 싣지 않는다).

use std::path::{Path, PathBuf};

use crate::adapter::{AgentHarness, uses_omp_home, uses_pi_home};
use crate::secret_scrub::{ScrubTally, scrub_turn_keys};
use crate::turn_preset::preassigns_session_id;
use crate::turn_probe_records::SpawnBlocked;

/// 띄우기 전 준비 단계(정본 순서).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchStep {
    /// 턴 열쇠를 서버에 맡긴다(정본 `registerTurnKeys`).
    TurnKeys,
    /// 이 턴에 마운트할 비밀을 받는다(정본 `secretLeases` 마운트).
    Secrets,
    /// 계정·제공사 lane 키를 받는다.
    LaneKeys,
}

/// 이 턴에 필요한 준비 단계. 꺼진 단계는 건너뛴다(관문은 그래도 띄우기 앞에서 본다).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LaunchPlan {
    pub turn_keys: bool,
    pub secrets: bool,
    pub lane_keys: bool,
}

/// 띄우기 순서가 바깥에 시키는 일.
pub trait LaunchIo {
    /// 하네스 한 번의 결과(정본 `TurnResult`).
    type Out;
    /// 준비 단계 하나. 실패면 `Err` — 그 뒤 단계와 띄우기를 하지 않는다.
    fn prepare(&mut self, step: LaunchStep) -> Result<(), String>;
    /// 하네스를 띄우고 끝날 때까지 돈다.
    fn spawn(&mut self) -> Self::Out;
}

/// 띄우기 순서의 끝.
#[derive(Debug, PartialEq, Eq)]
pub enum Launched<O> {
    /// 하네스가 돌았다.
    Ran(O),
    /// 관문이 막았다 — 하네스는 존재한 적이 없다(정본 `{ exitCode: 143, tail: '' }` 길, 문장은 `canceledBy`·펜스가 정한다).
    Blocked(SpawnBlocked),
    /// 준비 단계가 실패했다 — 닫히는 쪽(띄우지 않는다).
    SetupFailed(LaunchStep),
}

/// 띄우기 순서의 결과와, 턴 끝 정리에 필요한 사실.
#[derive(Debug, PartialEq, Eq)]
pub struct LaunchReport<O> {
    pub launched: Launched<O>,
    /// 턴 열쇠를 실제로 맡겼다(정본 `turnKeysRegistered`).
    pub turn_keys_registered: bool,
    /// `prepare` 를 **부른** 단계(성공·실패 모두). 턴 끝 [`release_launch`] 가 이것으로 거둔다 — 실패한 단계도 넣는다:
    /// 서버가 열쇠를 받고 응답만 놓쳤거나 비밀이 반쯤 마운트됐을 수 있다(#2012 security ⑤).
    pub attempted: Vec<LaunchStep>,
}

/// 정본 스폰 구간. `gate` 는 매번 지금의 수명·중단 상태로 [`spawn_gate`](crate::turn_probe_records::spawn_gate)를
/// 부르는 닫개다 — 준비 도중 바뀐 상태를 다음 단계 앞에서 본다.
pub fn launch<I: LaunchIo>(
    plan: LaunchPlan,
    io: &mut I,
    gate: &mut dyn FnMut() -> Result<(), SpawnBlocked>,
) -> LaunchReport<I::Out> {
    let steps = [
        (plan.turn_keys, LaunchStep::TurnKeys),
        (plan.secrets, LaunchStep::Secrets),
        (plan.lane_keys, LaunchStep::LaneKeys),
    ];
    let mut turn_keys_registered = false;
    let mut attempted = Vec::new();
    for (on, step) in steps {
        if !on {
            continue;
        }
        if let Err(b) = gate() {
            return LaunchReport {
                launched: Launched::Blocked(b),
                turn_keys_registered,
                attempted,
            };
        }
        attempted.push(step);
        if io.prepare(step).is_err() {
            return LaunchReport {
                launched: Launched::SetupFailed(step),
                turn_keys_registered,
                attempted,
            };
        }
        if step == LaunchStep::TurnKeys {
            turn_keys_registered = true;
        }
    }
    if let Err(b) = gate() {
        return LaunchReport {
            launched: Launched::Blocked(b),
            turn_keys_registered,
            attempted,
        };
    }
    LaunchReport {
        launched: Launched::Ran(io.spawn()),
        turn_keys_registered,
        attempted,
    }
}

/// 준비 단계에서 받은 것을 거두는 일(정본 `settle` 의 `revokeTurnKeys`·`provider_env_done`·마운트 해제).
pub trait LaunchRelease {
    /// 단계 하나를 거둔다. **없는 것에도 무해해야 한다** — 맡기기·받기가 실패한 단계도 부른다.
    fn release(&mut self, step: LaunchStep) -> Result<(), String>;
}

/// 턴 끝 정리 — [`LaunchReport::attempted`] 의 단계를 **거꾸로**(lane 키 → 비밀 → 턴 열쇠) 모두 거둔다.
///
/// [`Launched`] 의 갈래(`Ran`·`Blocked`·`SetupFailed`)와 상관없이 부른다(#2012 security ⑥) — 비밀을 받은 뒤 막히거나
/// 다음 단계가 실패해도 마운트·lane 키가 남지 않는다. 한 단계가 실패해도 나머지를 계속 거두고, 실패한 단계 이름만
/// 돌려준다(로그에는 단계 이름만, 오류 원문·값은 싣지 않는다).
pub fn release_launch(attempted: &[LaunchStep], io: &mut impl LaunchRelease) -> Vec<LaunchStep> {
    let mut failed = Vec::new();
    for &step in attempted.iter().rev() {
        // 되감기 중(`LaunchGuard` 의 Drop)에 release 가 다시 패닉하면 프로세스가 abort 된다 — 단계마다 패닉을 받아 실패로
        // 센다(#2014 security nit b). 패닉 문구는 싣지 않는다(값이 섞였을 수 있다).
        let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| io.release(step)));
        if !matches!(out, Ok(Ok(()))) {
            eprintln!("[mentionTurn] 턴 끝 정리 실패 — {step:?}(나머지는 계속 거둔다)");
            failed.push(step);
        }
    }
    failed
}

/// 턴 끝 정리를 **정확히 한 번** 부르는 가드(#2013 security: 예외·타임아웃·패닉 포함 모든 갈래).
///
/// [`launch_guarded`] 가 `prepare` 를 부르기 **직전에** 그 단계를 적는다 — `spawn` 이 패닉해도 그때까지 받은 것이
/// 가드에 남는다. 정리는 [`LaunchGuard::finish`](정상 끝)나 `Drop`(조기 반환·`?`·패닉) 중 먼저 오는 쪽에서 한 번만
/// 돈다. 두 번째 부름은 아무것도 하지 않는다.
pub struct LaunchGuard<R: LaunchRelease> {
    attempted: Vec<LaunchStep>,
    release: R,
    done: bool,
}

impl<R: LaunchRelease> LaunchGuard<R> {
    pub fn new(release: R) -> Self {
        Self {
            attempted: Vec::new(),
            release,
            done: false,
        }
    }

    /// 지금까지 `prepare` 를 부른 단계.
    pub fn attempted(&self) -> &[LaunchStep] {
        &self.attempted
    }

    /// 정상 끝의 정리. 실패한 단계 이름을 돌려준다. 이미 정리했으면 빈 것.
    pub fn finish(mut self) -> Vec<LaunchStep> {
        self.run()
    }

    fn run(&mut self) -> Vec<LaunchStep> {
        if self.done {
            return Vec::new();
        }
        self.done = true;
        release_launch(&self.attempted, &mut self.release)
    }
}

impl<R: LaunchRelease> Drop for LaunchGuard<R> {
    fn drop(&mut self) {
        // 패닉 중이어도 거둔다 — 거두기 자체가 다시 패닉하면 프로세스가 끝나므로, release 구현은 패닉하지 않아야 한다.
        self.run();
    }
}

/// [`launch`] 와 같은 순서·관문이되, 단계마다 `prepare` 직전에 `guard` 에 적는다.
pub fn launch_guarded<I: LaunchIo, R: LaunchRelease>(
    plan: LaunchPlan,
    io: &mut I,
    gate: &mut dyn FnMut() -> Result<(), SpawnBlocked>,
    guard: &mut LaunchGuard<R>,
) -> LaunchReport<I::Out> {
    struct Noting<'a, I: LaunchIo, R: LaunchRelease> {
        io: &'a mut I,
        guard: &'a mut LaunchGuard<R>,
    }
    impl<I: LaunchIo, R: LaunchRelease> LaunchIo for Noting<'_, I, R> {
        type Out = I::Out;
        fn prepare(&mut self, step: LaunchStep) -> Result<(), String> {
            self.guard.attempted.push(step);
            self.io.prepare(step)
        }
        fn spawn(&mut self) -> I::Out {
            self.io.spawn()
        }
    }
    launch(plan, &mut Noting { io, guard }, gate)
}

/// 실제 턴 끝 정리 — 세 갈래 모두 **없는 것에도 무해**하다.
/// - 턴 열쇠: 오퍼레이터 `/agent/turn-keys/end`(모르는 턴이면 지울 것이 없을 뿐 200) — 맡기기가 `Err` 였어도 부른다.
/// - 비밀: 마운트한 임대를 끝낸다(정본 `secretLeases.release` — 임대가 없으면 아무것도 안 함).
/// - lane 키: 제공사 env 를 거둔다(정본 `provider_env_done`).
///
/// 비밀·lane 은 한 번 쓰면 비우는 닫개(`Option::take`)라 두 번 불러도 한 번만 돈다.
pub struct TurnRelease<'a> {
    /// 열쇠 거두기 — 오퍼레이터 답이 200 이 아니면 `Err`(정리 실패로 센다).
    pub end_turn_keys: &'a mut dyn FnMut() -> Result<(), String>,
    pub end_secrets: Option<Box<dyn FnOnce() + 'a>>,
    pub provider_env_done: Option<Box<dyn FnOnce() + 'a>>,
}

impl LaunchRelease for TurnRelease<'_> {
    fn release(&mut self, step: LaunchStep) -> Result<(), String> {
        match step {
            LaunchStep::TurnKeys => return (self.end_turn_keys)(),
            LaunchStep::Secrets => {
                if let Some(f) = self.end_secrets.take() {
                    f();
                }
            }
            LaunchStep::LaneKeys => {
                if let Some(f) = self.provider_env_done.take() {
                    f();
                }
            }
        }
        Ok(())
    }
}

/// 턴 끝에 턴 열쇠를 가릴 **모든** 기록 경로(정본 `[transcript, ...(preassigns && !pi && !omp ? [dirname/sessionId] : [])]`).
/// claude 는 jsonl 옆 `<sessionId>/` 에 큰 도구 출력(`tool-results`)·서브에이전트 전사(`subagents`)를 따로 남긴다.
/// 기록 파일을 못 찾았으면(`None`) 빈 목록이다.
pub fn turn_record_paths(
    harness: AgentHarness,
    transcript: Option<&Path>,
    session_id: Option<&str>,
) -> Vec<PathBuf> {
    let Some(t) = transcript else {
        return Vec::new();
    };
    let mut out = vec![t.to_path_buf()];
    let sidecar = preassigns_session_id(harness).unwrap_or(false)
        && !uses_pi_home(harness)
        && !uses_omp_home(harness);
    if sidecar
        && let Some(id) = session_id
            .filter(|s| !s.is_empty() && !s.contains(['/', '\\']) && *s != ".." && *s != ".")
        && let Some(dir) = t.parent()
    {
        out.push(dir.join(id));
    }
    out
}

/// 턴 끝 가리기(정본 K3) — 이 턴의 모든 기록 경로에서 턴 열쇠를 가린다. 바늘이 없으면 아무것도 하지 않는다.
pub fn scrub_turn_records(
    key: &str,
    harness: AgentHarness,
    transcript: Option<&Path>,
    session_id: Option<&str>,
    needles: &[String],
) -> ScrubTally {
    if needles.is_empty() {
        return ScrubTally::default();
    }
    scrub_turn_keys(
        key,
        &turn_record_paths(harness, transcript, session_id),
        needles,
    )
}

#[cfg(test)]
#[path = "turn_launch_tests.rs"]
mod tests;
