//! `MentionParts`(대상별 `AttemptParts`) 의 준비 부품 — 깨움 → [`TurnWake`], 지시문 파일, 시도의 명령 옵션.
//!
//! - [`turn_wake_of`]: 정본 `target.wake` → `buildTurnPrompt` 의 `wake`(예약 깨움·카드 답·카드 닫힘). 깨움 사유·카드 답은
//!   서버가 준 데이터라 **턴 프롬프트의 데이터 칸**으로만 간다.
//! - [`write_turn_system_prompt`]: 정본 `buildSystemPrompt`(골든 대조된 [`build_system_prompt`] 그대로 — 기억·지시문은
//!   정해진 칸에, 정본의 경계 표지 그대로) → `system-prompt.txt`(`write_private`: 0600·`create_new`·`O_NOFOLLOW`·rename).
//! - [`attempt_command`]: 러너 기본 명령 옵션 위에 이 시도의 세션·지시문 파일·원인·턴 id 만 얹는다. 계정 폴더는 여기서
//!   다루지 않는다(#2039 `AttemptAccount::command` 가 따로 덮는다).

use std::path::{Path, PathBuf};

use serde_json::json;

use crate::mention_target::{MentionTarget, TargetWake};
use crate::prompt_system::{SystemPromptOpts, build_system_prompt};
use crate::prompt_turn::{TurnWake, WakeWritten};
use crate::turn_attempt_account::AttemptAccount;
use crate::turn_command::TurnCommandOptions;
use crate::turn_files::{TurnFileError, write_system_prompt_file};
use crate::turn_prep::TurnSession;

/// 정본 `target.wake`(+ 예약 뒤 다른 턴이 이미 보고한 글 id).
pub fn turn_wake_of(target: &MentionTarget, already_reported: Option<String>) -> Option<TurnWake> {
    match target.wake.as_ref()? {
        TargetWake::Scheduled(w) => Some(TurnWake {
            reason: w.reason.clone(),
            report_to: w
                .report_to
                .as_ref()
                .map(|r| json!({ "channelId": r.channel_id, "threadRootId": r.thread_root_id })),
            watch: w.watch,
            written: None,
            already_reported,
        }),
        TargetWake::AskAnswered(a) => Some(TurnWake {
            reason: a.reason.clone(),
            written: a.written.as_ref().map(|w| WakeWritten {
                by: w.by.clone(),
                text: w.text.clone(),
            }),
            ..TurnWake::default()
        }),
        TargetWake::AskClosed(note) => Some(TurnWake {
            reason: (*note).to_string(),
            ..TurnWake::default()
        }),
    }
}

/// 이 턴의 지시문을 지어 `system-prompt.txt` 에 쓴다(0600·링크 안 따라감).
pub fn write_turn_system_prompt(
    state_dir: &Path,
    opts: &SystemPromptOpts<'_>,
) -> Result<PathBuf, TurnFileError> {
    write_system_prompt_file(state_dir, &build_system_prompt(opts))
}

/// 러너 기본 명령 옵션 위에 이 시도의 세션·지시문 파일·원인·턴 id 를 얹는다.
pub fn attempt_command<'a>(
    base: &TurnCommandOptions<'a>,
    session: &'a TurnSession,
    system_prompt_file: &'a str,
    cause: &'a str,
    turn_id: &'a str,
) -> TurnCommandOptions<'a> {
    let mut o = base.clone();
    o.session_id = session.rec.session_id.as_deref();
    o.is_first_turn = session.is_first_turn;
    o.system_prompt_file = Some(system_prompt_file);
    o.cause_message_id = Some(cause);
    o.turn_id = Some(turn_id);
    o
}

/// 시도의 명령 옵션 — **차례가 정해져 있다**: 시도 칸([`attempt_command`])을 먼저 얹고, 그 결과 위에 이 시도의 계정
/// 폴더([`AttemptAccount::command`])를 **마지막에** 얹는다. 계정 단계를 빠뜨리면 기본 옵션의 폴더가 남는다.
pub fn attempt_command_for_account<'a>(
    base: &TurnCommandOptions<'a>,
    account: &'a AttemptAccount,
    session: &'a TurnSession,
    system_prompt_file: &'a str,
    cause: &'a str,
    turn_id: &'a str,
) -> TurnCommandOptions<'a> {
    account.command(&attempt_command(
        base,
        session,
        system_prompt_file,
        cause,
        turn_id,
    ))
}

#[cfg(test)]
#[path = "turn_parts_tests.rs"]
mod tests;
