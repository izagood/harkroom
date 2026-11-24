//! 멘션 반응 신호(정본 `runMentionTurn` 의 👀·💬) — 사람이 「듣기는 했나」·「아직 도나」를 글 위에서 보게 한다.
//!
//! - 👀: 멘션을 집은 **즉시**(준비·워크스페이스 해석보다 앞). 묶인 앞 글(사람의 글을 받은 턴일 때만)에도 단다.
//! - 💬: 턴이 도는 동안. [`TurnReactions`] 가드가 떨어질 때(정상·실패·패닉 모두) 뗀다 — 남으면 「영원히 작업 중」이라는
//!   거짓 신호다.
//! - **달기는 턴 시작을 막지 않는다**: 👀 → 💬 달기는 곁 스레드 하나에서 그 순서로 돌고, 멘션 몸통(턴 임대·준비·띄우기)은
//!   기다리지 않고 나아간다. 서버 왕복이 긴 기계에서 이 둘이 임대 앞에 줄 서면 그만큼 턴이 늦게 뜬다.
//! - **떼기는 달기를 앞지르지 않는다**: 가드는 떨어질 때 곁 스레드를 먼저 기다린 뒤(join) 💬 를 뗀다 — 임대 거절·준비
//!   실패처럼 몸통이 달기보다 먼저 끝나도 순서는 👀 → 💬 달기 → 💬 떼기다.
//! - 모두 best-effort 다. 실패로 턴을 멈추지 않되 삼키지도 않고 로그로 남긴다.

use crate::mention_target::MentionTarget;

/// 받음 신호.
pub const RECEIVED_REACTION: &str = "👀";
/// 진행 중 신호(정본 `WORKING_REACTION`).
pub use crate::turn_io::WORKING_REACTION;

/// 반응을 다는 길. 실패는 사유를 돌려준다. 달기가 곁 스레드에서 돌므로 `Sync` 다.
pub trait Reactor: Sync {
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

/// 👀(받음) → 💬(진행 중)를 그 순서로 단다. 실패는 턴을 멈추지 않고 로그 줄로 돌려준다.
/// `working` 이 `None` 이면 💬 는 달지 않는다.
pub fn add_all(
    r: &dyn Reactor,
    channel_id: &str,
    received: &[String],
    working: Option<&str>,
) -> Vec<String> {
    let mut lines = Vec::new();
    for id in received {
        if let Err(e) = r.add(channel_id, id, RECEIVED_REACTION) {
            lines.push(format!(
                "[mentionTurn] {channel_id}/{id}: 리액션(받았음) 실패(턴은 계속한다) — {e}"
            ));
        }
    }
    if let Some(id) = working
        && let Err(e) = r.add(channel_id, id, WORKING_REACTION)
    {
        // 달기에 실패해도 떼기는 해 둔다 — 서버가 받았는데 응답만 잃었을 수 있다.
        lines.push(format!(
            "[mentionTurn] {channel_id}/{id}: 리액션(진행 중) 실패(턴은 계속한다) — {e}"
        ));
    }
    lines
}

/// 턴 신호 가드 — 지을 때 👀·💬 달기를 곁 스레드에 맡기고, 떨어질 때 그 스레드를 기다린 뒤 💬 를 뗀다.
pub struct TurnReactions<'scope> {
    adding: Option<std::thread::ScopedJoinHandle<'scope, Vec<String>>>,
    reactor: &'scope dyn Reactor,
    channel_id: String,
    /// 💬 를 달고 뗄 글. 멘션 글이 없으면(id 빔) `None` — 달지도 떼지도 않는다.
    working: Option<String>,
    log: &'scope dyn Fn(&str),
}

impl<'scope> TurnReactions<'scope> {
    /// 달기를 곁 스레드로 띄우고 바로 돌아온다. 스레드를 못 띄우면 그 자리에서 단다(신호를 잃지 않는다).
    pub fn start<'env>(
        scope: &'scope std::thread::Scope<'scope, 'env>,
        reactor: &'scope dyn Reactor,
        t: &MentionTarget,
        log: &'scope dyn Fn(&str),
    ) -> Self {
        let received = received_ids(t);
        let working = (!t.mention_id.is_empty()).then(|| t.mention_id.clone());
        let (ch, ids, w) = (t.channel_id.clone(), received.clone(), working.clone());
        let spawned = std::thread::Builder::new()
            .name("turn-reactions".into())
            .spawn_scoped(scope, move || {
                let (lines, ms) =
                    crate::call_timing::measured(|| add_all(reactor, &ch, &ids, w.as_deref()));
                eprintln!(
                    "{}",
                    crate::call_timing::line("👀·💬 달기(턴 시작을 막지 않음)", ms)
                );
                lines
            });
        let adding = match spawned {
            Ok(h) => Some(h),
            Err(e) => {
                log(&format!(
                    "[mentionTurn] 리액션 스레드를 못 띄워 그 자리에서 단다 — {e}"
                ));
                for l in add_all(reactor, &t.channel_id, &received, working.as_deref()) {
                    log(&l);
                }
                None
            }
        };
        Self {
            adding,
            reactor,
            channel_id: t.channel_id.clone(),
            working,
            log,
        }
    }
}

impl Drop for TurnReactions<'_> {
    fn drop(&mut self) {
        // 달기를 먼저 끝낸다 — 떼기가 달기를 앞지르면 💬 가 영영 남는다.
        if let Some(h) = self.adding.take() {
            match h.join() {
                Ok(lines) => {
                    for l in lines {
                        (self.log)(&l);
                    }
                }
                Err(_) => (self.log)("[mentionTurn] 리액션 달기가 패닉했다(턴은 계속했다)"),
            }
        }
        let Some(id) = &self.working else { return };
        if let Err(e) = self.reactor.remove(&self.channel_id, id, WORKING_REACTION) {
            (self.log)(&format!(
                "[mentionTurn] {}/{id}: 리액션(진행 중) 제거 실패 — {e}",
                self.channel_id
            ));
        }
    }
}

#[cfg(test)]
#[path = "turn_reactions_tests.rs"]
mod tests;
