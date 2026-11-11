//! TS `workspaceCleanupService.ts` 의 `createWorkspaceCleanup` 이식 — 원장 파일·설정·회차·사람의 손을 한 줄로 세운다.
//!
//! 이 PR 은 **아무 데도 잇지 않는다** — 소켓 4요청·주기 sweep·relay 가로채기 배선은 뒤 PR(c5-4)이다.
//!
//! - 회차·사람의 손은 **하나씩만** 돈다(`serial` 잠금). 타이머와 손이 겹쳐도 원장을 둘이 동시에 쓰지 않는다.
//! - 설정(`enabled`·`graceDays`)은 `operator.json` 의 `cleanup` 칸. 기본은 **꺼짐**. 쓰기는 `operator.json.lock` 으로 묶는다.
//! - 스레드 폴더·세션 기록은 오퍼레이터가 지우지 않는다 — 그 러너에게 지워 달라고 한다(`request_delete`).
//! - TS 와 다른 점: 설정을 못 읽으면(깨진 `operator.json`) **꺼짐**으로 본다(TS 는 빈 설정 = 꺼짐과 같다).
use super::owners::CleanupOwners;
use super::scan::{
    Forward, ScanDeps, is_thread_done, last_activity_at, only_rebuildable_ignored,
    repo_of_worktree, scan_repo,
};
use super::{
    CLEANUP_GRACE_DEFAULT, CLEANUP_IDLE_DAYS, CleanupEvent, CleanupItem, CleanupKind,
    CleanupLedger, CleanupPorts, CleanupSettings, CleanupState, EventAction, HumanAction,
    ObservedIdle, ObservedWorktree, SweepFacts, SweepPlan, ThreadRef, apply_human_action,
    clamp_grace_days, normalize_cleanup_path, plan_sweep, read_ledger, run_sweep, trim_events,
    unowned_pr_matches, write_ledger,
};
use crate::local_agents::LocalAgents;
use crate::local_merge::iso_from_ms;
use crate::turn_leases::parse_iso_ms;
use harkroom_proto::p1::{RunnerLinkRequest, RunnerLinkResponse};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const DAY_MS: u64 = 86_400_000;

pub type AgentsFn = Box<dyn Fn() -> Vec<(String, Option<String>)> + Send + Sync>;
pub type ForwardFn = Box<dyn Fn(&str, RunnerLinkRequest) -> RunnerLinkResponse + Send + Sync>;

pub struct CleanupServiceDeps {
    pub ledger_path: PathBuf,
    /// `operator.json`(설정 칸 `cleanup`).
    pub config: LocalAgents,
    pub owners: Arc<CleanupOwners>,
    /// 이 오퍼레이터에 배정된 에이전트(id·workingDir).
    pub agents: AgentsFn,
    pub forward: ForwardFn,
    pub scan: Arc<ScanDeps>,
    pub now: Box<dyn Fn() -> u64 + Send + Sync>,
    pub log: Box<dyn Fn(&str) + Send + Sync>,
}

pub struct WorkspaceCleanup {
    deps: CleanupServiceDeps,
    base: Box<dyn CleanupPorts + Send + Sync>,
    serial: Mutex<()>,
    running: AtomicBool,
}

/// TS `readCleanupSettings`. 못 읽으면 꺼짐.
pub fn read_cleanup_settings(config: &LocalAgents) -> CleanupSettings {
    let c = config.read_config().unwrap_or_default();
    let cl = c.get("cleanup");
    CleanupSettings {
        enabled: cl.and_then(|v| v.get("enabled")) == Some(&Value::Bool(true)),
        grace_days: clamp_grace_days(
            cl.and_then(|v| v.get("graceDays"))
                .unwrap_or(&json!(CLEANUP_GRACE_DEFAULT)),
        ),
    }
}

fn settings_json(s: &CleanupSettings) -> Value {
    json!({ "enabled": s.enabled, "graceDays": s.grace_days })
}

/// 서비스용 포트 — 스레드 폴더·세션 기록은 러너에게 맡기고 실패로 남긴다(TS `AwaitingRunner`).
struct ServicePorts<'a> {
    base: &'a (dyn CleanupPorts + Send + Sync),
    owners: &'a CleanupOwners,
}

impl CleanupPorts for ServicePorts<'_> {
    fn check(&self, item: &CleanupItem, r: &HashSet<String>) -> Option<super::BlockReason> {
        self.base.check(item, r)
    }
    fn remove(&self, item: &CleanupItem) -> Result<(), String> {
        if item.kind == CleanupKind::Worktree {
            return self.base.remove(item);
        }
        let Some(t) = &item.thread else {
            return Err("no thread".into());
        };
        self.owners.request_delete(t);
        Err("awaiting runner".into())
    }
    fn size(&self, path: &str) -> Option<f64> {
        self.base.size(path)
    }
    fn remove_deps(&self, root: &str) -> Result<(), String> {
        self.base.remove_deps(root)
    }
}

fn listed_thread_keys(items: &[CleanupItem]) -> HashSet<String> {
    items
        .iter()
        .filter(|i| {
            i.kind != CleanupKind::Worktree
                && matches!(i.state, CleanupState::Listed | CleanupState::Blocked)
        })
        .filter_map(|i| i.thread.as_ref().map(ThreadRef::key))
        .collect()
}

impl WorkspaceCleanup {
    pub fn new(deps: CleanupServiceDeps, base: Box<dyn CleanupPorts + Send + Sync>) -> Self {
        Self {
            deps,
            base,
            serial: Mutex::new(()),
            running: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.serial.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn ports(&self) -> ServicePorts<'_> {
        ServicePorts {
            base: self.base.as_ref(),
            owners: &self.deps.owners,
        }
    }

    pub fn settings(&self) -> CleanupSettings {
        read_cleanup_settings(&self.deps.config)
    }

    /// TS `view` — 화면에는 원장에 있는 스레드 폴더의 상태만 낸다(security n1).
    fn view(&self) -> Value {
        let ledger = read_ledger(&self.deps.ledger_path);
        let keys: HashSet<String> = ledger
            .items
            .iter()
            .filter(|i| i.kind != CleanupKind::Worktree)
            .filter_map(|i| i.thread.as_ref().map(ThreadRef::key))
            .collect();
        json!({
            "settings": settings_json(&self.settings()),
            "ledger": ledger,
            "running": self.running.load(Ordering::SeqCst),
            "live": self.deps.owners.live(Some(&keys)),
        })
    }

    /// `workspaceCleanupGet`.
    pub fn get(&self) -> Value {
        let _g = self.lock();
        self.view()
    }

    /// `workspaceCleanupSettingsSet` — `enabled`(bool)·`graceDays`(수) 중 준 것만 바꾼다.
    pub fn set_settings(&self, next: &Value) -> Result<Value, String> {
        let _g = self.lock();
        let cur = self.settings();
        let enabled = next
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(cur.enabled);
        let grace_days = match next.get("graceDays") {
            None | Some(Value::Null) => cur.grace_days,
            Some(v) => clamp_grace_days(v),
        };
        let s = CleanupSettings {
            enabled,
            grace_days,
        };
        self.deps
            .config
            .modify_config(|c| {
                c.insert("cleanup".into(), settings_json(&s));
                Ok(true)
            })
            .map_err(|e| e.message)?;
        // 끄면 이미 러너에게 나간 지우기 요청도 거둔다(security F1).
        if !enabled {
            self.deps.owners.retain_deletes(&HashSet::new());
        }
        // N 을 바꾸면 기한을 다시 계산한다 — listedAt + N일.
        if grace_days != cur.grace_days {
            let mut ledger = read_ledger(&self.deps.ledger_path);
            for i in &mut ledger.items {
                if matches!(i.state, CleanupState::Listed | CleanupState::Blocked)
                    && let Some(ms) = i.listed_at.as_deref().and_then(parse_iso_ms)
                {
                    i.delete_after = Some(iso_from_ms(ms + grace_days as u64 * DAY_MS));
                }
            }
            write_ledger(&self.deps.ledger_path, &ledger).map_err(|e| e.to_string())?;
        }
        Ok(self.view())
    }

    /// `workspaceCleanupAct`.
    pub fn act(&self, path: &str, action: HumanAction, by: &str) -> Result<Value, String> {
        let _g = self.lock();
        let settings = self.settings();
        if action == HumanAction::DeleteNow && !settings.enabled {
            return Err("자동 정리가 꺼져 있다 — 켠 뒤에 지금 정리할 수 있다".into());
        }
        let now = (self.deps.now)();
        let prev = read_ledger(&self.deps.ledger_path);
        if action == HumanAction::DeleteNow {
            // 넣은 뒤 그 스레드에 새 턴이 왔으면 지금 지우지 않는다(security F1). 다음 회차가 뺀다.
            let item = prev.items.iter().find(|i| i.path == path);
            let last = item
                .and_then(|i| i.thread.as_ref())
                .and_then(|t| self.deps.owners.last_turn_at().get(&t.key()).cloned());
            if let (Some(listed), Some(last)) = (
                item.and_then(|i| i.listed_at.as_deref())
                    .and_then(parse_iso_ms),
                last.as_deref().and_then(parse_iso_ms),
            ) && last > listed
            {
                return Err(
                    "넣은 뒤 그 스레드에 새 턴이 왔다 — 다음 정리 때 목록에서 빠진다".into(),
                );
            }
        }
        let (ledger, actions) = apply_human_action(&prev, path, action, by, &settings, now)?;
        if action == HumanAction::Keep
            && let Some(t) = ledger
                .items
                .iter()
                .find(|i| i.path == path && i.kind != CleanupKind::Worktree)
                .and_then(|i| i.thread.as_ref())
        {
            self.deps.owners.cancel_delete(t);
        }
        let swept = run_sweep(
            SweepPlan { ledger, actions },
            &self.ports(),
            &self.deps.owners.running(),
            now,
        );
        let stamp = iso_from_ms(now);
        let mut next = swept;
        if action == HumanAction::DeleteNow {
            for e in &mut next.events {
                if e.at == stamp && e.path == path && e.by.is_none() {
                    e.by = Some(by.to_string());
                }
            }
        }
        write_ledger(&self.deps.ledger_path, &next).map_err(|e| e.to_string())?;
        Ok(self.view())
    }

    /// TS `observe` — 이번 회차의 사실.
    fn observe(&self, prev: &CleanupLedger) -> SweepFacts {
        let scan = self.deps.scan.as_ref();
        let agents = (self.deps.agents)();
        let owners = self.deps.owners.owner_of();
        let mut repos: Vec<(String, String)> = Vec::new();
        let mut add = |r: &str| {
            let k = normalize_cleanup_path(r);
            if !repos.iter().any(|(n, _)| *n == k) {
                repos.push((k, r.to_string()));
            }
        };
        for (_, wd) in &agents {
            if let Some(w) = wd {
                add(w);
            }
        }
        for i in &prev.items {
            if let Some(r) = &i.repo {
                add(r);
            }
        }
        let mut owner_paths: Vec<&String> = owners.keys().collect();
        owner_paths.sort();
        for p in owner_paths {
            if let Some(r) = repo_of_worktree(scan, p) {
                add(&r);
            }
        }
        // 에이전트의 workingDir 자체는 후보가 아니다.
        let working: HashSet<String> = agents
            .iter()
            .filter_map(|(_, w)| w.as_deref().map(normalize_cleanup_path))
            .collect();
        let mut worktrees: Vec<ObservedWorktree> = Vec::new();
        let mut seen = HashSet::new();
        for (_, repo) in &repos {
            if std::fs::symlink_metadata(PathBuf::from(repo).join(".git")).is_err() {
                continue;
            }
            for w in scan_repo(scan, repo, &owners) {
                if seen.contains(&w.path) || working.contains(&normalize_cleanup_path(&w.path)) {
                    continue;
                }
                seen.insert(w.path.clone());
                worktrees.push(w);
            }
        }
        for w in &mut worktrees {
            if w.thread.is_some() || !unowned_pr_matches(w.pr.as_ref(), w.head_sha.as_deref()) {
                continue;
            }
            let probe = CleanupItem {
                repo: Some(w.repo.clone()),
                branch: w.branch.clone(),
                head_sha: w.head_sha.clone(),
                pr: w.pr.clone(),
                last_modified_at: w.last_modified_at.clone(),
                size_before: w.size,
                size_now: w.size,
                ..CleanupItem::blank(&w.path, CleanupKind::Worktree)
            };
            w.clean = Some(self.base.check(&probe, &HashSet::new()).is_none());
            w.only_rebuildable_ignored = Some(only_rebuildable_ignored(scan, &w.path));
            w.last_activity_at = last_activity_at(scan, &w.path);
        }
        let mut done_threads = HashSet::new();
        let mut asked = HashSet::new();
        let fwd: Forward<'_> = &|a, r| (self.deps.forward)(a, r);
        for w in &worktrees {
            let (Some(t), Some(pr)) = (&w.thread, &w.pr) else {
                continue;
            };
            if pr.state == super::PrState::Open || !asked.insert(t.key()) {
                continue;
            }
            let agent = owners
                .get(&normalize_cleanup_path(&w.path))
                .map(|o| o.agent_id.clone());
            let req_id = format!("cleanup-done-{}", asked.len());
            if let Some(a) = agent
                && is_thread_done(fwd, &a, &t.thread_root_id, &req_id)
            {
                done_threads.insert(t.key());
            }
        }
        let running = self.deps.owners.running();
        let idle_before = (self.deps.now)().saturating_sub(CLEANUP_IDLE_DAYS * DAY_MS);
        let mut idle = Vec::new();
        for t in self.deps.owners.threads() {
            let (Some(dir), Some(last)) = (&t.workspace_dir, &t.last_turn_at) else {
                continue;
            };
            let Some(ms) = parse_iso_ms(last) else {
                continue;
            };
            if ms > idle_before || running.contains(&t.thread().key()) {
                continue;
            }
            idle.push(ObservedIdle {
                path: dir.clone(),
                kind: CleanupKind::ThreadDir,
                thread: t.thread(),
                size: None,
                last_modified_at: Some(last.clone()),
            });
        }
        SweepFacts {
            worktrees,
            idle,
            done_threads,
            last_turn_at: self.deps.owners.last_turn_at(),
            running_threads: running,
        }
    }

    /// `workspaceCleanupSweep`·주기 회차.
    pub fn sweep(&self) -> Result<(), String> {
        let _g = self.lock();
        self.running.store(true, Ordering::SeqCst);
        let r = self.sweep_once();
        self.running.store(false, Ordering::SeqCst);
        r
    }

    fn sweep_once(&self) -> Result<(), String> {
        let settings = self.settings();
        let prev = read_ledger(&self.deps.ledger_path);
        let facts = self.observe(&prev);
        let now = (self.deps.now)();
        let plan = plan_sweep(&prev, &facts, &settings, now);
        let swept = run_sweep(plan, &self.ports(), &facts.running_threads, now);
        // 러너가 지웠다고 알린 스레드 폴더 — 원장에서 빼고 최근 기록에 남긴다.
        let done = self.deps.owners.drain_deleted();
        let gone: HashSet<&str> = done.iter().map(|d| d.path.as_str()).collect();
        let at = iso_from_ms(now);
        let mut events = swept.events.clone();
        events.extend(done.iter().map(|d| CleanupEvent {
            at: at.clone(),
            path: d.path.clone(),
            thread: Some(d.thread.clone()),
            action: EventAction::Deleted,
            by: None,
            bytes: None,
            reason: None,
        }));
        let next = CleanupLedger {
            items: swept
                .items
                .iter()
                .filter(|i| !(i.kind != CleanupKind::Worktree && gone.contains(i.path.as_str())))
                .cloned()
                .collect(),
            events: trim_events(events),
            ..swept
        };
        write_ledger(&self.deps.ledger_path, &next).map_err(|e| e.to_string())?;
        // 꺼져 있으면 남은 요청도 없게 한다(plan_sweep 이 꺼짐이면 아무것도 listed 로 두지 않는 것과 같다).
        let keep = if settings.enabled {
            listed_thread_keys(&next.items)
        } else {
            HashSet::new()
        };
        self.deps.owners.retain_deletes(&keep);
        let n = |s: CleanupState| next.items.iter().filter(|i| i.state == s).count();
        (self.deps.log)(&format!(
            "cleanup: 삭제 예정 {} · ⚠ {} · 보존 {} · 주인 모름 {}",
            n(CleanupState::Listed),
            n(CleanupState::Blocked),
            n(CleanupState::Kept),
            n(CleanupState::Unowned)
        ));
        Ok(())
    }
}

#[allow(dead_code)]
fn _assert_send_sync() {
    fn f<T: Send + Sync>() {}
    f::<WorkspaceCleanup>();
}

#[cfg(test)]
mod tests;
