//! TS `test/claudeUsagePoller.test.ts` 의 경우를 옮기고, 합쳐 쓰기·파일 모양·뒤 스레드를 더 본다.
use super::*;
use crate::provider_usage::ExtraWindow;
use std::sync::atomic::{AtomicU64, Ordering};

const T0: f64 = 1_790_000_000_000.0;
const RESET: f64 = T0 + 3.0 * 3_600_000.0;

#[derive(Clone, Copy)]
enum Pct {
    Ok(f64),
    Fail,
}

struct Fake {
    clock: Arc<AtomicU64>,
    pct: Arc<Mutex<HashMap<String, Pct>>>,
    calls: Arc<Mutex<Vec<String>>>,
}

impl Fake {
    fn advance(&self, ms: f64) {
        self.clock.fetch_add(ms as u64, Ordering::SeqCst);
    }
    fn set(&self, name: &str, p: Pct) {
        self.pct.lock().unwrap().insert(name.into(), p);
    }
    fn take_calls(&self) -> Vec<String> {
        let mut c = std::mem::take(&mut *self.calls.lock().unwrap());
        c.sort();
        c
    }
}

fn tmp_root(name: &str, accounts: &[&str]) -> PathBuf {
    let d = std::env::temp_dir().join(format!("hk-usage-poll-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    fs::write(
        d.join("pools.json"),
        r#"{"defaultPool":"work","order":{},"agents":{}}"#,
    )
    .unwrap();
    for a in accounts {
        fs::create_dir_all(d.join("work").join(a)).unwrap();
    }
    d
}

fn setup(root: &Path, shared_file: bool) -> (ClaudeUsagePoller, Fake) {
    let fake = Fake {
        clock: Arc::new(AtomicU64::new(T0 as u64)),
        pct: Arc::default(),
        calls: Arc::default(),
    };
    let (clock, pct, calls) = (fake.clock.clone(), fake.pct.clone(), fake.calls.clone());
    let clock2 = clock.clone();
    let poller = ClaudeUsagePoller::new(PollerOpts {
        root: root.to_path_buf(),
        pools_path: root.join("pools.json"),
        now: Box::new(move || clock2.load(Ordering::SeqCst) as f64),
        read_sign_in: Box::new(|_| None),
        measure: Box::new(move |dir| {
            let name = dir.file_name().unwrap().to_string_lossy().to_string();
            calls.lock().unwrap().push(name.clone());
            let now = clock.load(Ordering::SeqCst) as f64;
            match pct
                .lock()
                .unwrap()
                .get(&name)
                .copied()
                .unwrap_or(Pct::Ok(0.0))
            {
                Pct::Fail => Measured::failed(now, "timeout"),
                Pct::Ok(p) => Measured {
                    fetched_at_ms: now,
                    session: Some(UsageWindow {
                        used_percent: p,
                        resets_at_ms: Some(RESET),
                        window_minutes: None,
                    }),
                    weekly: Some(UsageWindow {
                        used_percent: p / 2.0,
                        resets_at_ms: Some(RESET + 86_400_000.0),
                        window_minutes: None,
                    }),
                    extra: Some(vec![ExtraWindow {
                        label: "Opus weekly".into(),
                        window: UsageWindow {
                            used_percent: 1.0,
                            resets_at_ms: None,
                            window_minutes: None,
                        },
                    }]),
                    plan: None,
                    error: None,
                    source: None,
                },
            }
        }),
        log: None,
        shared_file,
    });
    (poller, fake)
}

fn read_file(root: &Path) -> Value {
    serde_json::from_slice(&fs::read(root.join(CLAUDE_USAGE_FILE)).unwrap()).unwrap()
}

fn account<'a>(f: &'a Value, name: &str) -> &'a Value {
    f["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["account"] == name)
        .unwrap()
}

#[test]
fn first_tick_measures_all_and_writes_ts_shape() {
    let root = tmp_root("first", &["aria", "bex"]);
    let (p, f) = setup(&root, false);
    f.set("aria", Pct::Ok(40.0));
    p.tick();
    assert_eq!(f.take_calls(), ["aria", "bex"]);
    let file = read_file(&root);
    assert_eq!(file["version"], 1);
    // 정수로 떨어지는 시각은 정수 글자로 — TS `JSON.stringify` 와 같다.
    assert_eq!(file["writtenAtMs"], json!(T0 as i64));
    assert_eq!(
        *account(&file, "aria"),
        json!({
            "pool": "work", "account": "aria", "signIn": null,
            "session": {"usedPercent": 40, "resetsAtMs": RESET as i64},
            "weekly": {"usedPercent": 20, "resetsAtMs": (RESET + 86_400_000.0) as i64},
            "modelWeekly": [{"label": "Opus weekly", "window": {"usedPercent": 1, "resetsAtMs": null}}],
            "readAtMs": T0 as i64,
        })
    );
    // 키 순서도 TS 와 같다.
    let keys: Vec<&String> = account(&file, "aria").as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "pool",
            "account",
            "signIn",
            "session",
            "weekly",
            "modelWeekly",
            "readAtMs"
        ]
    );
    let text = fs::read_to_string(root.join(CLAUDE_USAGE_FILE)).unwrap();
    assert!(text.ends_with("}\n"));
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(root.join(CLAUDE_USAGE_FILE))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
    // tmp 파일이 남지 않는다.
    assert!(
        fs::read_dir(&root).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp"))
    );
}

#[test]
fn moved_account_every_2min_idle_every_10min() {
    let root = tmp_root("cadence", &["aria", "bex"]);
    let (p, f) = setup(&root, false);
    f.set("aria", Pct::Ok(10.0));
    p.tick();
    f.advance(USAGE_POLL_ACTIVE_MS);
    f.set("aria", Pct::Ok(12.0));
    f.take_calls();
    p.tick();
    // 두 번째 조회 전에는 어느 쪽도 "움직였다"를 모른다.
    assert!(f.take_calls().is_empty());
    f.advance(USAGE_POLL_IDLE_MS - USAGE_POLL_ACTIVE_MS);
    p.tick();
    assert_eq!(f.take_calls(), ["aria", "bex"]);
    f.advance(USAGE_POLL_ACTIVE_MS);
    p.tick();
    assert_eq!(f.take_calls(), ["aria"]);
}

#[test]
fn failure_keeps_previous_values_and_read_at() {
    let root = tmp_root("fail-keep", &["aria"]);
    let (p, f) = setup(&root, false);
    f.set("aria", Pct::Ok(50.0));
    p.tick();
    f.advance(USAGE_POLL_IDLE_MS);
    f.set("aria", Pct::Fail);
    p.tick();
    let a = account(&read_file(&root), "aria").clone();
    assert_eq!(a["readAtMs"], json!(T0 as i64));
    assert_eq!(a["session"]["usedPercent"], 50);
    assert_eq!(a["error"], "timeout");
}

#[test]
fn never_read_account_has_no_windows() {
    let root = tmp_root("never", &["aria"]);
    let (p, f) = setup(&root, false);
    f.set("aria", Pct::Fail);
    p.tick();
    assert_eq!(
        *account(&read_file(&root), "aria"),
        json!({"pool": "work", "account": "aria", "signIn": null, "session": null, "weekly": null,
               "modelWeekly": [], "readAtMs": null, "error": "timeout"})
    );
}

#[test]
fn account_removed_from_disk_leaves_file() {
    let root = tmp_root("gone", &["aria", "bex"]);
    let (p, f) = setup(&root, false);
    p.tick();
    fs::remove_dir_all(root.join("work").join("bex")).unwrap();
    f.advance(1000.0);
    p.tick();
    let file = read_file(&root);
    let names: Vec<&str> = file["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["account"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["aria"]);
}

#[test]
fn forget_remeasures_only_that_account() {
    let root = tmp_root("forget", &["aria", "cedar"]);
    let (p, f) = setup(&root, false);
    f.set("aria", Pct::Ok(40.0));
    p.tick();
    f.take_calls();
    f.set("aria", Pct::Ok(5.0));
    f.advance(1000.0);
    p.forget(&root.join("work").join("aria"));
    assert_eq!(f.take_calls(), ["aria"]);
    assert_eq!(
        account(&read_file(&root), "aria")["session"]["usedPercent"],
        5
    );
}

#[test]
fn overlapping_ticks_measure_once() {
    let root = tmp_root("overlap", &["aria"]);
    let (p, f) = setup(&root, false);
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    // 첫 회차를 잼 함수 안에서 붙잡아 둔다.
    let p2 = {
        let g = gate.clone();
        let calls = f.calls.clone();
        let clock = f.clock.clone();
        ClaudeUsagePoller::new(PollerOpts {
            root: root.clone(),
            pools_path: root.join("pools.json"),
            now: Box::new(move || clock.load(Ordering::SeqCst) as f64),
            read_sign_in: Box::new(|_| None),
            measure: Box::new(move |_| {
                calls.lock().unwrap().push("aria".into());
                let (m, cv) = &*g;
                let mut open = m.lock().unwrap();
                while !*open {
                    open = cv.wait(open).unwrap();
                }
                Measured::failed(T0, "timeout")
            }),
            log: None,
            shared_file: false,
        })
    };
    drop(p);
    let a = {
        let p = p2.clone();
        std::thread::spawn(move || p.tick())
    };
    while f.calls.lock().unwrap().is_empty() {
        std::thread::sleep(Duration::from_millis(5));
    }
    let b = {
        let p = p2.clone();
        std::thread::spawn(move || p.tick())
    };
    std::thread::sleep(Duration::from_millis(50));
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
    a.join().unwrap();
    b.join().unwrap();
    assert_eq!(f.take_calls(), ["aria"]);
}

#[test]
fn shared_file_merges_with_other_writer() {
    let root = tmp_root("shared", &["aria", "bex"]);
    // 다른 프로세스가 쓴 값: 내가 모르는 계정(zed), 나보다 최근에 잰 aria.
    fs::write(
        root.join(CLAUDE_USAGE_FILE),
        serde_json::to_string(&json!({"version": 1, "writtenAtMs": 1, "accounts": [
            {"pool": "other", "account": "zed", "signIn": null, "session": null, "weekly": null,
             "modelWeekly": [], "readAtMs": 5, "extraKey": true},
            {"pool": "work", "account": "aria", "signIn": null, "session": null, "weekly": null,
             "modelWeekly": [], "readAtMs": T0 + 10.0},
        ]}))
        .unwrap(),
    )
    .unwrap();
    let (p, f) = setup(&root, true);
    f.set("aria", Pct::Ok(30.0));
    f.set("bex", Pct::Ok(10.0));
    p.tick();
    let file = read_file(&root);
    let accts = file["accounts"].as_array().unwrap();
    let names: Vec<&str> = accts
        .iter()
        .map(|a| a["account"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["zed", "aria", "bex"]);
    // 모르는 키까지 그대로 남는다.
    assert_eq!(account(&file, "zed")["extraKey"], true);
    // 디스크 쪽이 더 최근이면 그것을 남긴다.
    assert_eq!(account(&file, "aria")["session"], Value::Null);
    assert_eq!(account(&file, "bex")["session"]["usedPercent"], 10);
    assert!(!root.join("usage.json.lock").exists());

    // 내가 사라진 것을 본 계정만 남의 값에서도 뺀다.
    fs::remove_dir_all(root.join("work").join("bex")).unwrap();
    f.advance(1000.0);
    p.tick();
    let file = read_file(&root);
    let names: Vec<&str> = file["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["account"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["zed", "aria"]);
}

#[test]
fn merge_prefers_newer_and_mine_on_tie() {
    let e = |acct: &str, at: Value, tag: &str| json!({"pool": "p", "account": acct, "readAtMs": at, "tag": tag});
    let out = merge_usage_entries(
        vec![
            e("a", json!(10), "disk"),
            e("b", json!(10), "disk"),
            e("c", json!(1), "disk"),
        ],
        vec![
            e("a", json!(10), "mine"),
            e("b", json!(5), "mine"),
            e("d", Value::Null, "mine"),
        ],
        &HashSet::from([usage_key("p", "c")]),
    );
    let tags: Vec<String> = out
        .iter()
        .map(|v| {
            format!(
                "{}:{}",
                v["account"].as_str().unwrap(),
                v["tag"].as_str().unwrap()
            )
        })
        .collect();
    assert_eq!(tags, ["a:mine", "b:disk", "d:mine"]);
}

#[test]
fn wrong_version_on_disk_is_ignored() {
    let root = tmp_root("badver", &["aria"]);
    fs::write(
        root.join(CLAUDE_USAGE_FILE),
        r#"{"version":2,"accounts":[{"pool":"x","account":"y"}]}"#,
    )
    .unwrap();
    assert!(read_usage_file(&root.join(CLAUDE_USAGE_FILE)).is_empty());
    fs::write(root.join(CLAUDE_USAGE_FILE), "{broken").unwrap();
    assert!(read_usage_file(&root.join(CLAUDE_USAGE_FILE)).is_empty());
}

#[test]
fn background_thread_ticks_and_stops() {
    let root = tmp_root("thread", &["aria"]);
    let (p, f) = setup(&root, false);
    let h = p
        .start_with(Duration::from_millis(10), Duration::from_secs(3600))
        .unwrap();
    while f.calls.lock().unwrap().is_empty() {
        std::thread::sleep(Duration::from_millis(5));
    }
    p.stop();
    h.join().unwrap();
    assert!(root.join(CLAUDE_USAGE_FILE).exists());
}

#[test]
fn sign_in_key_matches_ts_and_hides_ids() {
    let root = tmp_root("signin", &["aria", "bex", "cy"]);
    let oauth = |org: &str, acct: &str| {
        json!({"oauthAccount": {"organizationUuid": org, "accountUuid": acct, "emailAddress": "a@example.com"}})
            .to_string()
    };
    fs::write(
        root.join("work/aria/.claude.json"),
        oauth("org-1", "acct-1"),
    )
    .unwrap();
    fs::write(root.join("work/bex/.claude.json"), oauth("org-1", "acct-1")).unwrap();
    let a = read_sign_in_key(&root.join("work/aria")).unwrap();
    // node: createHash('sha256').update('org-1:acct-1').digest('hex').slice(0, 16)
    assert_eq!(a, "163c300f042dd8e9");
    assert!(!a.contains("org-1"));
    assert_eq!(
        read_sign_in_key(&root.join("work/bex")).as_deref(),
        Some(a.as_str())
    );
    assert_eq!(read_sign_in_key(&root.join("work/cy")), None);
}
