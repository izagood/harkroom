//! 멘션 반응 신호(정본 `runMentionTurn` 의 👀·💬) — 사람이 「듣기는 했나」·「아직 도나」를 글 위에서 보게 한다.
//!
//! - 👀: 멘션을 집은 **즉시**(준비·워크스페이스 해석보다 앞). 묶인 앞 글(사람의 글을 받은 턴일 때만)에도 단다.
//! - 💬: 턴이 도는 동안. [`WorkingReaction`] 가드가 떨어질 때(정상·실패·패닉 모두) 뗀다 — 남으면 「영원히 작업 중」이라는
//!   거짓 신호다. 달기는 동기로 끝나므로 떼기가 달기를 앞지르지 않는다.
//! - 모두 best-effort 다. 실패로 턴을 멈추지 않되 삼키지도 않고 로그로 남긴다.

use crate::mention_target::MentionTarget;

/// 받음 신호.
pub const RECEIVED_REACTION: &str = "👀";
/// 진행 중 신호(정본 `WORKING_REACTION`).
pub use crate::turn_io::WORKING_REACTION;

/// 반응을 다는 길. 실패는 사유를 돌려준다.
pub trait Reactor {
    fn add(&self, channel_id: &str, message_id: &str, emoji: &str) -> Result<(), String>;
    fn remove(&self, channel_id: &str, message_id: &str, emoji: &str) -> Result<(), String>;
}

impl<L: crate::rest::RunnerLink> Reactor for crate::mcp::HarkroomMcpClient<L> {
    fn add(&self, channel_id: &str, message_id: &str, emoji: &str) -> Result<(), String> {
        self.add_reaction(channel_id, message_id, emoji)
            .map_err(|e| e.message)
    }
    fn remove(&self, channel_id: &str, message_id: &str, emoji: &str) -> Result<(), String> {
        self.remove_reaction(channel_id, message_id, emoji)
            .map_err(|e| e.message)
    }
}

/// 👀 를 달 글 id — 멘션 글, 그리고 사람의 글을 받은 턴이면 묶인 앞 글(정본: 예약·위임 갈래는 묶음을 싣지 않는다).
pub fn received_ids(t: &MentionTarget) -> Vec<String> {
    let mut ids = Vec::new();
    if !t.mention_id.is_empty() {
        ids.push(t.mention_id.clone());
    }
    let inbox_mention = t.wake.is_none()
        && t.delegation.is_none()
        && t.delegation_followup.is_none()
        && t.delegation_update.is_none();
    if inbox_mention {
        for row in &t.bundled_rows {
            if let Some(id) = row.get("id").and_then(serde_json::Value::as_str)
                && !id.is_empty()
                && !ids.iter().any(|x| x == id)
            {
                ids.push(id.to_string());
            }
        }
    }
    ids
}

/// 👀 를 단다(실패는 로그).
pub fn mark_received(r: &dyn Reactor, t: &MentionTarget, log: &dyn Fn(&str)) {
    for id in received_ids(t) {
        if let Err(e) = r.add(&t.channel_id, &id, RECEIVED_REACTION) {
            log(&format!(
                "[mentionTurn] {}/{id}: 리액션(받았음) 실패(턴은 계속한다) — {e}",
                t.channel_id
            ));
        }
    }
}

/// 💬 가드 — 지을 때 달고, 떨어질 때 뗀다.
pub struct WorkingReaction<'a> {
    reactor: &'a dyn Reactor,
    channel_id: String,
    message_id: String,
    log: &'a dyn Fn(&str),
}

impl<'a> WorkingReaction<'a> {
    /// 멘션 글이 없으면(id 빔) 달지도 떼지도 않는다.
    pub fn start(
        reactor: &'a dyn Reactor,
        t: &MentionTarget,
        log: &'a dyn Fn(&str),
    ) -> Option<Self> {
        if t.mention_id.is_empty() {
            return None;
        }
        if let Err(e) = reactor.add(&t.channel_id, &t.mention_id, WORKING_REACTION) {
            // 달기에 실패해도 떼기는 해 둔다 — 서버가 받았는데 응답만 잃었을 수 있다.
            log(&format!(
                "[mentionTurn] {}/{}: 리액션(진행 중) 실패(턴은 계속한다) — {e}",
                t.channel_id, t.mention_id
            ));
        }
        Some(Self {
            reactor,
            channel_id: t.channel_id.clone(),
            message_id: t.mention_id.clone(),
            log,
        })
    }
}

impl Drop for WorkingReaction<'_> {
    fn drop(&mut self) {
        if let Err(e) = self
            .reactor
            .remove(&self.channel_id, &self.message_id, WORKING_REACTION)
        {
            (self.log)(&format!(
                "[mentionTurn] {}/{}: 리액션(진행 중) 제거 실패 — {e}",
                self.channel_id, self.message_id
            ));
        }
    }
}

#[cfg(test)]
#[path = "turn_reactions_tests.rs"]
mod tests;
