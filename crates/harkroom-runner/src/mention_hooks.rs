//! [`MentionHooks`] 실물 — 턴 임대 넘기기·놓기는 **그 에이전트 링크**(`AgentClients::link`)로 오퍼레이터에 알리고, 스케줄러 몫
//! (슬롯 놓기·턴 끝·결과·펜스·[중단] 시각·실행 파일 없음)은 부르는 쪽([`SchedulerHooks`])에 넘긴다.
//!
//! **턴 임대 토큰은 오퍼레이터 알림 한 길로만 간다** — 글·로그에 싣지 않는다(로그는 고정 문장, `TurnLease` 의 Debug 는 토큰을
//! 가린다). 놓을 때는 받은 멘션 id(cause)로 끝을 알린다(정본 `secretLeases.release(mention.id)` → `notifyEnded(cause)`).

use crate::link::LinkClient;
use crate::mention_deps::MentionHooks;
use crate::rest::TurnLease;

/// 스케줄러가 쥔 일.
pub trait SchedulerHooks {
    fn notice_fenced(&mut self);
    fn turn_outcome(&mut self, ok: bool);
    fn stop_requested(&mut self, at: &str);
    fn executable_missing(&mut self);
    fn release_slot(&mut self, thread_key: &str);
    fn turn_ended(&mut self, thread_key: &str, mention_id: &str);
}

/// 오퍼레이터에 턴 임대를 알리는 길(실물 `LinkClient`).
pub trait LeaseHandoff {
    fn lease(&self, cause: &str, lease_id: &str, token: &str, expires_at: &str);
    fn lease_ended(&self, cause: &str);
}

impl LeaseHandoff for LinkClient {
    fn lease(&self, cause: &str, lease_id: &str, token: &str, expires_at: &str) {
        self.notify_secret_lease(cause, lease_id, token, expires_at);
    }
    fn lease_ended(&self, cause: &str) {
        self.notify_secret_lease_ended(cause);
    }
}

/// [`MentionHooks`] 실물.
pub struct LinkHooks<'a, O: LeaseHandoff, S: SchedulerHooks> {
    /// 그 에이전트 링크 — `AgentClients::link` 에서 받는다.
    pub operator: &'a O,
    pub scheduler: S,
    pub key: String,
    pub now: fn() -> u64,
    /// 받은 임대의 cause(멘션 id) — 놓을 때 쓴다. 토큰은 쥐지 않는다.
    held: Option<String>,
}

impl<'a, O: LeaseHandoff, S: SchedulerHooks> LinkHooks<'a, O, S> {
    pub fn new(operator: &'a O, scheduler: S, key: String, now: fn() -> u64) -> Self {
        Self {
            operator,
            scheduler,
            key,
            now,
            held: None,
        }
    }
}

impl<O: LeaseHandoff, S: SchedulerHooks> MentionHooks for LinkHooks<'_, O, S> {
    fn now(&self) -> u64 {
        (self.now)()
    }
    fn lease_issued(&mut self, cause: &str, lease: TurnLease) {
        self.operator
            .lease(cause, &lease.id, &lease.token, &lease.expires_at);
        self.held = Some(cause.to_string());
        self.log("턴 임대를 받아 오퍼레이터에 맡겼다");
    }
    fn release_lease(&mut self) {
        if let Some(cause) = self.held.take() {
            self.operator.lease_ended(&cause);
        }
    }
    fn notice_fenced(&mut self) {
        self.scheduler.notice_fenced();
    }
    fn turn_outcome(&mut self, ok: bool) {
        self.scheduler.turn_outcome(ok);
    }
    fn stop_requested(&mut self, at: &str) {
        self.scheduler.stop_requested(at);
    }
    fn executable_missing(&mut self) {
        self.scheduler.executable_missing();
    }
    fn release_slot(&mut self, thread_key: &str) {
        self.scheduler.release_slot(thread_key);
    }
    fn turn_ended(&mut self, thread_key: &str, mention_id: &str) {
        self.scheduler.turn_ended(thread_key, mention_id);
    }
    fn log(&mut self, line: &str) {
        eprintln!("[mentionScheduler] {}: {line}", self.key);
    }
}

#[cfg(test)]
#[path = "mention_hooks_tests.rs"]
mod tests;
