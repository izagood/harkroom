use super::*;
use crate::core::msg_list::derive_plan;
use serde_json::json;

fn node(derived: &str) -> DerivedNode {
    DerivedNode {
        derived: derived.into(),
        waiting_on: vec![],
        started_early: false,
    }
}

fn plan() -> Value {
    json!({
        "goal": "g",
        "groups": [{"id": "g1", "title": "G1", "dependsOn": []}],
        "steps": [
            {"id": "s1", "title": "S1", "state": "active", "groupId": "g1",
             "links": [{"kind": "pr", "repo": "Izagood/Harkroom", "number": 7}]},
            {"id": "s2", "title": "S2", "state": "blocked", "blockedReason": "wait",
             "links": [{"kind": "card", "messageId": "AAAA"}]},
            {"id": "s3", "title": "S3", "state": "done",
             "links": [{"kind": "pr", "repo": "izagood/harkroom", "number": 7}]}
        ]
    })
}

#[test]
fn merged_pr_marks_done_case_insensitive() {
    let next = apply_merged_pr(&plan(), "izagood/harkroom", 7.0).unwrap();
    assert_eq!(next["steps"][0]["state"], "done");
    assert_eq!(next["steps"][0]["blockedReason"], Value::Null);
    // 이미 done 인 단계는 그대로(새 칸도 붙이지 않는다).
    assert_eq!(next["steps"][2], plan()["steps"][2]);
    assert!(apply_merged_pr(&plan(), "izagood/harkroom", 8.0).is_none());
    assert!(apply_merged_pr(&plan(), "other/repo", 7.0).is_none());
}

#[test]
fn answered_card_unblocks_only_blocked() {
    let next = apply_answered_card(&plan(), "aaaa").unwrap();
    assert_eq!(next["steps"][1]["state"], "active");
    assert_eq!(next["steps"][1]["blockedReason"], Value::Null);
    let mut p = plan();
    p["steps"][1]["state"] = json!("active");
    assert!(apply_answered_card(&p, "aaaa").is_none());
}

#[test]
fn ready_diff_ignores_new_nodes() {
    let before = vec![("a".into(), node("waiting")), ("b".into(), node("ready"))];
    let after = vec![
        ("a".into(), node("ready")),
        ("b".into(), node("ready")),
        ("c".into(), node("ready")),
    ];
    assert_eq!(ready_diff(&before, &after), vec!["a".to_string()]);
}

#[test]
fn hidden_cause_is_dropped() {
    let doc = json!({
        "groups": [
            {"id": "L", "title": "linked", "linkedRootId": "x"},
            {"id": "G", "title": "G", "dependsOn": ["L"]}
        ],
        "steps": [
            {"id": "s", "title": "s", "groupId": "G", "dependsOn": []},
            {"id": "t", "title": "t", "dependsOn": ["u"]}
        ]
    });
    let before = vec![("L".into(), node("hidden")), ("u".into(), node("done"))];
    let out = drop_hidden_caused(vec!["G".into(), "s".into(), "t".into()], &doc, &before);
    assert_eq!(out, vec!["t".to_string()]);
}

#[test]
fn title_prefers_group() {
    let doc = json!({"groups": [{"id": "x", "title": "G"}], "steps": [{"id": "x", "title": "S"}, {"id": "y", "title": "Y"}]});
    assert_eq!(title_of(&doc, "x"), "G");
    assert_eq!(title_of(&doc, "y"), "Y");
    assert_eq!(title_of(&doc, "z"), "z");
}

#[test]
fn triggers_match_ts() {
    let merged = json!({"type": "message.created", "message": {
        "id": "m", "threadRootId": "r", "authorId": "a", "kind": "system",
        "meta": {"merge": {"repo": "o/n", "number": 3, "result": "merged"}}}});
    assert_eq!(
        trigger_of(&merged),
        Trigger::Merged {
            root: "r".into(),
            repo: "o/n".into(),
            number: 3.0,
            author: "a".into()
        }
    );
    // 시스템 줄이 아니면 믿지 않는다.
    let mut fake = merged.clone();
    fake["message"]["kind"] = json!("text");
    assert_eq!(trigger_of(&fake), Trigger::None);
    // queued 는 손대지 않는다.
    let mut queued = merged.clone();
    queued["message"]["meta"]["merge"]["result"] = json!("queued");
    assert_eq!(trigger_of(&queued), Trigger::None);
    // 문자열 번호는 TS `typeof === 'number'` 에 걸린다.
    let mut s = merged.clone();
    s["message"]["meta"]["merge"]["number"] = json!("3");
    assert_eq!(trigger_of(&s), Trigger::None);

    let ans = json!({"type": "message.updated", "message": {
        "id": "c", "authorId": "a", "meta": {"kind": "ask", "ask": {"answeredWith": "yes"}}}});
    assert_eq!(
        trigger_of(&ans),
        Trigger::Answered {
            root: "c".into(),
            card: "c".into(),
            author: "a".into()
        }
    );
    let mut unanswered = ans.clone();
    unanswered["message"]["meta"]["ask"]["answeredWith"] = Value::Null;
    assert_eq!(trigger_of(&unanswered), Trigger::None);

    let ch = json!({"type": "thread.plan.changed", "rootId": "r"});
    assert_eq!(trigger_of(&ch), Trigger::Changed("r".into()));
    let linked = json!({"type": "thread.plan.changed", "rootId": "r", "via": "linked"});
    assert_eq!(trigger_of(&linked), Trigger::None);
}

#[test]
fn answered_once_and_bounded() {
    let mut a = Answered::default();
    assert!(a.mark("ABC"));
    assert!(!a.mark("abc"));
    let mut b: Bounded<u8> = Bounded::default();
    for i in 0..=MEMORY_CAP {
        b.put(i.to_string(), 0);
    }
    assert!(b.get("0").is_none());
    assert!(b.get("1").is_some());
}

#[test]
fn merge_then_ready_flows_through_derive() {
    let doc = json!({
        "goal": "g", "groups": [],
        "steps": [
            {"id": "a", "title": "A", "state": "active", "links": [{"kind": "pr", "repo": "o/n", "number": 1}]},
            {"id": "b", "title": "B", "state": "pending", "dependsOn": ["a"], "links": []}
        ]
    });
    let none = HashMap::new();
    let before = derive_plan(&doc, &none);
    let next = apply_merged_pr(&doc, "o/n", 1.0).unwrap();
    let after = derive_plan(&next, &none);
    assert_eq!(ready_diff(&before, &after), vec!["b".to_string()]);
}
