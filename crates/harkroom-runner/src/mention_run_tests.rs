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
    /// 정리 때 멘션 자리가 열려 있었나(`run_mention` 시험).
    probe: Option<crate::turn_attempt_account::MentionSlots>,
    open_at_release: Vec<bool>,
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
        if let Some(p) = &self.probe {
            self.open_at_release.push(p.is_open("m7"));
        }
        self.order.push("slot");
        self.slots.push(thread_key.into());
    }
    fn turn_ended(&mut self, thread_key: &str, mention_id: &str) {
        if let Some(p) = &self.probe {
            self.open_at_release.push(p.is_open("m7"));
        }
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

// ---- run_mention: 멘션 자리를 첫 시도 전에 열고 끝까지 쥔다 ----

use crate::turn_attempt_account::{LiveSlot, MentionSlots};
use crate::turn_attempt_live::LiveTurn;

/// 시도마다 새 `LiveTurn` 을 자리에 걸고, 관문이 막으면 띄우지 않는 턴(실물 `PtyTurnAttempt` 의 흐름만).
struct SlotTurn {
    inner: Turn,
    slot: LiveSlot,
    slots: MentionSlots,
    open_at_attempt: Vec<bool>,
    /// 이 번째 시도가 끝난 뒤(다음 시도 전) [중단] 이 온다.
    cancel_after: Option<usize>,
    blocked: u32,
}

impl TurnAttempt for SlotTurn {
    type Err = Err;
    fn run(
        &mut self,
        target: &MentionTarget,
        account: Option<&ClaudeAccount>,
        is_last: bool,
        delivered: &mut bool,
    ) -> Result<TurnOk, Err> {
        self.open_at_attempt.push(self.slots.is_open("m7"));
        let live = Arc::new(LiveTurn::default());
        self.slot.bind(Some(Arc::clone(&live)));
        let out = if live.gate().is_err() {
            self.blocked += 1;
            self.inner
                .seen
                .push((account.map(|a| a.name.clone()), is_last));
            Err(Err::Other("blocked"))
        } else {
            self.inner.run(target, account, is_last, delivered)
        };
        self.slot.bind(None);
        if self.cancel_after == Some(self.inner.seen.len()) {
            assert!(!self.slot.is_bound(), "시도 사이 — 걸린 시도는 없다");
            assert!(self.slots.cancel("m7", "human-1"), "열린 멘션이라 받는다");
        }
        out
    }
}

/// security: `open` 은 첫 시도 전에, 자리는 `run_one` 의 정리(자리 놓기·감시 끝)까지 열려 있고, 끝나면 닫힌다.
#[test]
fn run_mention_opens_before_first_attempt_and_holds_through_release() {
    let s = setup();
    let slots = MentionSlots::default();
    let mut d = Fake {
        lane: vec![acc("a")],
        probe: Some(slots.clone()),
        ..Fake::default()
    };
    let mut open_at_make = false;
    run_mention(&s.ledger, &mut d, &slots, s.launch, |slot| {
        open_at_make = slots.is_open("m7");
        SlotTurn {
            inner: turn(vec![(ok(None), true)]),
            slot,
            slots: slots.clone(),
            open_at_attempt: vec![],
            cancel_after: None,
            blocked: 0,
        }
    });
    assert!(open_at_make, "턴을 만들기 전에 열렸다");
    assert_eq!(d.open_at_release, [true, true], "정리 때도 열려 있다");
    assert!(!slots.is_open("m7"), "끝나면 닫힌다");
    assert_eq!(d.order.last(), Some(&"ended"));
}

/// a1 한도 → a1 끝~a2 시작 사이 [중단] → a2 는 관문이 막아 띄우지 않고, 계정 축은 a3 로 가지 않는다 · 실패로 접힌다.
#[test]
fn run_mention_cancel_between_accounts_ends_axis() {
    let s = setup();
    let slots = MentionSlots::default();
    let mut d = Fake {
        lane: vec![acc("a1"), acc("a2"), acc("a3")],
        ..Fake::default()
    };
    let mut seen = vec![];
    let mut blocked = 0;
    let mut opens = vec![];
    run_mention(&s.ledger, &mut d, &slots, s.launch, |slot| {
        SlotTurn {
            inner: turn(vec![
                (Err(Err::Quota), false),
                (ok(None), true),
                (ok(None), true),
            ]),
            slot,
            slots: slots.clone(),
            open_at_attempt: vec![],
            cancel_after: Some(1),
            blocked: 0,
        }
        .into_probe(&mut seen, &mut blocked, &mut opens)
    });
    assert_eq!(
        seen,
        vec![(Some("a1".into()), false), (Some("a2".into()), false)],
        "a3 는 띄우지 않는다"
    );
    assert_eq!(blocked, 1);
    assert_eq!(opens, [true, true]);
    assert_eq!(d.fails.len(), 1, "막힌 시도의 실패로 접힌다");
    assert!(!slots.is_open("m7"));
}

/// 시험용 — `run_one` 이 끝나 턴이 떨어질 때 본 것을 밖으로 옮긴다.
struct Probe<'p> {
    t: SlotTurn,
    seen: &'p mut Vec<(Option<String>, bool)>,
    blocked: &'p mut u32,
    opens: &'p mut Vec<bool>,
}

impl SlotTurn {
    fn into_probe<'p>(
        self,
        seen: &'p mut Vec<(Option<String>, bool)>,
        blocked: &'p mut u32,
        opens: &'p mut Vec<bool>,
    ) -> Probe<'p> {
        Probe {
            t: self,
            seen,
            blocked,
            opens,
        }
    }
}

impl Drop for Probe<'_> {
    fn drop(&mut self) {
        *self.seen = self.t.inner.seen.clone();
        *self.blocked = self.t.blocked;
        *self.opens = self.t.open_at_attempt.clone();
    }
}

impl TurnAttempt for Probe<'_> {
    type Err = Err;
    fn run(
        &mut self,
        target: &MentionTarget,
        account: Option<&ClaudeAccount>,
        is_last: bool,
        delivered: &mut bool,
    ) -> Result<TurnOk, Err> {
        self.t.run(target, account, is_last, delivered)
    }
}

/// 멘션 하나를 도는 동안 [중단] 을 보내 본다 — `run` 이 받은 대상의 `mention_id`(= `run_mention` 이 연 id)와 갈고리.
struct CancelTurn {
    slot: LiveSlot,
    slots: MentionSlots,
    by_id: Vec<bool>,
    wrong_id: Vec<bool>,
    hooked: Vec<Option<String>>,
}

impl TurnAttempt for CancelTurn {
    type Err = Err;
    fn run(
        &mut self,
        target: &MentionTarget,
        _account: Option<&ClaudeAccount>,
        _is_last: bool,
        _delivered: &mut bool,
    ) -> Result<TurnOk, Err> {
        let live = Arc::new(LiveTurn::default());
        self.slot.bind(Some(Arc::clone(&live)));
        self.wrong_id.push(self.slots.cancel("m-other", "human-x"));
        self.by_id
            .push(self.slots.cancel(&target.mention_id, "human-1"));
        crate::turn_attempt_account::cancel_hook(&self.slot)("human-2");
        self.hooked.push(live.canceled_by());
        self.slot.bind(None);
        ok(None)
    }
}

/// security ①: [중단] 을 보내는 쪽이 쓰는 id(대상의 `mention_id`)가 `run_mention` 이 연 id 와 같다 — 그 id 로 보낸
/// [중단] 은 도는 시도에 닿고, 다른 id 는 버려진다. relay 갈고리는 슬롯을 직접 쥐어 id 를 거치지 않는다.
#[test]
fn cancel_by_target_mention_id_reaches_running_attempt() {
    let s = setup();
    let slots = MentionSlots::default();
    let mut d = Fake {
        lane: vec![acc("a")],
        ..Fake::default()
    };
    let mut got = (vec![], vec![], vec![]);
    struct Out<'o>(
        CancelTurn,
        &'o mut (Vec<bool>, Vec<bool>, Vec<Option<String>>),
    );
    impl Drop for Out<'_> {
        fn drop(&mut self) {
            *self.1 = (
                self.0.by_id.clone(),
                self.0.wrong_id.clone(),
                self.0.hooked.clone(),
            );
        }
    }
    impl TurnAttempt for Out<'_> {
        type Err = Err;
        fn run(
            &mut self,
            t: &MentionTarget,
            a: Option<&ClaudeAccount>,
            l: bool,
            d: &mut bool,
        ) -> Result<TurnOk, Err> {
            self.0.run(t, a, l, d)
        }
    }
    run_mention(&s.ledger, &mut d, &slots, s.launch, |slot| {
        Out(
            CancelTurn {
                slot,
                slots: slots.clone(),
                by_id: vec![],
                wrong_id: vec![],
                hooked: vec![],
            },
            &mut got,
        )
    });
    assert_eq!(got.0, [true], "대상 mention_id 로 보낸 [중단] 이 닿는다");
    assert_eq!(got.1, [false], "다른 id 는 버려진다");
    assert_eq!(
        got.2,
        [Some("human-1".to_string())],
        "처음 사람이 남는다(갈고리도 같은 시도에 닿음)"
    );
}
