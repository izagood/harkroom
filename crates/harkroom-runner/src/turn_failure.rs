//! 턴이 끝난 뒤 「실패인가, 무엇이 원인인가」를 가른다(정본 `mentionTurn.ts::runMentionTurn` 2960~3147행의 실패 갈래).
//!
//! - **회수로 끝났다**([`ended_by_reclaim`]): 러너가 SIGTERM 으로 거둔 턴이 이미 답했거나(`spoke`) 기록이 끝을 말했으면
//!   (`finished`) 정상이다. 종료 코드로는 못 가른다 — 회수·무발화·하네스 자멸이 전부 143 이다.
//! - **실패인가**([`turn_failed`]): 회수로 끝나지 않았고, 종료 코드·시간 초과·무발화·정지·API 오류 중 하나가 섰다.
//! - **원인 고르기**([`pick_failure`]): 사람 중단 → 펜스 → 턴 도중 API 오류 → 기록 API 오류 → 정지 → 발화 확인 불가 →
//!   무발화 → 종료 순(정본 삼항 사슬과 같은 순서). 정지를 무발화보다 먼저 보는 까닭: 접는 수단이 같은 SIGTERM 이라
//!   무발화 시계가 뒤따라 설 수 있는데, 사람이 알아야 할 사실은 「서 있었다」쪽이다.
//! - **표지**([`failure_marks`]): 스케줄러가 문장이 아니라 표지로 판정한다(#711) — 정지 ms·정지 화면 갈래·화면 오류 줄·
//!   스레드 지정 모델·펜스·판정용 API 오류 줄.
//! - **저장할 커서**([`failed_turn_cursor`]): 발화가 있었으면 `lastFedSeq` 를 전진하고, 세션이 디스크에 실재하면 `turnsRun` 을 1 로.
//!
//! **보이는 글**: 실패 문장([`TurnFailure::message`])·화면 줄은 가린 값만 싣는다. 화면 꼬리는 판정 재료로만 쥐고
//! 문장에 싣지 않는다 — TUI 에서는 주입한 프롬프트가 에코돼 꼬리에 섞이고, 그것이 판정 재료가 되면 사람이 본문 한 줄로
//! 러너를 물러나게 할 수 있다(설계 §3-4). 턴 도중 API 오류 원문도 문장에는 [`quoted_line`] 을 거쳐 싣는다(정본은 원문, #1971 낮음).
//!
//! 아직 아무 데서도 부르지 않는다 — 턴 흐름에 붙이는 것은 TurnAttempt 조각이다.

use std::fmt;

use crate::adapter::AgentHarness;
use crate::mention_turn_parts::{StallScreen, StallSignal, stall_screen_of};
use crate::thread_model::{TurnModel, uses_thread_model};
use crate::turn_end::{EndState, MASKED_API_ERROR};
use crate::turn_notice::{TurnFailure, quoted_line, stall_screen_line};

/// 하네스가 끝난 모양(정본 `result`). `tail` 은 턴 열쇠를 이미 지운 꼬리(정본 3067행 `scrubText`).
pub struct ExitFacts<'a> {
    pub exit_code: i32,
    pub timed_out: bool,
    pub tail: &'a str,
}

/// 실패 갈래가 보는 턴 사실(정본 `end` 중 이 갈래 몫과 `deps` 의 한도).
pub struct FailFacts<'a> {
    pub exit: ExitFacts<'a>,
    pub end: &'a EndState,
    /// 사람의 중단(정본 `end.canceledBy`) — `operator` 는 부르는 쪽이 이미 걸렀다.
    pub canceled_by: Option<&'a str>,
    /// 턴 임대를 잃었다(정본 `end.fencedOut`, [`crate::turn_life::TurnLife::fenced_out`]).
    pub fenced_out: bool,
    /// 러너가 서버 스레드를 못 읽었다(정본 `end.threadUnreadable`).
    pub thread_unreadable: bool,
    pub turn_timeout_ms: u64,
    /// 정지 한도(정본 `deps.harnessStallMs ?? 10분`).
    pub harness_stall_ms: u64,
}

/// 정본 `회수로끝났다`. 발화한 뒤 우리가 회수한 턴·말없이 `end_turn` 한 턴(깨움만 걸고 끝남)은 성공이다.
pub fn ended_by_reclaim(end: &EndState) -> bool {
    end.reclaimed
        && (end.spoke || end.finished)
        && !end.silenced
        && !end.stalled
        && end.api_error.is_none()
        && end.recorded_api_error.is_none()
}

/// 정본 실패 분기 조건.
pub fn turn_failed(exit: &ExitFacts<'_>, end: &EndState) -> bool {
    !ended_by_reclaim(end)
        && (exit.exit_code != 0
            || exit.timed_out
            || end.silenced
            || end.stalled
            || end.api_error.is_some()
            || end.recorded_api_error.is_some())
}

/// 정지 ms — 잰 값을 쓰고, 없을 때만(0) 한도를 바닥값으로 쓴다(0 이면 스케줄러가 정지로 못 읽어 재시도가 되살아난다).
fn stalled_ms(f: &FailFacts<'_>) -> u64 {
    u64::try_from(f.end.stalled_idle_ms)
        .ok()
        .filter(|ms| *ms > 0)
        .unwrap_or(f.harness_stall_ms)
}

/// 정본 실패 문장의 갈래 고르기. `pat`·`secrets` 는 턴 도중 API 오류 원문을 가리는 데만 쓴다.
pub fn pick_failure(f: &FailFacts<'_>, pat: &str, secrets: &[String]) -> TurnFailure {
    let end = f.end;
    if let Some(by) = f.canceled_by {
        return TurnFailure::Canceled(by.to_owned());
    }
    if f.fenced_out {
        return TurnFailure::FencedOut;
    }
    if let Some(raw) = end.api_error.as_deref() {
        let line = quoted_line(Some(raw), pat, secrets);
        return TurnFailure::ApiError(if line.is_empty() {
            MASKED_API_ERROR.to_owned()
        } else {
            line
        });
    }
    if let Some(r) = &end.recorded_api_error {
        return TurnFailure::RecordedApiError(r.clone());
    }
    if end.stalled {
        return TurnFailure::Stalled {
            idle_ms: u64::try_from(end.stalled_idle_ms).unwrap_or(0),
            limit_ms: f.harness_stall_ms,
        };
    }
    if end.silenced && f.thread_unreadable {
        return TurnFailure::SilenceUnknown {
            ms: f.turn_timeout_ms.saturating_mul(2),
        };
    }
    if end.silenced {
        return TurnFailure::Silenced {
            ms: f.turn_timeout_ms,
        };
    }
    TurnFailure::Exited {
        code: f.exit.exit_code,
        timed_out: f.exit.timed_out,
        tail: f.exit.tail.to_owned(),
    }
}

/// 정본 `failure.harness*`·`threadModel`·`fencedOut` 표지.
///
/// `Debug` 는 손으로 짠다 — `harness_api_error` 는 판정용 원문(비밀이 섞일 수 있다)이라 길이만 찍는다.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct FailureMarks {
    /// 판정용 API 오류 줄(정본 `harnessApiError`) — 턴 도중 관측이 우선, 없으면 종료 뒤 기록 읽기.
    /// **스레드에 싣지 않는다** — 한도·자격증명·모델 거절 판정 재료다.
    pub harness_api_error: Option<String>,
    pub stalled_ms: Option<u64>,
    pub stalled_screen: Option<StallScreen>,
    /// 가린 화면의 오류 줄 한 줄(정본 `harnessStalledScreenLine`) — 보이는 글로만 쓴다.
    pub stalled_screen_line: Option<String>,
    /// 스레드 지정으로 돈 턴의 모델(정본 `threadModel`).
    pub thread_model: Option<TurnModel>,
    pub fenced_out: bool,
}

impl fmt::Debug for FailureMarks {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FailureMarks")
            .field(
                "harness_api_error_len",
                &self.harness_api_error.as_ref().map(String::len),
            )
            .field("stalled_ms", &self.stalled_ms)
            .field("stalled_screen", &self.stalled_screen)
            .field("stalled_screen_line", &self.stalled_screen_line)
            .field("thread_model", &self.thread_model)
            .field("fenced_out", &self.fenced_out)
            .finish()
    }
}

/// 정지 화면 판정 재료(정본 `stallScreenOf(idleWatch, end.screenTail, def.harness, signal)`).
pub struct StallInputs<'a> {
    /// 화면 감시의 지금 갈래 — 감시가 없으면 `None`.
    pub watch_now: Option<&'a str>,
    /// 정지 순간 화면 꼬리(정본 `end.screenTail`).
    pub screen_tail: &'a str,
    pub harness: AgentHarness,
    /// 관문 신호 파일이 있는 턴만.
    pub signal: Option<StallSignal>,
}

/// 정본 표지 묶음. `recorded_after` 는 종료 뒤 기록에서 읽은 API 오류(정본 `readLastApiError`, 실패는 `None`).
pub fn failure_marks(
    f: &FailFacts<'_>,
    stall: &StallInputs<'_>,
    recorded_after: Option<&str>,
    turn_model: Option<&TurnModel>,
    pat: &str,
    secrets: &[String],
) -> FailureMarks {
    let end = f.end;
    let mut m = FailureMarks {
        fenced_out: f.fenced_out,
        // 턴 도중 관측이 우선이다 — 종료 뒤 읽기는 앞 턴의 오류를 집을 수 있다.
        harness_api_error: end
            .api_error
            .clone()
            .or_else(|| recorded_after.map(str::to_owned)),
        thread_model: uses_thread_model(turn_model)
            .then(|| turn_model.cloned())
            .flatten(),
        ..FailureMarks::default()
    };
    if end.stalled {
        m.stalled_ms = Some(stalled_ms(f));
        m.stalled_screen = Some(stall_screen_of(
            stall.watch_now,
            stall.screen_tail,
            stall.harness,
            stall.signal,
        ));
        m.stalled_screen_line = stall_screen_line(f.exit.tail, pat, secrets);
    }
    m
}

/// 실패한 턴이 저장할 세션 커서(정본 3036~3043행 `persist`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FailedCursor {
    /// `Some` 이면 `lastFedSeq` 를 이 값으로 전진(발화가 있었다).
    pub last_fed_seq: Option<i64>,
    pub turns_run: u32,
}

/// `answered` 는 턴 시작 뒤 자기 발화가 있었나(관측 실패면 `false` — 「한 번 더」가 「중복 발화」보다 회복 가능하다).
/// `materialized` 는 첫 턴인데 세션 파일이 디스크에 실재하나(관측 실패면 `false`).
pub fn failed_turn_cursor(
    answered: bool,
    fed_seq: i64,
    turns_run: u32,
    has_session_id: bool,
    materialized: bool,
) -> FailedCursor {
    FailedCursor {
        last_fed_seq: answered.then_some(fed_seq),
        turns_run: if turns_run == 0 && has_session_id && materialized {
            1
        } else {
            turns_run
        },
    }
}

#[cfg(test)]
#[path = "turn_failure_tests.rs"]
mod tests;
