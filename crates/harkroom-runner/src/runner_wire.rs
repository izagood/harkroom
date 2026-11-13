//! 기동 배선의 라이브러리 몫(L3d-3a) — `main.rs` 가 잇는 실물 셋.
//!
//! - [`BundlePoll`]: [`PollSource`] 실물. 서버 길은 그 에이전트의 [`AgentClients`] 묶음 하나뿐이다(롱폴·정의·채널·계정).
//!   inbox 임대(`inbox_lease`)가 켜져 있으면 도는 턴이 쥔 entry 를 `holding` 으로 실어 서버가 다시 내주지 않게 한다.
//! - [`LinkEvents`]: [`EventSink`] 실물. 자리 놓기·임대 잃음 표지는 같은 묶음으로, 종료 요청·회복 못 할 실패는 부르는 쪽
//!   (폴 루프·프로세스)으로 넘긴다. 표지 본문은 고정 키(`fenced`)뿐이고, 발화 실패는 로그만 남긴다.
//! - [`runner_exit_plan`]·[`executable_missing_plan`]: 정본 `runnerExitPlan`. 서버가 자격증명을 거절하면(401·403) 78 과 마커
//!   한 줄로 물러난다 — 앱은 마커만 읽는다. 로그에는 **상태 코드만** 남기고 오류 원문·응답 본문·PAT 는 싣지 않는다.

use std::sync::Arc;

use serde_json::{Value, json};

use crate::mcp::PollLease;
use crate::mention_clients::AgentClients;
use crate::poll_loop::PollSource;
use crate::poll_sched::EventSink;
use crate::rest::{HarkroomError, RunnerLink};

/// shared `EX_CONFIG` — 재시도로 낫지 않는 설정 실패.
pub const EX_CONFIG: i32 = 78;
/// shared `CREDENTIAL_REJECTED_LINE`(오퍼레이터 `runner_log.rs` 와 같은 글자).
pub const CREDENTIAL_REJECTED_LINE: &str =
    "harkroom-agent: credential rejected (revoked or rotated); exiting";
/// shared `EXECUTABLE_NOT_FOUND_LINE`.
pub const EXECUTABLE_NOT_FOUND_LINE: &str = "harkroom-agent: harness executable not found; exiting";

/// 물러나는 법 — 종료 코드와 찍을 줄.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExitPlan {
    pub code: i32,
    pub lines: Vec<String>,
}

/// 정본 `runnerExitPlan` 의 서버 자격증명 갈래 — 판정은 **HTTP 상태로만** 한다(문구 매칭 없음). 아니면 `None`.
pub fn runner_exit_plan(e: &HarkroomError) -> Option<ExitPlan> {
    let status = e.status.filter(|s| *s == 401 || *s == 403)?;
    Some(ExitPlan {
        code: EX_CONFIG,
        lines: vec![
            "\nHarkroom 자격증명을 해결할 수 없다. 러너를 멈춘다.".into(),
            "  서버가 이 러너의 오퍼레이터를 거절했다 — 오퍼레이터가 폐기됐거나 이 에이전트의 배정이 풀렸다.".into(),
            "  설정 › Operators 와 에이전트 상세의 배정을 확인해라. 배정이 살아 있으면 오퍼레이터가 다시 띄운다.".into(),
            format!("  상태: {status}"),
            CREDENTIAL_REJECTED_LINE.into(),
        ],
    })
}

/// 정본 `runnerExitPlan` 의 실행 파일 갈래.
pub fn executable_missing_plan() -> ExitPlan {
    ExitPlan {
        code: EX_CONFIG,
        lines: vec![
            "\nharness 실행 파일을 찾을 수 없다. 러너를 멈춘다.".into(),
            "  하네스를 설치했는지, 그 경로가 러너의 PATH 에 있는지 확인해라.".into(),
            "  launchd/systemd 로 띄웠다면 로그인 셸의 PATH 가 상속되지 않는다 — 서비스 정의에 직접 적어라.".into(),
            EXECUTABLE_NOT_FOUND_LINE.into(),
        ],
    }
}

/// [`PollSource`] 실물.
pub struct BundlePoll<L: RunnerLink> {
    clients: Arc<AgentClients<L>>,
    timeout_ms: u64,
    /// inbox 임대가 켜졌으면 이 러너 id.
    lease_runner_id: Option<String>,
}

impl<L: RunnerLink> BundlePoll<L> {
    pub fn new(
        clients: Arc<AgentClients<L>>,
        timeout_ms: u64,
        lease_runner_id: Option<String>,
    ) -> Self {
        Self {
            clients,
            timeout_ms,
            lease_runner_id,
        }
    }
}

impl<L: RunnerLink> PollSource for BundlePoll<L> {
    fn poll(&self, holding: &[i64]) -> Result<Value, HarkroomError> {
        let lease = self.lease_runner_id.as_ref().map(|id| PollLease {
            runner_id: id.clone(),
            holding: holding.to_vec(),
        });
        self.clients
            .mcp()
            .poll_inbox(self.timeout_ms, lease.as_ref())
    }
    fn definition(&self) -> Result<Value, HarkroomError> {
        self.clients.rest().definition()
    }
    fn channels(&self) -> Result<Vec<(String, String)>, HarkroomError> {
        self.clients.mcp().channels()
    }
    fn accounts(&self) -> Result<Vec<Value>, HarkroomError> {
        self.clients.rest().accounts()
    }
    fn reset(&self) {
        self.clients.mcp().reset();
    }
}

/// 종료 요청 시각을 받는 자리(폴 루프 `consider_stop_request`).
pub type OnStop = Box<dyn Fn(&str) + Send + Sync>;
/// 회복 못 할 실패로 물러나는 자리(프로세스 종료).
pub type OnFatal = Box<dyn Fn(ExitPlan) + Send + Sync>;
/// API 키 연결 턴 결과(오퍼레이터 `notify_provider_lane_turn`). 없으면 보내지 않는다.
pub type OnTurnOutcome = Box<dyn Fn(bool) + Send + Sync>;

/// [`EventSink`] 실물.
pub struct LinkEvents<L: RunnerLink> {
    clients: Arc<AgentClients<L>>,
    on_stop: OnStop,
    on_fatal: OnFatal,
    on_turn_outcome: Option<OnTurnOutcome>,
}

impl<L: RunnerLink> LinkEvents<L> {
    pub fn new(
        clients: Arc<AgentClients<L>>,
        on_stop: OnStop,
        on_fatal: OnFatal,
        on_turn_outcome: Option<OnTurnOutcome>,
    ) -> Self {
        Self {
            clients,
            on_stop,
            on_fatal,
            on_turn_outcome,
        }
    }
}

/// 정본 `runnerNoticeFallbackBody({key:'fenced'})`.
const FENCED_FALLBACK: &str = "(다른 러너가 이 스레드를 넘겨받아 이 턴을 접었다 — 이 러너가 서버와 끊긴 사이 스레드 임대가 만료됐다. 남은 일은 넘겨받은 쪽이 잇는다)";

impl<L: RunnerLink> EventSink for LinkEvents<L> {
    fn release_turn_slot(&self, thread_key: &str) {
        self.clients.rest().release_turn_slot(thread_key);
    }
    fn notice_fenced(&self, channel_id: &str, anchor: &str) {
        if let Err(e) = self.clients.mcp().notice(
            channel_id,
            Some(anchor),
            &json!({"key": "fenced"}),
            FENCED_FALLBACK,
        ) {
            eprintln!(
                "[mentionScheduler] 임대 잃음 표지 발화 실패(상태 {:?})",
                e.status
            );
        }
    }
    fn turn_outcome(&self, ok: bool) {
        if let Some(f) = &self.on_turn_outcome {
            f(ok);
        }
    }
    fn stop_requested(&self, at: &str) {
        (self.on_stop)(at);
    }
    fn executable_missing(&self) {
        (self.on_fatal)(executable_missing_plan());
    }
}

#[cfg(test)]
#[path = "runner_wire_tests.rs"]
mod tests;
