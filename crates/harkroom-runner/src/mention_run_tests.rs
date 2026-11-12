//! 정본 `test/mentionScheduler.test.ts` 의 runOne 조립 대조(임대 판정·계정 축·표식·관문·펜싱·정리 순서).

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use super::*;
use crate::account_failover::{AccountFailureKind, FailureOf};
use crate::mention_admit::ThreadClaimHandle;
use crate::mention_settle::{FailBody, FailNotice};
use serde_json::json;

#[derive(Clone, Debug, PartialEq)]
enum Err {
    Quota,
    Credential,
    Waiting,
    Gate,
    Other(&'static str),
}

impl AccountFailureClass for Err {
    fn account_failure(&self) -> Option<FailureOf> {
        let kind = match self {
            Err::Quota => AccountFailureKind::Quota,
            Err::Credential => AccountFailureKind::Credential,
            Err::Waiting => AccountFailureKind::Gate,
            _ => return None,
        };
        Some(FailureOf {
            kind,
            resets_at: None,
        })
    }
}

impl TurnError for Err {
    fn attempt_end(&self) -> AttemptEnd {
        match self {
            Err::Waiting => AttemptEnd::Waiting,
            Err::Credential => AttemptEnd::Credential,
            _ => AttemptEnd::OtherErr,
        }
    }
    fn harness_api_error(&self) -> bool {
        matches!(self, Err::Quota)
    }
    fn is_gate_requeue(&self) -> bool {
        matches!(self, Err::Gate)
    }
    fn into_turn_end(self) -> TurnEnd {
        match self {
            Err::Quota => TurnEnd::Quota {
                resets_at: None,
                api_line: None,
            },
            Err::Gate => TurnEnd::GateRequeue {
                why: "passed".into(),
                queued_config_dir: None,
            },
            Err::Credential => TurnEnd::Other {
                err_text: "credential".into(),
            },
            Err::Waiting => TurnEnd::Other {
                err_text: "waiting".into(),
            },
            Err::Other(t) => TurnEnd::Other { err_text: t.into() },
        }
    }
}

/// 계정마다 낼 결과(차례대로)와 입력창 도달 여부.
struct Turn {
    script: Vec<(Result<TurnOk, Err>, bool)>,
    seen: Vec<(Option<String>, bool)>,
    targets: Vec<String>,
}

impl TurnAttempt for Turn {
    type Err = Err;
    fn run(
        &mut self,
        target: &MentionTarget,
        account: Option<&ClaudeAccount>,
        is_last_account: bool,
        delivered: &mut bool,
    ) -> Result<TurnOk, Err> {
        self.seen
            .push((account.map(|a| a.name.clone()), is_last_account));
        self.targets.push(target.mention_id.clone());
        let (out, d) = self.script.remove(0);
        *delivered = d;
        out
    }
}

fn turn(script: Vec<(Result<TurnOk, Err>, bool)>) -> Turn {
    Turn {
        script,
        seen: vec![],
        targets: vec![],
    }
}

#[derive(Default)]
struct Fake {
    lane: Vec<Option<ClaudeAccount>>,
    lease: Option<LeaseState>,
    fails: Vec<FailNotice>,
    read: Vec<Vec<i64>>,
    lease_released: u32,
    fenced_notices: u32,
    outcomes: Vec<bool>,
    stops: Vec<String>,
    logs: Vec<String>,
    marks: Vec<(String, &'static str, Mark)>,
    trails: Vec<Vec<AccountFailure>>,
    before_fail: Vec<Err>,
    slots: Vec<String>,
    ended: Vec<(String, String)>,
    /// 일어난 순서(정리 순서 확인용).
    order: Vec<&'static str>,
}

impl SettleDeps for Fake {
    fn now(&self) -> u64 {
        1_000
    }
    fn fail(&mut self, notice: &FailNotice) -> Result<(), String> {
        self.order.push("fail");
        self.fails.push(notice.clone());
        Ok(())
    }
    fn mark_read(&mut self, ids: &[i64]) -> Result<(), String> {
        self.read.push(ids.to_vec());
        Ok(())
    }
    fn release_lease(&mut self) {
        self.lease_released += 1;
    }
    fn notice_fenced(&mut self) {
        self.fenced_notices += 1;
    }
    fn turn_outcome(&mut self, ok: bool) {
        self.outcomes.push(ok);
    }
    fn stop_requested(&mut self, at: &str) {
        self.stops.push(at.into());
    }
    fn log(&mut self, line: &str) {
        self.logs.push(line.into());
    }
}

impl RunDeps<Err> for Fake {
    fn lane(&mut self, _thread_key: &str, _anchor: &str) -> Vec<Option<ClaudeAccount>> {
        self.lane.clone()
    }
    fn acquire_lease(&mut self, _mention_id: &str) -> LeaseState {
        self.lease.unwrap_or(LeaseState::Ready)
    }
    fn attention(&mut self, account: &ClaudeAccount, mark: Mark) {
        self.marks.push((account.name.clone(), "attention", mark));
    }
    fn auth(&mut self, account: &ClaudeAccount, mark: Mark) {
        self.marks.push((account.name.clone(), "auth", mark));
    }
    fn account_trail(&mut self, trail: &[AccountFailure]) {
        self.trails.push(trail.to_vec());
    }
    fn before_fail(&mut self, err: &Err, _mention_id: &str) {
        self.order.push("before_fail");
        self.before_fail.push(err.clone());
    }
    fn release_slot(&mut self, thread_key: &str) {
        self.order.push("slot");
        self.slots.push(thread_key.into());
    }
    fn turn_ended(&mut self, thread_key: &str, mention_id: &str) {
        self.order.push("ended");
        self.ended.push((thread_key.into(), mention_id.into()));
    }
}

struct Claim {
    released: Arc<AtomicUsize>,
    lost: Arc<AtomicBool>,
}
impl ThreadClaimHandle for Claim {
    fn release(&self) {
        self.released.fetch_add(1, Ordering::SeqCst);
    }
    fn fenced(&self) -> bool {
        self.lost.load(Ordering::SeqCst)
    }
}

fn acc(name: &str) -> Option<ClaudeAccount> {
    Some(ClaudeAccount {
        name: name.into(),
        config_dir: PathBuf::from(format!("/pool/{name}")),
        pool: None,
    })
}

struct Setup {
    ledger: Mutex<Ledger>,
    launch: Launch,
    released: Arc<AtomicUsize>,
    lost: Arc<AtomicBool>,
}

fn setup() -> Setup {
    let mut l = Ledger::new(&[], 0);
    let tried = l.start(&[7], "c:t");
    let released = Arc::new(AtomicUsize::new(0));
    let lost = Arc::new(AtomicBool::new(false));
    let launch = Launch {
        lead_entry: json!({ "id": 7, "reason": "mention", "messageId": "m7" }),
        lead_mention: json!({ "id": "m7", "channelId": "c" }),
        bundled: vec![],
        anchor: "t".into(),
        thread_key: "c:t".into(),
        tried,
        claim: Some(Box::new(Claim {
            released: released.clone(),
            lost: lost.clone(),
        })),
        slot_held: true,
    };
    Setup {
        ledger: Mutex::new(l),
        launch,
        released,
        lost,
    }
}

fn ok(stop: Option<&str>) -> Result<TurnOk, Err> {
    Ok(TurnOk {
        stop_requested_at: stop.map(str::to_string),
    })
}

#[test]
fn success_reads_marks_and_releases_everything() {
    let s = setup();
    let mut d = Fake {
        lane: vec![acc("a")],
        ..Fake::default()
    };
    let mut t = turn(vec![(ok(Some("2026-11-12T06:00:00Z")), true)]);
    run_one(&s.ledger, &mut d, &mut t, s.launch);
    assert_eq!(t.seen, vec![(Some("a".into()), true)]);
    assert_eq!(t.targets, vec!["m7".to_string()]);
    assert_eq!(d.read, vec![vec![7]]);
    assert_eq!(d.outcomes, vec![true]);
    assert_eq!(d.stops, vec!["2026-11-12T06:00:00Z".to_string()]);
    assert_eq!(d.lease_released, 1);
    assert_eq!(
        d.marks,
        vec![
            ("a".into(), "attention", Mark::Clear),
            ("a".into(), "auth", Mark::Clear)
        ]
    );
    assert!(d.before_fail.is_empty() && d.fails.is_empty());
    assert_eq!(s.released.load(Ordering::SeqCst), 1);
    assert_eq!(d.slots, vec!["c:t".to_string()]);
    assert_eq!(d.ended, vec![("c:t".into(), "m7".into())]);
    // 장부 finally: 스레드가 비었다.
    assert!(!s.ledger.lock().unwrap().thread_in_flight("c:t"));
}

#[test]
fn not_delivered_success_keeps_attention() {
    let s = setup();
    let mut d = Fake {
        lane: vec![acc("a")],
        ..Fake::default()
    };
    run_one(
        &s.ledger,
        &mut d,
        &mut turn(vec![(ok(None), false)]),
        s.launch,
    );
    assert_eq!(d.marks, vec![("a".into(), "auth", Mark::Clear)]);
}

#[test]
fn failover_moves_to_next_account_and_logs_kind_only() {
    let s = setup();
    let mut d = Fake {
        lane: vec![acc("a"), acc("b")],
        ..Fake::default()
    };
    let mut t = turn(vec![(Err(Err::Credential), false), (ok(None), true)]);
    run_one(&s.ledger, &mut d, &mut t, s.launch);
    assert_eq!(
        t.seen,
        vec![(Some("a".into()), false), (Some("b".into()), true)]
    );
    assert!(d.marks.contains(&("a".into(), "auth", Mark::Set)));
    assert!(d.marks.contains(&("b".into(), "auth", Mark::Clear)));
    assert!(
        d.logs
            .iter()
            .any(|l| l == "  m7 계정 전환: a → b (이유: credential)")
    );
    assert_eq!(d.read, vec![vec![7]]);
    assert!(d.before_fail.is_empty());
}

#[test]
fn exhausted_lane_runs_before_fail_then_trail_then_fail_notice() {
    let s = setup();
    let mut d = Fake {
        lane: vec![acc("a"), acc("b")],
        ..Fake::default()
    };
    let mut t = turn(vec![(Err(Err::Quota), true), (Err(Err::Quota), true)]);
    run_one(&s.ledger, &mut d, &mut t, s.launch);
    assert_eq!(d.before_fail, vec![Err::Quota]);
    assert_eq!(d.trails.len(), 1);
    assert_eq!(
        d.trails[0]
            .iter()
            .map(|f| (f.account.clone(), f.kind))
            .collect::<Vec<_>>(),
        vec![
            (Some("a".into()), AccountFailureKind::Quota),
            (Some("b".into()), AccountFailureKind::Quota)
        ]
    );
    assert!(
        d.logs
            .iter()
            .any(|l| l == "  m7 계정 축 소진: a=quota, b=quota")
    );
    assert_eq!(d.fails.len(), 1);
    assert!(matches!(d.fails[0].body, FailBody::Quota { .. }));
    // 물러남 판정은 통지보다 먼저, 정리는 그 뒤.
    assert_eq!(d.order, vec!["before_fail", "fail", "slot", "ended"]);
    assert_eq!(d.outcomes, vec![false]);
    assert_eq!(d.read, vec![vec![7]]);
    assert_eq!(s.released.load(Ordering::SeqCst), 1);
}

#[test]
fn waiting_sets_attention_and_other_error_after_delivery_clears_it() {
    let s = setup();
    let mut d = Fake {
        lane: vec![acc("a"), acc("b")],
        ..Fake::default()
    };
    let mut t = turn(vec![
        (Err(Err::Waiting), false),
        (Err(Err::Other("boom")), true),
    ]);
    run_one(&s.ledger, &mut d, &mut t, s.launch);
    assert_eq!(
        d.marks,
        vec![
            ("a".into(), "attention", Mark::Set),
            ("b".into(), "attention", Mark::Clear)
        ]
    );
    // 계정 축을 넘긴 흔적은 남고, 재시도 갈래(그 밖)로 간다 — 읽음 없음.
    assert_eq!(d.before_fail, vec![Err::Other("boom")]);
    assert_eq!(d.trails[0].len(), 1);
    assert!(d.read.is_empty());
    assert!(matches!(d.fails[0].body, FailBody::Retry { tried: 1, .. }));
}

#[test]
fn gate_requeue_skips_before_fail_and_trail() {
    let s = setup();
    let mut d = Fake {
        lane: vec![acc("a")],
        ..Fake::default()
    };
    run_one(
        &s.ledger,
        &mut d,
        &mut turn(vec![(Err(Err::Gate), false)]),
        s.launch,
    );
    assert!(d.before_fail.is_empty() && d.trails.is_empty() && d.fails.is_empty());
    assert!(d.read.is_empty());
    assert_eq!(d.lease_released, 1);
    assert!(
        d.logs
            .iter()
            .any(|l| l.contains("계정 관문 — 턴을 접고 다시 띄운다"))
    );
    assert_eq!(s.released.load(Ordering::SeqCst), 1);
}

#[test]
fn fenced_claim_folds_without_failure_path() {
    let s = setup();
    s.lost.store(true, Ordering::SeqCst);
    let mut d = Fake {
        lane: vec![acc("a")],
        ..Fake::default()
    };
    run_one(
        &s.ledger,
        &mut d,
        &mut turn(vec![(Err(Err::Other("sigterm")), true)]),
        s.launch,
    );
    assert!(d.before_fail.is_empty() && d.fails.is_empty() && d.read.is_empty());
    assert_eq!(d.fenced_notices, 1);
    assert_eq!(s.released.load(Ordering::SeqCst), 1);
}

#[test]
fn deferred_lease_skips_turn_but_still_releases_holds() {
    let s = setup();
    let mut d = Fake {
        lane: vec![acc("a")],
        lease: Some(LeaseState::LeaseUsed),
        ..Fake::default()
    };
    let mut t = turn(vec![]);
    run_one(&s.ledger, &mut d, &mut t, s.launch);
    assert!(t.seen.is_empty());
    assert!(d.fails.is_empty() && d.read.is_empty());
    assert_eq!(d.slots, vec!["c:t".to_string()]);
    assert_eq!(d.ended.len(), 1);
    assert_eq!(s.released.load(Ordering::SeqCst), 1);
    assert!(!s.ledger.lock().unwrap().thread_in_flight("c:t"));
}

#[test]
fn rootless_runner_has_no_marks() {
    let s = setup();
    let mut d = Fake {
        lane: vec![None],
        ..Fake::default()
    };
    let mut t = turn(vec![(Err(Err::Credential), false)]);
    run_one(&s.ledger, &mut d, &mut t, s.launch);
    assert!(d.marks.is_empty());
    // 계정이 하나뿐이면 흔적 없이(그 오류 자신이 이유다).
    assert_eq!(d.trails, vec![Vec::<AccountFailure>::new()]);
}

#[test]
fn empty_lane_is_an_ordinary_failure_not_a_success() {
    let s = setup();
    let mut d = Fake::default();
    let mut t = turn(vec![]);
    run_one(&s.ledger, &mut d, &mut t, s.launch);
    assert!(t.seen.is_empty());
    assert!(d.outcomes.is_empty());
    assert!(matches!(d.fails[0].body, FailBody::Retry { .. }));
}
