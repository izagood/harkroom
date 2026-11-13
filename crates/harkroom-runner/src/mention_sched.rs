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
    slot: Option<String>,
    end: Option<(String, String)>,
}

impl<S: SchedulerHooks> OnceRelease<S> {
    /// `slot_held`·`thread_key`·`mention_id` 는 그 멘션의 `Launch` 값(정본 `slotHeld`·스레드 열쇠·앞 멘션 id).
    pub fn new(inner: S, thread_key: &str, slot_held: bool, mention_id: &str) -> Self {
        Self {
            inner,
            slot: slot_held.then(|| thread_key.to_string()),
            end: Some((thread_key.to_string(), mention_id.to_string())),
        }
    }
}

impl<S: SchedulerHooks> SchedulerHooks for OnceRelease<S> {
    fn notice_fenced(&mut self) {
        self.inner.notice_fenced();
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

#[cfg(test)]
#[path = "mention_sched_tests.rs"]
mod tests;
