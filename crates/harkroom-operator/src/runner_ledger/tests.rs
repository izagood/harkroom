use super::*;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicUsize, Ordering};

fn tmp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "hk-ledger-{tag}-{}-{}",
        std::process::id(),
        crate::endpoint::random_hex(4).unwrap()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn entry(agent: &str, pid: i32) -> RunnerLedgerEntry {
    RunnerLedgerEntry {
        agent_id: agent.into(),
        pid,
        incarnation_id: format!("inc-{pid}"),
        link_secret: None,
        started_at_ms: 1_700_000_000_000,
        boot_time_sec: Some(1_700_000_000),
        spawned_by_nonce: "n1".into(),
        spawned_by_app_version: None,
        retiring: None,
    }
}

#[test]
fn ts_written_ledger_reads_back() {
    // TS writeRunnerLedger 가 쓰는 꼴 그대로(JSON.stringify, 키 순서는 runners.ts 가 만든 순서).
    let text = r#"{"version":1,"runners":[
      {"agentId":"a1","pid":101,"incarnationId":"i1","linkSecret":"s","startedAtMs":5,"bootTimeSec":null,"spawnedByNonce":"n","spawnedByAppVersion":"0.4.1","retiring":{"holding":[3],"done":[]}},
      {"agentId":"a2","pid":102.0,"incarnationId":"i2","startedAtMs":6.5,"bootTimeSec":7,"spawnedByNonce":"n"}
    ]}"#;
    let got = parse_runner_ledger(text);
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].link_secret.as_deref(), Some("s"));
    assert_eq!(got[0].boot_time_sec, None);
    assert_eq!(got[0].spawned_by_app_version.as_deref(), Some("0.4.1"));
    assert_eq!(
        got[0].retiring,
        Some(RetiringFacts {
            holding: vec![3],
            done: vec![]
        })
    );
    assert_eq!(got[1].pid, 102);
    assert_eq!(got[1].started_at_ms, 6);
    assert_eq!(got[1].boot_time_sec, Some(7));
    assert_eq!(got[1].link_secret, None);
}

#[test]
fn bad_lines_are_dropped_one_by_one() {
    let text = r#"{"version":1,"runners":[
      {"agentId":"","pid":1,"incarnationId":"i","startedAtMs":1,"bootTimeSec":null},
      {"agentId":"a","pid":0,"incarnationId":"i","startedAtMs":1,"bootTimeSec":null},
      {"agentId":"a","pid":1.5,"incarnationId":"i","startedAtMs":1,"bootTimeSec":null},
      {"agentId":"a","pid":1,"incarnationId":"i","startedAtMs":1},
      {"agentId":"a","pid":1,"incarnationId":"i","startedAtMs":1,"bootTimeSec":null,"linkSecret":3},
      {"agentId":"a","pid":1,"incarnationId":"i","startedAtMs":1,"bootTimeSec":null,"retiring":{"holding":[1.5],"done":[]}},
      {"agentId":"a","pid":1,"incarnationId":"i","startedAtMs":1,"bootTimeSec":null,"retiring":{"holding":[]}},
      {"agentId":"ok","pid":9,"incarnationId":"i","startedAtMs":1,"bootTimeSec":null}
    ]}"#;
    let got = parse_runner_ledger(text);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].agent_id, "ok");
    assert_eq!(got[0].spawned_by_nonce, "");
}

#[test]
fn missing_broken_or_other_version_is_empty() {
    assert!(parse_runner_ledger("").is_empty());
    assert!(parse_runner_ledger("{").is_empty());
    assert!(parse_runner_ledger("null").is_empty());
    assert!(parse_runner_ledger(r#"{"version":2,"runners":[]}"#).is_empty());
    assert!(parse_runner_ledger(r#"{"version":1,"runners":{}}"#).is_empty());
    let d = tmp_dir("missing");
    assert!(read_runner_ledger(&runner_ledger_path(&d)).is_empty());
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn paths_match_ts() {
    let d = Path::new("/x");
    assert_eq!(
        runner_ledger_path(d),
        Path::new("/x/operator/runners-v1.json")
    );
    assert_eq!(
        legacy_runner_ledger_path(d),
        Path::new("/x/daemon/runners-v1.json")
    );
}

#[test]
fn write_round_trips_with_0600_and_no_tmp_left() {
    let d = tmp_dir("write");
    let mut e = entry("a1", 41);
    e.boot_time_sec = None;
    e.retiring = Some(RetiringFacts {
        holding: vec![1, 2],
        done: vec![3],
    });
    write_runner_ledger(&d, &[e.clone(), entry("a2", 42)], &|_| {});
    let path = runner_ledger_path(&d);
    let text = std::fs::read_to_string(&path).unwrap();
    // TS isEntry 는 bootTimeSec 키가 있어야 한다 — None 도 null 로 써야 TS 오퍼레이터가 읽는다.
    assert!(text.contains(r#""bootTimeSec":null"#), "{text}");
    assert!(!text.contains("linkSecret"));
    assert!(text.starts_with(r#"{"version":1,"runners":[{"agentId":"a1","pid":41,"#));
    assert_eq!(read_runner_ledger(&path), vec![e, entry("a2", 42)]);
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let left: Vec<_> = std::fs::read_dir(d.join("operator"))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left.len(), 1, "{left:?}");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn write_failure_logs_and_does_not_panic() {
    let d = tmp_dir("fail");
    // operator 자리를 파일로 막는다 → create_dir_all 실패.
    std::fs::write(d.join("operator"), "x").unwrap();
    let logged = Arc::new(Mutex::new(Vec::<String>::new()));
    let l = Arc::clone(&logged);
    write_runner_ledger(&d, &[entry("a", 1)], &move |s| {
        l.lock().unwrap().push(s.into())
    });
    let got = logged.lock().unwrap().clone();
    assert_eq!(got.len(), 1);
    assert!(got[0].starts_with("러너 장부를 쓰지 못했다: "), "{got:?}");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn writer_last_save_wins_even_when_first_write_is_slow() {
    // TS 2026-09-18 회귀: 느린 첫 쓰기가 나중에 착지해 낡은 스냅샷이 새 것을 덮던 것.
    let d = tmp_dir("writer");
    let calls = Arc::new(AtomicUsize::new(0));
    let c = Arc::clone(&calls);
    let w = RunnerLedgerWriter::with_write(
        d.clone(),
        Box::new(|_| {}),
        Box::new(move |dir, entries, log| {
            if c.fetch_add(1, Ordering::SeqCst) == 0 {
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
            write_runner_ledger(dir, entries, log)
        }),
    );
    w.save(vec![entry("a", 1)]);
    std::thread::sleep(std::time::Duration::from_millis(20));
    w.save(vec![entry("a", 1), entry("b", 2)]);
    w.save(vec![]);
    w.drain();
    assert!(read_runner_ledger(&runner_ledger_path(&d)).is_empty());
    // 첫 쓰기 + 합쳐진 마지막 하나 = 2번(가운데 스냅샷은 건너뛴다).
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn writer_survives_panicking_write() {
    let d = tmp_dir("panic");
    let calls = Arc::new(AtomicUsize::new(0));
    let c = Arc::clone(&calls);
    let logged = Arc::new(Mutex::new(Vec::<String>::new()));
    let l = Arc::clone(&logged);
    let w = RunnerLedgerWriter::with_write(
        d.clone(),
        Box::new(move |s| l.lock().unwrap().push(s.into())),
        Box::new(move |dir, entries, log| {
            if c.fetch_add(1, Ordering::SeqCst) == 0 {
                std::thread::sleep(std::time::Duration::from_millis(50));
                panic!("boom");
            }
            write_runner_ledger(dir, entries, log)
        }),
    );
    w.save(vec![entry("a", 1)]);
    std::thread::sleep(std::time::Duration::from_millis(10));
    w.save(vec![entry("b", 2)]);
    w.drain();
    assert_eq!(
        read_runner_ledger(&runner_ledger_path(&d)),
        vec![entry("b", 2)]
    );
    assert!(logged.lock().unwrap().iter().any(|s| s.contains("패닉")));
    let _ = std::fs::remove_dir_all(&d);
}
