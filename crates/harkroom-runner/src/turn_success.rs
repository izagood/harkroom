//! 성공한 턴 뒤에 무엇을 남길지 고른다(정본 `mentionTurn.ts` 의 정상 종료 갈래 — 저장 뒤 「관측·통보」 블록).
//!
//! 여기는 **고르기만** 한다. 실제 글·반응·실패 줄은 턴 연결(TurnAttempt)이 기존 문구 함수(`silent_turn_notice`·
//! `background_cut_notice`·`silent_wake_notice`·`report_promise_check`)로 만든다 — 결과 글에 싣는 말은 그 함수들이
//! 이미 `quoted_line`·`*_notice` 로 가린다. 이 모듈이 새로 만드는 문구는 고정 문장 둘뿐이고 그중 하나(`watch_missed_notice`)는
//! 예약 사유를 가리고 `@` 를 `＠` 로 바꿔 싣는다(#2008 security 낮음).
//!
//! 정본 순서(서로 배타인 앞 갈래 하나 + 독립 검사 셋):
//! 1. 침묵 갈래 — 배경 끊김 → (발화 0 · 내 예약 없음) 침묵 통지 → (발화 0 · 예약 턴) 예약 시각 깸이면 ✅, 아니면 progress 한 줄.
//! 2. 보고처 약속 — 보고처가 있고 새 예약을 안 걸었으면 `report_promise_check`.
//! 3. 감시 끊김 — 감시 예약으로 깬 턴이 다음 예약도 끝 보고도 없으면 실패 줄(재시도 아님).
//! 4. 위임 끝 보고 누락 — 넘겨받은 일에 글은 썼는데 끝 보고·실패·물음·예약 없이 끝났으면 실패 줄(재시도 가능).

use serde_json::Value;

use crate::turn_notice::{NOTICE_LINE_MAX_CHARS, one_line};

use crate::turn_posts::{
    TurnOwnership, count_own_posts_since, has_own_wake_since, owned_by_turn, seq,
};

/// 정본 `META_KIND_REPORT` — `message.report` 가 남기는 글의 `meta.kind`.
pub const META_KIND_REPORT: &str = "report";

/// 정본 `DELEGATION_REPORT_MISSED_NOTICE` — 넘겨받은 일을 끝 보고 없이 끝낸 턴에 러너가 올리는 실패 줄.
pub const DELEGATION_REPORT_MISSED_NOTICE: &str = "넘겨받은 일을 끝 보고(`message.report`) 없이 끝냈습니다 — 앞 글에 결과가 있으면 그것을 보고, 필요하면 다시 넘기세요.";

/// 위임을 닫거나 이어 가는 글의 `meta.kind` — 끝 보고·실패·물음.
const DELEGATION_CLOSING_KINDS: [&str; 3] = ["report", "failure", "ask"];

fn meta_kind(m: &Value) -> Option<&str> {
    m.get("meta")
        .and_then(|meta| meta.get("kind"))
        .and_then(Value::as_str)
}

fn own_since<'a>(
    messages: &'a [Value],
    me_id: &'a str,
    since_seq: i64,
    turn_id: Option<&'a str>,
) -> impl Iterator<Item = &'a Value> + 'a {
    messages.iter().filter(move |m| {
        m.get("authorId").and_then(Value::as_str) == Some(me_id)
            && seq(m) > since_seq
            && owned_by_turn(m, turn_id, TurnOwnership::Count)
    })
}

/// 정본 `hasOwnReportSince` — 이 턴이 끝 보고(`meta.kind: report`)를 남겼나. 보고는 평범한 발화(`kind: user`)로 저장되고
/// 형식은 meta 에 실리므로 메시지 `kind` 가 아니라 `meta.kind` 를 본다. 턴으로 가르는 규칙은 대기 줄과 같다.
pub fn has_own_report_since(
    messages: &[Value],
    me_id: &str,
    since_seq: i64,
    turn_id: Option<&str>,
) -> bool {
    own_since(messages, me_id, since_seq, turn_id).any(|m| meta_kind(m) == Some(META_KIND_REPORT))
}

/// 정본 `delegationLeftOpen` — 넘겨받은 일을 이 턴이 열어 둔 채 끝냈나. 끝 보고·실패로 닫았거나, 예약·물음으로 이어 갈 길을
/// 남겼으면 아니다.
pub fn delegation_left_open(
    messages: &[Value],
    me_id: &str,
    since_seq: i64,
    turn_id: Option<&str>,
) -> bool {
    if has_own_wake_since(messages, me_id, since_seq, turn_id) {
        return false;
    }
    !own_since(messages, me_id, since_seq, turn_id)
        .any(|m| meta_kind(m).is_some_and(|k| DELEGATION_CLOSING_KINDS.contains(&k)))
}

/// 정본 `watchMissedNotice` — 감시 예약으로 깬 턴이 다음 예약도 끝 보고도 없이 끝났을 때의 실패 줄. 이 글은 `message.fail`
/// 본문으로 다시 올라가 서버가 멘션을 새로 판정하므로, 사유를 [`one_line`](PAT·마운트한 비밀·토큰 가림, 한 줄·길이)에
/// 거친 뒤 `@` 를 전각 `＠` 로 바꾼다(#2008 security 낮음, #2006 `report_missed_notice` 와 같은 규칙).
pub fn watch_missed_notice(reason: &str, pat: &str, secrets: &[String]) -> String {
    let tail = if reason.is_empty() {
        String::new()
    } else {
        format!(
            " (사유: {})",
            one_line(reason, pat, NOTICE_LINE_MAX_CHARS, secrets).replace('@', "＠")
        )
    };
    format!(
        "감시 예약으로 깨어난 턴이 다음 예약도 끝 보고도 없이 끝났다 — 감시가 여기서 멈췄다.\n이어서 볼 거면 다시 부르거나 예약을 걸어라{tail}."
    )
}

/// 이 턴을 띄운 대상의 사실(정본 `MentionTarget` 에서 이 갈래가 보는 것만).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SuccessTarget {
    /// 예약·카드 답으로 깬 턴(`target.wake`).
    pub wake: bool,
    /// 예약 **시각**에 깬 턴(`target.scheduledWake`). `wake` 없이 참일 수 없다.
    pub scheduled_wake: bool,
    /// 감시 예약(`target.wake.watch`).
    pub watch: bool,
    /// 넘겨받은 일(`target.delegatedBy`).
    pub delegated_by: bool,
    /// 다른 스레드에 보고하기로 한 약속이 있고 기준 seq 도 있다(`reportTo && reportBaseSeq !== null`).
    pub report_promise: bool,
}

/// 앞 갈래(서로 배타) — 무엇을 남길지.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SilentPath {
    /// 하위 에이전트를 기다리다 거뒀다 — 답을 했든 안 했든 `background_cut_notice` 를 올린다.
    BackgroundCut { count: usize },
    /// 발화도 새 예약도 없이 끝났다 — `silent_turn_notice`(앵커 밖 정황·대리 글 포함).
    SilentTurn,
    /// 예약 시각에 깬 턴이 다시 예약만 걸고 끝났다 — 멘션(대기 줄)에 ✅.
    WakeAck,
    /// 카드 답으로 깬 턴이 다시 예약만 걸고 끝났다 — `silent_wake_notice` progress 한 줄.
    WakeProgress,
    /// 남길 것이 없다(발화했거나, 예약 턴이 아닌데 예약만 걸었다).
    Nothing,
}

/// 성공한 턴 뒤의 할 일 묶음.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AfterTurnPlan {
    pub silent: SilentPath,
    /// 결과 발화 수 — 2 이상이면 러너 로그에 중복 발화 경고(정본 `warnOnDuplicatePosts`).
    pub post_count: usize,
    /// 보고처에 말했는지 `report_promise_check` 로 본다.
    pub check_report_promise: bool,
    /// `watch_missed_notice` 를 실패 줄(재시도 아님)로 남긴다.
    pub watch_missed: bool,
    /// `DELEGATION_REPORT_MISSED_NOTICE` 를 실패 줄(재시도 가능)로 남긴다.
    pub delegation_report_missed: bool,
}

/// 정본 정상 종료 갈래의 고르기. `after` 는 턴 시작 seq 뒤로 다시 읽은 앵커 스레드, `background_cut` 은 거둔 하위 에이전트 수.
pub fn after_turn_plan(
    after: &[Value],
    me_id: &str,
    turn_start_seq: i64,
    turn_id: Option<&str>,
    background_cut: Option<usize>,
    target: SuccessTarget,
) -> AfterTurnPlan {
    let post_count = count_own_posts_since(after, me_id, turn_start_seq, turn_id);
    let own_wake = has_own_wake_since(after, me_id, turn_start_seq, turn_id);
    let silent = match background_cut {
        Some(count) => SilentPath::BackgroundCut { count },
        None if post_count == 0 && !own_wake => SilentPath::SilentTurn,
        None if post_count == 0 && target.wake => {
            if target.scheduled_wake {
                SilentPath::WakeAck
            } else {
                SilentPath::WakeProgress
            }
        }
        None => SilentPath::Nothing,
    };
    let watch_missed =
        target.watch && !own_wake && !has_own_report_since(after, me_id, turn_start_seq, turn_id);
    let delegation_report_missed = target.delegated_by
        && post_count > 0
        && delegation_left_open(after, me_id, turn_start_seq, turn_id);
    AfterTurnPlan {
        silent,
        post_count,
        check_report_promise: target.report_promise && !own_wake,
        watch_missed,
        delegation_report_missed,
    }
}

#[cfg(test)]
#[path = "turn_success_tests.rs"]
mod tests;
