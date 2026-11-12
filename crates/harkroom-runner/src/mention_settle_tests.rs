use super::*;
use crate::mention_scheduler::{GATE_REQUEUE_MAX, LEASE_RETRY_MS, LEASE_WAIT_MAX_MS};

#[derive(Default)]
struct Fake {
    now: u64,
    fails: Vec<FailNotice>,
    fail_err: bool,
    read: Vec<Vec<i64>>,
    read_err: bool,
    lease_released: u32,
    fenced: u32,
    outcomes: Vec<bool>,
    stops: Vec<String>,
    logs: Vec<String>,
}

impl SettleDeps for Fake {
    fn now(&self) -> u64 {
        self.now
    }
    fn fail(&mut self, notice: &FailNotice) -> Result<(), String> {
        self.fails.push(notice.clone());
        if self.fail_err {
            Err("down".into())
        } else {
            Ok(())
        }
    }
    fn mark_read(&mut self, ids: &[i64]) -> Result<(), String> {
        self.read.push(ids.to_vec());
        if self.read_err {
            Err("timeout".into())
        } else {
            Ok(())
        }
    }
    fn release_lease(&mut self) {
        self.lease_released += 1;
    }
    fn notice_fenced(&mut self) {
        self.fenced += 1;
    }
    fn turn_outcome(&mut self, ok: bool) {
        self.outcomes.push(ok);
    }
    fn stop_requested(&mut self, at: &str) {
        self.stops.push(at.to_string());
    }
    fn log(&mut self, line: &str) {
        self.logs.push(line.to_string());
    }
}

fn started(group: &[i64]) -> (Ledger, u32) {
    let mut l = Ledger::new(&[], 0);
    let tried = l.start(group, "c:t");
    (l, tried)
}

fn other(text: &str) -> TurnEnd {
    TurnEnd::Other {
        err_text: text.into(),
    }
}

#[test]
fn done_marks_bundle_read_settles_and_forwards_stop() {
    let (mut l, tried) = started(&[1, 2]);
    let mut d = Fake::default();
    settle(
        &mut l,
        &mut d,
        2,
        tried,
        TurnEnd::Done {
            stop_requested_at: Some("2026-11-12T06:00:00Z".into()),
        },
        false,
        false,
    );
    assert_eq!(d.read, vec![vec![1, 2]]);
    assert_eq!(d.outcomes, vec![true]);
    assert_eq!(d.lease_released, 1);
    assert_eq!(d.fenced, 0);
    assert_eq!(d.stops, vec!["2026-11-12T06:00:00Z".to_string()]);
    assert!(l.attempt(2).is_none());
    assert!(d.fails.is_empty());
}

#[test]
fn done_after_fence_keeps_read_and_leaves_marker() {
    let (mut l, tried) = started(&[5]);
    let mut d = Fake::default();
    settle(
        &mut l,
        &mut d,
        5,
        tried,
        TurnEnd::Done {
            stop_requested_at: None,
        },
        true,
        false,
    );
    assert_eq!(d.read, vec![vec![5]]);
    assert_eq!(d.fenced, 1);
}

#[test]
fn read_failure_goes_to_done_unread() {
    let (mut l, tried) = started(&[7]);
    let mut d = Fake {
        read_err: true,
        ..Fake::default()
    };
    settle(
        &mut l,
        &mut d,
        7,
        tried,
        TurnEnd::Done {
            stop_requested_at: None,
        },
        false,
        false,
    );
    assert_eq!(l.done_entries(), vec![7]);
}

#[test]
fn fenced_failure_is_not_counted_read_or_noticed() {
    let (mut l, tried) = started(&[3]);
    let mut d = Fake::default();
    settle(&mut l, &mut d, 3, tried, other("boom"), true, true);
    assert!(d.read.is_empty());
    assert!(d.fails.is_empty());
    assert_eq!(d.fenced, 1);
    assert_eq!(d.lease_released, 1);
    assert_eq!(d.outcomes, vec![false]);
    let a = l.attempt(3).unwrap();
    assert_eq!((a.tried, a.not_before), (0, 0));
}

#[test]
fn retry_notice_once_then_give_up_at_max() {
    let (mut l, _) = started(&[9]);
    let mut d = Fake {
        now: 1_000,
        ..Fake::default()
    };
    settle(&mut l, &mut d, 9, 1, other("Bearer abc 실패"), false, false);
    assert_eq!(d.fails.len(), 1);
    assert_eq!(
        d.fails[0].body,
        FailBody::Retry {
            tried: 1,
            reason: Some("Bearer (가림) 실패".into())
        }
    );
    assert!(d.fails[0].retryable);
    assert!(d.read.is_empty());
    let a = l.attempt(9).unwrap();
    assert!(a.noticed && a.not_before > 1_000);
    // 두 번째 실패 — 통지는 다시 하지 않는다.
    settle(&mut l, &mut d, 9, 2, other("x"), false, false);
    assert_eq!(d.fails.len(), 1);
    // 세 번째 — 포기 통지와 읽음.
    settle(&mut l, &mut d, 9, MAX_ATTEMPTS, other("x"), false, false);
    assert_eq!(d.fails.len(), 2);
    assert_eq!(d.fails[1].body, FailBody::GaveUp);
    assert!(!d.fails[1].retryable);
    assert_eq!(d.read, vec![vec![9]]);
    assert!(l.attempt(9).is_none());
}

#[test]
fn retry_notice_failure_still_counts() {
    let (mut l, _) = started(&[4]);
    let mut d = Fake {
        fail_err: true,
        ..Fake::default()
    };
    settle(&mut l, &mut d, 4, 1, other("x"), false, false);
    assert!(l.attempt(4).unwrap().noticed);
    assert!(d.logs.iter().any(|s| s.contains("재시도는 계속된다")));
}

#[test]
fn unrecoverable_failures_notice_read_and_release() {
    let cases = vec![
        (
            TurnEnd::Quota {
                resets_at: None,
                api_line: Some("rate".into()),
            },
            true,
            None,
        ),
        (
            TurnEnd::SessionConflict {
                message: "dup".into(),
            },
            false,
            None,
        ),
        (
            TurnEnd::ProviderLane {
                code: "no_lease".into(),
                recallable: true,
            },
            true,
            Some("provider_lane"),
        ),
        (
            TurnEnd::ProviderLane {
                code: "bad_key".into(),
                recallable: false,
            },
            false,
            Some("provider_lane"),
        ),
        (
            TurnEnd::ThreadModelRejected {
                model: Some("m".into()),
                effort: None,
                api_error: "nope".into(),
            },
            false,
            Some("thread_model_rejected"),
        ),
        (
            TurnEnd::Stall {
                stall_ms: 600_000,
                screen: Some("idle".into()),
                screen_line: None,
            },
            true,
            None,
        ),
        (
            TurnEnd::Stall {
                stall_ms: 600_000,
                screen: Some("gate".into()),
                screen_line: None,
            },
            false,
            None,
        ),
    ];
    for (end, retryable, code) in cases {
        let (mut l, tried) = started(&[11]);
        let mut d = Fake {
            fail_err: true,
            ..Fake::default()
        };
        settle(&mut l, &mut d, 11, tried, end.clone(), false, false);
        assert_eq!(d.fails.len(), 1, "{end:?}");
        assert_eq!(d.fails[0].retryable, retryable, "{end:?}");
        assert_eq!(d.fails[0].code, code, "{end:?}");
        // 통지가 실패해도 읽음 처리는 계속된다.
        assert_eq!(d.read, vec![vec![11]], "{end:?}");
        assert_eq!(d.lease_released, 1, "{end:?}");
        assert!(l.attempt(11).is_none(), "{end:?}");
    }
}

#[test]
fn quota_logs_api_line_only_when_reset_unknown() {
    let (mut l, tried) = started(&[1]);
    let mut d = Fake::default();
    settle(
        &mut l,
        &mut d,
        1,
        tried,
        TurnEnd::Quota {
            resets_at: Some("15:00".into()),
            api_line: Some("secret-ish".into()),
        },
        false,
        false,
    );
    assert!(!d.logs.iter().any(|s| s.contains("secret-ish")));
    assert_eq!(d.fails[0].reason.as_deref(), Some("15:00 에 풀린다"));
}

#[test]
fn gate_requeue_uncounts_until_cap_then_reads() {
    let (mut l, _) = started(&[6]);
    let mut d = Fake::default();
    for i in 1..=GATE_REQUEUE_MAX {
        settle(
            &mut l,
            &mut d,
            6,
            1,
            TurnEnd::GateRequeue {
                why: "queued".into(),
                queued_config_dir: Some("/acct".into()),
            },
            false,
            false,
        );
        assert!(d.read.is_empty(), "requeue {i}");
        assert_eq!(l.attempt(6).unwrap().tried, 0);
        assert_eq!(l.gate_wait(6).unwrap().config_dir, "/acct");
    }
    settle(
        &mut l,
        &mut d,
        6,
        1,
        TurnEnd::GateRequeue {
            why: "passed".into(),
            queued_config_dir: Some("/acct".into()),
        },
        false,
        false,
    );
    assert_eq!(d.read, vec![vec![6]]);
    assert!(d.fails.is_empty());
    assert_eq!(d.lease_released, GATE_REQUEUE_MAX + 1);
}

#[test]
fn gate_passed_does_not_wait_on_marker() {
    let (mut l, _) = started(&[8]);
    let mut d = Fake::default();
    settle(
        &mut l,
        &mut d,
        8,
        1,
        TurnEnd::GateRequeue {
            why: "passed".into(),
            queued_config_dir: Some("/acct".into()),
        },
        false,
        false,
    );
    assert!(l.gate_wait(8).is_none());
}

#[test]
fn lease_gate_defers_quietly_then_fails_on_409() {
    let (mut l, tried) = started(&[2]);
    let mut d = Fake {
        now: 100,
        ..Fake::default()
    };
    assert_eq!(
        lease_gate(&mut l, &mut d, 2, tried, LeaseState::LeaseUsed),
        LeaseGate::Deferred
    );
    let a = l.attempt(2).unwrap();
    assert_eq!((a.tried, a.not_before), (0, 100 + LEASE_RETRY_MS));
    assert!(d.fails.is_empty() && d.read.is_empty());
    d.now = 100 + LEASE_WAIT_MAX_MS;
    assert_eq!(
        lease_gate(&mut l, &mut d, 2, 1, LeaseState::LeaseUsed),
        LeaseGate::GaveUp
    );
    assert_eq!(d.fails[0].body, FailBody::LeaseLost);
    assert!(d.fails[0].retryable);
    assert_eq!(d.read, vec![vec![2]]);
    assert_eq!(d.lease_released, 1);
}

#[test]
fn lease_gate_unreachable_runs_after_cap() {
    let (mut l, tried) = started(&[2]);
    let mut d = Fake::default();
    assert_eq!(
        lease_gate(&mut l, &mut d, 2, tried, LeaseState::Unreachable),
        LeaseGate::Deferred
    );
    d.now = LEASE_WAIT_MAX_MS;
    assert_eq!(
        lease_gate(&mut l, &mut d, 2, 1, LeaseState::Unreachable),
        LeaseGate::Run
    );
    assert!(d.fails.is_empty());
    for s in [LeaseState::Ready, LeaseState::Declined] {
        assert_eq!(lease_gate(&mut l, &mut d, 2, 1, s), LeaseGate::Run);
    }
}
