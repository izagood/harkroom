//! 정본 `policy.ts` 의 턴 실패 판정과, `run_one` 이 받는 시도 오류 [`AttemptError`].
//!
//! **판정 재료는 하네스가 스스로 적은 것뿐이다**(정본 2026-09-16): 한도·자격증명·모델 거절은 하네스 세션 기록의 API 오류 줄
//! (`FailureMarks::harness_api_error`)만 본다 — 화면 꼬리에는 주입한 프롬프트(사람이 쓴 글)가 에코돼 섞이므로, 그것을
//! 재료로 쓰면 누구든 본문 한 줄로 멀쩡한 계정을 옮겨 타게 하거나 러너를 물러나게 할 수 있다. 세션 충돌만 정본처럼
//! 꼬리를 보는데, 그 문구(`is already in use`)는 claude 가 띄우기 직후 내는 것이라 하네스가 프롬프트를 받기 전이다.
//!
//! 결말 순서(정본 `mentionScheduler.ts` 의 `catch`): 한도 → 세션 충돌 → API 키 연결 → 스레드 모델 거절 → 정지 → 그 밖.

use crate::account_failover::{AccountFailureClass, AccountFailureKind, AttemptEnd, FailureOf};
use crate::fail_text::provider_lane_recallable;
use crate::mention_run::TurnError;
use crate::mention_settle::TurnEnd;
use crate::turn_failure::FailureMarks;

/// 정본 `quotaFromText` — `You've hit your session|usage limit … resets <시각>`. 시각은 줄 끝·ESC 에서 멈춘다.
pub fn quota_from_text(text: &str) -> Option<Option<String>> {
    let squashed: String = text
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '\'' && *c != '’')
        .collect::<String>()
        .to_lowercase();
    if !(squashed.contains("hityoursessionlimit") || squashed.contains("hityourusagelimit")) {
        return None;
    }
    let lower = text.to_lowercase();
    let resets = lower.find("resets").and_then(|i| {
        let rest = &text[i + "resets".len()..];
        let rest = rest.strip_prefix(|c: char| c.is_whitespace())?;
        let rest = rest.trim_start();
        let end = rest.find(['\n', '\u{1b}']).unwrap_or(rest.len());
        let t = rest[..end].trim();
        (!t.is_empty()).then(|| t.to_string())
    });
    Some(resets)
}

/// 정본 `isQuotaExhausted` — 하네스 기록의 API 오류 줄만 본다.
pub fn quota_exhausted(marks: &FailureMarks) -> Option<Option<String>> {
    marks.harness_api_error.as_deref().and_then(quota_from_text)
}

/// 정본 `HARNESS_CREDENTIAL_PATTERNS` — 공백을 **전부** 지운 뒤 맞춘다(화면 폭 랩과 무관하게).
const HARNESS_CREDENTIAL_PATTERNS: [&str; 6] = [
    "couldnotresolveauthentication",
    "x-api-key",
    "authentication_error",
    "failedtoauthenticate",
    "oauthsessionexpired",
    "notloggedin",
];

/// 정본 `isCredentialFailure` 의 하네스 갈래 — 하네스 기록의 API 오류 줄만 본다.
pub fn harness_credential(marks: &FailureMarks) -> bool {
    let Some(s) = marks.harness_api_error.as_deref() else {
        return false;
    };
    let squashed: String = s
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase();
    HARNESS_CREDENTIAL_PATTERNS
        .iter()
        .any(|p| squashed.contains(p))
}

/// 정본 `isSessionIdConflict` — `Session ID … is already in use`(꼬리 앞이 잘려도 맞게 뒤 문구만).
pub fn session_id_conflict(tail: &str) -> bool {
    tail.chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
        .contains("isalreadyinuse")
}

/// 정본 `isThreadModelRejected` — 스레드 지정으로 돌았고, 하네스 API 오류가 모델·effort 를 말할 때만.
pub fn thread_model_rejected(marks: &FailureMarks) -> bool {
    let (Some(_), Some(api)) = (&marks.thread_model, marks.harness_api_error.as_deref()) else {
        return false;
    };
    let l = api.to_lowercase();
    l.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|w| w == "model")
        || l.contains("effort")
        || l.contains("reasoning")
}

/// 프롬프트가 입력창까지 못 갔다(정본 `PromptNotDeliveredError.kind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotDelivered {
    /// 화면이 사람의 선택을 기다린다.
    Waiting,
    /// 상한까지 입력창을 못 봤다.
    Timeout,
}

/// `run_one` 이 받는 시도 하나의 오류(정본 `runMentionTurn` 이 던지는 `failure`).
///
/// `Debug` 는 손으로 짠다 — `tail` 은 판정 재료(사람 글이 에코될 수 있다)라 길이만, 표지는 [`FailureMarks`] 의 가린 Debug.
#[derive(Clone, Default)]
pub struct AttemptError {
    /// 사람이 보는 실패 문장(이미 가린 [`crate::turn_notice::TurnFailure`] 문장, 준비 실패면 종류만).
    pub message: String,
    /// 판정 재료로만 쓰는 화면 꼬리(턴 열쇠를 지운 것). 글에 싣지 않는다.
    pub tail: String,
    pub marks: FailureMarks,
    pub not_delivered: Option<NotDelivered>,
    /// API 키 연결 준비 실패의 접힌 코드(정본 `ProviderLaneError`).
    pub lane_code: Option<String>,
    /// 하네스 실행 파일이 없다(정본 `ExecutableNotFoundError`) — 턴 실패가 아니라 러너가 물러날 일(`before_fail` 이 본다).
    pub executable_missing: bool,
}

impl std::fmt::Debug for AttemptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AttemptError")
            .field("message", &self.message)
            .field("tail_len", &self.tail.len())
            .field("marks", &self.marks)
            .field("not_delivered", &self.not_delivered)
            .field("lane_code", &self.lane_code)
            .field("executable_missing", &self.executable_missing)
            .finish()
    }
}

impl AccountFailureClass for AttemptError {
    /// 정본 `accountFailureOf` — 한도 → 프롬프트 미전달(관문·시한) → 하네스 자격증명.
    fn account_failure(&self) -> Option<FailureOf> {
        if let Some(resets_at) = quota_exhausted(&self.marks) {
            return Some(FailureOf {
                kind: AccountFailureKind::Quota,
                resets_at,
            });
        }
        if let Some(n) = self.not_delivered {
            return Some(FailureOf {
                kind: match n {
                    NotDelivered::Waiting => AccountFailureKind::Gate,
                    NotDelivered::Timeout => AccountFailureKind::Timeout,
                },
                resets_at: None,
            });
        }
        harness_credential(&self.marks).then_some(FailureOf {
            kind: AccountFailureKind::Credential,
            resets_at: None,
        })
    }
}

impl TurnError for AttemptError {
    fn attempt_end(&self) -> AttemptEnd {
        if self.not_delivered == Some(NotDelivered::Waiting) {
            return AttemptEnd::Waiting;
        }
        if harness_credential(&self.marks) {
            return AttemptEnd::Credential;
        }
        AttemptEnd::OtherErr
    }

    fn harness_api_error(&self) -> bool {
        self.marks.harness_api_error.is_some()
    }

    /// 계정 관문으로 접힌 턴은 [`AttemptError`] 가 아니라 따로 온다(정본 `AccountGateRequeueError`).
    fn is_gate_requeue(&self) -> bool {
        false
    }

    /// 정본 `catch` 순서: 한도 → 세션 충돌 → API 키 연결 → 스레드 모델 거절 → 정지 → 그 밖.
    fn into_turn_end(self) -> TurnEnd {
        if let Some(resets_at) = quota_exhausted(&self.marks) {
            return TurnEnd::Quota {
                resets_at,
                api_line: self.marks.harness_api_error.clone(),
            };
        }
        if session_id_conflict(&self.tail) {
            return TurnEnd::SessionConflict {
                message: self.message,
            };
        }
        if let Some(code) = self.lane_code {
            let recallable = provider_lane_recallable(&code);
            return TurnEnd::ProviderLane { code, recallable };
        }
        if thread_model_rejected(&self.marks) {
            let tm = self.marks.thread_model.as_ref();
            return TurnEnd::ThreadModelRejected {
                model: tm.and_then(|t| t.model.clone()),
                effort: tm.and_then(|t| t.effort.clone()),
                // 보이는 글에는 가린 줄만(#2028 security 낮음) — 판정은 위에서 원문으로 끝났다.
                api_error: self
                    .marks
                    .harness_api_error_shown
                    .clone()
                    .unwrap_or_else(|| crate::turn_end::MASKED_API_ERROR.to_owned()),
            };
        }
        if let Some(stall_ms) = self.marks.stalled_ms.filter(|ms| *ms > 0) {
            return TurnEnd::Stall {
                stall_ms,
                screen: self.marks.stalled_screen.map(|s| s.as_str().to_string()),
                screen_line: self.marks.stalled_screen_line.clone(),
            };
        }
        TurnEnd::Other {
            err_text: self.message,
        }
    }
}

#[cfg(test)]
#[path = "turn_policy_tests.rs"]
mod tests;
