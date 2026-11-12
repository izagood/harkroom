use std::cell::{Cell, RefCell};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;

use super::*;

/// 서버 흉내. 호출 수를 세고, `down` 이면 실패한다.
#[derive(Default)]
struct Fake {
    core: RefCell<Option<String>>,
    slugs: RefCell<Vec<String>>,
    rev: RefCell<Option<String>>,
    extra: RefCell<Value>,
    down: Cell<bool>,
    lists: Cell<u32>,
    gets: Cell<u32>,
}

impl Fake {
    fn new(core: Option<&str>, slugs: &[&str], rev: Option<&str>) -> Self {
        let f = Fake::default();
        *f.core.borrow_mut() = core.map(str::to_owned);
        *f.slugs.borrow_mut() = slugs.iter().map(|s| s.to_string()).collect();
        *f.rev.borrow_mut() = rev.map(str::to_owned);
        *f.extra.borrow_mut() = json!({});
        f
    }
    fn set(&self, core: &str, rev: &str) {
        *self.core.borrow_mut() = Some(core.into());
        *self.rev.borrow_mut() = Some(rev.into());
    }
    fn calls(&self) -> (u32, u32) {
        (self.lists.get(), self.gets.get())
    }
}

impl MemorySource for Fake {
    type Error = String;
    fn list_memory(&self) -> Result<Value, String> {
        self.lists.set(self.lists.get() + 1);
        if self.down.get() {
            return Err("server down".into());
        }
        let mut slugs = self.slugs.borrow().clone();
        if self.core.borrow().is_some() {
            slugs.insert(0, "core".into());
        }
        let mut v = json!({"slugs": slugs});
        if let Some(r) = &*self.rev.borrow() {
            v["rev"] = json!(r);
        }
        for (k, x) in self.extra.borrow().as_object().unwrap() {
            v[k] = x.clone();
        }
        Ok(v)
    }
    fn get_memory_value(&self, _: &str) -> Result<Option<String>, String> {
        self.gets.set(self.gets.get() + 1);
        if self.down.get() {
            return Err("server down".into());
        }
        Ok(self.core.borrow().clone())
    }
}

const T0: u64 = 1_790_553_600_000; // 2026-09-28T00:00:00Z

fn setup(tag: &str) -> (PathBuf, Arc<AtomicU64>) {
    let d = std::env::temp_dir().join(format!("hr-memcache-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    (d, Arc::new(AtomicU64::new(T0)))
}

fn cache(d: &Path, clock: &Arc<AtomicU64>) -> MemoryCache {
    let c = clock.clone();
    MemoryCache::with(
        d,
        Box::new(move || u128::from(c.load(Ordering::SeqCst))),
        Box::new(|_| {}),
    )
}

fn read(core: Option<&str>, slugs: &[&str]) -> MemoryRead {
    MemoryRead {
        core: core.map(str::to_owned),
        slugs: slugs.iter().map(|s| s.to_string()).collect(),
        ..MemoryRead::default()
    }
}

#[test]
fn first_read_fetches_and_persists_0600_snapshot() {
    use std::os::unix::fs::PermissionsExt;
    let (d, clock) = setup("first");
    let f = Fake::new(Some("C"), &["mem/a"], Some("r1"));
    assert_eq!(
        cache(&d, &clock).read(&f).unwrap(),
        read(Some("C"), &["mem/a"])
    );
    assert_eq!(f.calls(), (1, 1));
    let file = d.join(MEMORY_CACHE_FILE);
    let saved: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(
        saved,
        json!({"rev": "r1", "core": "C", "slugs": ["mem/a"], "fetchedAt": "2026-09-28T00:00:00.000Z"})
    );
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn matching_batch_rev_serves_snapshot_with_zero_round_trips() {
    let (d, clock) = setup("hit");
    let f = Fake::new(Some("C"), &[], Some("r1"));
    let c = cache(&d, &clock);
    c.read(&f).unwrap();
    c.note_rev(Some("r1"));
    assert_eq!(c.read(&f).unwrap(), read(Some("C"), &[]));
    assert_eq!(f.calls(), (1, 1));
}

#[test]
fn batch_hint_is_one_shot() {
    let (d, clock) = setup("oneshot");
    let f = Fake::new(Some("C"), &[], Some("r1"));
    let c = cache(&d, &clock);
    c.read(&f).unwrap();
    c.note_rev(Some("r1"));
    c.read(&f).unwrap();
    f.set("C2", "r2");
    assert_eq!(c.read(&f).unwrap(), read(Some("C2"), &[]));
    assert_eq!(f.calls(), (2, 2));
}

#[test]
fn stale_batch_hint_is_ignored() {
    let (d, clock) = setup("stalehint");
    let f = Fake::new(Some("C"), &[], Some("r1"));
    let c = cache(&d, &clock);
    c.read(&f).unwrap();
    c.note_rev(Some("r1"));
    clock.fetch_add(HINT_TTL_MS as u64 + 1, Ordering::SeqCst);
    f.set("C2", "r2");
    assert_eq!(c.read(&f).unwrap().core.as_deref(), Some("C2"));
}

#[test]
fn same_rev_from_list_skips_core() {
    let (d, clock) = setup("samerev");
    let f = Fake::new(Some("C"), &[], Some("r1"));
    let c = cache(&d, &clock);
    c.read(&f).unwrap();
    c.read(&f).unwrap();
    assert_eq!(f.calls(), (2, 1));
}

#[test]
fn bg_cleanup_tracks_list_independent_of_rev_and_persists() {
    let (d, clock) = setup("bg");
    let f = Fake::new(Some("C"), &[], Some("r1"));
    let c = cache(&d, &clock);
    assert!(!c.read(&f).unwrap().bg_cleanup);
    *f.extra.borrow_mut() = json!({"bgCleanup": true});
    assert!(c.read(&f).unwrap().bg_cleanup);
    let saved: Value =
        serde_json::from_str(&fs::read_to_string(d.join(MEMORY_CACHE_FILE)).unwrap()).unwrap();
    assert_eq!(saved["bgCleanup"], json!(true));
    *f.extra.borrow_mut() = json!({});
    assert!(!c.read(&f).unwrap().bg_cleanup);
    assert_eq!(f.gets.get(), 1);
}

#[test]
fn changed_rev_fetches_new_core() {
    let (d, clock) = setup("changed");
    let f = Fake::new(Some("C"), &[], Some("r1"));
    let c = cache(&d, &clock);
    c.read(&f).unwrap();
    c.note_rev(Some("r2"));
    f.set("C2", "r2");
    *f.slugs.borrow_mut() = vec!["mem/new".into()];
    assert_eq!(c.read(&f).unwrap(), read(Some("C2"), &["mem/new"]));
}

#[test]
fn server_failure_falls_back_to_snapshot_marked_stale() {
    let (d, clock) = setup("fallback");
    let f = Fake::new(Some("C"), &["mem/a"], Some("r1"));
    let c = cache(&d, &clock);
    c.read(&f).unwrap();
    f.down.set(true);
    assert_eq!(
        c.read(&f).unwrap(),
        MemoryRead {
            stale: Some("2026-09-28T00:00:00.000Z".into()),
            ..read(Some("C"), &["mem/a"])
        }
    );
}

#[test]
fn fresh_runner_falls_back_to_snapshot_on_disk() {
    let (d, clock) = setup("restart");
    cache(&d, &clock)
        .read(&Fake::new(Some("C"), &[], Some("r1")))
        .unwrap();
    let second = Fake::new(Some("X"), &[], Some("r9"));
    second.down.set(true);
    assert_eq!(
        cache(&d, &clock).read(&second).unwrap().core.as_deref(),
        Some("C")
    );
}

#[test]
fn failure_without_snapshot_errors_never_reads_as_empty() {
    let (d, clock) = setup("nosnap");
    let f = Fake::new(Some("C"), &[], Some("r1"));
    f.down.set(true);
    assert_eq!(cache(&d, &clock).read(&f).unwrap_err(), "server down");
}

#[test]
fn corrupt_snapshot_counts_as_none() {
    let (d, clock) = setup("corrupt");
    fs::write(d.join(MEMORY_CACHE_FILE), "{not json").unwrap();
    let f = Fake::new(Some("C"), &[], Some("r1"));
    f.down.set(true);
    assert!(cache(&d, &clock).read(&f).is_err());
}

#[test]
fn entries_descriptions_and_kinds_survive_fallback() {
    let (d, clock) = setup("entries");
    let f = Fake::new(Some("C"), &["mem/a"], Some("r1"));
    *f.extra.borrow_mut() = json!({"entries": [
        {"slug": "core", "description": null},
        {"slug": "mem/a", "description": "요약", "kind": "journal"},
        {"slug": "mem/b", "description": "", "kind": "topic"}
    ]});
    let c = cache(&d, &clock);
    let r = c.read(&f).unwrap();
    let one = |k: &str, v: &str| Some(BTreeMap::from([(k.to_owned(), v.to_owned())]));
    assert_eq!(r.descriptions, one("mem/a", "요약"));
    assert_eq!(r.kinds, one("mem/a", "journal"));
    f.down.set(true);
    assert_eq!(c.read(&f).unwrap().descriptions, one("mem/a", "요약"));
}

#[test]
fn without_server_rev_always_fetches_but_keeps_fallback() {
    let (d, clock) = setup("norev");
    let f = Fake::new(Some("C"), &[], None);
    let c = cache(&d, &clock);
    c.read(&f).unwrap();
    c.note_rev(None);
    c.read(&f).unwrap();
    assert_eq!(f.gets.get(), 2);
    f.down.set(true);
    assert!(c.read(&f).unwrap().stale.is_some());
}

#[test]
fn reads_snapshot_left_by_node_runner() {
    let (d, clock) = setup("nodeshape");
    fs::write(
        d.join(MEMORY_CACHE_FILE),
        r#"{"rev":"r1","core":"C","slugs":["mem/a",3],"fetchedAt":"2026-09-01T00:00:00.000Z","descriptions":{"mem/a":"요약"},"bgCleanup":true}"#,
    )
    .unwrap();
    let f = Fake::new(None, &[], None);
    f.down.set(true);
    let r = cache(&d, &clock).read(&f).unwrap();
    assert_eq!(r.slugs, vec!["mem/a".to_string()]);
    assert!(r.bg_cleanup);
    assert_eq!(r.stale.as_deref(), Some("2026-09-01T00:00:00.000Z"));
}
