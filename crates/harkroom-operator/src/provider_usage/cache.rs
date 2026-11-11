//! TS `usageChain.ts::createUsageCache` — 키(계정 디렉터리)별로 잰 값을 잠시 들고 있는다.
//!
//! - 같은 키는 TTL(`USAGE_CACHE_MS`, 2분) 안에서 한 번만 잰다. **재는 중인 것도 공유한다** — 폴 둘이 겹쳐도 CLI 는 하나다.
//! - `stale`(화면용 SWR): TTL 이 지났어도 지난 값이 있으면 곧바로 돌려주고, 새로 재는 것은 뒤(스레드)에서 한다.
//! - `force`(사람이 누른 [Refresh usage]): TTL·`stale` 을 건너뛰고 새로 잰 값을 기다린다. 이미 재는 중이면 거기 붙는다.
//! - `forget`·`forget_under`: 다시 로그인했거나 풀을 지운 계정에 옛 로그인의 % 가 되살아나지 않게 버린다.
//!
//! TS 와 다른 점: 오퍼레이터는 tokio 없는 std::thread 구조라 Promise 대신 [`Slot`](값 한 번 채우고 기다리는 칸)을 쓴다.
//! TS 의 "요청이 reject 되면 캐시에서 뺀다"는 Rust 쪽 잼 함수가 실패를 값(`error`)으로 돌려주므로 생기지 않고,
//! 잼 함수가 panic 한 경우에만 같은 처리(캐시에서 빼고 기다리던 쪽에는 `network` 오류 값)를 한다.
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{MAIN_SEPARATOR, Path};
use std::sync::{Arc, Condvar, Mutex};

use super::Measured;

/// TS `USAGE_CACHE_MS`.
pub const USAGE_CACHE_MS: f64 = 2.0 * 60.0 * 1000.0;

/// 한 번 채워지는 값 — 기다리는 쪽은 채워질 때까지 막힌다(TS `Promise<Measured>`).
struct Slot {
    v: Mutex<Option<Measured>>,
    cv: Condvar,
}

impl Slot {
    fn new() -> Arc<Self> {
        Arc::new(Slot {
            v: Mutex::new(None),
            cv: Condvar::new(),
        })
    }
    fn ready(v: Measured) -> Arc<Self> {
        Arc::new(Slot {
            v: Mutex::new(Some(v)),
            cv: Condvar::new(),
        })
    }
    fn set(&self, v: Measured) {
        *self.v.lock().unwrap_or_else(|e| e.into_inner()) = Some(v);
        self.cv.notify_all();
    }
    fn is_set(&self) -> bool {
        self.v.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }
    fn wait(&self) -> Measured {
        let mut g = self.v.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(v) = g.as_ref() {
                return v.clone();
            }
            g = self.cv.wait(g).unwrap_or_else(|e| e.into_inner());
        }
    }
}

struct Entry {
    /// `forget`·새 값으로 갈린 뒤 늦게 끝난 옛 시도를 가려내는 표(TS `entries.get(key) === hit`).
    id: u64,
    at: f64,
    value: Arc<Slot>,
    /// 뒤에서 다시 재는 중인 시도 — 화면이 연달아 물어도 CLI 는 하나다. `force` 도 여기에 붙는다.
    refreshing: Option<Arc<Slot>>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CacheOpts {
    pub stale: bool,
    pub force: bool,
}

type Load = Box<dyn FnOnce() -> Measured + Send + 'static>;

pub struct UsageCache {
    ttl_ms: f64,
    now: Box<dyn Fn() -> f64 + Send + Sync>,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    entries: HashMap<String, Entry>,
}

/// 지금 할 일 — 잠금 밖에서 한다(잼은 수십 초 걸릴 수 있다).
enum Plan {
    Wait(Arc<Slot>),
    /// 새 칸을 세웠다 — 이 스레드가 잰다.
    Store(u64, Arc<Slot>),
    /// 지난 값을 두고 다시 잰다 — `background` 면 스레드로 띄우고 지난 값을, 아니면 기다린다.
    Revalidate {
        id: u64,
        next: Arc<Slot>,
        old: Arc<Slot>,
        background: bool,
    },
}

impl UsageCache {
    pub fn new(ttl_ms: f64, now: impl Fn() -> f64 + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(UsageCache {
            ttl_ms,
            now: Box::new(now),
            inner: Mutex::new(Inner::default()),
        })
    }

    /// 운영 판 — TTL 2분, 벽시계.
    pub fn system() -> Arc<Self> {
        Self::new(USAGE_CACHE_MS, || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as f64)
                .unwrap_or(0.0)
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// TS `cache(key, load, opts)`.
    pub fn get(
        self: &Arc<Self>,
        key: &str,
        load: impl FnOnce() -> Measured + Send + 'static,
        opts: CacheOpts,
    ) -> Measured {
        let plan = {
            let mut g = self.lock();
            let now = (self.now)();
            let hit = g.entries.get(key).map(|e| {
                (
                    e.id,
                    e.at,
                    e.value.clone(),
                    e.refreshing.clone(),
                    e.value.is_set(),
                )
            });
            match hit {
                None => Self::plan_store(&mut g, key, now),
                Some((id, at, value, refreshing, loaded)) => {
                    if opts.force {
                        if !loaded {
                            Plan::Wait(value)
                        } else if let Some(r) = refreshing {
                            Plan::Wait(r)
                        } else {
                            Self::plan_revalidate(&mut g, key, id, value, false)
                        }
                    } else if now - at < self.ttl_ms {
                        Plan::Wait(value)
                    } else if !opts.stale {
                        Self::plan_store(&mut g, key, now)
                    } else if refreshing.is_some() {
                        Plan::Wait(value)
                    } else {
                        Self::plan_revalidate(&mut g, key, id, value, true)
                    }
                }
            }
        };
        match plan {
            Plan::Wait(s) => s.wait(),
            Plan::Store(id, slot) => {
                let v = self.run(key, id, Box::new(load), true);
                slot.set(v.clone());
                v
            }
            Plan::Revalidate {
                id,
                next,
                old,
                background,
            } => {
                let me = self.clone();
                let k = key.to_owned();
                let job = move || {
                    let v = me.run(&k, id, Box::new(load), false);
                    next.set(v.clone());
                    v
                };
                if background {
                    // 지난 값을 지킨다 — 실패해도 다음 물음이 다시 잰다.
                    std::thread::spawn(job);
                    old.wait()
                } else {
                    job()
                }
            }
        }
    }

    fn plan_store(g: &mut Inner, key: &str, now: f64) -> Plan {
        g.next_id += 1;
        let id = g.next_id;
        let slot = Slot::new();
        g.entries.insert(
            key.to_owned(),
            Entry {
                id,
                at: now,
                value: slot.clone(),
                refreshing: None,
            },
        );
        Plan::Store(id, slot)
    }

    fn plan_revalidate(
        g: &mut Inner,
        key: &str,
        id: u64,
        old: Arc<Slot>,
        background: bool,
    ) -> Plan {
        let next = Slot::new();
        if let Some(e) = g.entries.get_mut(key) {
            e.refreshing = Some(next.clone());
        }
        Plan::Revalidate {
            id,
            next,
            old,
            background,
        }
    }

    /// 잰다. 끝나면 — 처음 잰 값(`first`)은 칸이 이미 자리에 있으니 그대로, 다시 잰 값은 그 사이 그 항목이
    /// 버려지거나 갈리지 않았을 때만 새 항목으로 갈아 끼운다(다시 로그인한 계정에 옛 % 가 되살아나면 안 된다).
    /// panic 이면 그 항목을 빼고(곧바로 다시 잴 수 있게) `network` 오류 값을 돌려준다.
    fn run(&self, key: &str, id: u64, load: Load, first: bool) -> Measured {
        let res = catch_unwind(AssertUnwindSafe(load));
        let mut g = self.lock();
        let same = g.entries.get(key).is_some_and(|e| e.id == id);
        match res {
            Ok(v) => {
                if !first && same {
                    g.next_id += 1;
                    let nid = g.next_id;
                    let at = (self.now)();
                    g.entries.insert(
                        key.to_owned(),
                        Entry {
                            id: nid,
                            at,
                            value: Slot::ready(v.clone()),
                            refreshing: None,
                        },
                    );
                }
                v
            }
            Err(_) => {
                if same {
                    if first {
                        g.entries.remove(key);
                    } else if let Some(e) = g.entries.get_mut(key) {
                        e.refreshing = None;
                    }
                }
                Measured::failed((self.now)(), "network")
            }
        }
    }

    /// TS `cache.forget` — 그 키의 값을 버린다.
    pub fn forget(&self, key: &str) {
        self.lock().entries.remove(key);
    }

    /// TS `cache.forgetUnder` — `dir` 과 그 아래 키를 전부 버린다(풀을 통째로 지울 때).
    pub fn forget_under(&self, dir: &Path) {
        let dir = dir.to_string_lossy();
        let prefix = if dir.ends_with(MAIN_SEPARATOR) {
            dir.to_string()
        } else {
            format!("{dir}{MAIN_SEPARATOR}")
        };
        self.lock()
            .entries
            .retain(|k, _| !(k.as_str() == dir.as_ref() || k.starts_with(&prefix)));
    }
}

#[cfg(test)]
mod tests;
