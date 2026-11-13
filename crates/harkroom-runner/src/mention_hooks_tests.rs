//! [`LinkHooks`] — 턴 임대 토큰은 오퍼레이터 알림으로만 가고, 러너 수명 장부가 쥐며, 놓을 때 받은 cause 로 끝을 알린다.
use std::cell::RefCell;
use std::panic::{AssertUnwindSafe, catch_unwind};

use super::*;

#[derive(Default)]
struct Operator {
    leased: RefCell<Vec<(String, String, String)>>,
    ended: RefCell<Vec<String>>,
}
impl LeaseHandoff for Operator {
    fn lease(&self, cause: &str, lease_id: &str, token: &str, _expires_at: &str) {
        self.leased
            .borrow_mut()
            .push((cause.into(), lease_id.into(), token.into()));
    }
    fn lease_ended(&self, cause: &str) {
        self.ended.borrow_mut().push(cause.into());
    }
}

#[derive(Default)]
struct Sched {
    slots: Vec<String>,
    ended: Vec<(String, String)>,
    outcomes: Vec<bool>,
}
impl SchedulerHooks for Sched {
    fn notice_fenced(&mut self) {}
    fn turn_outcome(&mut self, ok: bool) {
        self.outcomes.push(ok);
    }
    fn stop_requested(&mut self, _at: &str) {}
    fn executable_missing(&mut self) {}
    fn release_slot(&mut self, k: &str) {
        self.slots.push(k.into());
    }
    fn turn_ended(&mut self, k: &str, m: &str) {
        self.ended.push((k.into(), m.into()));
    }
}

#[test]
fn lease_goes_to_operator_and_release_ends_that_cause_once() {
    let op = Operator::default();
    let book = LeaseBook::default();
    let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
    h.lease_issued(
        "men-1",
        TurnLease {
            id: "lease-1".into(),
            token: "tok-secret-value".into(),
            expires_at: "x".into(),
        },
    );
    assert_eq!(
        *op.leased.borrow(),
        vec![("men-1".into(), "lease-1".into(), "tok-secret-value".into())]
    );
    assert_eq!(h.cause.as_deref(), Some("men-1"), "쥐는 것은 cause 뿐");
    assert_eq!(book.get("men-1"), Some(Booked::Held));
    h.release_lease();
    h.release_lease();
    assert_eq!(
        *op.ended.borrow(),
        vec!["men-1".to_string()],
        "끝 알림은 한 번"
    );
    assert!(book.is_empty());
}

#[test]
fn scheduler_parts_are_delegated() {
    let op = Operator::default();
    let book = LeaseBook::default();
    let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
    h.release_slot("t");
    h.turn_ended("t", "m");
    h.turn_outcome(true);
    assert_eq!(h.scheduler.slots, vec!["t".to_string()]);
    assert_eq!(h.scheduler.ended, vec![("t".to_string(), "m".to_string())]);
    assert_eq!(h.scheduler.outcomes, vec![true]);
    assert!(op.ended.borrow().is_empty(), "임대가 없으면 끝 알림도 없다");
}

fn lease() -> TurnLease {
    TurnLease {
        id: "l".into(),
        token: "t".into(),
        expires_at: "x".into(),
    }
}

/// 정상 길에서 떨어지면 놓지 않는다(재시도 갈래 — 장부가 쥔다). 다음 호출은 장부의 답을 그대로 쓰고, 놓으면 한 번 끝을 알린다.
#[test]
fn normal_drop_keeps_lease_in_book_for_next_call() {
    let op = Operator::default();
    let book = LeaseBook::default();
    {
        let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
        assert_eq!(h.prior_lease("men-2"), None);
        h.lease_issued("men-2", lease());
    }
    assert!(op.ended.borrow().is_empty(), "정상 Drop 은 놓지 않는다");
    assert_eq!(book.get("men-2"), Some(Booked::Held));

    let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
    assert_eq!(
        h.prior_lease("men-2"),
        Some(LeaseState::Ready),
        "다시 청하지 않는다"
    );
    h.release_lease();
    drop(h);
    assert_eq!(*op.ended.borrow(), vec!["men-2".to_string()]);
    assert!(book.is_empty());
}

/// 패닉 풀림 중 떨어지면 한 번 놓는다(장부에서도 지운다).
#[test]
fn held_lease_is_ended_on_panic_drop_once() {
    let op = Operator::default();
    let book = LeaseBook::default();
    let r = catch_unwind(AssertUnwindSafe(|| {
        let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
        h.lease_issued("men-3", lease());
        panic!("시험 패닉");
    }));
    assert!(r.is_err());
    assert_eq!(*op.ended.borrow(), vec!["men-3".to_string()]);
    assert!(book.is_empty());
}

/// 거절은 적어 두고(재시도마다 다시 묻지 않는다) 놓을 때 끝을 알리지 않는다(받은 임대가 없다).
#[test]
fn declined_is_booked_and_release_sends_nothing() {
    let op = Operator::default();
    let book = LeaseBook::default();
    {
        let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
        h.lease_declined("men-4");
    }
    let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
    assert_eq!(h.prior_lease("men-4"), Some(LeaseState::Declined));
    h.release_lease();
    assert!(op.ended.borrow().is_empty());
    assert!(book.is_empty());
}
