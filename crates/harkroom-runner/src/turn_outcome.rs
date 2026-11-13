//! `TurnAttempt` 본체 — 시도 하나의 결과([`Attempted`] + PTY 결과)를 `run_one` 이 받는 `Result<TurnOk, AttemptError>` 로 접는다.
//!
//! 정본 `runMentionTurn` 의 끝(2960~3147행): 회수로 끝났나 → 실패인가 → 원인 고르기 → 표지 → `throw failure`.
//! 펜스·[중단] 은 [`LiveTurn`] 에서 **지금 값**으로 읽는다(관문이 쓰는 것과 같은 자리). `operator` 의 중단은 사람이 멈춘 것이
//! 아니라 원인에서 뺀다(정본 `humanCancelOf`).
//!
//! - 관문이 막았다([`Attempted::Blocked`]) — 정본 `canceledBeforeSpawn` 처럼 「종료 143·꼬리 없음」으로 같은 실패 갈래를 탄다.
//! - 준비 실패([`Attempted::SetupFailed`]) — lane 은 접힌 코드(`lane_code`), 나머지는 고정 문장(종류만).
//! - PTY 가 프롬프트를 못 넣었다 — `not_delivered`(관문·시한)로 계정 축이 판단한다. 꼬리는 판정 재료로만.
//! - 실행 파일 부재 — 턴 실패가 아니라 러너가 잘못 세워진 것(정본 `ExecutableNotFoundError` → 물러나기). 표지로 넘긴다.
//!
//! 보이는 문장은 [`TurnFailure::message`](crate::turn_notice::TurnFailure::message)·고정 문장뿐이다 — 화면 꼬리·오류 원문·경로는
//! 싣지 않는다(꼬리는 [`AttemptError::tail`] 에 판정 재료로만, 원문 API 오류는 표지에, 보이는 사본은 #2029 가림).

use crate::mention_run::TurnOk;
use crate::mention_settle::TurnEnd;
use crate::mention_turn_parts::human_cancel_of;
use crate::pty::NotDeliveredKind;
use crate::pty_turn::{PtyTurnError, TurnResult};
use crate::thread_model::TurnModel;
use crate::turn_attempt::{Attempted, setup_failure_end};
use crate::turn_attempt_live::LiveTurn;
use crate::turn_end::EndState;
use crate::turn_failure::{
    ExitFacts, FailFacts, StallInputs, failure_marks, pick_failure, turn_failed,
};
use crate::turn_launch::LaunchStep;
use crate::turn_policy::{AttemptError, NotDelivered};

/// 결과를 접는 데 필요한 이 턴의 사실.
pub struct OutcomeFacts<'a> {
    pub end: &'a EndState,
    pub live: &'a LiveTurn,
    /// 러너가 서버 스레드를 못 읽었다(정본 `end.threadUnreadable`).
    pub thread_unreadable: bool,
    pub turn_timeout_ms: u64,
    pub harness_stall_ms: u64,
    pub stall: StallInputs<'a>,
    /// 종료 뒤 하네스 기록에서 읽은 API 오류(정본 `readLastApiError`).
    pub recorded_after: Option<&'a str>,
    pub turn_model: Option<&'a TurnModel>,
    pub pat: &'a str,
    pub secrets: &'a [String],
    /// 턴이 받은 종료 요청 시각(성공일 때 그대로 넘긴다).
    pub stop_requested_at: Option<String>,
}

/// 하네스 실행 파일을 못 찾았을 때의 문장(경로·이름은 싣지 않는다).
pub const EXECUTABLE_MISSING: &str =
    "하네스 실행 파일을 찾지 못했다 — 이 기기에 하네스를 설치하거나 PATH 를 확인하라";
/// PTY 를 못 띄웠을 때의 문장(오류 원문은 싣지 않는다 — 로컬 로그 몫).
pub const SPAWN_FAILED: &str = "PTY 를 띄우지 못했다";

// 턴 하나에 한 번 도는 차가운 길이고, 오류 꼴은 `TurnAttempt::Err` 로 정해져 있다 — 상자에 담을 이득이 없다.
#[allow(clippy::result_large_err)]
fn failed_or_ok(
    exit: ExitFacts<'_>,
    always_failed: bool,
    f: &OutcomeFacts<'_>,
) -> Result<TurnOk, AttemptError> {
    let canceled = f.live.canceled_by();
    let facts = FailFacts {
        exit,
        end: f.end,
        canceled_by: human_cancel_of(canceled.as_deref()),
        fenced_out: f.live.fenced_out(),
        thread_unreadable: f.thread_unreadable,
        turn_timeout_ms: f.turn_timeout_ms,
        harness_stall_ms: f.harness_stall_ms,
    };
    if !always_failed && !turn_failed(&facts.exit, f.end) {
        return Ok(TurnOk {
            stop_requested_at: f.stop_requested_at.clone(),
        });
    }
    let failure = pick_failure(&facts, f.pat, f.secrets);
    let marks = failure_marks(
        &facts,
        &f.stall,
        f.recorded_after,
        f.turn_model,
        f.pat,
        f.secrets,
    );
    Err(AttemptError {
        message: failure.message(),
        tail: facts.exit.tail.to_string(),
        marks,
        ..AttemptError::default()
    })
}

/// 정본 실패 갈래 — 시도 결과를 접는다.
#[allow(clippy::result_large_err)]
pub fn attempt_outcome(
    attempted: Attempted<Result<TurnResult, PtyTurnError>>,
    f: &OutcomeFacts<'_>,
) -> Result<TurnOk, AttemptError> {
    match attempted {
        Attempted::Ran(Ok(r)) => failed_or_ok(
            ExitFacts {
                exit_code: r.exit_code,
                timed_out: r.timed_out,
                tail: &r.tail,
            },
            false,
            f,
        ),
        // 하네스는 존재한 적 없다 — 정본 `{ exitCode: 143, timedOut: false, tail: '' }`.
        Attempted::Blocked(_) => failed_or_ok(
            ExitFacts {
                exit_code: 143,
                timed_out: false,
                tail: "",
            },
            true,
            f,
        ),
        Attempted::Ran(Err(PtyTurnError::NotDelivered(p))) => Err(AttemptError {
            message: p.to_string(),
            tail: p.tail,
            not_delivered: Some(match p.kind {
                NotDeliveredKind::Waiting => NotDelivered::Waiting,
                NotDeliveredKind::Timeout => NotDelivered::Timeout,
            }),
            ..AttemptError::default()
        }),
        Attempted::Ran(Err(PtyTurnError::NotFound(_))) => Err(AttemptError {
            message: EXECUTABLE_MISSING.to_string(),
            executable_missing: true,
            ..AttemptError::default()
        }),
        Attempted::Ran(Err(PtyTurnError::Spawn(e))) => {
            eprintln!("[mentionTurn] PTY 를 띄우지 못했다 — {:?}", e.kind());
            Err(AttemptError {
                message: SPAWN_FAILED.to_string(),
                ..AttemptError::default()
            })
        }
        Attempted::SetupFailed { step, code } => {
            let message = match setup_failure_end(step, &code) {
                TurnEnd::Other { err_text } => err_text,
                _ => format!("API 키 연결을 준비하지 못했다({code})"),
            };
            Err(AttemptError {
                message,
                lane_code: (step == LaunchStep::LaneKeys).then_some(code),
                ..AttemptError::default()
            })
        }
    }
}

#[cfg(test)]
#[path = "turn_outcome_tests.rs"]
mod tests;
