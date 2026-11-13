//! [`LinkHooks`] — 턴 임대 토큰은 오퍼레이터 알림으로만 가고, 놓을 때 받은 cause 로 끝을 알린다.
use std::cell::RefCell;

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
    let mut h = LinkHooks::new(&op, Sched::default(), "k".into(), || 1);
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
    assert_eq!(h.held.as_deref(), Some("men-1"), "쥐는 것은 cause 뿐");
    h.release_lease();
    h.release_lease();
    assert_eq!(
        *op.ended.borrow(),
        vec!["men-1".to_string()],
        "끝 알림은 한 번"
    );
}

#[test]
fn scheduler_parts_are_delegated() {
    let op = Operator::default();
    let mut h = LinkHooks::new(&op, Sched::default(), "k".into(), || 1);
    h.release_slot("t");
    h.turn_ended("t", "m");
    h.turn_outcome(true);
    assert_eq!(h.scheduler.slots, vec!["t".to_string()]);
    assert_eq!(h.scheduler.ended, vec![("t".to_string(), "m".to_string())]);
    assert_eq!(h.scheduler.outcomes, vec![true]);
    assert!(op.ended.borrow().is_empty(), "임대가 없으면 끝 알림도 없다");
}

#[test]
fn held_lease_is_ended_on_drop_once() {
    let op = Operator::default();
    {
        let mut h = LinkHooks::new(&op, Sched::default(), "k".into(), || 1);
        h.lease_issued(
            "men-2",
            TurnLease {
                id: "l".into(),
                token: "t".into(),
                expires_at: "x".into(),
            },
        );
        // release_lease 없이 떨어진다(패닉 풀림과 같은 길).
    }
    assert_eq!(*op.ended.borrow(), vec!["men-2".to_string()]);

    let op = Operator::default();
    {
        let mut h = LinkHooks::new(&op, Sched::default(), "k".into(), || 1);
        h.lease_issued(
            "men-3",
            TurnLease {
                id: "l".into(),
                token: "t".into(),
                expires_at: "x".into(),
            },
        );
        h.release_lease();
    }
    assert_eq!(
        *op.ended.borrow(),
        vec!["men-3".to_string()],
        "정상 길 뒤 Drop 은 다시 안 보낸다"
    );
}
