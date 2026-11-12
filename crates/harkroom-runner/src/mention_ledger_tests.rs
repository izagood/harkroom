//! 정본 `test/mentionScheduler.test.ts` 의 장부 판정 대조(관문 순서·묶음·회계).

use super::*;
use serde_json::json;

fn none() -> HashSet<i64> {
    HashSet::new()
}

fn no_attention(_: &str) -> bool {
    false
}

fn human_ctx() -> BatchContext {
    let mut ctx = BatchContext::default();
    ctx.human_ids.insert("u1".into());
    ctx
}

fn msg(id: &str, author: &str, root: Option<&str>, body: &str) -> Value {
    json!({ "id": id, "channelId": "c", "threadRootId": root, "authorId": author, "kind": "user", "body": body })
}

fn ent(id: i64, mid: &str) -> Value {
    json!({ "id": id, "messageId": mid, "reason": "mention" })
}

#[test]
fn anchor_and_thread_key_follow_root_or_self() {
    let top = msg("m1", "u1", None, "x");
    let inner = msg("m2", "u1", Some("r"), "x");
    assert_eq!(mention_anchor(&top), "m1");
    assert_eq!(mention_anchor(&inner), "r");
    assert_eq!(mention_thread_key(&inner), "c/r");
    assert_eq!(thread_key("c", None), "c/_root");
}

#[test]
fn backoff_blocks_until_not_before() {
    let mut l = Ledger::default();
    let tried = l.start(&[1], "c/r");
    l.release(1, "c/r");
    assert!(l.retry_later(1, tried, 1_000));
    assert_eq!(
        l.pre_gate(1, 1_000 + 29_999, &none(), &mut no_attention),
        PreGate::Blocked
    );
    assert_eq!(
        l.pre_gate(1, 1_000 + 30_000, &none(), &mut no_attention),
        PreGate::Proceed
    );
    // 재시도 통지는 entry 당 1회.
    let tried = l.start(&[1], "c/r");
    assert_eq!(tried, 2);
    l.release(1, "c/r");
    assert!(!l.retry_later(1, tried, 40_000));
    assert_eq!(l.attempt(1).unwrap().not_before, 40_000 + 60_000);
}

#[test]
fn done_unread_and_recently_done_gates() {
    let mut l = Ledger::new(&[7], 0);
    assert_eq!(l.done_entries(), vec![7]);
    assert_eq!(
        l.pre_gate(7, 1, &none(), &mut no_attention),
        PreGate::DoneAgain
    );
    l.mark_read_result(&[7], true, 5);
    assert!(l.done_entries().is_empty());
    assert_eq!(l.pre_gate(7, 6, &none(), &mut no_attention), PreGate::Skip);
    l.prune(5 + RECENTLY_DONE_MS + 1);
    assert_eq!(
        l.pre_gate(7, 5 + RECENTLY_DONE_MS + 1, &none(), &mut no_attention),
        PreGate::Proceed
    );
}

#[test]
fn mark_read_failure_keeps_first_time_and_prunes_after_24h() {
    let mut l = Ledger::default();
    l.mark_read_result(&[3, 4], false, 10);
    l.mark_read_result(&[3], false, 99);
    assert_eq!(l.done_entries(), vec![3, 4]);
    l.prune(10 + DONE_UNREAD_MAX_MS);
    assert_eq!(l.done_entries(), vec![3, 4]);
    l.prune(10 + DONE_UNREAD_MAX_MS + 1);
    assert!(l.done_entries().is_empty());
}

#[test]
fn in_flight_and_handover_hold_block() {
    let mut l = Ledger::default();
    l.start(&[1], "c/r");
    assert!(l.thread_in_flight("c/r"));
    assert_eq!(
        l.pre_gate(1, 0, &none(), &mut no_attention),
        PreGate::Blocked
    );
    assert_eq!(l.holding_entries(), vec![1]);
    l.release(1, "c/r");
    assert!(!l.thread_in_flight("c/r"));
    let held: HashSet<i64> = [1].into();
    assert_eq!(l.pre_gate(1, 0, &held, &mut no_attention), PreGate::Blocked);
}

#[test]
fn gate_wait_blocks_while_marked_then_expires_to_mark_read() {
    let mut l = Ledger::default();
    let tried = l.start(&[1], "c/r");
    assert_eq!(
        l.gate_requeue(1, tried, Some("/cfg/a"), 100),
        GateRequeueOutcome::Requeue { count: 1 }
    );
    l.release(1, "c/r");
    // 회계는 이번 시도를 세지 않는다.
    assert_eq!(l.attempt(1).unwrap().tried, 0);
    let mut seen = Vec::new();
    let mut active = |d: &str| {
        seen.push(d.to_string());
        true
    };
    assert_eq!(l.pre_gate(1, 200, &none(), &mut active), PreGate::Blocked);
    assert_eq!(seen, vec!["/cfg/a".to_string()]);
    assert_eq!(
        l.pre_gate(1, 300, &none(), &mut no_attention),
        PreGate::Proceed
    );
    assert!(l.gate_wait(1).is_none());

    let mut l = Ledger::default();
    let tried = l.start(&[2], "c/r");
    l.gate_requeue(2, tried, Some("/cfg/a"), 0);
    l.release(2, "c/r");
    assert_eq!(
        l.pre_gate(2, GATE_WAIT_MAX_MS + 1, &none(), &mut |_| true),
        PreGate::MarkRead
    );
    assert!(l.attempt(2).is_none());
}

#[test]
fn gate_requeue_gives_up_after_cap() {
    let mut l = Ledger::default();
    for n in 1..=GATE_REQUEUE_MAX {
        let tried = l.start(&[1], "k");
        assert_eq!(
            l.gate_requeue(1, tried, None, 0),
            GateRequeueOutcome::Requeue { count: n }
        );
        l.release(1, "k");
    }
    let tried = l.start(&[1], "k");
    assert_eq!(
        l.gate_requeue(1, tried, None, 0),
        GateRequeueOutcome::GiveUp {
            count: GATE_REQUEUE_MAX + 1
        }
    );
    assert!(l.gate_requeue(1, 1, None, 0) == GateRequeueOutcome::Requeue { count: 1 });
}

#[test]
fn lease_wait_retries_quietly_until_cap() {
    let mut l = Ledger::default();
    let tried = l.start(&[1], "k");
    assert!(l.lease_wait(1, tried, 0));
    let a = l.attempt(1).unwrap();
    assert_eq!((a.tried, a.not_before), (0, LEASE_RETRY_MS));
    assert!(l.lease_wait(1, 1, LEASE_WAIT_MAX_MS - 1));
    assert!(!l.lease_wait(1, 1, LEASE_WAIT_MAX_MS));
    // 상한 뒤엔 새로 센다.
    assert!(l.lease_wait(1, 1, LEASE_WAIT_MAX_MS + 1));
}

#[test]
fn blocked_notice_once_per_entry_and_forgotten_on_start() {
    let mut l = Ledger::default();
    assert!(l.note_blocked(5));
    assert!(!l.note_blocked(5));
    l.start(&[5], "k");
    l.release(5, "k");
    assert!(l.note_blocked(5));
    for id in 100..(100 + BLOCKED_NOTICED_MAX as i64) {
        l.note_blocked(id);
    }
    // 가장 오래된 5 가 밀려났다.
    assert!(l.note_blocked(5));
}

#[test]
fn bundle_groups_same_author_same_thread_plain_mentions() {
    let batch = json!({
        "entries": [ent(1, "a"), ent(2, "b"), ent(3, "c"), ent(4, "d"), ent(5, "e")],
        "messages": [
            msg("a", "u1", Some("r"), "one"),
            msg("b", "u1", Some("r"), "two"),
            msg("c", "u2", Some("r"), "other author"),
            msg("d", "u1", Some("s"), "other thread"),
            msg("e", "u1", Some("r"), "three"),
        ],
    });
    let l = Ledger::default();
    assert_eq!(
        l.bundle_for(&batch, 0, &human_ctx(), 0, &none()),
        vec![0, 1, 4]
    );
    // 사람으로 확인되지 않은 글쓴이(원인 키 없음)는 묶지 않는다.
    assert_eq!(
        l.bundle_for(&batch, 0, &BatchContext::default(), 0, &none()),
        vec![0]
    );
    // 이관 보류 중인 것은 빠진다.
    let held: HashSet<i64> = [2].into();
    assert_eq!(l.bundle_for(&batch, 0, &human_ctx(), 0, &held), vec![0, 4]);
}

#[test]
fn bundle_respects_cause_key_and_char_cap() {
    let mut e2 = ent(2, "b");
    e2["causeKey"] = json!("k1");
    let mut e1 = ent(1, "a");
    e1["causeKey"] = json!("k1");
    let big = "x".repeat(BUNDLE_MAX_CHARS);
    let batch = json!({
        "entries": [e1, e2, ent(3, "c")],
        "messages": [
            msg("a", "agent", Some("r"), "one"),
            msg("b", "agent", Some("r"), "two"),
            msg("c", "agent", Some("r"), "no key"),
        ],
    });
    let l = Ledger::default();
    // 한쪽만 키가 있으면 묶지 않는다.
    assert_eq!(
        l.bundle_for(&batch, 0, &human_ctx(), 0, &none()),
        vec![0, 1]
    );

    let batch = json!({
        "entries": [ent(1, "a"), ent(2, "b")],
        "messages": [msg("a", "u1", Some("r"), "1"), msg("b", "u1", Some("r"), &big)],
    });
    assert_eq!(l.bundle_for(&batch, 0, &human_ctx(), 0, &none()), vec![0]);
}

#[test]
fn bundle_skips_entries_with_repeated_failures() {
    let batch = json!({
        "entries": [ent(1, "a"), ent(2, "b")],
        "messages": [msg("a", "u1", Some("r"), "1"), msg("b", "u1", Some("r"), "2")],
    });
    let mut l = Ledger::default();
    for _ in 0..BUNDLE_MAX_FAILURES {
        let t = l.start(&[1], "c/r");
        l.release(1, "c/r");
        l.retry_later(1, t, 0);
    }
    assert_eq!(
        l.bundle_for(&batch, 0, &human_ctx(), 1_000_000, &none()),
        vec![0]
    );
}

#[test]
fn start_takes_max_tried_and_shares_outcome_with_members() {
    let mut l = Ledger::default();
    let t = l.start(&[1], "k");
    l.release(1, "k");
    l.retry_later(1, t, 0);
    l.gate_requeue(2, 0, None, 0);
    l.gate_requeue(2, 0, None, 0);
    let tried = l.start(&[1, 2, 3], "k");
    assert_eq!(tried, 2);
    assert!(l.attempt(1).is_none());
    assert_eq!(l.gate_requeue_of(3).unwrap().count, 2);
    assert_eq!(l.finish_ids(3), vec![1, 2, 3]);
    assert_eq!(l.holding_entries(), vec![1, 2, 3]);
    l.release(3, "k");
    assert!(l.holding_entries().is_empty());
    // 대표의 회계를 구성원이 같이 진다.
    assert_eq!(l.attempt(1).unwrap().tried, 2);
    assert_eq!(l.attempt(2).unwrap().tried, 2);
    assert_eq!(l.finish_ids(3), vec![3]);
}

#[test]
fn settle_clears_accounts() {
    let mut l = Ledger::default();
    let t = l.start(&[1], "k");
    l.gate_requeue(1, t, None, 0);
    l.settle(1);
    assert!(l.attempt(1).is_none());
    assert!(l.gate_requeue_of(1).is_none());
}
