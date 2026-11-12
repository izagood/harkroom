//! 실패 통지 본문 조립(정본 `prompt.ts` 의 `FAILURE_NOTICE`·`LEASE_LOST_NOTICE`·`quotaNotice`·`sessionConflictNotice`·
//! `providerLaneNotice`·`threadModelRejectedNotice`·`retryNotice`·`stallNotice`·`withAccountTrail`·`accountTrailReason`, B4-2).
//!
//! [`FailBody`] 는 결말 갈래(`mention_settle`)가 고른 **사실**이고, 사람이 읽는 문장은 여기서만 만든다. 계정 축 흔적에는
//! 실패 **종류**와 `계정 N`(시도 순서)만 싣는다 — 화면 원문·이메일·계정 이름(풀 폴더 이름)은 싣지 않는다.

use crate::account_failover::{AccountFailure, AccountFailureKind};
use crate::mention_settle::{FailBody, MAX_ATTEMPTS};

/// 정본 `FAILURE_NOTICE` — `MAX_ATTEMPTS` 를 다 태웠을 때.
pub const FAILURE_NOTICE: &str = "(답변에 실패했습니다 — 운영자 확인이 필요합니다)";
/// 정본 `LEASE_LOST_NOTICE`.
pub const LEASE_LOST_NOTICE: &str = "(이 부름의 턴 임대를 다시 받지 못했습니다 — 비밀·API·머지를 쓸 수 없어 시작하지 않았습니다. 다시 불러 주세요)";

/// 정본 shared `PROVIDER_LANE_RECALLABLE_CODES` — 다시 부르면 풀리는 API 키 연결 실패 코드.
pub const PROVIDER_LANE_RECALLABLE_CODES: [&str; 2] = ["no_lease", "lease_invalid"];
/// 정본 `RETRY_REASON_MAX_CHARS`(모델 거절 사유 자르기).
const RETRY_REASON_MAX_CHARS: usize = 160;

pub fn provider_lane_recallable(code: &str) -> bool {
    PROVIDER_LANE_RECALLABLE_CODES.contains(&code)
}

pub fn quota_notice(resets_at: Option<&str>) -> String {
    match resets_at {
        None => "(사용량 한도에 걸렸습니다 — 한도가 풀린 뒤 다시 불러 주세요)".into(),
        Some(at) => {
            format!("(사용량 한도에 걸렸습니다 — {at} 에 풀립니다. 그 뒤에 다시 불러 주세요)")
        }
    }
}

pub fn session_conflict_notice() -> String {
    "(하네스 세션 상태가 어긋나 답할 수 없었습니다 — 운영자가 러너 로그를 확인해야 합니다)".into()
}

/// 코드만 싣는다 — 주소·비밀 이름·경로는 싣지 않는다(코드는 이미 허용 목록으로 접힌 값).
pub fn provider_lane_notice(code: &str) -> String {
    if provider_lane_recallable(code) {
        format!(
            "(이 멘션의 턴 임대가 없어 턴을 띄우지 않았습니다 — 러너가 다시 뜨면서 앞서 받은 임대를 잃었습니다. \
             설정은 고칠 것이 없습니다. 다시 불러 주시면 새 임대로 뜹니다. 까닭: {code})"
        )
    } else {
        format!(
            "(API 키 연결을 준비하지 못해 이 턴을 띄우지 않았습니다 — 다시 시도하지 않습니다. \
             데스크톱의 에이전트 설정 › 모델 연결에서 API 주소와 API 키(비밀 허락)를 확인한 뒤 다시 불러 주세요. 까닭: {code})"
        )
    }
}

/// 정본은 `.filter(Boolean)` — 빈 문자열 effort 도 뺀다. 사유는 공백을 접어 앞 160자(정본 UTF-16, 여기는 `char`).
pub fn thread_model_rejected_notice(
    model: Option<&str>,
    effort: Option<&str>,
    api_error: &str,
) -> String {
    let parts: Vec<&str> = [Some(model.unwrap_or("설정 모델")), effort]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect();
    let value = parts.join(" · ");
    let why: String = api_error
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(RETRY_REASON_MAX_CHARS)
        .collect();
    format!(
        "(이 스레드에 지정한 모델 {value} 을 하네스가 받지 않아 답하지 못했습니다 — 다시 시도하지 않습니다. \
         스레드 머리의 모델 칩에서 기본으로 되돌리거나 다른 모델을 골라 다시 불러 주세요. 하네스: {why})"
    )
}

pub fn retry_notice(tried: u32, max: u32, reason: Option<&str>) -> String {
    let tail = reason.map(|r| format!(", 원인: {r}")).unwrap_or_default();
    format!("(답하지 못하고 끝나 다시 시도합니다 — {tried}/{max}회째{tail})")
}

/// 정본 `stallNotice`. `screen` 은 `gate`·`idle`·`stuck`, 그 밖(모름)은 옛 문장.
pub fn stall_notice(stall_ms: u64, screen_line: Option<&str>, screen: Option<&str>) -> String {
    // `Math.round(ms / 60_000)` — 양수에서 반올림(0.5 는 올림).
    let min = (stall_ms + 30_000) / 60_000;
    let err_line = screen_line
        .filter(|l| !l.is_empty())
        .map(|l| format!(" 화면의 마지막 오류 줄: \"{l}\""))
        .unwrap_or_default();
    match screen {
        Some("gate") => format!(
            "(하네스가 {min}분 동안 확인 물음 앞에 서 있어 접었습니다 — 이 스레드의 터미널을 열어 무엇을 묻는지 확인한 뒤 다시 불러 주세요.{err_line})"
        ),
        Some("idle") => format!(
            "(답을 남기지 못하고 끝났습니다 — {min}분 뒤에 알아채 접었습니다. 다시 부르면 이어서 합니다.{err_line})"
        ),
        Some("stuck") => format!(
            "(하네스가 {min}분 동안 아무것도 하지 않아 접었습니다 — 다시 불러도 같은 곳에서 멈출 수 있어 자동으로 다시 시도하지 않습니다. \
             이 스레드의 터미널을 열어 화면을 확인해 주세요.{err_line})"
        ),
        _ => format!(
            "(하네스가 {min}분 동안 아무것도 하지 않아 접었습니다 — 다시 시도하지 않습니다: \
             같은 자리에 다시 서기 때문입니다. 이 스레드의 터미널을 열어 화면을 확인해 주세요 — \
             확인을 기다리는 물음이 서 있을 수 있습니다.{err_line})"
        ),
    }
}

/// [`FailBody`] → 스레드에 남길 본문(계정 흔적 붙이기 전).
pub fn fail_body_text(body: &FailBody) -> String {
    match body {
        FailBody::LeaseLost => LEASE_LOST_NOTICE.into(),
        FailBody::Quota { resets_at } => quota_notice(resets_at.as_deref()),
        FailBody::SessionConflict => session_conflict_notice(),
        FailBody::ProviderLane { code } => provider_lane_notice(code),
        FailBody::ThreadModelRejected {
            model,
            effort,
            api_error,
        } => thread_model_rejected_notice(model.as_deref(), effort.as_deref(), api_error),
        FailBody::Stall {
            stall_ms,
            screen,
            screen_line,
        } => stall_notice(*stall_ms, screen_line.as_deref(), screen.as_deref()),
        FailBody::Retry { tried, reason } => retry_notice(*tried, MAX_ATTEMPTS, reason.as_deref()),
        FailBody::GaveUp => FAILURE_NOTICE.into(),
    }
}

/// 계정 이유 한 칸(종류만). **계정 이름을 싣지 않는다** — 이 말은 스레드 본문과 실패 카드 `reason` 으로 서버에 가고,
/// 계정 이름은 계정 풀의 폴더 이름이라 사람 이름일 수 있다(#1039). `계정 N`(이 턴에서 시도한 순서, 1부터)으로 쓰고,
/// 어느 계정인지는 러너 로그의 전환 줄(`switch_log_line`)이 같은 순서로 남긴다. 정본 `prompt.ts::accountFailureText` 와 같다.
fn account_failure_text(f: &AccountFailure, index: usize) -> String {
    let who = match f.account {
        None => "(기본 계정)".to_string(),
        Some(_) => format!("계정 {}", index + 1),
    };
    match f.kind {
        AccountFailureKind::Gate => format!("{who}: 설정 확인 화면에서 사람의 선택을 기다림"),
        AccountFailureKind::Quota => match &f.resets_at {
            None => format!("{who}: 사용량 한도"),
            Some(at) => format!("{who}: 사용량 한도({at} 에 풀림)"),
        },
        AccountFailureKind::Credential => format!("{who}: 로그인이 풀림"),
        AccountFailureKind::Timeout => format!("{who}: 입력창이 뜨지 않음(시간 초과)"),
    }
}

/// 정본 `withAccountTrail` — 축을 안 넘겼으면 원문 그대로.
pub fn with_account_trail(notice: &str, trail: &[AccountFailure]) -> String {
    if trail.is_empty() {
        return notice.into();
    }
    let mut lines = vec![notice.to_string(), "계정별 이유:".to_string()];
    lines.extend(
        trail
            .iter()
            .enumerate()
            .map(|(i, f)| format!("- {}", account_failure_text(f, i))),
    );
    if trail.iter().any(|f| f.kind == AccountFailureKind::Gate) {
        lines.push(
            "설정 확인 화면에 선 계정은 그 계정으로 claude 를 터미널에서 한 번 실행해 화면의 물음에 답하면 풀립니다. 그 뒤 다시 불러 주세요."
                .into(),
        );
    }
    lines.join("\n")
}

/// 정본 `accountTrailReason` — 실패 카드 `reason` 한 줄.
pub fn account_trail_reason(trail: &[AccountFailure]) -> Option<String> {
    if trail.is_empty() {
        return None;
    }
    Some(
        trail
            .iter()
            .enumerate()
            .map(|(i, f)| account_failure_text(f, i))
            .collect::<Vec<_>>()
            .join(" · "),
    )
}

#[cfg(test)]
#[path = "fail_text_tests.rs"]
mod tests;
