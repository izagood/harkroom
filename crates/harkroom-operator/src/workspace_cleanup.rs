//! 작업 폴더 청소기 핵심(s21c5-1) — TS `packages/shared/src/workspaceCleanup.ts`(원장 모양·러너 보고 거르기·경로 도움)와
//! `packages/operator/src/workspaceCleanup.ts`(원장 파일·`planSweep`·`applyHumanAction`·`runSweep`·`removeRebuildable`) 이식.
//!
//! 이 PR 은 **아무 데도 잇지 않는다** — git·러너 사실 재기(Owners·Scan)와 소켓 요청·주기 sweep 배선은 뒤 PR 이다.
//!
//! **지우는 동작이라 TS 보다 좁게 잡은 것**(위임 지시):
//! - 지울 대상 경로는 절대 경로이고, `.`·`..`·빈 칸이 없고, 정규화(`normalize_cleanup_path`) 뒤 모양이어야 한다(`safe_target`).
//!   원장 파일은 이 기기의 것이지만, 손으로 고치거나 깨진 원장이 `/` 나 `..` 을 지우게 두지 않는다.
//! - `remove_rebuildable` 은 뿌리 자체가 심링크·폴더 아님이면 아무것도 하지 않는다(TS 는 뿌리를 따라간다).
//! - 원장 파일은 폴더 0700·심링크 거절, 쓰기는 유일 임시 이름 + `create_new`(O_EXCL) 0600 + rename, 읽기는 `O_NOFOLLOW`.
//!   TS 는 `.tmp-<pid>` 고정 이름이라 같은 pid 두 회차가 겹치면 섞일 수 있다.
//! - 깨진 원장은 TS 처럼 옆으로 치우되, 치울 이름도 `create_new` 와 같은 유일 꼴로 짓는다.
use crate::local_merge::iso_from_ms;
use crate::turn_leases::parse_iso_ms;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const DAY_MS: u64 = 86_400_000;
/// TS `MAX_EVENTS`.
pub const MAX_EVENTS: usize = 200;
pub const CLEANUP_GRACE_MIN: i64 = 1;
pub const CLEANUP_GRACE_MAX: i64 = 30;
pub const CLEANUP_GRACE_DEFAULT: i64 = 7;
/// TS `CLEANUP_IDLE_DAYS`.
pub const CLEANUP_IDLE_DAYS: u64 = 7;
/// TS `REBUILDABLE_DIRS`.
pub const REBUILDABLE_DIRS: [&str; 4] = ["node_modules", "target", "dist", "build"];
/// TS `CLEANUP_REPORT_PATH`.
pub const CLEANUP_REPORT_PATH: &str = "/agent/cleanup-report";
const MAX_REPORT_THREADS: usize = 2000;
const MAX_REPORT_WORKTREES: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupState {
    Unowned,
    Listed,
    Kept,
    Blocked,
    Deleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupKind {
    Worktree,
    ThreadDir,
    ClaudeSession,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BlockReason {
    #[serde(rename = "uncommitted")]
    Uncommitted,
    #[serde(rename = "unpushed")]
    Unpushed,
    #[serde(rename = "turn-running")]
    TurnRunning,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRef {
    pub channel_id: String,
    pub thread_root_id: String,
}

impl ThreadRef {
    /// TS `threadKey`·`cleanupThreadKey`.
    pub fn key(&self) -> String {
        format!("{}/{}", self.channel_id, self.thread_root_id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrState {
    Open,
    Merged,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPr {
    pub number: i64,
    pub state: PrState,
    pub head_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupItem {
    pub path: String,
    pub kind: CleanupKind,
    pub state: CleanupState,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub head_sha: Option<String>,
    pub thread: Option<ThreadRef>,
    pub pr: Option<CleanupPr>,
    pub last_modified_at: Option<String>,
    pub listed_at: Option<String>,
    pub delete_after: Option<String>,
    pub block_reason: Option<BlockReason>,
    pub acted_by: Option<String>,
    pub acted_at: Option<String>,
    pub size_before: Option<f64>,
    pub size_now: Option<f64>,
}

impl CleanupItem {
    /// TS `blank`.
    pub fn blank(path: &str, kind: CleanupKind) -> Self {
        CleanupItem {
            path: path.to_string(),
            kind,
            state: CleanupState::Unowned,
            repo: None,
            branch: None,
            head_sha: None,
            thread: None,
            pr: None,
            last_modified_at: None,
            listed_at: None,
            delete_after: None,
            block_reason: None,
            acted_by: None,
            acted_at: None,
            size_before: None,
            size_now: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EventAction {
    Listed,
    DepsRemoved,
    Kept,
    Unkept,
    Revived,
    Blocked,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CleanupEvent {
    pub at: String,
    pub path: String,
    pub thread: Option<ThreadRef>,
    pub action: EventAction,
    pub by: Option<String>,
    pub bytes: Option<f64>,
    pub reason: Option<BlockReason>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupLedger {
    pub version: u8,
    pub items: Vec<CleanupItem>,
    pub events: Vec<CleanupEvent>,
    pub last_sweep_at: Option<String>,
}

impl Default for CleanupLedger {
    /// TS `emptyLedger`.
    fn default() -> Self {
        CleanupLedger {
            version: 1,
            items: Vec::new(),
            events: Vec::new(),
            last_sweep_at: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CleanupSettings {
    pub enabled: bool,
    pub grace_days: i64,
}

/// TS `clampGraceDays` — 수가 아니면 기본값, 반올림 뒤 1~30.
pub fn clamp_grace_days(n: &Value) -> i64 {
    match n.as_f64() {
        Some(f) if f.is_finite() => {
            // JS Math.round: .5 는 +∞ 쪽.
            let r = (f + 0.5).floor() as i64;
            r.clamp(CLEANUP_GRACE_MIN, CLEANUP_GRACE_MAX)
        }
        _ => CLEANUP_GRACE_DEFAULT,
    }
}

fn grace_ms(settings: &CleanupSettings) -> u64 {
    settings
        .grace_days
        .clamp(CLEANUP_GRACE_MIN, CLEANUP_GRACE_MAX) as u64
        * DAY_MS
}

// ── 경로 도움 ────────────────────────────────────────────────────────────────

/// TS `normalizeCleanupPath` — `/private/tmp/x` → `/tmp/x`, 끝 슬래시를 뗀다.
pub fn normalize_cleanup_path(p: &str) -> String {
    let s = p
        .strip_prefix("/private")
        .filter(|r| r.starts_with("/tmp/"))
        .unwrap_or(p);
    s.trim_end_matches('/').to_string()
}

/// TS `claudeProjectDirName`.
pub fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// TS `worktreeAddPaths` — 세션 기록 글에서 `git worktree add` 대상 경로.
pub fn worktree_add_paths(text: &str, home: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find("worktree add") {
        let after = &rest[i + "worktree add".len()..];
        // `\b` — 다음 글자가 낱말 글자면 맞지 않는다.
        if after
            .chars()
            .next()
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
        {
            rest = after;
            continue;
        }
        let seg: String = after
            .chars()
            .take_while(|&c| c != '"' && c != '\n')
            .take(400)
            .collect();
        let seg = seg.replace("\\n", " ").replace("\\t", " ");
        let toks: Vec<&str> = seg.split_whitespace().collect();
        let mut j = 0;
        while j < toks.len() {
            let t = toks[j];
            if t == "-b" || t == "-B" || t == "--reason" {
                j += 2;
                continue;
            }
            if t.starts_with('-') {
                j += 1;
                continue;
            }
            if t.starts_with([';', '&', '|']) {
                break;
            }
            let clean = t.trim_end_matches([';', '&', '|', ')']);
            if clean.starts_with('/') {
                out.push(normalize_cleanup_path(clean));
            } else if let Some(r) = clean.strip_prefix("~/") {
                out.push(normalize_cleanup_path(&format!("{home}/{r}")));
            }
            break;
        }
        rest = after;
    }
    out
}

/// 지울 대상으로 받는 경로인가(TS 에 없음 — 더 좁게). 절대 경로, `.`·`..`·빈 칸 없음, 뿌리(`/`) 아님, 정규화된 모양.
pub fn safe_target(path: &str) -> bool {
    if !path.starts_with('/') || path.len() >= 1024 || path.contains('\0') {
        return false;
    }
    if normalize_cleanup_path(path) != path {
        return false;
    }
    // `Path::components` 는 가운데 `.` 을 접어 버리므로 글자로 칸을 본다 — 빈 칸(`//`)·`.`·`..` 가 하나라도 있으면 거절.
    let segs: Vec<&str> = path[1..].split('/').collect();
    if segs.iter().any(|s| s.is_empty() || *s == "." || *s == "..") {
        return false;
    }
    segs.len() >= 2
}

// ── 러너 보고 ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct ThreadReport {
    pub thread: ThreadRef,
    pub worktrees: Vec<String>,
    pub last_turn_at: Option<String>,
    pub running: bool,
    pub workspace_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct CleanupReport {
    pub threads: Vec<ThreadReport>,
    pub deleted: Vec<ThreadRef>,
}

fn uuidish(s: &str) -> bool {
    s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

fn thread_ref(v: &Value) -> Option<ThreadRef> {
    let c = v.get("channelId")?.as_str().filter(|s| uuidish(s))?;
    let t = v.get("threadRootId")?.as_str().filter(|s| uuidish(s))?;
    Some(ThreadRef {
        channel_id: c.to_string(),
        thread_root_id: t.to_string(),
    })
}

fn abs_short(v: &Value) -> Option<String> {
    v.as_str()
        .filter(|s| s.starts_with('/') && s.len() < 1024)
        .map(str::to_string)
}

/// TS `readCleanupReport` — 모양이 틀린 줄은 버린다. `lastTurnAt` 이 미래면 `now` 로 자른다.
pub fn read_cleanup_report(body: &Value, now_ms: u64) -> Option<CleanupReport> {
    let threads = body.get("threads")?.as_array()?;
    let mut out = CleanupReport::default();
    for t in threads.iter().take(MAX_REPORT_THREADS) {
        let Some(thread) = thread_ref(t) else {
            continue;
        };
        let worktrees = t
            .get("worktrees")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(abs_short)
                    .take(MAX_REPORT_WORKTREES)
                    .collect()
            })
            .unwrap_or_default();
        let last_turn_at = t
            .get("lastTurnAt")
            .and_then(Value::as_str)
            .and_then(parse_iso_ms)
            .map(|ms| iso_from_ms(ms.min(now_ms)));
        out.threads.push(ThreadReport {
            thread,
            worktrees,
            last_turn_at,
            running: t.get("running") == Some(&Value::Bool(true)),
            workspace_dir: t.get("workspaceDir").and_then(abs_short),
        });
    }
    if let Some(d) = body.get("deleted").and_then(Value::as_array) {
        out.deleted = d
            .iter()
            .filter_map(thread_ref)
            .take(MAX_REPORT_THREADS)
            .collect();
    }
    Some(out)
}

// ── 원장 파일 ────────────────────────────────────────────────────────────────

/// TS `cleanupLedgerPath`.
pub fn cleanup_ledger_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("cleanup").join("ledger.json")
}

fn item_of(v: &Value) -> Option<CleanupItem> {
    // TS `isItem` — path·kind 가 문자열이고 state 가 아는 값. 모르는 칸·틀린 칸은 serde 가 거르므로 하나씩 읽는다.
    v.get("path")?.as_str()?;
    serde_json::from_value(v.clone()).ok()
}

/// TS `readLedger` — 없으면 빈 원장, 깨졌으면 옆으로 치우고 빈 원장. 심링크·일반 파일 아님이면 읽지 않고 빈 원장(치우지도 않는다).
pub fn read_ledger(path: &Path) -> CleanupLedger {
    let text = match crate::hook_run::open_nofollow(path, std::fs::OpenOptions::new().read(true))
        .and_then(|mut f| {
            let mut s = String::new();
            f.read_to_string(&mut s).map(|_| s)
        }) {
        Ok(t) => t,
        Err(_) => return CleanupLedger::default(),
    };
    let parsed: Option<CleanupLedger> = (|| {
        let raw: Value = serde_json::from_str(&text).ok()?;
        if raw.get("version") != Some(&Value::from(1)) {
            return None;
        }
        let items = raw
            .get("items")?
            .as_array()?
            .iter()
            .filter_map(item_of)
            .collect();
        let events: Vec<CleanupEvent> = raw
            .get("events")
            .and_then(Value::as_array)
            .map(|a| {
                let skip = a.len().saturating_sub(MAX_EVENTS);
                a.iter()
                    .skip(skip)
                    .filter_map(|e| serde_json::from_value(e.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        Some(CleanupLedger {
            version: 1,
            items,
            events,
            last_sweep_at: raw
                .get("lastSweepAt")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    })();
    match parsed {
        Some(l) => l,
        None => {
            let aside = path.with_file_name(format!(
                "ledger.json.broken-{}",
                crate::runners::now_ms().max(0)
            ));
            let _ = std::fs::rename(path, aside);
            CleanupLedger::default()
        }
    }
}

/// TS `writeLedger` — 폴더 0700(심링크 거절), 유일 임시 이름에 `create_new` 0600 으로 쓰고 rename.
pub fn write_ledger(path: &Path, ledger: &CleanupLedger) -> std::io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other("no parent"))?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    crate::hook_run::plain_dir(dir)?;
    let tmp = dir.join(format!(
        ".ledger.json.tmp-{}-{}",
        std::process::id(),
        crate::runners::new_incarnation_id().unwrap_or_default()
    ));
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(ledger).map_err(std::io::Error::other)?
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

// ── 이번 회차에 잰 사실 ──────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ObservedWorktree {
    pub path: String,
    pub repo: String,
    pub branch: Option<String>,
    pub head_sha: Option<String>,
    pub thread: Option<ThreadRef>,
    pub pr: Option<CleanupPr>,
    pub last_modified_at: Option<String>,
    pub size: Option<f64>,
    pub clean: Option<bool>,
    pub last_activity_at: Option<String>,
    pub only_rebuildable_ignored: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ObservedIdle {
    pub path: String,
    pub kind: CleanupKind,
    pub thread: ThreadRef,
    pub size: Option<f64>,
    pub last_modified_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SweepFacts {
    pub worktrees: Vec<ObservedWorktree>,
    pub idle: Vec<ObservedIdle>,
    pub done_threads: HashSet<String>,
    pub last_turn_at: HashMap<String, String>,
    pub running_threads: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SweepAction {
    RemoveDeps(String),
    Delete(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct SweepPlan {
    pub ledger: CleanupLedger,
    pub actions: Vec<SweepAction>,
}

fn event(at: &str, item: &CleanupItem, action: EventAction) -> CleanupEvent {
    CleanupEvent {
        at: at.to_string(),
        path: item.path.clone(),
        thread: item.thread.clone(),
        action,
        by: None,
        bytes: None,
        reason: None,
    }
}

pub(super) fn trim_events(mut v: Vec<CleanupEvent>) -> Vec<CleanupEvent> {
    let skip = v.len().saturating_sub(MAX_EVENTS);
    v.drain(..skip);
    v
}

/// 규칙 1: PR 이 머지·닫힘 **그리고** 스레드 ✅.
fn qualifies(w: &ObservedWorktree, facts: &SweepFacts) -> bool {
    match (&w.thread, &w.pr) {
        (Some(t), Some(pr)) => pr.state != PrState::Open && facts.done_threads.contains(&t.key()),
        _ => false,
    }
}

/// TS `unownedPrMatches` — PR 이 머지·닫힘이고 PR head 가 HEAD 와 같다.
pub fn unowned_pr_matches(pr: Option<&CleanupPr>, head_sha: Option<&str>) -> bool {
    match (pr, head_sha) {
        (Some(pr), Some(h)) => pr.state != PrState::Open && pr.head_sha.as_deref() == Some(h),
        _ => false,
    }
}

/// TS `qualifiesUnowned`.
pub fn qualifies_unowned(w: &ObservedWorktree, settings: &CleanupSettings, now_ms: u64) -> bool {
    if w.thread.is_some() || !unowned_pr_matches(w.pr.as_ref(), w.head_sha.as_deref()) {
        return false;
    }
    if w.clean != Some(true) || w.only_rebuildable_ignored != Some(true) {
        return false;
    }
    match w.last_activity_at.as_deref().and_then(parse_iso_ms) {
        Some(t) => t <= now_ms.saturating_sub(grace_ms(settings)),
        None => false,
    }
}

struct Unowned {
    activity_at: Option<String>,
    pr_matches: bool,
}

/// TS `planSweep` — 순수 함수. 원장 + 이번 회차 사실 → 새 원장 + 할 일. 규칙은 전부 여기 있다.
pub fn plan_sweep(
    prev: &CleanupLedger,
    facts: &SweepFacts,
    settings: &CleanupSettings,
    now_ms: u64,
) -> SweepPlan {
    let at = iso_from_ms(now_ms);
    let delete_after = iso_from_ms(now_ms + grace_ms(settings));
    let mut events: Vec<CleanupEvent> = Vec::new();
    let mut actions: Vec<SweepAction> = Vec::new();
    let by_path: HashMap<&str, &CleanupItem> =
        prev.items.iter().map(|i| (i.path.as_str(), i)).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<CleanupItem> = Vec::new();

    let list =
        |item: CleanupItem, events: &mut Vec<CleanupEvent>, actions: &mut Vec<SweepAction>| {
            let next = CleanupItem {
                state: CleanupState::Listed,
                listed_at: Some(at.clone()),
                delete_after: Some(delete_after.clone()),
                block_reason: None,
                ..item
            };
            events.push(event(&at, &next, EventAction::Listed));
            actions.push(SweepAction::RemoveDeps(next.path.clone()));
            next
        };

    let mut step = |observed: CleanupItem,
                    eligible: bool,
                    unowned: Option<Unowned>,
                    events: &mut Vec<CleanupEvent>,
                    actions: &mut Vec<SweepAction>,
                    out: &mut Vec<CleanupItem>| {
        seen.insert(observed.path.clone());
        let Some(old) = by_path.get(observed.path.as_str()).copied() else {
            if observed.thread.is_none() {
                out.push(if eligible && settings.enabled {
                    list(observed, events, actions)
                } else {
                    observed
                });
                return;
            }
            if eligible && settings.enabled {
                out.push(list(observed, events, actions));
            }
            return;
        };
        let mut item = CleanupItem {
            repo: observed.repo.clone().or_else(|| old.repo.clone()),
            branch: observed.branch.clone(),
            head_sha: observed.head_sha.clone(),
            thread: old.thread.clone().or_else(|| observed.thread.clone()),
            pr: observed.pr.clone().or_else(|| old.pr.clone()),
            last_modified_at: observed
                .last_modified_at
                .clone()
                .or_else(|| old.last_modified_at.clone()),
            size_now: observed.size_now.or(old.size_now),
            ..old.clone()
        };
        if item.state == CleanupState::Unowned
            && item.acted_by.is_none()
            && eligible
            && settings.enabled
        {
            item = list(item, events, actions);
        }
        if let Some(u) = &unowned
            && matches!(old.state, CleanupState::Listed | CleanupState::Blocked)
            && old.thread.is_none()
            && old.acted_by.is_none()
            && let Some(listed_at) = &old.listed_at
            && (!u.pr_matches || u.activity_at.as_ref().is_some_and(|a| a > listed_at))
        {
            events.push(event(&at, old, EventAction::Revived));
            return;
        }
        if matches!(item.state, CleanupState::Listed | CleanupState::Blocked)
            && let (Some(t), Some(listed_at)) = (&item.thread, &item.listed_at)
            && facts
                .last_turn_at
                .get(&t.key())
                .is_some_and(|last| last > listed_at)
        {
            events.push(event(&at, &item, EventAction::Revived));
            return;
        }
        if settings.enabled
            && matches!(item.state, CleanupState::Listed | CleanupState::Blocked)
            && item
                .delete_after
                .as_ref()
                .is_some_and(|d| d.as_str() <= at.as_str())
        {
            actions.push(SweepAction::Delete(item.path.clone()));
        }
        out.push(item);
    };

    for w in &facts.worktrees {
        let item = CleanupItem {
            repo: Some(w.repo.clone()),
            branch: w.branch.clone(),
            head_sha: w.head_sha.clone(),
            thread: w.thread.clone(),
            pr: w.pr.clone(),
            last_modified_at: w.last_modified_at.clone(),
            size_before: w.size,
            size_now: w.size,
            ..CleanupItem::blank(&w.path, CleanupKind::Worktree)
        };
        let (eligible, unowned) = if w.thread.is_some() {
            (qualifies(w, facts), None)
        } else {
            (
                qualifies_unowned(w, settings, now_ms),
                Some(Unowned {
                    activity_at: w.last_activity_at.clone(),
                    pr_matches: unowned_pr_matches(w.pr.as_ref(), w.head_sha.as_deref()),
                }),
            )
        };
        step(item, eligible, unowned, &mut events, &mut actions, &mut out);
    }
    for d in &facts.idle {
        let item = CleanupItem {
            thread: Some(d.thread.clone()),
            last_modified_at: d.last_modified_at.clone(),
            size_before: d.size,
            size_now: d.size,
            ..CleanupItem::blank(&d.path, d.kind)
        };
        step(item, true, None, &mut events, &mut actions, &mut out);
    }
    // 이번에 안 보인 항목: 폴더가 이미 없다 → 뺀다. 「보존」은 남긴다.
    for old in &prev.items {
        if !seen.contains(&old.path) && old.state == CleanupState::Kept {
            out.push(old.clone());
        }
    }
    let mut all = prev.events.clone();
    all.extend(events);
    SweepPlan {
        ledger: CleanupLedger {
            version: 1,
            items: out,
            events: trim_events(all),
            last_sweep_at: Some(at),
        },
        actions,
    }
}

// ── 사람의 손 ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HumanAction {
    Keep,
    Unkeep,
    List,
    DeleteNow,
}

impl HumanAction {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "keep" => Self::Keep,
            "unkeep" => Self::Unkeep,
            "list" => Self::List,
            "deleteNow" => Self::DeleteNow,
            _ => return None,
        })
    }
}

/// TS `applyHumanAction`. 거절은 `Err(이유)`.
pub fn apply_human_action(
    prev: &CleanupLedger,
    path: &str,
    action: HumanAction,
    by: &str,
    settings: &CleanupSettings,
    now_ms: u64,
) -> Result<(CleanupLedger, Vec<SweepAction>), String> {
    let at = iso_from_ms(now_ms);
    let idx = prev
        .items
        .iter()
        .position(|i| i.path == path)
        .ok_or_else(|| "no such cleanup item".to_string())?;
    let item = &prev.items[idx];
    let mut items = prev.items.clone();
    if action == HumanAction::DeleteNow {
        if !matches!(item.state, CleanupState::Listed | CleanupState::Blocked) {
            return Err(format!("cannot deleteNow from {:?}", item.state).to_lowercase());
        }
        items[idx] = CleanupItem {
            delete_after: Some(at.clone()),
            acted_by: Some(by.to_string()),
            acted_at: Some(at),
            ..item.clone()
        };
        return Ok((
            CleanupLedger {
                items,
                ..prev.clone()
            },
            vec![SweepAction::Delete(path.to_string())],
        ));
    }
    let mut actions = Vec::new();
    let (next, ev) = if action == HumanAction::Keep {
        if item.state == CleanupState::Deleted {
            return Err("already deleted".into());
        }
        (
            CleanupItem {
                state: CleanupState::Kept,
                delete_after: None,
                block_reason: None,
                ..item.clone()
            },
            EventAction::Kept,
        )
    } else {
        let from = if action == HumanAction::Unkeep {
            CleanupState::Kept
        } else {
            CleanupState::Unowned
        };
        if item.state != from {
            return Err(format!("cannot {action:?} from {:?}", item.state).to_lowercase());
        }
        actions.push(SweepAction::RemoveDeps(path.to_string()));
        (
            CleanupItem {
                state: CleanupState::Listed,
                listed_at: Some(at.clone()),
                block_reason: None,
                delete_after: Some(iso_from_ms(now_ms + grace_ms(settings))),
                ..item.clone()
            },
            if action == HumanAction::Unkeep {
                EventAction::Unkept
            } else {
                EventAction::Listed
            },
        )
    };
    let next = CleanupItem {
        acted_by: Some(by.to_string()),
        acted_at: Some(at.clone()),
        ..next
    };
    let mut e = event(&at, &next, ev);
    e.by = Some(by.to_string());
    items[idx] = next;
    let mut events = prev.events.clone();
    events.push(e);
    Ok((
        CleanupLedger {
            items,
            events: trim_events(events),
            ..prev.clone()
        },
        actions,
    ))
}

// ── 실행 ─────────────────────────────────────────────────────────────────────

/// TS `CleanupPorts`.
pub trait CleanupPorts {
    /// 지우기 직전 검사. 통과면 None.
    fn check(&self, item: &CleanupItem, running_threads: &HashSet<String>) -> Option<BlockReason>;
    fn remove(&self, item: &CleanupItem) -> Result<(), String>;
    fn size(&self, path: &str) -> Option<f64>;
    fn remove_deps(&self, root: &str) -> Result<(), String>;
}

/// TS `removeRebuildable` — 다시 만들 수 있는 폴더만. **심링크면 링크만**. `safe(name, symlink)` 이 참일 때만.
/// TS 보다 좁게: 뿌리 자체가 심링크이거나 폴더가 아니면 아무것도 하지 않는다.
pub fn remove_rebuildable(root: &Path, safe: &dyn Fn(&str, bool) -> bool) -> std::io::Result<()> {
    crate::hook_run::plain_dir(root)?;
    for name in REBUILDABLE_DIRS {
        let p = root.join(name);
        let Ok(m) = std::fs::symlink_metadata(&p) else {
            continue;
        };
        let link = m.file_type().is_symlink();
        if !(link || m.is_dir()) {
            continue;
        }
        if !safe(name, link) {
            continue;
        }
        if link {
            std::fs::remove_file(&p)?;
        } else {
            std::fs::remove_dir_all(&p)?;
        }
    }
    Ok(())
}

/// TS `runSweep` — 할 일을 포트로 실행한다. 지우기 직전 검사를 다시 한다. **지울 대상 경로가 `safe_target` 이 아니면
/// 아무것도 하지 않고 `blocked` 로도 바꾸지 않는다**(TS 에 없음 — 깨진 원장이 엉뚱한 곳을 지우지 않게).
pub fn run_sweep(
    plan: SweepPlan,
    ports: &dyn CleanupPorts,
    running_threads: &HashSet<String>,
    now_ms: u64,
) -> CleanupLedger {
    let at = iso_from_ms(now_ms);
    let mut items = plan.ledger.items.clone();
    let mut events = plan.ledger.events.clone();
    for a in &plan.actions {
        let (path, delete) = match a {
            SweepAction::RemoveDeps(p) => (p, false),
            SweepAction::Delete(p) => (p, true),
        };
        let Some(idx) = items.iter().position(|i| &i.path == path) else {
            continue;
        };
        if !safe_target(path) {
            eprintln!("작업 폴더 청소: 받지 않는 경로라 건너뛴다 — {path}");
            continue;
        }
        let item = items[idx].clone();
        if !delete {
            if item.kind != CleanupKind::Worktree {
                continue;
            }
            if ports.remove_deps(&item.path).is_ok() {
                let size_now = ports.size(&item.path);
                let freed = match (item.size_now, size_now) {
                    (Some(a), Some(b)) => Some((a - b).max(0.0)),
                    _ => None,
                };
                items[idx] = CleanupItem {
                    size_now,
                    ..item.clone()
                };
                let mut e = event(&at, &item, EventAction::DepsRemoved);
                e.bytes = freed;
                events.push(e);
            }
            continue;
        }
        if let Some(reason) = ports.check(&item, running_threads) {
            if item.block_reason != Some(reason) {
                let mut e = event(&at, &item, EventAction::Blocked);
                e.reason = Some(reason);
                events.push(e);
            }
            items[idx] = CleanupItem {
                state: CleanupState::Blocked,
                block_reason: Some(reason),
                ..item
            };
            continue;
        }
        if ports.remove(&item).is_ok() {
            let mut e = event(&at, &item, EventAction::Deleted);
            e.bytes = item.size_now;
            events.push(e);
            items[idx] = CleanupItem {
                state: CleanupState::Deleted,
                block_reason: None,
                size_now: Some(0.0),
                ..item
            };
        }
    }
    CleanupLedger {
        items: items
            .into_iter()
            .filter(|i| i.state != CleanupState::Deleted)
            .collect(),
        events: trim_events(events),
        ..plan.ledger
    }
}

pub mod owners;
pub mod payload;
pub mod ports;
pub mod scan;
pub mod service;
pub mod wire;

#[cfg(test)]
mod tests;
