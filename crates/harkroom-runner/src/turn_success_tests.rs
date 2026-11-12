use serde_json::{Value, json};

use super::*;

fn msg(seq: i64, author: &str, kind: &str, meta: Value) -> Value {
    json!({ "id": format!("m{seq}"), "seq": seq, "authorId": author, "kind": kind, "meta": meta })
}

fn reply(seq: i64) -> Value {
    msg(seq, "me", "user", json!({ "turnId": "t1" }))
}

fn wake(seq: i64) -> Value {
    msg(seq, "me", "wake", json!({ "turnId": "t1", "kind": "wake" }))
}

fn report(seq: i64) -> Value {
    msg(
        seq,
        "me",
        "user",
        json!({ "turnId": "t1", "kind": "report" }),
    )
}

fn plan(after: &[Value], cut: Option<usize>, target: SuccessTarget) -> AfterTurnPlan {
    after_turn_plan(after, "me", 10, Some("t1"), cut, target)
}

// 정본 prompt.test.ts 「hasOwnReportSince 는 이 턴의 내 끝 보고(meta.kind report)만 센다」
#[test]
fn report_since_counts_only_own_report_of_this_turn() {
    let msgs = vec![
        msg(5, "me", "user", json!({ "kind": "report" })),
        msg(11, "peer", "user", json!({ "kind": "report" })),
        msg(12, "me", "user", json!({})),
    ];
    assert!(!has_own_report_since(&msgs, "me", 10, None));
    let mut with = msgs.clone();
    with.push(msg(
        13,
        "me",
        "user",
        json!({ "kind": "report", "turnId": "t1" }),
    ));
    assert!(has_own_report_since(&with, "me", 10, Some("t1")));
    assert!(!has_own_report_since(&with, "me", 10, Some("t2")));
}

#[test]
fn delegation_open_until_report_failure_ask_or_wake() {
    assert!(delegation_left_open(&[reply(11)], "me", 10, Some("t1")));
    for k in ["report", "failure", "ask"] {
        let m = msg(12, "me", "user", json!({ "turnId": "t1", "kind": k }));
        assert!(
            !delegation_left_open(&[reply(11), m], "me", 10, Some("t1")),
            "{k}"
        );
    }
    assert!(!delegation_left_open(
        &[reply(11), wake(12)],
        "me",
        10,
        Some("t1")
    ));
    // 다른 턴의 끝 보고는 이 턴의 위임을 닫지 않는다.
    let other = msg(
        12,
        "me",
        "user",
        json!({ "turnId": "t2", "kind": "report" }),
    );
    assert!(delegation_left_open(
        &[reply(11), other],
        "me",
        10,
        Some("t1")
    ));
    // 턴 시작 전 보고도 세지 않는다.
    let old = msg(9, "me", "user", json!({ "turnId": "t1", "kind": "report" }));
    assert!(delegation_left_open(
        &[old, reply(11)],
        "me",
        10,
        Some("t1")
    ));
}

#[test]
fn watch_missed_notice_carries_reason_only_when_given() {
    assert_eq!(
        watch_missed_notice("CI 확인"),
        "감시 예약으로 깨어난 턴이 다음 예약도 끝 보고도 없이 끝났다 — 감시가 여기서 멈췄다.\n이어서 볼 거면 다시 부르거나 예약을 걸어라 (사유: CI 확인)."
    );
    assert!(watch_missed_notice("").ends_with("예약을 걸어라."));
}

#[test]
fn background_cut_wins_even_with_posts() {
    let p = plan(&[reply(11)], Some(2), SuccessTarget::default());
    assert_eq!(p.silent, SilentPath::BackgroundCut { count: 2 });
    assert_eq!(p.post_count, 1);
}

#[test]
fn silent_turn_when_no_post_and_no_wake() {
    let p = plan(&[], None, SuccessTarget::default());
    assert_eq!(p.silent, SilentPath::SilentTurn);
    // progress 만 있는 턴도 침묵이다(#144).
    let prog = msg(11, "me", "progress", json!({ "turnId": "t1" }));
    assert_eq!(
        plan(&[prog], None, SuccessTarget::default()).silent,
        SilentPath::SilentTurn
    );
    // 다른 턴의 글은 이 턴의 발화가 아니다.
    let other = msg(11, "me", "user", json!({ "turnId": "t2" }));
    assert_eq!(
        plan(&[other], None, SuccessTarget::default()).silent,
        SilentPath::SilentTurn
    );
}

#[test]
fn rewake_only_turn_acks_or_progresses_by_wake_kind() {
    let scheduled = SuccessTarget {
        wake: true,
        scheduled_wake: true,
        ..Default::default()
    };
    assert_eq!(
        plan(&[wake(11)], None, scheduled).silent,
        SilentPath::WakeAck
    );
    let card = SuccessTarget {
        wake: true,
        ..Default::default()
    };
    assert_eq!(
        plan(&[wake(11)], None, card).silent,
        SilentPath::WakeProgress
    );
    // 예약 턴이 아닌데 예약만 걸었다 — 대기 줄이 보이므로 남길 것이 없다.
    assert_eq!(
        plan(&[wake(11)], None, SuccessTarget::default()).silent,
        SilentPath::Nothing
    );
    // 발화했으면 아무 갈래도 아니다.
    assert_eq!(
        plan(&[reply(11)], None, scheduled).silent,
        SilentPath::Nothing
    );
}

#[test]
fn report_promise_checked_unless_rewaked() {
    let t = SuccessTarget {
        report_promise: true,
        ..Default::default()
    };
    assert!(plan(&[reply(11)], None, t).check_report_promise);
    assert!(!plan(&[reply(11), wake(12)], None, t).check_report_promise);
    assert!(!plan(&[reply(11)], None, SuccessTarget::default()).check_report_promise);
}

#[test]
fn watch_missed_unless_rewake_or_report() {
    let t = SuccessTarget {
        wake: true,
        scheduled_wake: true,
        watch: true,
        ..Default::default()
    };
    // 일반 답글은 끝 표식이 아니다.
    assert!(plan(&[reply(11)], None, t).watch_missed);
    assert!(!plan(&[wake(11)], None, t).watch_missed);
    assert!(!plan(&[report(11)], None, t).watch_missed);
    let not_watch = SuccessTarget {
        wake: true,
        scheduled_wake: true,
        ..Default::default()
    };
    assert!(!plan(&[reply(11)], None, not_watch).watch_missed);
}

#[test]
fn delegation_report_missed_only_with_posts_left_open() {
    let t = SuccessTarget {
        delegated_by: true,
        ..Default::default()
    };
    assert!(plan(&[reply(11)], None, t).delegation_report_missed);
    assert!(!plan(&[report(11)], None, t).delegation_report_missed);
    // 말 없이 끝난 턴은 침묵 경로가 이미 실패로 닫는다 — 여기서 두 번 남기지 않는다.
    let silent = plan(&[], None, t);
    assert_eq!(silent.silent, SilentPath::SilentTurn);
    assert!(!silent.delegation_report_missed);
    assert!(!plan(&[reply(11)], None, SuccessTarget::default()).delegation_report_missed);
}
