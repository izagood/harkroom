//! 정본 `memoryCache.ts` — 러너 메모리 캐시(2026-09-28, 소유자 승인 — 메모리 고도화 PR1).
//!
//! 매 턴 다시 읽기(#139)의 두 값 — 조회가 실패하면 그 턴이 기억 없이 돌고, 턴마다 직렬 두 왕복이 든다 — 을 덜려고 사본을
//! 에이전트 state 에 둔다. 판본(`rev`)으로 맞는지 가리므로 수정은 다음 턴부터 반영된다.
//!
//! - **배치 판본(`note_rev`)**: 폴 응답의 `memoryRev` 가 사본과 같으면 왕복 0회. **한 번만**, **`HINT_TTL_MS` 안에서만** 믿는다.
//! - 힌트가 없거나 다르면 `memory.list` 하나로 rev 를 보고, 같으면 core 를 다시 받지 않는다.
//! - 조회가 실패하면 사본으로 돈다(`stale`). 사본이 **없는** 상태에서 실패하면 던진다 — "기억이 없다"와 "못 읽었다"를 섞지 않는다.
//!
//! 오퍼레이터는 건드리지 않는다 — 캐시는 턴을 조립하는 러너의 일이다. 사본 파일 모양은 정본과 같아 node 러너가 남긴 것을 잇는다.

use std::collections::BTreeMap;
use std::fmt::Display;
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::mcp::HarkroomMcpClient;
use crate::pty_record::iso_utc;
use crate::rest::{HarkroomError, RunnerLink};
use crate::turn_files::write_private;

/// 배치 판본을 믿는 시간(ms). 폴 응답 직후 뜨는 턴만 왕복 0회로 간다 — 그 뒤는 `memory.list` 하나.
pub const HINT_TTL_MS: u128 = 5_000;
/// 사본 파일 이름. 에이전트 state 디렉터리 바로 아래다(지시문 파일과 같은 자리).
pub const MEMORY_CACHE_FILE: &str = "memory-cache.json";

/// 정본 `MemorySnapshot`(디스크 모양 그대로).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    /// 서버 판본. 옛 서버면 `None` — 그때는 사본을 폴백으로만 쓴다.
    pub rev: Option<String>,
    pub core: Option<String>,
    pub slugs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub descriptions: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kinds: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bg_cleanup: bool,
    /// 서버에서 받아 온 시각(ISO).
    pub fetched_at: String,
}

/// 정본 `MemoryRead`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemoryRead {
    pub core: Option<String>,
    pub slugs: Vec<String>,
    pub descriptions: Option<BTreeMap<String, String>>,
    pub kinds: Option<BTreeMap<String, String>>,
    /// 서버가 이 에이전트의 정리를 백그라운드 회차로 맡았다(BG5).
    pub bg_cleanup: bool,
    /// 서버를 못 읽어 사본으로 돈다 — 그 사본을 받은 시각.
    pub stale: Option<String>,
}

/// 서버에서 읽는 두 가지. 실패는 `Err`.
pub trait MemorySource {
    type Error: Display;
    /// `memory.list` 그대로(slugs·rev·entries·bgCleanup).
    fn list_memory(&self) -> Result<Value, Self::Error>;
    fn get_memory_value(&self, slug: &str) -> Result<Option<String>, Self::Error>;
}

impl<L: RunnerLink> MemorySource for HarkroomMcpClient<L> {
    type Error = HarkroomError;
    fn list_memory(&self) -> Result<Value, HarkroomError> {
        HarkroomMcpClient::list_memory(self)
    }
    fn get_memory_value(&self, slug: &str) -> Result<Option<String>, HarkroomError> {
        HarkroomMcpClient::get_memory_value(self, slug)
    }
}

fn view(s: &MemorySnapshot) -> MemoryRead {
    MemoryRead {
        core: s.core.clone(),
        slugs: s.slugs.clone(),
        descriptions: s.descriptions.clone(),
        kinds: s.kinds.clone(),
        bg_cleanup: s.bg_cleanup,
        stale: None,
    }
}

struct Inner {
    /// `None` = 아직 디스크를 안 읽었다.
    snap: Option<Option<MemorySnapshot>>,
    hint: Option<(String, u128)>,
}

type Clock = Box<dyn Fn() -> u128 + Send + Sync>;
type Log = Box<dyn Fn(&str) + Send + Sync>;

/// 정본 `createMemoryCache`. 병렬 턴이 같이 쓰므로 안쪽은 잠근다(정본은 한 스레드 이벤트 루프).
pub struct MemoryCache {
    state_dir: PathBuf,
    file: PathBuf,
    now_ms: Clock,
    log: Log,
    inner: Mutex<Inner>,
}

fn epoch_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn str_map(v: Option<&Value>) -> Option<BTreeMap<String, String>> {
    let m: BTreeMap<String, String> = v?
        .as_object()?
        .iter()
        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
        .collect();
    Some(m)
}

/// 정본 `load` 의 판정 — `slugs` 배열과 `fetchedAt` 문자열이 없으면 사본이 없는 것과 같다.
fn parse_snapshot(text: &str) -> Option<MemorySnapshot> {
    let v: Value = serde_json::from_str(text).ok()?;
    let slugs = v.get("slugs")?.as_array()?;
    let fetched_at = v.get("fetchedAt")?.as_str()?.to_owned();
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    Some(MemorySnapshot {
        rev: s("rev"),
        core: s("core"),
        slugs: slugs
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        descriptions: str_map(v.get("descriptions")),
        kinds: str_map(v.get("kinds")),
        bg_cleanup: v.get("bgCleanup") == Some(&Value::Bool(true)),
        fetched_at,
    })
}

impl MemoryCache {
    /// `state_dir` 는 이 에이전트(인스턴스)의 state 디렉터리.
    pub fn new(state_dir: &Path) -> Self {
        Self::with(
            state_dir,
            Box::new(epoch_ms),
            Box::new(|l| eprintln!("{l}")),
        )
    }

    pub fn with(state_dir: &Path, now_ms: Clock, log: Log) -> Self {
        Self {
            state_dir: state_dir.to_path_buf(),
            file: state_dir.join(MEMORY_CACHE_FILE),
            now_ms,
            log,
            inner: Mutex::new(Inner {
                snap: None,
                hint: None,
            }),
        }
    }

    /// 방금 받은 폴 배치의 `memoryRev`. 다음 `read()` 한 번에만 쓰인다.
    pub fn note_rev(&self, rev: Option<&str>) {
        let at = (self.now_ms)();
        self.lock().hint = rev.map(|r| (r.to_owned(), at));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 원자적으로 쓴다(0600 임시 파일 → rename). 실패는 삼킨다 — 이번 턴은 방금 받은 값으로 돈다.
    fn persist(&self, next: &MemorySnapshot) {
        let res = fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.state_dir)
            .and_then(|()| {
                let body = serde_json::to_string(next).map_err(std::io::Error::other)?;
                write_private(&self.file, &body)
            });
        if let Err(e) = res {
            (self.log)(&format!(
                "[memoryCache] 사본 저장 실패 — 이번 턴은 받아 온 값으로 돈다: {e}"
            ));
        }
    }

    /// 정본 `read`. 사본이 없는데 서버도 못 읽으면 그 오류를 그대로 돌려준다.
    pub fn read<S: MemorySource>(&self, source: &S) -> Result<MemoryRead, S::Error> {
        // 서버 왕복 동안에도 잠가 둔다 — 정본의 한 줄 이벤트 루프와 같이 사본 쓰기가 엇갈리지 않는다.
        let mut inner = self.lock();
        if inner.snap.is_none() {
            // 없거나 깨졌다 — 사본이 없는 것과 같다.
            inner.snap = Some(
                fs::read_to_string(&self.file)
                    .ok()
                    .and_then(|t| parse_snapshot(&t)),
            );
        }
        let cached = inner.snap.clone().flatten();
        let now = (self.now_ms)();
        let batch_rev = inner
            .hint
            .take()
            .filter(|(_, at)| now.saturating_sub(*at) <= HINT_TTL_MS)
            .map(|(r, _)| r);
        if let (Some(b), Some(c)) = (&batch_rev, &cached)
            && c.rev.as_ref() == Some(b)
        {
            return Ok(view(c));
        }

        let fetched = (|| {
            let listed = source.list_memory()?;
            let rev = listed.get("rev").and_then(Value::as_str).map(str::to_owned);
            let all: Vec<String> = listed
                .get("slugs")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            // 정리를 누가 맡나(BG5)는 rev 와 따로 바뀐다 — 목록을 받았으면 늘 지금 값으로.
            let bg_cleanup = listed.get("bgCleanup") == Some(&Value::Bool(true));
            if let (Some(r), Some(c)) = (&rev, &cached)
                && c.rev.as_ref() == Some(r)
            {
                if c.bg_cleanup == bg_cleanup {
                    return Ok((None, view(c)));
                }
                let next = MemorySnapshot {
                    bg_cleanup,
                    ..c.clone()
                };
                let out = view(&next);
                return Ok((Some(next), out));
            }
            let core = if all.iter().any(|s| s == "core") {
                source.get_memory_value("core")?
            } else {
                None
            };
            let entries: Vec<&Value> = listed
                .get("entries")
                .and_then(Value::as_array)
                .map(|a| a.iter().collect())
                .unwrap_or_default();
            let pick = |field: &str, keep: &dyn Fn(&str) -> bool| {
                let m: BTreeMap<String, String> = entries
                    .iter()
                    .filter_map(|e| {
                        let slug = e.get("slug")?.as_str()?;
                        let val = e.get(field)?.as_str()?;
                        (slug != "core" && !val.is_empty() && keep(val))
                            .then(|| (slug.to_owned(), val.to_owned()))
                    })
                    .collect();
                (!m.is_empty()).then_some(m)
            };
            let next = MemorySnapshot {
                rev,
                core,
                slugs: all.into_iter().filter(|s| s != "core").collect(),
                descriptions: pick("description", &|_| true),
                kinds: pick("kind", &|k| k != "topic"),
                bg_cleanup,
                fetched_at: iso_utc((self.now_ms)()),
            };
            let out = view(&next);
            Ok((Some(next), out))
        })();

        match fetched {
            Ok((next, out)) => {
                if let Some(next) = next {
                    self.persist(&next);
                    inner.snap = Some(Some(next));
                }
                Ok(out)
            }
            Err(e) => {
                let Some(c) = cached else { return Err(e) };
                (self.log)(&format!(
                    "[memoryCache] 메모리 조회 실패 — {} 사본으로 돈다: {e}",
                    c.fetched_at
                ));
                Ok(MemoryRead {
                    stale: Some(c.fetched_at.clone()),
                    ..view(&c)
                })
            }
        }
    }
}

#[cfg(test)]
#[path = "memory_cache_tests.rs"]
mod tests;
