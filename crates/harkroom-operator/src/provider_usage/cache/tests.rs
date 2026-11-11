//! TS `test/usageChain.test.ts` 의 캐시 경우를 옮긴다(TTL·공유·stale·force·forget).
use super::*;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::Duration;

fn clock() -> (Arc<AtomicU64>, impl Fn() -> f64 + Send + Sync + 'static) {
    let t = Arc::new(AtomicU64::new(1_000_000));
    let c = t.clone();
    (t, move || c.load(Ordering::SeqCst) as f64)
}

fn m(p: f64) -> Measured {
    let mut v = Measured::failed(0.0, "x");
    v.error = None;
    v.fetched_at_ms = p;
    v
}

fn counting(n: &Arc<AtomicUsize>, val: f64) -> impl FnOnce() -> Measured + Send + 'static {
    let n = n.clone();
    move || {
        n.fetch_add(1, Ordering::SeqCst);
        m(val)
    }
}

#[test]
fn ttl_reuses_then_reloads() {
    let (t, now) = clock();
    let c = UsageCache::new(1000.0, now);
    let n = Arc::new(AtomicUsize::new(0));
    assert_eq!(
        c.get("a", counting(&n, 1.0), CacheOpts::default())
            .fetched_at_ms,
        1.0
    );
    assert_eq!(
        c.get("a", counting(&n, 2.0), CacheOpts::default())
            .fetched_at_ms,
        1.0
    );
    assert_eq!(n.load(Ordering::SeqCst), 1);
    t.fetch_add(1000, Ordering::SeqCst);
    assert_eq!(
        c.get("a", counting(&n, 3.0), CacheOpts::default())
            .fetched_at_ms,
        3.0
    );
    assert_eq!(n.load(Ordering::SeqCst), 2);
}

#[test]
fn concurrent_callers_share_one_load() {
    let (_t, now) = clock();
    let c = UsageCache::new(1000.0, now);
    let (go_tx, go_rx) = mpsc::channel::<()>();
    let n = Arc::new(AtomicUsize::new(0));
    let n1 = n.clone();
    let c1 = c.clone();
    let first = std::thread::spawn(move || {
        c1.get(
            "a",
            move || {
                n1.fetch_add(1, Ordering::SeqCst);
                go_rx.recv().unwrap();
                m(7.0)
            },
            CacheOpts::default(),
        )
    });
    while n.load(Ordering::SeqCst) == 0 {
        std::thread::sleep(Duration::from_millis(5));
    }
    let c2 = c.clone();
    let n2 = n.clone();
    let second = std::thread::spawn(move || c2.get("a", counting(&n2, 9.0), CacheOpts::default()));
    std::thread::sleep(Duration::from_millis(30));
    go_tx.send(()).unwrap();
    assert_eq!(first.join().unwrap().fetched_at_ms, 7.0);
    assert_eq!(second.join().unwrap().fetched_at_ms, 7.0);
    assert_eq!(n.load(Ordering::SeqCst), 1);
}

#[test]
fn stale_returns_old_then_swaps_in_background() {
    let (t, now) = clock();
    let c = UsageCache::new(1000.0, now);
    let n = Arc::new(AtomicUsize::new(0));
    c.get("a", counting(&n, 1.0), CacheOpts::default());
    t.fetch_add(5000, Ordering::SeqCst);
    let stale = CacheOpts {
        stale: true,
        force: false,
    };
    assert_eq!(c.get("a", counting(&n, 2.0), stale).fetched_at_ms, 1.0);
    for _ in 0..200 {
        if n.load(Ordering::SeqCst) == 2
            && c.get("a", counting(&n, 99.0), CacheOpts::default())
                .fetched_at_ms
                == 2.0
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("뒤에서 잰 값이 들어오지 않았다");
}

#[test]
fn stale_without_old_value_waits() {
    let (_t, now) = clock();
    let c = UsageCache::new(1000.0, now);
    let n = Arc::new(AtomicUsize::new(0));
    let stale = CacheOpts {
        stale: true,
        force: false,
    };
    assert_eq!(c.get("a", counting(&n, 4.0), stale).fetched_at_ms, 4.0);
}

#[test]
fn force_skips_ttl_and_caches_result() {
    let (_t, now) = clock();
    let c = UsageCache::new(60_000.0, now);
    let n = Arc::new(AtomicUsize::new(0));
    c.get("a", counting(&n, 1.0), CacheOpts::default());
    let force = CacheOpts {
        stale: false,
        force: true,
    };
    assert_eq!(c.get("a", counting(&n, 2.0), force).fetched_at_ms, 2.0);
    assert_eq!(
        c.get("a", counting(&n, 3.0), CacheOpts::default())
            .fetched_at_ms,
        2.0
    );
    assert_eq!(n.load(Ordering::SeqCst), 2);
}

#[test]
fn forget_drops_and_late_revalidate_does_not_resurrect() {
    let (t, now) = clock();
    let c = UsageCache::new(1000.0, now);
    let n = Arc::new(AtomicUsize::new(0));
    c.get("a", counting(&n, 1.0), CacheOpts::default());
    t.fetch_add(5000, Ordering::SeqCst);
    let (go_tx, go_rx) = mpsc::channel::<()>();
    let stale = CacheOpts {
        stale: true,
        force: false,
    };
    assert_eq!(
        c.get(
            "a",
            move || {
                go_rx.recv().unwrap();
                m(2.0)
            },
            stale
        )
        .fetched_at_ms,
        1.0
    );
    c.forget("a");
    go_tx.send(()).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(
        c.get("a", counting(&n, 3.0), CacheOpts::default())
            .fetched_at_ms,
        3.0
    );
}

#[test]
fn forget_under_drops_dir_and_children_only() {
    let (_t, now) = clock();
    let c = UsageCache::new(60_000.0, now);
    let n = Arc::new(AtomicUsize::new(0));
    for k in ["/p/pool", "/p/pool/a", "/p/pool2/a"] {
        c.get(k, counting(&n, 1.0), CacheOpts::default());
    }
    c.forget_under(Path::new("/p/pool"));
    assert_eq!(
        c.get("/p/pool", counting(&n, 2.0), CacheOpts::default())
            .fetched_at_ms,
        2.0
    );
    assert_eq!(
        c.get("/p/pool/a", counting(&n, 2.0), CacheOpts::default())
            .fetched_at_ms,
        2.0
    );
    assert_eq!(
        c.get("/p/pool2/a", counting(&n, 2.0), CacheOpts::default())
            .fetched_at_ms,
        1.0
    );
}

#[test]
fn panic_in_load_drops_entry() {
    let (_t, now) = clock();
    let c = UsageCache::new(60_000.0, now);
    let n = Arc::new(AtomicUsize::new(0));
    let v = c.get("a", || panic!("boom"), CacheOpts::default());
    assert_eq!(v.error.as_deref(), Some("network"));
    assert_eq!(
        c.get("a", counting(&n, 5.0), CacheOpts::default())
            .fetched_at_ms,
        5.0
    );
}
