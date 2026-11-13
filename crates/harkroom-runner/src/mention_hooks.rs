//! [`MentionHooks`] 실물 — 턴 임대 넘기기·놓기는 **그 에이전트 링크**(`AgentClients::link`)로 오퍼레이터에 알리고, 스케줄러 몫
//! (슬롯 놓기·턴 끝·결과·펜스·[중단] 시각·실행 파일 없음)은 부르는 쪽([`SchedulerHooks`])에 넘긴다.
//!
//! **턴 임대 토큰은 오퍼레이터 알림 한 길로만 간다** — 글·로그에 싣지 않는다(로그는 고정 문장, `TurnLease` 의 Debug 는 토큰을
//! 가린다). 놓을 때는 받은 멘션 id(cause)로 끝을 알린다(정본 `secretLeases.release(mention.id)` → `notifyEnded(cause)`).
//!
//! **임대를 쥐는 자리는 러너 수명의 [`LeaseBook`] 이다**(정본 `secretLeases` 의 `held` Map). 멘션 호출(deps)은 시도마다 새로 짓지만,
//! 재시도·계정 전환으로 같은 멘션이 다시 돌면 장부의 답을 그대로 쓴다 — 서버는 멘션당 한 번만 주고 끝난 멘션의 재청은 409
//! `lease_used` 다. 그래서 [`LinkHooks`] 의 `Drop` 은 **패닉 풀림 중일 때만** 놓는다 — 정상 길에서 놓을지는 결말(`settle`)이 정한다.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::link::LinkClient;
use crate::mention_deps::MentionHooks;
use crate::mention_settle::LeaseState;
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

/// 장부에 적힌 그 멘션의 답.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Booked {
    /// 받아서 오퍼레이터에 맡겼다(정본 `leaseId` 있음 → `'held'`).
    Held,
    /// 서버가 주지 않았다(정본 `leaseId: null` → `'none'`) — 재시도마다 다시 묻지 않는다.
    Declined,
}

/// 러너 수명의 턴 임대 장부(정본 `secretLeases` 의 `held`) — 멘션 id → 받은 답. 토큰·임대 id 는 적지 않는다.
/// 409·무응답은 적지 않는다(다음 시도가 다시 묻는다).
#[derive(Default)]
pub struct LeaseBook(Mutex<HashMap<String, Booked>>);

impl LeaseBook {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Booked>> {
        // 맵 조작 도중 패닉하지 않는다 — 독이 들어도 값은 쓸 만하다(놓기를 멈추면 임대가 남는다).
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
    pub fn get(&self, cause: &str) -> Option<Booked> {
        self.map().get(cause).copied()
    }
    fn put(&self, cause: &str, b: Booked) {
        self.map().insert(cause.to_string(), b);
    }
    fn take(&self, cause: &str) -> Option<Booked> {
        self.map().remove(cause)
    }
    pub fn len(&self) -> usize {
        self.map().len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// [`MentionHooks`] 실물.
pub struct LinkHooks<'a, O: LeaseHandoff, S: SchedulerHooks> {
    /// 그 에이전트 링크 — `AgentClients::link` 에서 받는다.
    pub operator: &'a O,
    /// 러너 수명의 임대 장부.
    pub book: &'a LeaseBook,
    pub scheduler: S,
    pub key: String,
    pub now: fn() -> u64,
    /// 이 호출이 장부에서 다룬 cause(멘션 id) — 놓을 때 쓴다. 토큰은 쥐지 않는다.
    cause: Option<String>,
}

impl<'a, O: LeaseHandoff, S: SchedulerHooks> LinkHooks<'a, O, S> {
    pub fn new(
        operator: &'a O,
        book: &'a LeaseBook,
        scheduler: S,
        key: String,
        now: fn() -> u64,
    ) -> Self {
        Self {
            operator,
            book,
            scheduler,
            key,
            now,
            cause: None,
        }
    }

    /// 장부에서 지우고, 받은 임대였으면 끝을 알린다(정본 `release` — 거절이었으면 알릴 것이 없다).
    fn end(&mut self) {
        if let Some(cause) = self.cause.take()
            && self.book.take(&cause) == Some(Booked::Held)
        {
            self.operator.lease_ended(&cause);
        }
    }
}

impl<O: LeaseHandoff, S: SchedulerHooks> MentionHooks for LinkHooks<'_, O, S> {
    fn now(&self) -> u64 {
        (self.now)()
    }
    fn prior_lease(&mut self, cause: &str) -> Option<LeaseState> {
        let b = self.book.get(cause)?;
        self.cause = Some(cause.to_string());
        Some(match b {
            Booked::Held => LeaseState::Ready,
            Booked::Declined => LeaseState::Declined,
        })
    }
    fn lease_issued(&mut self, cause: &str, lease: TurnLease) {
        self.operator
            .lease(cause, &lease.id, &lease.token, &lease.expires_at);
        self.book.put(cause, Booked::Held);
        self.cause = Some(cause.to_string());
        self.log("턴 임대를 받아 오퍼레이터에 맡겼다");
    }
    fn lease_declined(&mut self, cause: &str) {
        self.book.put(cause, Booked::Declined);
        self.cause = Some(cause.to_string());
    }
    fn release_lease(&mut self) {
        self.end();
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

impl<O: LeaseHandoff, S: SchedulerHooks> Drop for LinkHooks<'_, O, S> {
    /// **패닉 풀림 중일 때만** 놓는다 — `release_lease` 를 못 지난 멘션의 임대를 남기지 않는다(그 멘션은 다시 돌지 않는다).
    /// 정상 길에서는 놓지 않는다: 재시도 갈래는 장부가 임대를 쥐고 있어야 다음 시도가 다시 발급을 청하지 않는다(서버 409).
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.end();
        }
    }
}

#[cfg(test)]
#[path = "mention_hooks_tests.rs"]
mod tests;
