use super::*;
use serde_json::json;

fn mention() -> Value {
    json!({ "id": "m1", "channelId": "c1", "body": "깨움 사유", "seq": 9, "meta": null })
}

#[test]
fn plain_mention_carries_only_base_fields() {
    let t = build_mention_target(
        &json!({ "id": 1, "reason": "mention" }),
        &mention(),
        "root",
        &[],
    );
    assert_eq!(t.channel_id, "c1");
    assert_eq!(t.thread_root_id, "root");
    assert_eq!(t.mention_id, "m1");
    assert!(t.wake.is_none() && !t.scheduled_wake());
    assert!(t.team.is_none() && t.delegation.is_none() && t.delegated_by.is_none());
    assert!(t.edited_mention.is_none() && t.bundled_rows.is_empty());
}

#[test]
fn wake_reason_is_scheduled_with_body_as_reason() {
    let t = build_mention_target(&json!({ "reason": "wake" }), &mention(), "root", &[]);
    assert!(t.scheduled_wake());
    match t.wake {
        Some(TargetWake::Scheduled(w)) => assert_eq!(w.reason, "깨움 사유"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn ask_answered_and_closed_use_wake_slot_but_not_scheduled() {
    let a = build_mention_target(&json!({ "reason": "ask_answered" }), &mention(), "r", &[]);
    assert!(matches!(a.wake, Some(TargetWake::AskAnswered(_))) && !a.scheduled_wake());
    let c = build_mention_target(&json!({ "reason": "ask_closed" }), &mention(), "r", &[]);
    assert!(matches!(c.wake, Some(TargetWake::AskClosed(_))) && !c.scheduled_wake());
}

#[test]
fn reason_paired_fields_need_matching_reason() {
    let team = json!({ "teamId": "t" });
    let e =
        json!({ "reason": "mention", "team": team, "delegation": {"x":1}, "delegatedBy": {"y":1} });
    let t = build_mention_target(&e, &mention(), "r", &[]);
    assert!(t.team.is_none() && t.delegation.is_none() && t.delegated_by.is_none());

    let t = build_mention_target(
        &json!({ "reason": "team_mention", "team": team }),
        &mention(),
        "r",
        &[],
    );
    assert_eq!(t.team, Some(team));
    // 팀이 그 사이 지워졌으면(null) 블록을 싣지 않는다.
    let t = build_mention_target(
        &json!({ "reason": "team_mention", "team": null }),
        &mention(),
        "r",
        &[],
    );
    assert!(t.team.is_none());
    let t = build_mention_target(
        &json!({ "reason": "delegation_done", "delegation": {"o":1} }),
        &mention(),
        "r",
        &[],
    );
    assert!(t.delegation.is_some());
    let t = build_mention_target(
        &json!({ "reason": "team_delegated", "delegatedBy": {"by":1} }),
        &mention(),
        "r",
        &[],
    );
    assert!(t.delegated_by.is_some());
}

#[test]
fn delegation_followup_and_update_carry_mention_row() {
    let f = build_mention_target(
        &json!({ "reason": "delegation_followup" }),
        &mention(),
        "r",
        &[],
    );
    assert_eq!(f.delegation_followup, Some(mention()));
    assert!(f.delegation_update.is_none());
    let u = build_mention_target(
        &json!({ "reason": "delegation_update" }),
        &mention(),
        "r",
        &[],
    );
    assert_eq!(u.delegation_update, Some(mention()));
}

#[test]
fn reason_free_fields_ride_any_reason() {
    let e = json!({
        "reason": "mention", "viaEdit": true,
        "canceledWakes": [{"id": "w"}], "startedIn": {"channelId": "c0", "threadRootId": "t0"},
        "delegations": [{"id": "d"}],
    });
    let b = vec![json!({ "id": "m0" })];
    let t = build_mention_target(&e, &mention(), "r", &b);
    assert_eq!(t.edited_mention, Some(mention()));
    assert_eq!(t.canceled_wakes.len(), 1);
    assert!(t.started_in.is_some());
    assert_eq!(t.delegations.len(), 1);
    assert_eq!(t.bundled_rows, b);
}
