//! `TurnAttempt` 본체의 차례 — 시도 하나를 처음부터 끝까지 한 함수로 묶는다(정본 `runMentionTurn` 의 띄우기 ~ 끝 갈래).
//!
//! [`run_attempt`] 의 차례:
//! 1. 기록 가리기(`after_run`)를 여기서 짓는다 — 기록 찾기([`transcript_record_paths`])가 고른 **모든** 경로를, 넘겨받은
//!    [`TurnSecrets`] 의 바늘로 가린다. 호출자가 다른 목록을 끼울 자리가 없다.
//! 2. [`attempt_with_files`] — 관문은 [`LiveTurn::gate`](지금 값), 정리 가드(열쇠 거두기·임대 끝)가 기록 가리기 **뒤**,
//!    턴 설정 파일(`TurnFiles`)은 그 **뒤**.
//! 3. `outcome` — 같은 [`TurnSecrets`] 로 [`attempt_outcome`](crate::turn_outcome::attempt_outcome) 을 부르는 닫개.
//! 4. 성공이면 `after` — 같은 [`TurnSecrets`] 로 턴 뒤 IO(`apply_after_turn`)를 부르는 닫개. 실패는 로그만(정본 best-effort).
//!
//! 세 자리(결과 접기·턴 뒤 글·기록 가리기)가 **같은 `&TurnSecrets` 하나**를 받는다(#2031 security).

use crate::mention_run::TurnOk;
use crate::pty_turn::{PtyTurnError, TurnResult};
use crate::rest::RunnerLink;
use crate::turn_attempt::{
    AttemptInput, Attempted, LeaseNotice, TurnSecrets, attempt_with_files, scrub_after_run,
};
use crate::turn_attempt_live::LiveTurn;
use crate::turn_launch::{TranscriptHomes, transcript_record_paths};
use crate::turn_mcp_plan::TurnFiles;
use crate::turn_policy::AttemptError;

/// PTY 턴 한 번의 결과.
pub type PtyOut = Result<TurnResult, PtyTurnError>;

/// 기록 가리기가 기록을 찾을 재료.
#[derive(Clone, Copy, Debug)]
pub struct RecordScrub<'a> {
    pub key: &'a str,
    pub session_id: Option<&'a str>,
    pub homes: TranscriptHomes<'a>,
}

/// 시도 하나가 쥐는 것 — 턴 설정 파일·가림 목록·기록 찾기 재료.
pub struct AttemptSetup<'a> {
    pub files: TurnFiles,
    /// 결과 접기·턴 뒤 IO·기록 가리기가 **같이** 받는 목록.
    pub secrets: &'a TurnSecrets,
    pub scrub: RecordScrub<'a>,
}

/// 시도 하나. `input.after_run` 은 여기서 짓는다(넘겨준 값은 덮는다).
#[allow(clippy::result_large_err)]
pub fn run_attempt<'a, L: RunnerLink>(
    setup: AttemptSetup<'a>,
    mut input: AttemptInput<'a, L, PtyOut>,
    notice: &impl LeaseNotice,
    live: &LiveTurn,
    outcome: impl FnOnce(Attempted<PtyOut>, &TurnSecrets) -> Result<TurnOk, AttemptError>,
    after: impl FnOnce(&TurnSecrets) -> Result<(), String>,
) -> Result<TurnOk, AttemptError> {
    let AttemptSetup {
        files,
        secrets,
        scrub,
    } = setup;
    let harness = input.harness;
    input.after_run = Some(Box::new(move |_out: &PtyOut| {
        let (transcript, _) = transcript_record_paths(harness, scrub.session_id, scrub.homes);
        let t = scrub_after_run(
            scrub.key,
            harness,
            transcript.as_deref(),
            scrub.session_id,
            secrets,
        );
        if t.failed > 0 {
            eprintln!(
                "[mentionTurn] {}: 기록 가리기 실패 {}곳",
                scrub.key, t.failed
            );
        }
    }));
    let attempted = attempt_with_files(files, input, notice, &mut || live.gate());
    let res = outcome(attempted, secrets);
    if res.is_ok()
        && let Err(e) = after(secrets)
    {
        // 정본처럼 best-effort — 세션 상태는 이미 저장됐다. 사유는 로컬 로그에만(값은 들지 않는 MCP 오류 문장).
        eprintln!("[mentionTurn] {}: 턴 뒤 관측·통보 실패 — {e}", scrub.key);
    }
    res
}

#[cfg(test)]
#[path = "turn_run_tests.rs"]
mod tests;
