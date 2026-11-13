//! 결과 접기 재료 실물(C3) — [`outcome_source`] 가 `MentionParts.outcome` 닫개를 돌려준다. 정본 `runMentionTurn` 실패 갈래의
//! 재료(종료 뒤 기록의 API 오류·정지 화면·스레드 못 읽음·시간 한도)를 모아 [`fold_outcome`] 에 넘긴다.
//!
//! **시도마다 바뀌는 값은 인자로만 온다**(mem/runner/per-attempt-state): 세션 id·계정 폴더는 그 시도의 `LoopCtx`, 화면 꼬리와
//! 「스레드 못 읽음」은 그 시도의 감시 자리([`OutcomeCtx`]). 설정([`OutcomeConfig`])은 멘션 단위 값만 쥔다. 손님은 없다.
//!
//! - 종료 뒤 API 오류: 정본 `readLastApiError(harness, sessionId, { configDir, sinceMs: turnStartedAtMs })` — 그 시도의 세션·계정
//!   폴더로, 그 시도 시작 뒤 것만 읽는다. 원문은 판정용이고 글로 갈 때는 결과 접기의 가림(PAT·마운트 비밀)을 지난다.
//! - 정지 화면: 판정 재료로만 넘긴다(`stall_screen_line` 이 가린 한 줄만 글로 간다). 화면 감시가 아직 없어 `watch_now` 는 `None`.

use std::path::PathBuf;
use std::sync::Mutex;

use crate::adapter::AgentHarness;
use crate::harness_errors::{TranscriptDirs, read_last_api_error};
use crate::mention_parts::{OutcomeCtx, OutcomeFn};
use crate::thread_model::TurnModel;
use crate::turn_attempt::{Attempted, TurnSecrets};
use crate::turn_attempt_fold::{OutcomeInputs, fold_outcome};
use crate::turn_attempt_live::LiveTurn;
use crate::turn_end::EndState;
use crate::turn_failure::StallInputs;
use crate::turn_run::PtyOut;

/// 멘션 단위 재료.
pub struct OutcomeConfig {
    pub harness: AgentHarness,
    /// 기본 로그인일 때 기록을 찾을 홈(계정 폴더는 시도 문맥에서 온다).
    pub home: Option<PathBuf>,
    pub turn_timeout_ms: u64,
    pub harness_stall_ms: u64,
    pub turn_model: Option<TurnModel>,
    /// 이 멘션이 받은 종료 요청 시각(정본 `def.stopRequestedAt`).
    pub stop_requested_at: Option<String>,
}

/// 그 시도의 종료 뒤 기록 API 오류(원문).
pub fn recorded_after(c: &OutcomeConfig, o: &OutcomeCtx) -> Option<String> {
    read_last_api_error(
        c.harness,
        o.ctx.session_id.as_deref(),
        TranscriptDirs {
            config_dir: o.ctx.claude_config_dir.as_deref(),
            home: c.home.as_deref(),
        },
        // 이번 시도 것만 — 지난 턴의 한도 줄을 이번 시도 사실로 집지 않는다(#2042 꼴, node 와 같이).
        Some(o.ctx.turn_started_at_ms),
    )
    .map(|e| e.text)
}

/// 결과 접기 닫개 실물.
pub fn outcome_source(c: &OutcomeConfig) -> OutcomeFn<'_> {
    Box::new(move |attempted, secrets, live, end, o| fold_with(c, attempted, secrets, live, end, o))
}

/// 설정을 **소유하는** 결과 접기 — 멘션마다 새로 지은 설정을 그 멘션의 닫개가 가져간다(실물 짓개, security L3c-2 ④).
pub fn outcome_source_owned<'a>(c: OutcomeConfig) -> OutcomeFn<'a> {
    Box::new(move |attempted, secrets, live, end, o| {
        fold_with(&c, attempted, secrets, live, end, o)
    })
}

#[allow(clippy::result_large_err)]
fn fold_with(
    c: &OutcomeConfig,
    attempted: Attempted<PtyOut>,
    secrets: &TurnSecrets,
    live: &LiveTurn,
    end: &EndState,
    o: &OutcomeCtx,
) -> Result<crate::mention_run::TurnOk, crate::turn_policy::AttemptError> {
    {
        let api = recorded_after(c, o);
        let end = Mutex::new(end.clone());
        fold_outcome(
            attempted,
            secrets,
            live,
            &end,
            OutcomeInputs {
                thread_unreadable: o.thread_unreadable,
                turn_timeout_ms: c.turn_timeout_ms,
                harness_stall_ms: c.harness_stall_ms,
                stall: StallInputs {
                    watch_now: None,
                    screen_tail: &o.screen,
                    harness: c.harness,
                    signal: None,
                },
                recorded_after: api.as_deref(),
                turn_model: c.turn_model.as_ref(),
                stop_requested_at: c.stop_requested_at.clone(),
            },
        )
    }
}

#[cfg(test)]
#[path = "turn_outcome_source_tests.rs"]
mod tests;
