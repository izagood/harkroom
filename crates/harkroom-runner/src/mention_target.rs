//! 정본 `mentionScheduler.ts::runOne` 머리의 `MentionTarget` 만들기(B4-1b-2b-2b).
//!
//! inbox 대표 줄(entry)·멘션 글(row)·묶인 앞 글에서 멘션 턴이 받을 대상을 접는다. 사유(`reason`)마다 실리는 칸이
//! 다르고, **사유와 짝인 칸은 사유가 맞을 때만** 싣는다(팀 명단·위임 결말·넘겨받은 일 — 서버가 그 사이 지워
//! 맥락 없이 사유만 줄 수 있고, 빈 블록을 그리면 「없음」을 사실처럼 알리는 셈이다).
//!
//! 팀·위임 같은 하위 꼴은 받는 쪽(B4-2 멘션 턴 본체)이 읽으므로 여기서는 서버 줄 그대로(`Value`) 넘긴다.
//! 펜싱 신호는 [`crate::mention_admit::Launch`] 의 임대가 들고 있어 여기 칸이 없다.

use serde_json::Value;

use crate::mention_scheduler::{
    AskAnsweredWake, WakeTarget, ask_answered_wake, ask_closed_note, wake_target,
};

/// 델타 대신 실리는 깨움 사유(정본 `MentionTarget['wake']` — 세 사유가 같은 자리를 쓴다).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetWake {
    /// 자기가 걸어 둔 예약(`reason: wake`). 이 턴은 큰 세션을 이어받지 않는다(`scheduledWake`).
    Scheduled(WakeTarget),
    /// 카드에 답이 왔다(`ask_answered`).
    AskAnswered(AskAnsweredWake),
    /// 카드가 답 없이 닫혔다(`ask_closed`).
    AskClosed(&'static str),
}

/// 정본 `MentionTarget`.
#[derive(Debug, Clone, PartialEq)]
pub struct MentionTarget {
    pub channel_id: String,
    pub thread_root_id: String,
    pub mention_id: String,
    pub mention_row: Value,
    /// 묶여 함께 처리할 앞 글(오래된 순). 비었으면 혼자 뜬 턴.
    pub bundled_rows: Vec<Value>,
    pub wake: Option<TargetWake>,
    pub canceled_wakes: Vec<Value>,
    pub started_in: Option<Value>,
    pub team: Option<Value>,
    pub delegation: Option<Value>,
    /// 닫힌 위임의 후속 보고 — 멘션 글이 그 보고다.
    pub delegation_followup: Option<Value>,
    /// 넘긴 일의 진행/결과 — 멘션 글은 담당의 글이다.
    pub delegation_update: Option<Value>,
    pub delegations: Vec<Value>,
    pub delegated_by: Option<Value>,
    /// 수정으로 생긴 부름 — 고친 뒤의 본문을 델타와 무관하게 싣는다.
    pub edited_mention: Option<Value>,
}

impl MentionTarget {
    /// `scheduledWake` — 예약 깨움일 때만 참(선택 답은 앞 대화가 필요하다).
    pub fn scheduled_wake(&self) -> bool {
        matches!(self.wake, Some(TargetWake::Scheduled(_)))
    }
}

fn present(v: Option<&Value>) -> Option<Value> {
    v.filter(|v| !v.is_null()).cloned()
}

fn nonempty_array(v: Option<&Value>) -> Vec<Value> {
    v.and_then(Value::as_array).cloned().unwrap_or_default()
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// 정본 runOne 의 `target` 조립. `entry` 는 inbox 대표 줄, `mention` 은 그 멘션 글, `anchor` 는 스레드 앵커.
pub fn build_mention_target(
    entry: &Value,
    mention: &Value,
    anchor: &str,
    bundled: &[Value],
) -> MentionTarget {
    let reason = str_of(entry, "reason");
    let meta = mention.get("meta").filter(|m| !m.is_null());
    let wake = match reason {
        "wake" => Some(TargetWake::Scheduled(wake_target(mention))),
        "ask_answered" => Some(TargetWake::AskAnswered(ask_answered_wake(
            str_of(mention, "id"),
            meta,
        ))),
        "ask_closed" => Some(TargetWake::AskClosed(ask_closed_note(meta))),
        _ => None,
    };
    let when = |want: &str, key: &str| {
        if reason == want {
            present(entry.get(key))
        } else {
            None
        }
    };
    MentionTarget {
        channel_id: str_of(mention, "channelId").to_string(),
        thread_root_id: anchor.to_string(),
        mention_id: str_of(mention, "id").to_string(),
        mention_row: mention.clone(),
        bundled_rows: bundled.to_vec(),
        wake,
        canceled_wakes: nonempty_array(entry.get("canceledWakes")),
        started_in: present(entry.get("startedIn")),
        team: when("team_mention", "team"),
        delegation: when("delegation_done", "delegation"),
        delegation_followup: (reason == "delegation_followup").then(|| mention.clone()),
        delegation_update: (reason == "delegation_update").then(|| mention.clone()),
        delegations: nonempty_array(entry.get("delegations")),
        delegated_by: when("team_delegated", "delegatedBy"),
        edited_mention: entry
            .get("viaEdit")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            .then(|| mention.clone()),
    }
}

#[cfg(test)]
#[path = "mention_target_tests.rs"]
mod tests;
