use super::*;

fn entry(pid: i32, id: Option<&str>) -> RetiringEntry {
    RetiringEntry {
        pid,
        incarnation_id: id.map(str::to_string),
        poll_stopped: None,
        ledger: None,
    }
}

fn facts(started: i64) -> RetiringLedgerFacts {
    RetiringLedgerFacts {
        started_at_ms: started,
        boot_time_sec: Some(7),
        link_secret: Some("s".into()),
        spawned_by_app_version: None,
    }
}

#[test]
fn holds_inbox_until_poll_stopped_then_env_carries_hold_and_done_without_overlap() {
    let mut s = RetiringSet::new();
    s.insert("a1", entry(10, Some("i1")));
    let mut reaped = Vec::new();
    assert_eq!(s.holds_inbox("a1", |_| true, &mut reaped), Some(10));
    assert!(s.handover_env("a1").is_empty());
    assert!(!s.note_poll_stopped("a1", "other", &[1], &[]));
    assert!(s.note_poll_stopped("a1", "i1", &[3, 4], &[4, 5]));
    assert_eq!(s.holds_inbox("a1", |_| true, &mut reaped), None);
    assert_eq!(
        s.handover_env("a1"),
        vec![
            ("HARKROOM_HANDOVER_HOLD".into(), "3,4".into()),
            ("HARKROOM_HANDOVER_DONE".into(), "5".into()),
        ]
    );
    assert!(reaped.is_empty());
}

#[test]
fn several_retiring_merge_holds_and_release_only_when_last_one_goes() {
    let mut s = RetiringSet::new();
    s.insert("a1", entry(10, Some("i1")));
    s.insert("a1", entry(11, Some("i2")));
    s.note_poll_stopped("a1", "i1", &[1], &[]);
    s.note_poll_stopped("a1", "i2", &[1, 2], &[9]);
    assert_eq!(
        s.handover_env("a1")[0],
        ("HARKROOM_HANDOVER_HOLD".into(), "1,2".into())
    );
    let r = s.reap_dead(|p| p != 10);
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].incarnation_id.as_deref(), Some("i1"));
    assert!(!r[0].release_handover);
    let r = s.reap_dead(|_| false);
    assert!(r[0].release_handover);
    // 두 번 거두지 않는다.
    assert!(s.reap_dead(|_| false).is_empty());
}

#[test]
fn dead_holder_is_reaped_by_holds_inbox_and_same_pid_replaces() {
    let mut s = RetiringSet::new();
    s.insert("a1", entry(10, None));
    s.insert("a1", entry(10, Some("i1")));
    let mut reaped = Vec::new();
    assert_eq!(s.holds_inbox("a1", |_| false, &mut reaped), None);
    assert_eq!(reaped.len(), 1);
    assert_eq!(reaped[0].incarnation_id.as_deref(), Some("i1"));
    assert!(
        !reaped[0].release_handover,
        "보류를 심은 적 없으면 풀 것도 없다"
    );
}

#[test]
fn announce_lists_only_alive_with_id() {
    let mut s = RetiringSet::new();
    s.insert("a1", entry(10, Some("i1")));
    s.insert("a2", entry(20, None));
    s.insert("a3", entry(30, Some("i3")));
    assert_eq!(
        s.announce(|p| p != 30),
        vec![("a1".to_string(), 10, "i1".to_string())]
    );
}

#[test]
fn ledger_rows_skip_unknown_and_table_pids_and_keep_retiring_facts() {
    let mut s = RetiringSet::new();
    let mut e = entry(10, Some("i1"));
    e.ledger = Some(facts(5));
    s.insert("a1", e);
    let mut e2 = entry(11, Some("i2"));
    e2.ledger = Some(RetiringLedgerFacts {
        spawned_by_app_version: Some("0.4.1".into()),
        ..facts(3)
    });
    s.insert("a2", e2);
    s.insert("a3", entry(12, Some("i3"))); // 장부 사실 없음
    let mut e4 = entry(13, Some("i4"));
    e4.ledger = Some(facts(1));
    s.insert("a4", e4); // 표에 있는 pid
    s.note_poll_stopped("a1", "i1", &[2], &[3]);
    let rows = s.ledger_rows(&[13], "n", Some("0.4.9"));
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].agent_id, "a2");
    assert_eq!(rows[0].spawned_by_app_version.as_deref(), Some("0.4.1"));
    assert_eq!(rows[0].retiring, Some(RetiringFacts::default()));
    assert_eq!(rows[1].spawned_by_app_version.as_deref(), Some("0.4.9"));
    assert_eq!(rows[1].spawned_by_nonce, "n");
    assert_eq!(
        rows[1].retiring,
        Some(RetiringFacts {
            holding: vec![2],
            done: vec![3]
        })
    );
}

#[test]
fn ledger_facts_debug_hides_secret() {
    assert!(!format!("{:?}", facts(1)).contains("\"s\""));
}
