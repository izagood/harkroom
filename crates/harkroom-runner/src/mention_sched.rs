//! 스케줄러 hooks 실물의 놓기 가드 — [`OnceRelease`] 는 멘션 하나의 슬롯 놓기(`release_slot`)와 턴 끝(`turn_ended`)을
//! **정상·패닉 모두에서 정확히 한 번** 부른다(security ③b-2b 조건 ③).
//!
//! 정상 길: `run_one` 의 끝(`Launch::release_holds`)이 부른다 → 안쪽에 넘기고 표지를 지운다. 패닉 길: `run_one` 이 거기까지 못
//! 가면 `run_mention` 의 떨굼 차례(턴 → 중계 세션 → 자리, #2043)에서 deps(`MentionDeps` → `LinkHooks` → 이 값)가 떨어질 때
//! 남은 것만 부른다. 그래서 두 번 놓이지 않고, 빠지지도 않는다.
//!
//! 슬롯을 쥐지 않은 멘션(`slot_held == false`)은 슬롯을 놓지 않는다(정본 `releaseHolds` 와 같다).

use crate::mention_hooks::SchedulerHooks;

/// 슬롯 놓기·턴 끝을 한 번씩 보장하는 감싸개.
pub struct OnceRelease<S: SchedulerHooks> {
    pub inner: S,
    key: String,
    slot: Option<String>,
    end: Option<(String, String)>,
}

impl<S: SchedulerHooks> OnceRelease<S> {
    /// `slot_held`·`thread_key`·`mention_id` 는 그 멘션의 `Launch` 값(정본 `slotHeld`·스레드 열쇠·앞 멘션 id).
    pub fn new(inner: S, thread_key: &str, slot_held: bool, mention_id: &str) -> Self {
        Self {
            inner,
            key: thread_key.to_string(),
            slot: slot_held.then(|| thread_key.to_string()),
            end: Some((thread_key.to_string(), mention_id.to_string())),
        }
    }
}

impl<S: SchedulerHooks> SchedulerHooks for OnceRelease<S> {
    /// 부른 쪽의 열쇠가 아니라 이 멘션의 `Launch` 열쇠를 싣는다 — 표지가 다른 스레드로 가지 않는다.
    fn notice_fenced(&mut self, _thread_key: &str) {
        let key = self.key.clone();
        self.inner.notice_fenced(&key);
    }
    fn turn_outcome(&mut self, ok: bool) {
        self.inner.turn_outcome(ok);
    }
    fn stop_requested(&mut self, at: &str) {
        self.inner.stop_requested(at);
    }
    fn executable_missing(&mut self) {
        self.inner.executable_missing();
    }
    fn release_slot(&mut self, thread_key: &str) {
        if self.slot.take().is_some() {
            self.inner.release_slot(thread_key);
        }
    }
    fn turn_ended(&mut self, thread_key: &str, mention_id: &str) {
        if self.end.take().is_some() {
            self.inner.turn_ended(thread_key, mention_id);
        }
    }
}

impl<S: SchedulerHooks> Drop for OnceRelease<S> {
    fn drop(&mut self) {
        // 정본 차례: 슬롯을 먼저 놓고 턴 끝을 알린다.
        if let Some(k) = self.slot.take() {
            self.inner.release_slot(&k);
        }
        if let Some((k, m)) = self.end.take() {
            self.inner.turn_ended(&k, &m);
        }
    }
}

/// 스케줄러 고리로 가는 사건 — [`ChannelScheduler`] 가 보낸다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SchedEvent {
    /// 그 스레드 열쇠(`채널/앵커`).
    Fenced(String),
    Outcome(bool),
    StopRequested(String),
    ExecutableMissing,
    SlotReleased(String),
    TurnEnded {
        thread_key: String,
        mention_id: String,
    },
}

/// [`SchedulerHooks`] 실물 — 멘션 스레드에서 스케줄러 고리로 사건을 보낸다. **패닉하지 않는다**: 받는 쪽이 사라졌으면(러너
/// 종료 중) 보내기 실패를 버린다. 패닉 풀림 중 `Drop`(`OnceRelease`)에서 불려도 안전하다.
#[derive(Clone)]
pub struct ChannelScheduler(pub std::sync::mpsc::Sender<SchedEvent>);

impl ChannelScheduler {
    fn send(&self, e: SchedEvent) {
        let _ = self.0.send(e);
    }
}

impl SchedulerHooks for ChannelScheduler {
    fn notice_fenced(&mut self, thread_key: &str) {
        self.send(SchedEvent::Fenced(thread_key.to_string()));
    }
    fn turn_outcome(&mut self, ok: bool) {
        self.send(SchedEvent::Outcome(ok));
    }
    fn stop_requested(&mut self, at: &str) {
        self.send(SchedEvent::StopRequested(at.to_string()));
    }
    fn executable_missing(&mut self) {
        self.send(SchedEvent::ExecutableMissing);
    }
    fn release_slot(&mut self, thread_key: &str) {
        self.send(SchedEvent::SlotReleased(thread_key.to_string()));
    }
    fn turn_ended(&mut self, thread_key: &str, mention_id: &str) {
        self.send(SchedEvent::TurnEnded {
            thread_key: thread_key.to_string(),
            mention_id: mention_id.to_string(),
        });
    }
}

#[cfg(test)]
#[path = "mention_sched_tests.rs"]
mod tests;
