//! 정본 `test/mentionScheduler.test.ts` 의 잎 판정 대조.

use super::*;
use serde_json::json;

#[test]
fn backoff_ladder_starts_at_30s_and_caps_at_60s() {
    assert_eq!(backoff_for(0), 30_000);
    assert_eq!(backoff_for(1), 30_000);
    assert_eq!(backoff_for(2), 60_000);
    assert_eq!(backoff_for(5), 60_000);
}

#[test]
fn invalid_tool_input_by_code_or_message() {
    assert!(is_invalid_tool_input(Some(-32602), "x"));
    assert!(is_invalid_tool_input(None, "MCP error -32602: bad"));
    assert!(is_invalid_tool_input(None, "Invalid Arguments for tool"));
    assert!(is_invalid_tool_input(None, "invalid enum value"));
    assert!(!is_invalid_tool_input(Some(-32000), "socket hang up"));
}

#[test]
fn blocked_notice_only_for_human_calls() {
    for r in ["mention", "thread_reply", "dm", "team_mention"] {
        assert!(is_blocked_notice_reason(r));
    }
    for r in [
        "wake",
        "ask_answered",
        "team_delegated",
        "delegation_result",
    ] {
        assert!(!is_blocked_notice_reason(r));
    }
}

#[test]
fn ask_closed_note_distinguishes_expiry() {
    let m = json!({"ask": {"closedReason": "expired"}});
    assert!(ask_closed_note(Some(&m)).contains("permission.request"));
    assert!(ask_closed_note(None).contains("답하지 않기로"));
}

#[test]
fn ask_answered_wake_written_mirror_and_pick() {
    let w =
        json!({"ask": {"answeredWith": "__text__", "answeredText": "B 로", "answeredBy": "u1"}});
    let r = ask_answered_wake("m1", Some(&w));
    assert!(r.reason.contains("harkroom://message/m1"));
    assert!(!r.reason.contains("B 로"), "사람의 글은 사유에 싣지 않는다");
    assert_eq!(
        r.written,
        Some(WrittenAnswer {
            by: Some("u1".into()),
            text: "B 로".into()
        })
    );

    let mirror = json!({"ask": {"answeredWith": "__text__", "mirrorOf": "orig"}});
    let r = ask_answered_wake("m2", Some(&mirror));
    assert!(
        r.reason
            .ends_with("원본 카드 harkroom://message/orig 에 있다")
    );
    assert!(r.written.is_none());

    let pick = json!({"ask": {"answeredWith": "b", "options": [{"id": "a", "label": "가"}, {"id": "b", "label": "나"}]}});
    assert_eq!(
        ask_answered_wake("m3", Some(&pick)).reason,
        "내가 낸 선택지에 답이 왔다 — 고른 것: 나"
    );
    let unknown = json!({"ask": {"answeredWith": "z", "options": []}});
    assert!(
        ask_answered_wake("m4", Some(&unknown))
            .reason
            .ends_with("고른 것: z")
    );
    assert!(
        ask_answered_wake("m5", None)
            .reason
            .contains("스레드에서 확인")
    );
}

#[test]
fn wake_target_report_fields_only_with_report_to() {
    let origin = "0123abcd-0000-4000-8000-00000000abcd";
    let m = json!({"body": "CI 확인", "seq": 42, "meta": {"turnId": "t9",
        "wake": {"reportTo": {"channelId": "c", "threadRootId": "r"}, "watch": true, "origin": origin}}});
    let t = wake_target(&m);
    assert_eq!(t.reason, "CI 확인");
    assert_eq!(
        t.report_to,
        Some(WakeReportTo {
            channel_id: "c".into(),
            thread_root_id: "r".into()
        })
    );
    assert_eq!(t.scheduled_seq, Some(42));
    assert_eq!(t.scheduled_turn_id.as_deref(), Some("t9"));
    assert!(t.watch);
    assert_eq!(t.origin.as_deref(), Some(origin));

    let plain =
        json!({"body": "x", "seq": 7, "meta": {"turnId": "t1", "wake": {"origin": origin}}});
    let t = wake_target(&plain);
    assert!(t.report_to.is_none() && t.scheduled_seq.is_none() && t.scheduled_turn_id.is_none());
    assert!(!t.watch);
    assert!(t.origin.is_none(), "감시가 아니면 origin 을 보지 않는다");

    let bad = json!({"body": "x", "meta": {"wake": {"watch": true, "origin": "not-a-uuid"}}});
    assert!(wake_target(&bad).origin.is_none());
    let truthy_watch = json!({"body": "x", "meta": {"wake": {"watch": 1}}});
    assert!(!wake_target(&truthy_watch).watch, "true 만 참");
}

#[test]
fn plain_mention_only_for_plain_human_calls() {
    let user = json!({"kind": "user", "meta": null});
    assert!(is_plain_mention(&json!({"reason": "mention"}), &user));
    assert!(is_plain_mention(
        &json!({"reason": "dm", "canceledWakes": []}),
        &user
    ));
    assert!(!is_plain_mention(&json!({"reason": "wake"}), &user));
    assert!(!is_plain_mention(&json!({"reason": "team_mention"}), &user));
    for k in ["team", "delegation", "delegatedBy", "viaEdit", "startedIn"] {
        let mut e = json!({"reason": "mention"});
        e[k] = json!("x");
        assert!(!is_plain_mention(&e, &user), "{k}");
    }
    assert!(!is_plain_mention(
        &json!({"reason": "mention", "canceledWakes": ["w"]}),
        &user
    ));
    assert!(!is_plain_mention(
        &json!({"reason": "mention"}),
        &json!({"kind": "system"})
    ));
    for meta in [
        json!({"kind": "ask"}),
        json!({"kind": "wake"}),
        json!({"automation": {}}),
        json!({"automationId": "a"}),
        json!({"planStart": {}}),
    ] {
        assert!(!is_plain_mention(
            &json!({"reason": "thread_reply"}),
            &json!({"kind": "user", "meta": meta})
        ));
    }
    assert!(is_plain_mention(
        &json!({"reason": "thread_reply"}),
        &json!({"kind": "user", "meta": {"kind": "report"}})
    ));
}
