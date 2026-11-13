//! TurnAttempt 본체 — 계정 하나로 턴 한 번을 **띄우고 거두는 뼈대**(정본 `runMentionTurn` 의 스폰 구간 + `finally`).
//!
//! [`attempt_once`] 가 시도 하나마다:
//! 1. lane env 를 함께 쥘 [`LaneSlot`] 하나, 실제 [`RestLaunch`]·[`RestRelease`] 한 쌍, [`LaunchGuard`] 하나를 만든다.
//! 2. [`launch_guarded`] 로 열쇠 → 비밀 → lane 키 → 띄우기를 돈다. 단계마다 그 바로 앞에서 `gate`
//!    (= [`spawn_gate`](crate::turn_probe_records::spawn_gate)`(&life, canceled)`)를 다시 본다.
//! 3. 돌았으면 `after_run`(기록 가리기)을 **정리 전에** 한다.
//! 4. **갈래와 상관없이** 가드의 [`LaunchGuard::finish`] 를 부른다. 그 사이 패닉·조기 반환이면
//!    가드의 `Drop` 이 같은 정리를 한 번 한다.
//!
//! 임대 끝내기(`end_lease`)는 [`LeaseNotice::lease_ended`] — 실물은 [`LinkClient::notify_secret_lease_ended`]`(cause)`
//! 다(정본 `secretLeases.release` → `notifyEnded`). 오퍼레이터는 두 번째 끝내기에 무동작이다.
//!
//! 띄우기 결과를 결말([`TurnEnd`])로 접는 일은 여기서 준비 실패 갈래만 한다 — 막힘(`Blocked`)은 정본처럼 「종료 143·꼬리
//! 없음」으로 실패 갈래(`turn_failure`)가 `canceled_by`·`fenced_out` 을 보고 문장을 고른다.

use crate::adapter::AgentHarness;
use crate::fail_text::provider_lane_recallable;
use crate::link::LinkClient;
use crate::mention_settle::TurnEnd;
use crate::provider_lane::ProviderLane;
use crate::rest::{HarkroomRestClient, OpenTurn, RunnerLink};
use crate::turn_launch::{LaunchGuard, LaunchIo, LaunchPlan, LaunchStep, Launched, launch_guarded};
use crate::turn_launch_io::{LaneSlot, RestLaunch, RestRelease, SecretsMount, SpawnFn};
use crate::turn_probe_records::SpawnBlocked;

/// 턴 임대 끝 알림.
pub trait LeaseNotice {
    fn lease_ended(&self, cause: &str);
}

impl LeaseNotice for LinkClient {
    fn lease_ended(&self, cause: &str) {
        self.notify_secret_lease_ended(cause);
    }
}

/// 하네스가 돈 뒤 정리 전에 할 일.
pub type AfterRun<'a, O> = Box<dyn FnOnce(&O) + 'a>;

/// 시도 하나의 재료.
pub struct AttemptInput<'a, L: RunnerLink, O> {
    pub plan: LaunchPlan,
    pub client: &'a HarkroomRestClient<L>,
    pub lane: Option<&'a ProviderLane>,
    pub harness: AgentHarness,
    /// 원인 메시지 id — 임대·lane 마운트의 열쇠.
    pub cause: &'a str,
    pub turn: OpenTurn,
    pub mount_secrets: Option<SecretsMount<'a>>,
    pub spawn: SpawnFn<'a, O>,
    /// 하네스가 돈 뒤, **정리(임대 끝내기) 전에** 할 일 — 기록 가리기(턴 열쇠 + 마운트한 비밀 바늘). 임대가 끝나면
    /// 오퍼레이터가 비밀 파일을 지워 바늘을 못 만든다(정본 `secretLeases.release` 가 가린 뒤 끝을 알리는 순서).
    pub after_run: Option<AfterRun<'a, O>>,
}

/// 시도 하나의 끝.
#[derive(Debug, PartialEq, Eq)]
pub enum Attempted<O> {
    /// 하네스가 돌았다.
    Ran(O),
    /// 관문이 막았다 — 하네스는 존재한 적 없다(정본 `canceledBeforeSpawn` → 종료 143·꼬리 없음).
    Blocked(SpawnBlocked),
    /// 준비 단계 실패 — 단계와 그 접힌 코드(경로·값 없음).
    SetupFailed { step: LaunchStep, code: String },
}

/// 준비 단계 실패를 결말로 접는다. lane 은 접힌 코드로(정본 `ProviderLaneError` 길), 나머지는 고정 문장(종류만).
pub fn setup_failure_end(step: LaunchStep, code: &str) -> TurnEnd {
    match step {
        LaunchStep::LaneKeys => TurnEnd::ProviderLane {
            code: code.to_string(),
            recallable: provider_lane_recallable(code),
        },
        LaunchStep::TurnKeys => TurnEnd::Other {
            err_text: "턴 자격을 오퍼레이터에 맡기지 못했다 — 오퍼레이터가 이 판을 모르면 앱을 업데이트하라".to_string(),
        },
        LaunchStep::Secrets => TurnEnd::Other {
            err_text: "이 턴의 비밀을 받지 못했다".to_string(),
        },
    }
}

/// 준비 실패의 접힌 코드를 받아 둔다(`launch` 는 단계만 돌려준다).
struct Recording<'r, I: LaunchIo> {
    io: &'r mut I,
    last_err: Option<String>,
}

impl<I: LaunchIo> LaunchIo for Recording<'_, I> {
    type Out = I::Out;
    fn prepare(&mut self, step: LaunchStep) -> Result<(), String> {
        let r = self.io.prepare(step);
        if let Err(e) = &r {
            self.last_err = Some(e.clone());
        }
        r
    }
    fn spawn(&mut self) -> I::Out {
        self.io.spawn()
    }
}

/// 계정 하나로 턴 한 번 — 띄우기 순서와 정리를 한데 묶는다. 정리는 **여기서 끝난다**(가드 `finish`) — 호출자가 잊을 수
/// 없다. 거두기 실패는 단계 이름만 로그에 남는다.
pub fn attempt_once<L: RunnerLink, O>(
    input: AttemptInput<'_, L, O>,
    notice: &impl LeaseNotice,
    gate: &mut dyn FnMut() -> Result<(), SpawnBlocked>,
) -> Attempted<O> {
    let AttemptInput {
        plan,
        client,
        lane,
        harness,
        cause,
        turn,
        mount_secrets,
        spawn,
        after_run,
    } = input;
    let turn_id = turn.turn_id.clone();
    let slot = LaneSlot::default();
    let mut guard = LaunchGuard::new(RestRelease {
        client,
        turn_id,
        lane,
        lane_slot: slot.clone(),
        end_lease: Some(Box::new(move || notice.lease_ended(cause))),
    });
    let mut io = RestLaunch {
        client,
        turn,
        lane,
        harness,
        cause,
        lane_slot: slot,
        mount_secrets,
        spawn: Some(spawn),
    };
    let mut rec = Recording {
        io: &mut io,
        last_err: None,
    };
    let report = launch_guarded(plan, &mut rec, gate, &mut guard);
    let last_err = rec.last_err.take();
    if let (Launched::Ran(o), Some(f)) = (&report.launched, after_run) {
        f(o);
    }
    let failed = guard.finish();
    if !failed.is_empty() {
        eprintln!("[mentionTurn] 턴 끝 정리 실패 단계: {failed:?}");
    }
    match report.launched {
        Launched::Ran(o) => Attempted::Ran(o),
        Launched::Blocked(b) => Attempted::Blocked(b),
        Launched::SetupFailed(step) => Attempted::SetupFailed {
            step,
            code: last_err.unwrap_or_else(|| "setup".to_string()),
        },
    }
}

/// 비밀 값 파일 하나의 상한 — 이보다 크면 바늘을 만들지 않는다(정본은 상한이 없다; 값 파일은 작다).
const LEASE_VALUE_MAX_BYTES: u64 = 1024 * 1024;

/// 정본 `secretLeases.needlesOf` — 그 턴 임대 디렉터리의 값 파일들로 바늘을 만든다(긴 것부터). 심링크·디렉터리·큰 파일은
/// 건너뛴다. 값은 이 함수 밖으로 나가지 않는다 — 바늘(값의 여러 꼴)만 나간다.
pub fn lease_needles(dir: &std::path::Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut all: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for e in rd.flatten() {
        let p = e.path();
        let Ok(m) = std::fs::symlink_metadata(&p) else {
            continue;
        };
        if !m.file_type().is_file() || m.len() > LEASE_VALUE_MAX_BYTES {
            continue;
        }
        if let Ok(v) = std::fs::read(&p) {
            all.extend(crate::secret_scrub::scrub_needles(&v));
        }
    }
    let mut v: Vec<String> = all.into_iter().collect();
    v.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    v
}

/// 실제 `after_run` — 이 턴의 **모든** 기록 경로([`turn_record_paths`](crate::turn_launch::turn_record_paths): 기록 파일과
/// `<sessionId>/`)를 턴 열쇠 바늘 + 임대 비밀 바늘로 가린다. 임대가 끝나기 전에 불려야 한다(`attempt_once` 가 그 순서를 지킨다).
pub fn scrub_after_run(
    key: &str,
    harness: AgentHarness,
    transcript: Option<&std::path::Path>,
    session_id: Option<&str>,
    turn_key_values: &[&str],
    lease_dir: Option<&std::path::Path>,
) -> crate::secret_scrub::ScrubTally {
    let mut needles: std::collections::BTreeSet<String> =
        crate::secret_scrub::turn_key_needles(turn_key_values)
            .into_iter()
            .collect();
    if let Some(d) = lease_dir {
        needles.extend(lease_needles(d));
    }
    let mut needles: Vec<String> = needles.into_iter().collect();
    needles.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    crate::turn_launch::scrub_turn_records(key, harness, transcript, session_id, &needles)
}

#[cfg(test)]
#[path = "turn_attempt_tests.rs"]
mod tests;
