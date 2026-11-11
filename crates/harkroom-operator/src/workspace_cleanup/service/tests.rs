use super::*;
use crate::workspace_cleanup::BlockReason;
use std::path::Path;

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn tmpdir() -> Tmp {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let d = std::env::temp_dir().join(format!("hk-c5s-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    Tmp(d)
}

#[derive(Default)]
struct Fake {
    removed: Mutex<Vec<String>>,
}
impl CleanupPorts for Arc<Fake> {
    fn check(&self, _: &CleanupItem, _: &HashSet<String>) -> Option<BlockReason> {
        None
    }
    fn remove(&self, item: &CleanupItem) -> Result<(), String> {
        self.removed.lock().unwrap().push(item.path.clone());
        Ok(())
    }
    fn size(&self, _: &str) -> Option<f64> {
        None
    }
    fn remove_deps(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

const NOW: u64 = 1_800_000_000_000;

fn service(root: &Path) -> (WorkspaceCleanup, Arc<Fake>, Arc<CleanupOwners>) {
    let owners = Arc::new(CleanupOwners::new(
        root.join("owners.json"),
        Box::new(|| NOW),
        Box::new(|| true),
        None,
        Box::new(|_| {}),
    ));
    let fake = Arc::new(Fake::default());
    let deps = CleanupServiceDeps {
        ledger_path: root.join("ledger.json"),
        config: LocalAgents::new(root.to_str().unwrap(), "https://example.invalid"),
        owners: owners.clone(),
        agents: Box::new(Vec::new),
        forward: Box::new(|_, _| unreachable!("묻지 않는다")),
        scan: Arc::new(ScanDeps {
            exec: Arc::new(|_: &str, _: &[String], _: &[(String, String)]| {
                crate::local_merge::ExecResult {
                    code: 1,
                    stdout: String::new(),
                    stderr: String::new(),
                }
            }),
            git_path: "/nonexistent".into(),
            gh_path: "/nonexistent".into(),
            gh_env: vec![],
            home: root.to_str().unwrap().into(),
            protected: vec![],
        }),
        now: Box::new(|| NOW),
        log: Box::new(|_| {}),
    };
    (
        WorkspaceCleanup::new(deps, Box::new(fake.clone())),
        fake,
        owners,
    )
}

fn listed(path: &str, kind: CleanupKind) -> CleanupItem {
    CleanupItem {
        state: CleanupState::Listed,
        thread: Some(ThreadRef {
            channel_id: "11111111-1111-1111-1111-111111111111".into(),
            thread_root_id: "22222222-2222-2222-2222-222222222222".into(),
        }),
        listed_at: Some(iso_from_ms(NOW - 2 * DAY_MS)),
        delete_after: Some(iso_from_ms(NOW + 5 * DAY_MS)),
        ..CleanupItem::blank(path, kind)
    }
}

fn seed(root: &Path, items: Vec<CleanupItem>) {
    write_ledger(
        &root.join("ledger.json"),
        &CleanupLedger {
            items,
            ..CleanupLedger::default()
        },
    )
    .unwrap();
}

#[test]
fn settings_default_off_and_written_to_operator_json() {
    let t = tmpdir();
    let (s, _, _) = service(&t.0);
    assert_eq!(
        s.get()["settings"],
        json!({ "enabled": false, "graceDays": 7 })
    );
    let v = s
        .set_settings(&json!({ "enabled": true, "graceDays": 99 }))
        .unwrap();
    assert_eq!(v["settings"], json!({ "enabled": true, "graceDays": 30 }));
    let raw: Value =
        serde_json::from_str(&std::fs::read_to_string(t.0.join("operator/operator.json")).unwrap())
            .unwrap();
    assert_eq!(raw["cleanup"], json!({ "enabled": true, "graceDays": 30 }));
    // 준 칸만 바꾼다.
    let v = s.set_settings(&json!({ "graceDays": 3 })).unwrap();
    assert_eq!(v["settings"], json!({ "enabled": true, "graceDays": 3 }));
}

#[test]
fn grace_change_recomputes_delete_after() {
    let t = tmpdir();
    let (s, _, _) = service(&t.0);
    seed(&t.0, vec![listed("/tmp/x/wt", CleanupKind::Worktree)]);
    s.set_settings(&json!({ "graceDays": 3 })).unwrap();
    let l = read_ledger(&t.0.join("ledger.json"));
    assert_eq!(l.items[0].delete_after, Some(iso_from_ms(NOW + DAY_MS)));
}

#[test]
fn delete_now_refused_when_off() {
    let t = tmpdir();
    let (s, fake, _) = service(&t.0);
    seed(&t.0, vec![listed("/tmp/x/wt", CleanupKind::Worktree)]);
    assert!(s.act("/tmp/x/wt", HumanAction::DeleteNow, "u").is_err());
    assert!(fake.removed.lock().unwrap().is_empty());
}

#[test]
fn delete_now_worktree_goes_to_ports_and_stamps_by() {
    let t = tmpdir();
    let (s, fake, _) = service(&t.0);
    s.set_settings(&json!({ "enabled": true })).unwrap();
    seed(&t.0, vec![listed("/tmp/x/wt", CleanupKind::Worktree)]);
    s.act("/tmp/x/wt", HumanAction::DeleteNow, "u1").unwrap();
    assert_eq!(*fake.removed.lock().unwrap(), vec!["/tmp/x/wt".to_string()]);
    let l = read_ledger(&t.0.join("ledger.json"));
    assert!(l.items.is_empty());
    assert_eq!(l.events.last().unwrap().by.as_deref(), Some("u1"));
}

#[test]
fn thread_dir_is_never_removed_by_operator() {
    let t = tmpdir();
    let (s, fake, _) = service(&t.0);
    s.set_settings(&json!({ "enabled": true })).unwrap();
    let item = listed("/tmp/x/thread", CleanupKind::ThreadDir);
    seed(&t.0, vec![item.clone()]);
    let _ = s.act("/tmp/x/thread", HumanAction::DeleteNow, "u1");
    assert!(fake.removed.lock().unwrap().is_empty());
    // 러너에게 맡겼다 — 원장에는 남는다.
    assert_eq!(read_ledger(&t.0.join("ledger.json")).items.len(), 1);
}
