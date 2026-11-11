use super::*;
use crate::claude_accounts::AccountDir;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

fn ok(at: f64) -> Measured {
    Measured {
        fetched_at_ms: at,
        session: Some(crate::provider_usage::UsageWindow {
            used_percent: 12.0,
            resets_at_ms: None,
            window_minutes: None,
        }),
        weekly: None,
        extra: None,
        plan: None,
        error: None,
        source: Some("cli"),
    }
}

/// 잰 경로를 적는 가짜 측정기. 시계는 1000 으로 고정.
fn meters(log: Arc<Mutex<Vec<String>>>) -> UsageMeters {
    let (l1, l2) = (log.clone(), log);
    UsageMeters::with(
        UsageCache::new(120_000.0, || 1000.0),
        UsageCache::new(120_000.0, || 1000.0),
        Arc::new(move |d: &Path, at| {
            l1.lock().unwrap().push(d.display().to_string());
            ok(at)
        }),
        Arc::new(move |d: &Path, at| {
            l2.lock().unwrap().push(d.display().to_string());
            ok(at)
        }),
        Arc::new(|| 1000.0),
    )
}

fn layout(pools: &[(&str, &[&str])]) -> Layout {
    Layout {
        root: PathBuf::from("/r"),
        pools_mode: true,
        default_pool: None,
        agents: Default::default(),
        assign: Default::default(),
        strays: vec![],
        pools: pools
            .iter()
            .map(|(p, accts)| {
                (
                    p.to_string(),
                    accts
                        .iter()
                        .map(|a| AccountDir {
                            name: a.to_string(),
                            dir: PathBuf::from(format!("/r/{p}/{a}")),
                        })
                        .collect(),
                )
            })
            .collect(),
    }
}

#[test]
fn read_usage_request_matches_ts() {
    assert_eq!(read_usage_request(None), Ok(UsageRequest::default()));
    assert_eq!(
        read_usage_request(Some(&json!("x"))),
        Ok(UsageRequest::default())
    );
    assert_eq!(
        read_usage_request(Some(&json!({"force": true, "pool": "p", "account": "a"}))),
        Ok(UsageRequest {
            force: true,
            pool: Some("p".into()),
            account: Some("a".into())
        })
    );
    assert!(read_usage_request(Some(&json!({"force": "yes"}))).is_err());
    assert!(read_usage_request(Some(&json!({"pool": 1}))).is_err());
    assert!(read_usage_request(Some(&json!({"account": null}))).is_err());
}

#[test]
fn claude_snapshot_shape_and_order() {
    let log = Arc::new(Mutex::new(vec![]));
    let m = meters(log);
    let snap = m.claude_snapshot(
        &layout(&[("p1", &["a", "b", "c", "d", "e"]), ("p2", &["a"])]),
        &UsageRequest::default(),
    );
    assert_eq!(snap["measuredAtMs"], json!(1000));
    let accts = snap["accounts"].as_array().unwrap();
    let keys: Vec<String> = accts
        .iter()
        .map(|a| {
            format!(
                "{}/{}",
                a["pool"].as_str().unwrap(),
                a["account"].as_str().unwrap()
            )
        })
        .collect();
    assert_eq!(keys, ["p1/a", "p1/b", "p1/c", "p1/d", "p1/e", "p2/a"]);
    // 잰 결과만 — 토큰·URL 칸은 없다.
    let first = accts[0].as_object().unwrap();
    let mut names: Vec<&str> = first.keys().map(String::as_str).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "account",
            "fetchedAtMs",
            "pool",
            "session",
            "source",
            "weekly"
        ]
    );
}

#[test]
fn force_with_account_remeasures_only_that_account() {
    let log = Arc::new(Mutex::new(vec![]));
    let m = meters(log.clone());
    let l = layout(&[("p1", &["a", "b"]), ("p2", &["a"])]);
    m.claude_snapshot(&l, &UsageRequest::default());
    assert_eq!(log.lock().unwrap().len(), 3);
    log.lock().unwrap().clear();
    // 캐시가 살아 있다 — 다시 물어도 재지 않는다.
    m.claude_snapshot(&l, &UsageRequest::default());
    assert!(log.lock().unwrap().is_empty());
    // p2/a 만 새로 잰다(이름이 같은 p1/a 는 아니다).
    m.claude_snapshot(
        &l,
        &UsageRequest {
            force: true,
            pool: Some("p2".into()),
            account: Some("a".into()),
        },
    );
    assert_eq!(*log.lock().unwrap(), ["/r/p2/a"]);
    log.lock().unwrap().clear();
    // 계정 없이 force 면 전부.
    m.claude_snapshot(
        &l,
        &UsageRequest {
            force: true,
            ..Default::default()
        },
    );
    assert_eq!(log.lock().unwrap().len(), 3);
}

#[test]
fn codex_snapshot_system_first_then_accounts() {
    let base = std::env::temp_dir().join(format!("hk-usage-meter-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let root = base.join("accounts");
    std::fs::create_dir_all(root.join("work")).unwrap();
    std::fs::create_dir_all(root.join("home")).unwrap();
    let log = Arc::new(Mutex::new(vec![]));
    let m = meters(log.clone());
    let sys = base.join("sys");
    let snap = m.codex_snapshot(&sys, &root, &UsageRequest::default());
    let accts = snap["accounts"].as_array().unwrap();
    assert_eq!(accts[0]["account"], json!(""));
    assert!(accts.iter().all(|a| a.get("pool").is_none()));
    let mut rest: Vec<&str> = accts[1..]
        .iter()
        .map(|a| a["account"].as_str().unwrap())
        .collect();
    rest.sort();
    assert_eq!(rest, ["home", "work"]);
    log.lock().unwrap().clear();
    // force + account '' = 시스템 기본만.
    m.codex_snapshot(
        &sys,
        &root,
        &UsageRequest {
            force: true,
            account: Some(String::new()),
            ..Default::default()
        },
    );
    assert_eq!(*log.lock().unwrap(), [sys.display().to_string()]);
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn batches_cap_concurrency_and_keep_order() {
    let live = AtomicUsize::new(0);
    let peak = AtomicUsize::new(0);
    let items: Vec<usize> = (0..10).collect();
    let out = in_batches(&items, |i| {
        let n = live.fetch_add(1, Ordering::SeqCst) + 1;
        peak.fetch_max(n, Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(20));
        live.fetch_sub(1, Ordering::SeqCst);
        Measured::failed(*i as f64, "x")
    });
    assert!(peak.load(Ordering::SeqCst) <= MAX_PARALLEL);
    let ats: Vec<f64> = out.iter().map(|m| m.fetched_at_ms).collect();
    assert_eq!(ats, (0..10).map(|i| i as f64).collect::<Vec<_>>());
}

#[test]
fn panicking_measure_becomes_network_failure() {
    let out = in_batches(&[1], |_| panic!("boom"));
    assert_eq!(out[0].error.as_deref(), Some("network"));
}
