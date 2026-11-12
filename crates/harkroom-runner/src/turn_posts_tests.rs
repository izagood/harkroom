use serde_json::json;

use super::*;

fn row(author: &str, seq: i64, kind: &str, turn: Option<&str>) -> Value {
    let mut m = json!({ "id": format!("m{seq}"), "authorId": author, "seq": seq, "kind": kind });
    if let Some(t) = turn {
        m["meta"] = json!({ "turnId": t });
    }
    m
}

#[test]
fn counts_own_posts_after_baseline_only() {
    let msgs = vec![
        row("me", 5, "text", None),
        row("me", 11, "text", None),
        row("other", 12, "text", None),
        row("me", 13, "text", None),
    ];
    assert_eq!(count_own_posts_since(&msgs, "me", 10, None), 2);
    assert_eq!(count_own_posts_since(&msgs, "me", 13, None), 0);
}

#[test]
fn progress_and_wake_are_not_utterances() {
    let msgs = vec![
        row("me", 11, "progress", None),
        row("me", 12, "wake", None),
        row("me", 13, "report", None),
    ];
    assert_eq!(count_own_posts_since(&msgs, "me", 10, None), 1);
}

#[test]
fn other_turns_posts_are_excluded_but_untagged_count() {
    let msgs = vec![
        row("me", 11, "text", Some("t1")),
        row("me", 12, "text", Some("t2")),
        row("me", 13, "text", None),
        // 빈 문자열 turnId 는 안 적힌 것과 같다.
        row("me", 14, "text", Some("")),
    ];
    assert_eq!(count_own_posts_since(&msgs, "me", 10, Some("t1")), 3);
    assert_eq!(count_own_posts_since(&msgs, "me", 10, None), 4);
    assert_eq!(count_own_posts_since(&msgs, "me", 10, Some("")), 4);
}

#[test]
fn ownership_rules_per_use() {
    let tagged = row("me", 1, "text", Some("t1"));
    let untagged = row("me", 2, "text", None);
    assert!(owned_by_turn(&tagged, Some("t1"), TurnOwnership::Link));
    assert!(!owned_by_turn(&tagged, Some("t2"), TurnOwnership::Count));
    assert!(owned_by_turn(&untagged, Some("t1"), TurnOwnership::Count));
    assert!(!owned_by_turn(&untagged, Some("t1"), TurnOwnership::Link));
    assert!(owned_by_turn(&tagged, None, TurnOwnership::Count));
    assert!(!owned_by_turn(&tagged, None, TurnOwnership::Link));
    assert_eq!(message_turn_id(&tagged), Some("t1"));
    assert_eq!(message_turn_id(&untagged), None);
}

#[test]
fn float_seq_and_missing_fields() {
    let msgs = vec![
        json!({ "authorId": "me", "seq": 11.0, "kind": "text" }),
        json!({ "authorId": "me", "kind": "text" }),
        json!({ "seq": 12, "kind": "text" }),
    ];
    assert_eq!(count_own_posts_since(&msgs, "me", 10, None), 1);
}

#[test]
fn own_wake_since_counts_only_this_turns_wake_rows() {
    let msgs = vec![
        row("me", 5, "wake", Some("t1")),
        row("me", 12, "text", Some("t1")),
        row("other", 13, "wake", Some("t1")),
        row("me", 14, "wake", Some("t2")),
    ];
    assert!(!has_own_wake_since(&msgs, "me", 10, Some("t1")));
    assert!(has_own_wake_since(&msgs, "me", 10, Some("t2")));
    assert!(has_own_wake_since(&msgs, "me", 4, Some("t1")));
    let untagged = vec![row("me", 11, "wake", None)];
    assert!(has_own_wake_since(&untagged, "me", 10, Some("t1")));
}
