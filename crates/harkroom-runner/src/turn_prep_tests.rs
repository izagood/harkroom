use super::*;
use serde_json::json;

fn ids() -> impl FnMut() -> String {
    let mut n = 0;
    move || {
        n += 1;
        format!("new-{n}")
    }
}

fn rec(harness: AgentHarness) -> SessionRecord {
    SessionRecord {
        workspace_dir: "/w".into(),
        session_id: Some("old".into()),
        harness,
        last_fed_seq: 10,
        turns_run: 3,
        claude_account: Some("a1".into()),
        claude_pool: Some(Some("p1".into())),
        unseen_own_after_seq: None,
        canceled_by: None,
    }
}

const AX: AccountAxis<'static> = AccountAxis {
    account: Some("a1"),
    pool: Some("p1"),
};

fn used(c: RecordChoice) -> SessionRecord {
    match c {
        RecordChoice::Use(r) => r,
        RecordChoice::NeedWorkspace => panic!("기록이 있어야 한다"),
    }
}

#[test]
fn no_record_needs_workspace() {
    assert_eq!(
        reconcile_record(None, AgentHarness::ClaudeCode, AX, &mut ids()),
        RecordChoice::NeedWorkspace
    );
    let r = fresh_record("/w".into(), AgentHarness::ClaudeCode, AX, &mut ids());
    assert_eq!(r.session_id.as_deref(), Some("new-1"));
    assert_eq!(r.claude_pool, Some(Some("p1".into())));
    let r = fresh_record("/w".into(), AgentHarness::Codex, AX, &mut ids());
    assert_eq!(r.session_id, None, "codex 는 첫 턴 뒤에 id 를 안다");
}

#[test]
fn same_axis_keeps_session() {
    let r = used(reconcile_record(
        Some(rec(AgentHarness::ClaudeCode)),
        AgentHarness::ClaudeCode,
        AX,
        &mut ids(),
    ));
    assert_eq!(r, rec(AgentHarness::ClaudeCode));
}

#[test]
fn harness_change_drops_conversation_keeps_workspace() {
    let r = used(reconcile_record(
        Some(rec(AgentHarness::Codex)),
        AgentHarness::ClaudeCode,
        AX,
        &mut ids(),
    ));
    assert_eq!(r.workspace_dir, "/w");
    assert_eq!(r.session_id.as_deref(), Some("new-1"));
    assert_eq!((r.last_fed_seq, r.turns_run), (0, 0));
}

#[test]
fn account_or_pool_change_drops_only_for_pooled_harness() {
    let other = AccountAxis {
        account: Some("a2"),
        pool: Some("p1"),
    };
    let r = used(reconcile_record(
        Some(rec(AgentHarness::ClaudeCode)),
        AgentHarness::ClaudeCode,
        other,
        &mut ids(),
    ));
    assert_eq!(r.turns_run, 0);
    assert_eq!(r.claude_account.as_deref(), Some("a2"));
    let other_pool = AccountAxis {
        account: Some("a1"),
        pool: Some("p2"),
    };
    let r = used(reconcile_record(
        Some(rec(AgentHarness::ClaudeCode)),
        AgentHarness::ClaudeCode,
        other_pool,
        &mut ids(),
    ));
    assert_eq!(r.turns_run, 0, "같은 이름이 다른 풀에 있을 수 있다");
    // 풀이 없는 하네스(opencode)는 계정 축이 바뀌어도 세션을 잇는다(2026-09-25 실측).
    let r = used(reconcile_record(
        Some(rec(AgentHarness::Opencode)),
        AgentHarness::Opencode,
        other,
        &mut ids(),
    ));
    assert_eq!(r.turns_run, 3);
}

#[test]
fn old_record_without_pool_is_filled_not_dropped() {
    let old = SessionRecord {
        claude_pool: None,
        ..rec(AgentHarness::ClaudeCode)
    };
    let other_pool = AccountAxis {
        account: Some("a1"),
        pool: Some("p9"),
    };
    let r = used(reconcile_record(
        Some(old),
        AgentHarness::ClaudeCode,
        other_pool,
        &mut ids(),
    ));
    assert_eq!(r.turns_run, 3);
    assert_eq!(r.claude_pool, Some(Some("p9".into())));
    // 풀이 없는 하네스는 채우지도 않는다.
    let old = SessionRecord {
        claude_pool: None,
        ..rec(AgentHarness::Opencode)
    };
    let r = used(reconcile_record(
        Some(old),
        AgentHarness::Opencode,
        AX,
        &mut ids(),
    ));
    assert_eq!(r.claude_pool, None);
}

fn m(id: &str, seq: u64) -> Value {
    json!({ "id": id, "seq": seq, "createdAt": format!("t{seq}") })
}

#[test]
fn merge_pages_reports_gap_and_dedupes() {
    let oldest = [m("a", 11), m("b", 12)];
    let latest = [m("y", 50), m("z", 51)];
    let (msgs, gap) = merge_thread_pages(&oldest, &latest, 10);
    assert_eq!(
        msgs.iter()
            .map(|x| x["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["a", "b", "y", "z"]
    );
    assert_eq!(gap, Some(12));
    // 최신 페이지가 옛 페이지에 겹치면(최신에만 있는 글이 옛 끝보다 앞) 틈이 없다 — 정본과 같은 판정.
    let latest = [m("b", 12), m("c", 12)];
    let (msgs, gap) = merge_thread_pages(&oldest, &latest, 10);
    assert_eq!(msgs.len(), 3);
    assert_eq!(gap, None);
    // 최신 페이지가 옛 페이지에 다 들어 있으면 틈이 없다.
    let (_, gap) = merge_thread_pages(&oldest, &[m("b", 12)], 10);
    assert_eq!(gap, None);
    // 한쪽이 커서 뒤에 아무것도 없으면 틈을 말하지 않는다.
    let (_, gap) = merge_thread_pages(&[], &latest, 10);
    assert_eq!(gap, None);
}

#[test]
fn merge_pages_later_value_wins() {
    let oldest = [json!({ "id": "a", "seq": 11, "body": "old" })];
    let latest = [json!({ "id": "a", "seq": 11, "body": "edited" })];
    let (msgs, _) = merge_thread_pages(&oldest, &latest, 10);
    assert_eq!(msgs[0]["body"], "edited");
}

#[test]
fn fill_asked_rows_adds_missing_mention_and_bundle() {
    let thread = vec![m("x", 20), m("y", 30)];
    let mention = m("men", 40);
    let bundled = [m("b1", 5), m("y", 30)];
    let out = fill_asked_rows(thread.clone(), Some(&mention), &bundled, 10);
    assert_eq!(
        out.thread
            .iter()
            .map(|x| x["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["b1", "x", "y", "men"]
    );
    assert_eq!(out.bundled_ids, ["b1", "y"]);
    assert_eq!(out.oldest_asked_at.as_deref(), Some("t5"));
    assert!(!out.asked_already_seen);
    let seen = fill_asked_rows(thread.clone(), Some(&m("men", 9)), &[], 10);
    assert!(seen.asked_already_seen, "앞 턴이 본 글만 처리 — 빈 턴 후보");
    let first = fill_asked_rows(thread.clone(), Some(&m("men", 9)), &[], 0);
    assert!(!first.asked_already_seen, "첫 턴은 본 것이 없다");
    let wake = fill_asked_rows(thread.clone(), None, &bundled, 10);
    assert_eq!(
        wake.thread, thread,
        "깨움·위임 결말은 부른 글을 채우지 않는다"
    );
    assert!(wake.bundled_ids.is_empty());
}

#[test]
fn choose_session_resume_and_fresh_wake() {
    let s = choose_turn_session(rec(AgentHarness::ClaudeCode), false, &mut ids());
    assert!(!s.fresh_wake && !s.is_first_turn);
    let s = choose_turn_session(rec(AgentHarness::ClaudeCode), true, &mut ids());
    assert!(s.fresh_wake && s.is_first_turn);
    assert_eq!(s.rec.session_id.as_deref(), Some("new-1"));
    assert_eq!(s.rec.turns_run, 0);
    assert_eq!(s.stored.session_id.as_deref(), Some("old"));
    // 이어받을 세션이 없으면 깨움도 평소 경로다.
    let none = SessionRecord {
        session_id: None,
        ..rec(AgentHarness::Codex)
    };
    let s = choose_turn_session(none, true, &mut ids());
    assert!(!s.fresh_wake && s.is_first_turn);
    let zero = SessionRecord {
        turns_run: 0,
        ..rec(AgentHarness::ClaudeCode)
    };
    assert!(choose_turn_session(zero, false, &mut ids()).is_first_turn);
}

#[test]
fn persist_fresh_wake_keeps_stored_and_marks_boundary() {
    let stored = SessionRecord {
        unseen_own_after_seq: Some(30),
        ..rec(AgentHarness::ClaudeCode)
    };
    let s = choose_turn_session(stored.clone(), true, &mut ids());
    let next = SessionRecord {
        last_fed_seq: 99,
        ..s.rec.clone()
    };
    let out = record_to_persist(&s, next.clone(), true, 50, None);
    assert_eq!(out.session_id.as_deref(), Some("old"));
    assert_eq!(out.last_fed_seq, 10, "깨움 세션은 커서를 전진시키지 않는다");
    assert_eq!(out.unseen_own_after_seq, Some(30), "더 이른 경계를 지킨다");
    let fresh = SessionRecord {
        unseen_own_after_seq: None,
        ..stored
    };
    let s = choose_turn_session(fresh, true, &mut ids());
    let out = record_to_persist(&s, next, false, 50, Some("jb"));
    assert_eq!(out.unseen_own_after_seq, Some(50));
    assert_eq!(out.canceled_by.as_deref(), Some("jb"));
}

#[test]
fn persist_normal_turn_clears_marks_when_advanced() {
    let base = SessionRecord {
        unseen_own_after_seq: Some(5),
        canceled_by: Some("jb".into()),
        ..rec(AgentHarness::ClaudeCode)
    };
    let s = choose_turn_session(base.clone(), false, &mut ids());
    let out = record_to_persist(&s, base.clone(), true, 0, None);
    assert_eq!((out.unseen_own_after_seq, out.canceled_by), (None, None));
    let out = record_to_persist(&s, base.clone(), false, 0, None);
    assert_eq!(
        out.unseen_own_after_seq,
        Some(5),
        "보여 주지 않았으면 지우지 않는다"
    );
    assert_eq!(out.canceled_by.as_deref(), Some("jb"));
    let out = record_to_persist(&s, base, true, 0, Some("op2"));
    assert_eq!(out.canceled_by.as_deref(), Some("op2"));
    assert_eq!(out.unseen_own_after_seq, None);
}

#[test]
fn start_seq_is_thread_end() {
    assert_eq!(turn_start_seq(&[m("a", 3), m("b", 9), m("c", 4)]), 9);
    assert_eq!(turn_start_seq(&[]), 0);
}
