//! TS `workspaceCleanupOwners.ts` — 「이 worktree 는 어느 스레드 것인가」의 장부. 러너가 relay 로 보고하고
//! (`CLEANUP_REPORT_PATH`), 청소기가 읽는다.
//!
//! 오퍼레이터는 러너 상태 트리를 읽지 않는다(#431 D5) — 그 안의 사실은 러너가 말로 건넨다.
//! - 스레드별 사실(worktree 들·마지막 턴·작업 폴더)은 `cleanup/owners.json` 에 둔다.
//! - "지금 도는 턴"·지우기 요청은 **메모리에만** 둔다(러너가 죽으면 그 러너가 알린 것은 지운다).
//!
//! TS 보다 좁힌 곳:
//! - owners.json 은 원장과 같은 꼴로 쓴다(폴더 0700·심링크 거절·유일 임시 이름 `create_new` 0600·fsync·rename),
//!   읽기는 `O_NOFOLLOW`. 모양이 틀린 기록은 버린다(TS 는 통째로 믿는다).
//! - 기록의 `worktrees`·`workspaceDir` 은 절대 경로이고 1024자 미만인 것만 남긴다.
//! - 시각 비교는 글자가 아니라 ms 로 한다.
use super::{CLEANUP_REPORT_PATH, ThreadRef, normalize_cleanup_path, read_cleanup_report};
use crate::local_merge::iso_from_ms;
use crate::turn_leases::parse_iso_ms;
use harkroom_proto::p1::{RunnerLinkKind, RunnerLinkRequest, RunnerLinkResponse};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 한 스레드가 알린 worktree 를 몇 개까지 기억하나(TS `.slice(-50)`).
const MAX_OWNER_WORKTREES: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerRecord {
    pub channel_id: String,
    pub thread_root_id: String,
    pub agent_id: String,
    pub worktrees: Vec<String>,
    pub last_turn_at: Option<String>,
    /// 러너 상태 트리 안의 그 스레드 작업 폴더. 러너가 지웠다고 알리면 None.
    #[serde(default)]
    pub workspace_dir: Option<String>,
}

impl OwnerRecord {
    pub fn thread(&self) -> ThreadRef {
        ThreadRef {
            channel_id: self.channel_id.clone(),
            thread_root_id: self.thread_root_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveThread {
    pub delete_requested_at: Option<String>,
    pub runner_connected: bool,
}

/// TS `CleanupLive`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupLive {
    pub threads: BTreeMap<String, LiveThread>,
    pub owners_reported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletedConfirmed {
    pub thread: ThreadRef,
    pub path: String,
}

/// TS `cleanupOwnersPath`.
pub fn cleanup_owners_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("cleanup").join("owners.json")
}

fn abs_ok(s: &str) -> bool {
    s.starts_with('/') && s.len() < 1024 && !s.contains('\0')
}

fn record_ok(r: &OwnerRecord) -> bool {
    !r.channel_id.is_empty()
        && !r.thread_root_id.is_empty()
        && !r.agent_id.is_empty()
        && r.worktrees.iter().all(|w| abs_ok(w))
        && r.workspace_dir.as_deref().is_none_or(abs_ok)
}

/// owners.json 읽기 — 없거나 깨졌거나 심링크면 빈 장부. 모양이 틀린 기록은 버린다.
pub fn read_owners(path: &Path) -> HashMap<String, OwnerRecord> {
    let Ok(text) = crate::hook_run::open_nofollow(path, std::fs::OpenOptions::new().read(true))
        .and_then(|mut f| {
            let mut s = String::new();
            f.read_to_string(&mut s).map(|_| s)
        })
    else {
        return HashMap::new();
    };
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&text) else {
        return HashMap::new();
    };
    map.into_iter()
        .filter_map(|(k, v)| {
            let r: OwnerRecord = serde_json::from_value(v).ok()?;
            (record_ok(&r) && k == r.thread().key()).then_some((k, r))
        })
        .collect()
}

/// owners.json 쓰기 — 원장(`write_ledger`)과 같은 꼴.
pub fn write_owners(path: &Path, all: &HashMap<String, OwnerRecord>) -> std::io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other("no parent"))?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    crate::hook_run::plain_dir(dir)?;
    let tmp = dir.join(format!(
        ".owners.json.tmp-{}-{}",
        std::process::id(),
        crate::runners::new_incarnation_id().unwrap_or_default()
    ));
    let sorted: BTreeMap<&String, &OwnerRecord> = all.iter().collect();
    let body = format!(
        "{}\n",
        serde_json::to_string(&sorted).map_err(std::io::Error::other)?
    );
    let res = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

fn ms_of(s: Option<&str>) -> u64 {
    s.and_then(parse_iso_ms).unwrap_or(0)
}

struct Pending {
    thread: ThreadRef,
    requested_at: String,
}

#[derive(Default)]
struct Inner {
    /// runnerId → 그 러너가 알린 도는 스레드 키.
    running_by: HashMap<String, HashSet<String>>,
    /// runnerId → agentId. 보고한 러너만 오르고 `release_runner` 로 빠진다.
    agent_of: HashMap<String, String>,
    /// threadKey → 지워 달라고 한 스레드. 메모리에만.
    pending_delete: HashMap<String, Pending>,
    deleted_confirmed: Vec<DeletedConfirmed>,
    cache: Option<HashMap<String, OwnerRecord>>,
}

pub type NowMs = Box<dyn Fn() -> u64 + Send + Sync>;
pub type Enabled = Box<dyn Fn() -> bool + Send + Sync>;
pub type LinkedAgents = Box<dyn Fn() -> HashSet<String> + Send + Sync>;

/// TS `createCleanupOwners`.
pub struct CleanupOwners {
    path: PathBuf,
    now: NowMs,
    /// 자동 정리가 지금 켜져 있나 — 답을 짓는 순간 다시 본다(security F1). 못 읽으면 꺼짐으로 보는 것은 부르는 쪽 몫.
    enabled: Enabled,
    /// relay 로 지금 붙어 있는 러너의 에이전트들. 없으면 보고 수신(`agent_of`)으로 잰다.
    linked_agents: Option<LinkedAgents>,
    log: Box<dyn Fn(&str) + Send + Sync>,
    inner: Mutex<Inner>,
}

fn answer(id: &str, status: u16, body: Value) -> RunnerLinkResponse {
    RunnerLinkResponse::HttpResponse {
        id: id.to_string(),
        status,
        body: if status == 204 {
            String::new()
        } else {
            body.to_string()
        },
    }
}

impl CleanupOwners {
    pub fn new(
        path: PathBuf,
        now: NowMs,
        enabled: Enabled,
        linked_agents: Option<LinkedAgents>,
        log: Box<dyn Fn(&str) + Send + Sync>,
    ) -> Self {
        Self {
            path,
            now,
            enabled,
            linked_agents,
            log,
            inner: Mutex::new(Inner::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn load<'a>(&self, inner: &'a mut Inner) -> &'a mut HashMap<String, OwnerRecord> {
        if inner.cache.is_none() {
            inner.cache = Some(read_owners(&self.path));
        }
        inner.cache.as_mut().expect("방금 채웠다")
    }

    /// relay 로 온 정리 보고면 받아 답한다. 아니면 None.
    pub fn maybe_handle(
        &self,
        runner_id: &str,
        agent_id: &str,
        req: &RunnerLinkRequest,
        from: RunnerLinkKind,
    ) -> Option<RunnerLinkResponse> {
        let RunnerLinkRequest::HttpForward {
            id,
            method,
            path,
            body,
            ..
        } = req
        else {
            return None;
        };
        if method != "POST" || path.split('?').next() != Some(CLEANUP_REPORT_PATH) {
            return None;
        }
        // 브릿지(=하네스가 부르는 MCP)로는 못 보낸다 — 모델이 주인을 지어내 남의 worktree 를 목록에 올리면 안 된다.
        if from != RunnerLinkKind::Relay {
            return Some(answer(
                id,
                403,
                json!({"error":{"code":"forbidden","message":"정리 보고는 러너 relay 에서만 받는다"}}),
            ));
        }
        let now = (self.now)();
        let parsed: Value =
            serde_json::from_str(body.as_deref().unwrap_or("")).unwrap_or(Value::Null);
        let Some(report) = read_cleanup_report(&parsed, now) else {
            return Some(answer(
                id,
                400,
                json!({"error":{"code":"bad_request","message":"threads 가 없다"}}),
            ));
        };
        let mut inner = self.lock();
        let run: HashSet<String> = report
            .threads
            .iter()
            .filter(|t| t.running)
            .map(|t| t.thread.key())
            .collect();
        inner.running_by.insert(runner_id.to_string(), run);
        inner
            .agent_of
            .insert(runner_id.to_string(), agent_id.to_string());
        // 되살리기(규칙 4): 요청한 뒤 그 스레드에 턴이 돌거나 새 턴이 왔으면 요청을 거둔다(security F1).
        for t in &report.threads {
            let k = t.thread.key();
            if let Some(p) = inner.pending_delete.get(&k) {
                let newer = t
                    .last_turn_at
                    .as_deref()
                    .is_some_and(|l| ms_of(Some(l)) > ms_of(Some(&p.requested_at)));
                if t.running || newer {
                    inner.pending_delete.remove(&k);
                }
            }
        }
        let mut all = self.load(&mut inner).clone();
        for t in &report.threads {
            let k = t.thread.key();
            let prev = all.get(&k);
            // 같은 스레드를 다른 에이전트가 알리면 덮지 않고 합친다.
            let mut worktrees: Vec<String> = prev.map(|p| p.worktrees.clone()).unwrap_or_default();
            for w in t.worktrees.iter().map(|w| normalize_cleanup_path(w)) {
                if !worktrees.contains(&w) {
                    worktrees.push(w);
                }
            }
            let skip = worktrees.len().saturating_sub(MAX_OWNER_WORKTREES);
            let worktrees: Vec<String> = worktrees.into_iter().skip(skip).collect();
            let last_turn_at = [
                prev.and_then(|p| p.last_turn_at.clone()),
                t.last_turn_at.clone(),
            ]
            .into_iter()
            .flatten()
            .max_by_key(|s| ms_of(Some(s)));
            // 작업 폴더는 **그 에이전트 것만** 받는다 — 지우기 요청은 이 값을 알린 에이전트의 러너에게만 간다.
            let owner = prev.map_or_else(|| agent_id.to_string(), |p| p.agent_id.clone());
            let workspace_dir = match (&t.workspace_dir, owner == agent_id) {
                (Some(d), true) => Some(d.clone()),
                _ => prev.and_then(|p| p.workspace_dir.clone()),
            };
            all.insert(
                k,
                OwnerRecord {
                    channel_id: t.thread.channel_id.clone(),
                    thread_root_id: t.thread.thread_root_id.clone(),
                    agent_id: owner,
                    worktrees,
                    last_turn_at,
                    workspace_dir,
                },
            );
        }
        for d in &report.deleted {
            let k = d.key();
            let Some(prev) = all.get(&k).cloned() else {
                continue;
            };
            // 지워 달라고 한 적 있는 것만 받는다 — 러너가 지어낸 "지웠다"로 남의 항목을 원장에서 빼지 못하게.
            if prev.agent_id != agent_id || !inner.pending_delete.contains_key(&k) {
                continue;
            }
            inner.pending_delete.remove(&k);
            if let Some(p) = &prev.workspace_dir {
                inner.deleted_confirmed.push(DeletedConfirmed {
                    thread: d.clone(),
                    path: p.clone(),
                });
            }
            all.insert(
                k,
                OwnerRecord {
                    workspace_dir: None,
                    ..prev
                },
            );
        }
        if let Err(e) = write_owners(&self.path, &all) {
            (self.log)(&format!("cleanup 주인 장부 쓰기 실패: {e}"));
        }
        inner.cache = Some(all);
        // 답을 짓는 **그 순간에** 다시 본다: 그 에이전트 것이고, 어느 러너에서도 돌지 않고, 요청한 뒤 턴이 없었을 때만.
        let busy: HashSet<String> = inner.running_by.values().flatten().cloned().collect();
        // 꺼져 있으면 하나도 내보내지 않고 기다리던 요청도 거둔다 — 「끄면 지우지 않는다」(security F1).
        if !(self.enabled)() {
            inner.pending_delete.clear();
        }
        let all = inner.cache.as_ref().expect("방금 채웠다");
        let mut delete_threads: Vec<&Pending> = inner
            .pending_delete
            .iter()
            .filter(|(k, p)| {
                all.get(*k).is_some_and(|r| {
                    r.agent_id == agent_id
                        && ms_of(r.last_turn_at.as_deref()) <= ms_of(Some(&p.requested_at))
                }) && !busy.contains(*k)
            })
            .map(|(_, p)| p)
            .collect();
        delete_threads.sort_by_key(|p| p.thread.key());
        let list: Vec<Value> = delete_threads
            .iter()
            .map(|p| json!({"channelId": p.thread.channel_id, "threadRootId": p.thread.thread_root_id}))
            .collect();
        Some(answer(id, 200, json!({ "deleteThreads": list })))
    }

    pub fn release_runner(&self, runner_id: &str) {
        let mut inner = self.lock();
        inner.running_by.remove(runner_id);
        inner.agent_of.remove(runner_id);
    }

    /// 스레드 → 주인 기록(7일 무턴 판정용).
    pub fn threads(&self) -> Vec<OwnerRecord> {
        let mut inner = self.lock();
        let mut v: Vec<OwnerRecord> = self.load(&mut inner).values().cloned().collect();
        v.sort_by_key(|r| r.thread().key());
        v
    }

    /// 이 스레드의 작업 폴더를 지워 달라고 그 러너의 다음 보고 답에 싣는다.
    pub fn request_delete(&self, r: &ThreadRef) {
        let at = iso_from_ms((self.now)());
        self.lock()
            .pending_delete
            .entry(r.key())
            .or_insert_with(|| Pending {
                thread: r.clone(),
                requested_at: at,
            });
    }

    /// 지우기 요청을 거둔다(「보존」).
    pub fn cancel_delete(&self, r: &ThreadRef) {
        self.lock().pending_delete.remove(&r.key());
    }

    /// 원장에서 아직 지울 차례인 스레드 키만 남기고 나머지 요청은 거둔다(회차마다).
    pub fn retain_deletes(&self, keys: &HashSet<String>) {
        self.lock().pending_delete.retain(|k, _| keys.contains(k));
    }

    /// 러너가 지웠다고 알린 스레드들 — 한 번 읽으면 비운다.
    pub fn drain_deleted(&self) -> Vec<DeletedConfirmed> {
        std::mem::take(&mut self.lock().deleted_confirmed)
    }

    /// 화면용 그 순간 상태. `keys` 를 주면 그 스레드만 싣는다.
    pub fn live(&self, keys: Option<&HashSet<String>>) -> CleanupLive {
        let mut inner = self.lock();
        let connected: HashSet<String> = match &self.linked_agents {
            Some(f) => f(),
            None => inner.agent_of.values().cloned().collect(),
        };
        let pending: HashMap<String, String> = inner
            .pending_delete
            .iter()
            .map(|(k, p)| (k.clone(), p.requested_at.clone()))
            .collect();
        let all = self.load(&mut inner);
        let mut threads = BTreeMap::new();
        for (k, rec) in all.iter() {
            if rec.workspace_dir.is_none() || keys.is_some_and(|ks| !ks.contains(k)) {
                continue;
            }
            threads.insert(
                k.clone(),
                LiveThread {
                    delete_requested_at: pending.get(k).cloned(),
                    runner_connected: connected.contains(&rec.agent_id),
                },
            );
        }
        CleanupLive {
            threads,
            owners_reported: !all.is_empty(),
        }
    }

    /// worktree 경로(정규화) → 주인. 같은 경로를 여러 스레드가 알리면 마지막 턴이 늦은 쪽.
    pub fn owner_of(&self) -> HashMap<String, OwnerRecord> {
        let mut inner = self.lock();
        let mut out: HashMap<String, OwnerRecord> = HashMap::new();
        let mut recs: Vec<&OwnerRecord> = self.load(&mut inner).values().collect();
        recs.sort_by_key(|r| r.thread().key());
        for rec in recs {
            for w in &rec.worktrees {
                let later = out.get(w).is_none_or(|p| {
                    ms_of(rec.last_turn_at.as_deref()) > ms_of(p.last_turn_at.as_deref())
                });
                if later {
                    out.insert(w.clone(), rec.clone());
                }
            }
        }
        out
    }

    pub fn last_turn_at(&self) -> HashMap<String, String> {
        let mut inner = self.lock();
        self.load(&mut inner)
            .iter()
            .filter_map(|(k, r)| r.last_turn_at.clone().map(|l| (k.clone(), l)))
            .collect()
    }

    pub fn running(&self) -> HashSet<String> {
        self.lock().running_by.values().flatten().cloned().collect()
    }
}

#[cfg(test)]
mod tests;
