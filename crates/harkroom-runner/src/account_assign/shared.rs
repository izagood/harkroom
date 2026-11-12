//! 배정이 쓰는 shared 조각의 최소 이식: `claudeUsage.ts`(usage.json 파싱·신선도·점수),
//! `claudePools.ts`(풀별 배정 기준만), `claudePoolChain.ts`(풀 순서 판정), `claudeGates.ts`(표식 읽기),
//! `claudeSessions.ts`(세션 파일 실재). 정본은 TS 쪽이고 식은 그대로 옮겼다.
//!
//! 시각은 TS 와 같이 ms 단위 `f64` 다(무한대를 "모름"으로 쓰는 자리가 있다).

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde_json::{Map, Value};

/// `<claude-accounts 뿌리>/usage.json`.
pub const CLAUDE_USAGE_FILE: &str = "usage.json";
pub const CLAUDE_USAGE_VERSION: f64 = 1.0;
/// 이보다 오래 읽은 값은 믿지 않는다(모르는 계정으로 다룬다).
pub const CLAUDE_USAGE_STALE_MS: f64 = 10.0 * 60.0 * 1000.0;
/// `<claude-accounts 뿌리>/pools.json`.
pub const CLAUDE_POOLS_FILE: &str = "pools.json";
/// 관문 표식(계정 config 디렉터리 안).
pub const CLAUDE_ATTENTION_FILE: &str = ".harkroom-attention.json";
/// 로그인 풀림 표식(계정 config 디렉터리 안).
pub const CLAUDE_AUTH_FILE: &str = ".harkroom-auth.json";

/// `ProviderUsageWindow`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UsageWindow {
    pub used_percent: f64,
    pub resets_at_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelWeekly {
    pub label: String,
    pub window: UsageWindow,
}

/// `ClaudeUsageEntry`.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageEntry {
    /// 평평한 구조면 `""`.
    pub pool: String,
    pub account: String,
    /// 같은 로그인이면 같은 값. 못 읽었으면 `None`(자기 혼자인 묶음).
    pub sign_in: Option<String>,
    pub session: Option<UsageWindow>,
    pub weekly: Option<UsageWindow>,
    pub model_weekly: Vec<ModelWeekly>,
    pub read_at_ms: Option<f64>,
    pub error: Option<String>,
}

fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn window(raw: Option<&Value>) -> Option<UsageWindow> {
    let o = raw?.as_object()?;
    let used = finite(o.get("usedPercent"))?;
    Some(UsageWindow {
        used_percent: used.clamp(0.0, 100.0),
        resets_at_ms: finite(o.get("resetsAtMs")),
    })
}

/// `parseClaudeUsageFile(..).accounts`. 모르는 판본·깨진 파일은 빈 목록, 틀린 항목만 버린다.
pub fn parse_usage_accounts(raw: &Value) -> Vec<UsageEntry> {
    let Some(o) = raw.as_object() else {
        return Vec::new();
    };
    if o.get("version").and_then(Value::as_f64) != Some(CLAUDE_USAGE_VERSION) {
        return Vec::new();
    }
    let Some(list) = o.get("accounts").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for a in list {
        let Some(a) = a.as_object() else { continue };
        let Some(account) = a.get("account").and_then(Value::as_str) else {
            continue;
        };
        if account.is_empty() {
            continue;
        }
        let mut model_weekly = Vec::new();
        if let Some(ms) = a.get("modelWeekly").and_then(Value::as_array) {
            for m in ms {
                let Some(m) = m.as_object() else { continue };
                if let (Some(w), Some(label)) = (
                    window(m.get("window")),
                    m.get("label").and_then(Value::as_str),
                ) {
                    model_weekly.push(ModelWeekly {
                        label: label.to_string(),
                        window: w,
                    });
                }
            }
        }
        out.push(UsageEntry {
            pool: a
                .get("pool")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            account: account.to_string(),
            sign_in: a
                .get("signIn")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            session: window(a.get("session")),
            weekly: window(a.get("weekly")),
            model_weekly,
            read_at_ms: finite(a.get("readAtMs")),
            error: a.get("error").and_then(Value::as_str).map(str::to_string),
        });
    }
    out
}

/// `isUsageFresh` (기본 시한).
pub fn is_usage_fresh(entry: &UsageEntry, now: f64) -> bool {
    entry
        .read_at_ms
        .is_some_and(|r| now - r <= CLAUDE_USAGE_STALE_MS)
}

/// `headroomPerHour`: 초기화 전 남은 % ÷ 남은 시간(h). 모르면 168h, 바닥 0.1h.
pub fn headroom_per_hour(w: &UsageWindow, now: f64, penalty_pct: f64) -> f64 {
    let hours = match w.resets_at_ms {
        None => 168.0,
        Some(r) => ((r - now) / 3_600_000.0).max(0.1),
    };
    (100.0 - w.used_percent - penalty_pct).max(0.0) / hours
}

// ── 배정 기준(claudePools.ts) ─────────────────────────────────────────────

/// `ClaudeAssignThresholds`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AssignThresholds {
    pub new_session_pct: f64,
    pub new_weekly_pct: f64,
    pub move_session_pct: f64,
    pub move_weekly_pct: f64,
}

pub const DEFAULT_ASSIGN_THRESHOLDS: AssignThresholds = AssignThresholds {
    new_session_pct: 85.0,
    new_weekly_pct: 97.0,
    move_session_pct: 95.0,
    move_weekly_pct: 98.0,
};

/// 풀별 기준의 빈 칸 있는 모양(`Partial<ClaudeAssignThresholds>`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PartialThresholds {
    pub new_session_pct: Option<f64>,
    pub new_weekly_pct: Option<f64>,
    pub move_session_pct: Option<f64>,
    pub move_weekly_pct: Option<f64>,
}

impl From<AssignThresholds> for PartialThresholds {
    fn from(t: AssignThresholds) -> Self {
        Self {
            new_session_pct: Some(t.new_session_pct),
            new_weekly_pct: Some(t.new_weekly_pct),
            move_session_pct: Some(t.move_session_pct),
            move_weekly_pct: Some(t.move_weekly_pct),
        }
    }
}

/// `ClaudePoolsConfig` 중 배정이 읽는 `assign` 칸만.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AssignConfig {
    pub assign: HashMap<String, PartialThresholds>,
}

/// `CLAUDE_POOL_NAME_PATTERN` = `^[a-z0-9-]{1,32}$`.
pub fn is_pool_name(s: &str) -> bool {
    (1..=32).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn thresholds(raw: &Value) -> Option<PartialThresholds> {
    let o: &Map<String, Value> = raw.as_object()?;
    let get = |k: &str| {
        o.get(k)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && (1.0..=100.0).contains(v))
    };
    let out = PartialThresholds {
        new_session_pct: get("newSessionPct"),
        new_weekly_pct: get("newWeeklyPct"),
        move_session_pct: get("moveSessionPct"),
        move_weekly_pct: get("moveWeeklyPct"),
    };
    (out != PartialThresholds::default()).then_some(out)
}

/// `parseClaudePoolsConfig(raw).assign` — 틀린 풀 이름·칸만 버린다.
pub fn parse_assign_config(raw: &Value) -> AssignConfig {
    let mut assign = HashMap::new();
    if let Some(a) = raw.get("assign").and_then(Value::as_object) {
        for (pool, t) in a {
            if !is_pool_name(pool) {
                continue;
            }
            if let Some(p) = thresholds(t) {
                assign.insert(pool.clone(), p);
            }
        }
    }
    AssignConfig { assign }
}

/// `resolveAssignThresholds`: 빈 칸은 기본값, 옮기기 기준은 새 배정 기준 이상으로 올린다.
pub fn resolve_assign_thresholds(
    cfg: Option<&AssignConfig>,
    pool: Option<&str>,
) -> AssignThresholds {
    let own = pool
        .filter(|p| !p.is_empty())
        .and_then(|p| cfg?.assign.get(p).copied())
        .unwrap_or_default();
    let d = DEFAULT_ASSIGN_THRESHOLDS;
    let mut t = AssignThresholds {
        new_session_pct: own.new_session_pct.unwrap_or(d.new_session_pct),
        new_weekly_pct: own.new_weekly_pct.unwrap_or(d.new_weekly_pct),
        move_session_pct: own.move_session_pct.unwrap_or(d.move_session_pct),
        move_weekly_pct: own.move_weekly_pct.unwrap_or(d.move_weekly_pct),
    };
    t.move_session_pct = t.move_session_pct.max(t.new_session_pct);
    t.move_weekly_pct = t.move_weekly_pct.max(t.new_weekly_pct);
    t
}

// ── 풀 순서 판정(claudePoolChain.ts) ─────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolChainStatus {
    Available,
    Exhausted,
    Missing,
    Empty,
}

/// `PoolChainEntry` 중 배정이 쓰는 칸만(계정별 상세·`exhaustedBy` 는 화면 몫이라 옮기지 않았다).
#[derive(Debug, Clone, PartialEq)]
pub struct PoolChainEntry {
    pub pool: String,
    pub status: PoolChainStatus,
    pub unblock_at_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PoolChainState {
    pub entries: Vec<PoolChainEntry>,
    pub active_index: Option<usize>,
    pub all_exhausted: bool,
}

pub struct PoolChainInput<'a> {
    pub chain: &'a [String],
    /// 디스크에 있는 풀 → 계정 이름. 없는 풀은 `Missing`.
    pub accounts_by_pool: &'a HashMap<String, Vec<String>>,
    pub usage: &'a [UsageEntry],
    pub cfg: Option<&'a AssignConfig>,
    pub now: f64,
    pub blocked: &'a dyn Fn(&str, &str) -> bool,
}

fn window_hot(w: Option<&UsageWindow>, pct: f64, now: f64) -> bool {
    match w {
        Some(w) if w.used_percent >= pct => w.resets_at_ms.is_none_or(|r| r > now),
        _ => false,
    }
}

/// (hot, unblockAtMs) — `poolChainAccount` 의 배정에 쓰는 두 칸.
fn chain_account(
    entry: Option<&UsageEntry>,
    t: &AssignThresholds,
    now: f64,
    blocked: bool,
) -> (bool, Option<f64>) {
    if blocked {
        return (true, None);
    }
    let Some(fresh) = entry.filter(|e| is_usage_fresh(e, now) && e.weekly.is_some()) else {
        return (false, None);
    };
    let s = window_hot(fresh.session.as_ref(), t.new_session_pct, now);
    let w = window_hot(fresh.weekly.as_ref(), t.new_weekly_pct, now);
    let mut resets = Vec::new();
    if s {
        resets.push(fresh.session.and_then(|x| x.resets_at_ms));
    }
    if w {
        resets.push(fresh.weekly.and_then(|x| x.resets_at_ms));
    }
    let unblock = if !resets.is_empty() && resets.iter().all(Option::is_some) {
        resets.into_iter().flatten().reduce(f64::max)
    } else {
        None
    };
    (s || w, unblock)
}

/// `poolChainState`. **순수 함수다.**
pub fn pool_chain_state(input: &PoolChainInput<'_>) -> PoolChainState {
    let entries: Vec<PoolChainEntry> = input
        .chain
        .iter()
        .map(|pool| {
            let t = resolve_assign_thresholds(input.cfg, Some(pool));
            let entry = |status, unblock_at_ms| PoolChainEntry {
                pool: pool.clone(),
                status,
                unblock_at_ms,
            };
            let Some(names) = input.accounts_by_pool.get(pool) else {
                return entry(PoolChainStatus::Missing, None);
            };
            let accounts: Vec<(bool, Option<f64>)> = names
                .iter()
                .map(|account| {
                    let e = input
                        .usage
                        .iter()
                        .find(|e| &e.pool == pool && &e.account == account);
                    chain_account(e, &t, input.now, (input.blocked)(pool, account))
                })
                .collect();
            if accounts.is_empty() {
                return entry(PoolChainStatus::Empty, None);
            }
            if !accounts.iter().all(|a| a.0) {
                return entry(PoolChainStatus::Available, None);
            }
            let unblock = accounts.iter().filter_map(|a| a.1).reduce(f64::min);
            entry(PoolChainStatus::Exhausted, unblock)
        })
        .collect();

    if let Some(first) = entries
        .iter()
        .position(|e| e.status == PoolChainStatus::Available)
    {
        return PoolChainState {
            entries,
            active_index: Some(first),
            all_exhausted: false,
        };
    }
    // 모두 소진(D4): 가장 먼저 풀리는 풀. 시각을 모르는 풀은 뒤로, 같으면 목록 순서.
    let soonest = entries
        .iter()
        .enumerate()
        .filter(|(_, e)| e.status == PoolChainStatus::Exhausted)
        .min_by(|(i, a), (j, b)| {
            let (x, y) = (
                a.unblock_at_ms.unwrap_or(f64::INFINITY),
                b.unblock_at_ms.unwrap_or(f64::INFINITY),
            );
            x.partial_cmp(&y)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(i.cmp(j))
        })
        .map(|(i, _)| i);
    PoolChainState {
        all_exhausted: soonest.is_some(),
        active_index: soonest,
        entries,
    }
}

// ── 표식(claudeGates.ts) ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttentionKind {
    Gate,
    Credential,
}

/// `ClaudeAccountAttention`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Attention {
    pub kind: AttentionKind,
    pub at_ms: f64,
}

fn read_marker(path: &Path, kind: AttentionKind, word: &str) -> Option<Attention> {
    let text = fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    if v.get("kind").and_then(Value::as_str) != Some(word) {
        return None;
    }
    let at_ms = finite(v.get("atMs"))?;
    Some(Attention { kind, at_ms })
}

/// `readAccountBlocked`: 관문 표식이 먼저, 없으면 로그인 풀림 표식. 없거나 깨졌으면 `None`.
pub fn read_account_blocked(config_dir: &Path) -> Option<Attention> {
    read_marker(
        &config_dir.join(CLAUDE_ATTENTION_FILE),
        AttentionKind::Gate,
        "gate",
    )
    .or_else(|| {
        read_marker(
            &config_dir.join(CLAUDE_AUTH_FILE),
            AttentionKind::Credential,
            "credential",
        )
    })
}

/// `isAttentionActive`: 시한은 없다. 미래 시각이 1분 넘게 찍힌 표식은 깨진 것으로 본다.
pub fn is_attention_active(a: Option<&Attention>, now: f64) -> bool {
    a.is_some_and(|a| a.at_ms <= now + 60_000.0)
}

// ── 세션 파일(claudeSessions.ts) ─────────────────────────────────────────

/// `claudeSessionFileExists(id, { configDir })`: `<configDir>/projects/*/<id>.jsonl` 가 있나.
pub fn claude_session_file_exists(session_id: &str, config_dir: &Path) -> bool {
    let root = config_dir.join("projects");
    let Ok(projects) = fs::read_dir(&root) else {
        return false;
    };
    let wanted = format!("{session_id}.jsonl");
    for entry in projects.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Ok(files) = fs::read_dir(entry.path()) else {
            continue;
        };
        if files.flatten().any(|f| f.file_name() == wanted.as_str()) {
            return true;
        }
    }
    false
}
