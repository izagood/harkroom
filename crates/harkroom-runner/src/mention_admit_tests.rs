//! 정본 `test/mentionScheduler.test.ts` 의 admit 판정 대조(유예·스레드·임대·자리·묶음·고아).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use serde_json::json;

struct Claim(Arc<AtomicUsize>);
impl ThreadClaimHandle for Claim {
    fn release(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct Fake {
    now: u64,
    held: HashSet<i64>,
    controlled: HashMap<String, Option<String>>,
    defer_result: Option<DeferResult>,
    warned: Vec<String>,
    busy: HashSet<String>,
    reserved: Vec<String>,
    notices: Vec<(String, AdmitNotice)>,
    fails: Vec<String>,
    claims: Option<ClaimMode>,
    claim_releases: Arc<AtomicUsize>,
    slot: Option<SlotOutcome>,
    slot_releases: Vec<String>,
    started: Vec<String>,
    read: Vec<Vec<i64>>,
    read_fails: bool,
    launches: Rc<RefCell<Vec<Launched>>>,
}

/// (대표 id, 시도, 묶인 수, 임대 쥠, 자리 쥠)
type Launched = (i64, u32, usize, bool, bool);

#[derive(Clone, Copy)]
enum ClaimMode {
    Busy,
    Grant,
}

impl AdmitDeps for Fake {
    fn now(&self) -> u64 {
        self.now
    }
    fn held_entry_ids(&self) -> HashSet<i64> {
        self.held.clone()
    }
    fn attention_active(&mut self, _: &str) -> bool {
        false
    }
    fn control_of(&self, key: &str) -> Option<ThreadControl> {
        self.controlled.get(key).map(|h| ThreadControl {
            opened_by_handle: h.clone(),
        })
    }
    fn defer(&mut self, _: &str, _: i64, _: i64, _: u64) -> DeferResult {
        self.defer_result.clone().expect("defer result")
    }
    fn mark_warned(&mut self, key: &str) {
        self.warned.push(key.into());
    }
    fn registry_busy(&self, key: &str) -> bool {
        self.busy.contains(key)
    }
    fn reserve_mention(&mut self, key: &str) {
        self.reserved.push(key.into());
    }
    fn notice(&mut self, _: &str, anchor: &str, n: &AdmitNotice) -> Result<(), String> {
        self.notices.push((anchor.into(), n.clone()));
        Ok(())
    }
    fn fail(&mut self, _: &str, _: &str, body: &str, _: &str, _: &str) -> Result<(), String> {
        self.fails.push(body.into());
        Err("down".into())
    }
    fn hold_claim(&mut self, _: &str, _: &str) -> ClaimHold {
        match self.claims {
            None => ClaimHold::NotConfigured,
            Some(ClaimMode::Busy) => ClaimHold::Busy,
            Some(ClaimMode::Grant) => ClaimHold::Held(Box::new(Claim(self.claim_releases.clone()))),
        }
    }
    fn acquire_slot(&mut self, _: &str) -> Option<SlotOutcome> {
        self.slot
    }
    fn release_slot(&mut self, key: &str) {
        self.slot_releases.push(key.into());
    }
    fn turn_started(&mut self, key: &str, _: &str) {
        self.started.push(key.into());
    }
    fn mark_read(&mut self, ids: &[i64]) -> Result<(), String> {
        self.read.push(ids.to_vec());
        if self.read_fails {
            Err("timeout".into())
        } else {
            Ok(())
        }
    }
    fn launch(&mut self, l: Launch) {
        self.launches.borrow_mut().push((
            l.lead_id(),
            l.tried,
            l.bundled.len(),
            l.claim.is_some(),
            l.slot_held,
        ));
    }
}

fn human_ctx() -> BatchContext {
    let mut ctx = BatchContext::default();
    ctx.human_ids.insert("u1".into());
    ctx.agent_ids.insert("a1".into());
    ctx
}

fn msg(id: &str, author: &str, root: &str) -> Value {
    json!({ "id": id, "seq": 7, "channelId": "c", "threadRootId": root, "authorId": author, "kind": "user", "body": "hi" })
}

fn batch(entries: Vec<Value>, messages: Vec<Value>) -> Value {
    json!({ "entries": entries, "messages": messages })
}

fn ent(id: i64, mid: &str) -> Value {
    json!({ "id": id, "messageId": mid, "reason": "mention" })
}

#[test]
fn starts_one_turn_and_registers_before_launch() {
    let mut l = Ledger::default();
    let mut f = Fake {
        now: 1_000,
        ..Fake::default()
    };
    let b = batch(vec![ent(1, "m1")], vec![msg("m1", "u1", "r")]);
    let out = admit(&mut l, &mut f, &b, &human_ctx()).unwrap();
    assert_eq!(
        out,
        AdmitOutcome {
            started: 1,
            deferred: 0,
            blocked: 0
        }
    );
    assert_eq!(f.reserved, vec!["c/r"]);
    assert_eq!(f.started, vec!["c/r"]);
    assert_eq!(*f.launches.borrow(), vec![(1, 1, 0, false, false)]);
    assert!(l.thread_in_flight("c/r"));
    assert_eq!(l.holding_entries(), vec![1]);
    // 같은 entry 가 묵은 배치로 다시 와도 도는 중이라 막힌다.
    let out = admit(&mut l, &mut f, &b, &human_ctx()).unwrap();
    assert_eq!(out.blocked, 1);
    assert_eq!(f.launches.borrow().len(), 1);
}

#[test]
fn orphan_is_marked_read_and_failure_surfaces() {
    let mut l = Ledger::default();
    let mut f = Fake::default();
    let b = batch(vec![ent(9, "gone")], vec![]);
    assert!(admit(&mut l, &mut f, &b, &human_ctx()).is_ok());
    assert_eq!(f.read, vec![vec![9]]);
    f.read_fails = true;
    assert_eq!(
        admit(&mut l, &mut f, &b, &human_ctx()),
        Err("timeout".into())
    );
}

#[test]
fn controlled_thread_defers_with_one_notice_and_warns_at_limit() {
    let mut l = Ledger::default();
    let mut f = Fake::default();
    f.controlled.insert("c/r".into(), Some("jae".into()));
    f.defer_result = Some(DeferResult {
        should_notify: true,
        pending: 3,
        held_ms: 0,
        warned: false,
    });
    let b = batch(vec![ent(1, "m1")], vec![msg("m1", "u1", "r")]);
    let out = admit(&mut l, &mut f, &b, &human_ctx()).unwrap();
    assert_eq!(
        out,
        AdmitOutcome {
            started: 0,
            deferred: 1,
            blocked: 0
        }
    );
    assert_eq!(
        f.notices,
        vec![(
            "r".into(),
            AdmitNotice::Controlled {
                handle: "jae".into(),
                pending: 3
            }
        )]
    );
    // 경고 발화가 실패해도 먼저 적었으므로 다시 시도하지 않는다.
    assert_eq!(f.warned, vec!["c/r"]);
    assert_eq!(f.fails.len(), 1);
    assert!(f.fails[0].starts_with("jae 의 조종이 1분째"));
    assert!(f.launches.borrow().is_empty());
    // 시도로 세지 않는다.
    assert!(l.attempt(1).is_none());
}

#[test]
fn control_without_handle_says_owner_and_no_warn_below_limit() {
    let mut l = Ledger::default();
    let mut f = Fake::default();
    f.controlled.insert("c/r".into(), None);
    f.defer_result = Some(DeferResult {
        should_notify: false,
        pending: 1,
        held_ms: DEFER_WARN_MS as i64 - 1,
        warned: false,
    });
    let b = batch(vec![ent(1, "m1")], vec![msg("m1", "u1", "r")]);
    admit(&mut l, &mut f, &b, &human_ctx()).unwrap();
    assert!(f.notices.is_empty());
    assert!(f.warned.is_empty());
    assert_eq!(
        control_held_notice("소유자", 2, 90_000).split(' ').next(),
        Some("소유자")
    );
    assert!(control_held_notice("x", 2, 90_000).contains("2분째"));
}

#[test]
fn busy_thread_notices_humans_once_but_not_agents() {
    let mut l = Ledger::default();
    let mut f = Fake::default();
    f.busy.insert("c/r".into());
    let b = batch(
        vec![ent(1, "m1"), ent(2, "m2")],
        vec![msg("m1", "u1", "r"), msg("m2", "a1", "r")],
    );
    let out = admit(&mut l, &mut f, &b, &human_ctx()).unwrap();
    assert_eq!(out.blocked, 2);
    assert_eq!(f.notices, vec![("r".into(), AdmitNotice::BlockedByTurn)]);
    admit(&mut l, &mut f, &b, &human_ctx()).unwrap();
    assert_eq!(f.notices.len(), 1);
    // 명단을 모르면 알리지 않는다.
    let mut l2 = Ledger::default();
    let mut f2 = Fake::default();
    f2.busy.insert("c/r".into());
    admit(&mut l2, &mut f2, &b, &BatchContext::default()).unwrap();
    assert!(f2.notices.is_empty());
}

#[test]
fn claim_busy_blocks_and_full_slot_releases_claim() {
    let mut l = Ledger::default();
    let mut f = Fake {
        claims: Some(ClaimMode::Busy),
        ..Fake::default()
    };
    let b = batch(vec![ent(1, "m1")], vec![msg("m1", "u1", "r")]);
    assert_eq!(admit(&mut l, &mut f, &b, &human_ctx()).unwrap().blocked, 1);
    f.claims = Some(ClaimMode::Grant);
    f.slot = Some(SlotOutcome::Full);
    assert_eq!(admit(&mut l, &mut f, &b, &human_ctx()).unwrap().blocked, 1);
    assert_eq!(f.claim_releases.load(Ordering::SeqCst), 1);
    assert!(l.attempt(1).is_none());
    f.slot = Some(SlotOutcome::Granted);
    assert_eq!(admit(&mut l, &mut f, &b, &human_ctx()).unwrap().started, 1);
    assert_eq!(*f.launches.borrow(), vec![(1, 1, 0, true, true)]);
}

#[test]
fn release_holds_frees_claim_slot_once() {
    let releases = Arc::new(AtomicUsize::new(0));
    let mut launch = Launch {
        lead_entry: ent(1, "m1"),
        lead_mention: msg("m1", "u1", "r"),
        bundled: vec![],
        anchor: "r".into(),
        thread_key: "c/r".into(),
        tried: 1,
        claim: Some(Box::new(Claim(releases.clone()))),
        slot_held: true,
    };
    let mut slots = Vec::new();
    let mut ended = Vec::new();
    launch.release_holds(&mut |k| slots.push(k.to_string()), &mut |k, m| {
        ended.push(format!("{k}:{m}"))
    });
    launch.release_holds(&mut |k| slots.push(k.to_string()), &mut |_, _| {});
    assert_eq!(releases.load(Ordering::SeqCst), 1);
    assert_eq!(slots, vec!["c/r"]);
    assert_eq!(ended, vec!["c/r:m1"]);
}

#[test]
fn same_human_mentions_bundle_into_newest_lead() {
    let mut l = Ledger::default();
    let mut f = Fake::default();
    let b = batch(
        vec![ent(1, "m1"), ent(2, "m2"), ent(3, "m3")],
        vec![
            msg("m1", "u1", "r"),
            msg("m2", "u1", "r"),
            msg("m3", "u1", "r"),
        ],
    );
    let out = admit(&mut l, &mut f, &b, &human_ctx()).unwrap();
    // 첫 entry 가 묶음을 띄우고, 나머지는 도는 중이라 막힌다.
    assert_eq!(
        out,
        AdmitOutcome {
            started: 1,
            deferred: 0,
            blocked: 2
        }
    );
    assert_eq!(*f.launches.borrow(), vec![(3, 1, 2, false, false)]);
    assert_eq!(l.finish_ids(3), vec![1, 2, 3]);
}

#[test]
fn held_by_previous_generation_is_not_mine() {
    let mut l = Ledger::default();
    let mut f = Fake::default();
    f.held.insert(1);
    let b = batch(vec![ent(1, "m1")], vec![msg("m1", "u1", "r")]);
    assert_eq!(admit(&mut l, &mut f, &b, &human_ctx()).unwrap().blocked, 1);
    assert!(f.launches.borrow().is_empty());
}

#[test]
fn done_unread_is_reread_without_turn() {
    let mut l = Ledger::new(&[5], 0);
    let mut f = Fake::default();
    let b = batch(vec![ent(5, "m5")], vec![msg("m5", "u1", "r")]);
    let out = admit(&mut l, &mut f, &b, &human_ctx()).unwrap();
    assert_eq!(out, AdmitOutcome::default());
    assert_eq!(f.read, vec![vec![5]]);
    assert!(l.done_entries().is_empty());
    // 읽음까지 끝났으니 다시 와도 아무것도 하지 않는다.
    admit(&mut l, &mut f, &b, &human_ctx()).unwrap();
    assert_eq!(f.read.len(), 1);
    assert!(f.launches.borrow().is_empty());
}
