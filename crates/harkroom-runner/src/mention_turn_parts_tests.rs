use super::*;
use crate::mention_target::build_mention_target;
use crate::turn_notice::GateAccountRank;
use serde_json::json;

fn mention() -> Value {
    json!({ "id": "m1", "channelId": "c1", "body": "사유", "seq": 9, "meta": null })
}

fn target(entry: Value) -> MentionTarget {
    build_mention_target(&entry, &mention(), "root", &[])
}

#[test]
fn human_cancel_skips_operator_and_empty() {
    assert_eq!(human_cancel_of(Some("acc-1")), Some("acc-1"));
    assert_eq!(human_cancel_of(Some("operator")), None);
    assert_eq!(human_cancel_of(Some("")), None);
    assert_eq!(human_cancel_of(None), None);
}

#[test]
fn gate_extras_only_for_startup() {
    let ranks = GateRanks {
        pool: Some(2),
        account: GateAccountRank::Rank(1),
    };
    assert_eq!(
        gate_fail_extras(AttentionKind::Gate, "m1", ranks),
        GateFailExtras::default()
    );
    let e = gate_fail_extras(AttentionKind::Startup, "m1", ranks);
    assert_eq!(e.code, Some("account_gate"));
    assert_eq!(e.mention_id.as_deref(), Some("m1"));
    assert_eq!(
        (e.claude_pool_rank, e.claude_account_rank),
        (Some(2), Some(1))
    );
    let d = gate_fail_extras(
        AttentionKind::Startup,
        "m1",
        GateRanks {
            pool: None,
            account: GateAccountRank::DefaultLogin,
        },
    );
    assert_eq!((d.claude_pool_rank, d.claude_account_rank), (None, None));
}

#[test]
fn gate_signal_counts_valid_stamps() {
    let f = std::env::temp_dir().join(format!("hr-gate-signal-{}", std::process::id()));
    let _ = std::fs::remove_file(&f);
    assert_eq!(gate_signal_of(&f), GateSignal::default());
    std::fs::write(&f, "100\n\n abc\n0\n200 \n9007199254740992\n").unwrap();
    let got = gate_signal_of(&f);
    let _ = std::fs::remove_file(&f);
    assert_eq!(
        got,
        GateSignal {
            count: 2,
            last_at_ms: Some(200)
        }
    );
}

#[test]
fn stall_screen_signal_wins_over_screen() {
    let sig = |at, prog| {
        Some(StallSignal {
            last_at_ms: at,
            last_progress_at_ms: prog,
        })
    };
    let h = AgentHarness::Codex;
    assert_eq!(
        stall_screen_of(None, "", h, sig(Some(5), None)),
        StallScreen::Gate
    );
    assert_eq!(
        stall_screen_of(None, "", h, sig(Some(5), Some(5))),
        StallScreen::Gate
    );
    assert_eq!(
        stall_screen_of(Some("gate"), "", h, sig(Some(5), Some(6))),
        StallScreen::Stuck
    );
    assert_eq!(
        stall_screen_of(Some("idle"), "", h, sig(None, None)),
        StallScreen::Idle
    );
    // 신호 없음: 감시가 말하는 대로.
    assert_eq!(
        stall_screen_of(Some("gate"), "", h, None),
        StallScreen::Gate
    );
    assert_eq!(
        stall_screen_of(Some("busy"), "", h, None),
        StallScreen::Stuck
    );
    // 감시도 없음: 꼬리를 하네스 관문 정규식으로.
    assert_eq!(
        stall_screen_of(None, "\x1b[1mDo you want to proceed?\x1b[0m", h, None),
        StallScreen::Gate
    );
    assert_eq!(
        stall_screen_of(None, "working…", h, None),
        StallScreen::Stuck
    );
    assert_eq!(StallScreen::Idle.as_str(), "idle");
}

#[test]
fn wrote_by_turn_needs_matching_turn_id() {
    let m = json!({ "meta": { "turnId": "t1" } });
    assert!(wrote_by_turn(&m, Some("t1")));
    assert!(!wrote_by_turn(&m, Some("t2")));
    assert!(!wrote_by_turn(&m, None));
    assert!(!wrote_by_turn(&json!({ "meta": null }), Some("t1")));
}

#[test]
fn silent_caller_branches() {
    let thread = vec![json!({ "id": "m1", "authorId": "agent-1" })];
    let agents: HashSet<String> = ["agent-1".to_string()].into();
    assert_eq!(
        silent_turn_caller(Some(&agents), &target(json!({ "reason": "wake" })), &thread),
        SilentCaller::Wake
    );
    assert_eq!(
        silent_turn_caller(
            Some(&agents),
            &target(json!({ "reason": "delegation_done", "delegation": { "id": "d" } })),
            &thread
        ),
        SilentCaller::DelegationOutcome
    );
    assert_eq!(
        silent_turn_caller(
            Some(&agents),
            &target(json!({ "reason": "ask_closed" })),
            &thread
        ),
        SilentCaller::Human
    );
    assert_eq!(
        silent_turn_caller(
            Some(&agents),
            &target(json!({ "reason": "team_delegated", "delegatedBy": { "id": "x" } })),
            &thread
        ),
        SilentCaller::Delegated
    );
    let plain = target(json!({ "reason": "mention" }));
    assert_eq!(
        silent_turn_caller(Some(&agents), &plain, &thread),
        SilentCaller::Agent
    );
    assert_eq!(
        silent_turn_caller(None, &plain, &thread),
        SilentCaller::Human
    );
    assert_eq!(
        silent_turn_caller(Some(&agents), &plain, &[]),
        SilentCaller::Human
    );
}
