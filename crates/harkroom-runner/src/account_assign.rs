//! claude 계정을 **스레드마다** 고른다(`accountAssign.ts` 이식).
//!
//! 목표는 풀 전체 사용량을 최대로 쓰는 것이다. 점수 = `(100 − 주간%) ÷ 주간 초기화까지 남은 h` —
//! 먼저 사라질 여유부터 쓴다. 스레드가 처음 올 때 고르고 그 뒤로는 고정된 계정을 따르며, 옮기기
//! 기준(95/98)을 넘었을 때만 옮긴다(옮기면 세션을 잃는다).
//!
//! 둘로 나뉜다: [`pick_account`] 는 순수 함수(시계·난수를 인자로 받는다)이고, [`AccountAssigner`] 가
//! usage.json·pools.json·표식·최근 배정 수를 모아 그것을 부른다. 턴 흐름에는 아직 붙이지 않았다.

pub mod shared;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use serde_json::Value;

use shared::{
    AssignConfig, AssignThresholds, Attention, CLAUDE_POOLS_FILE, CLAUDE_USAGE_FILE,
    DEFAULT_ASSIGN_THRESHOLDS, PoolChainInput, PoolChainStatus, UsageEntry, UsageWindow,
    claude_session_file_exists, headroom_per_hour, is_attention_active, is_usage_fresh,
    parse_assign_config, parse_usage_accounts, pool_chain_state, read_account_blocked,
    resolve_assign_thresholds,
};

/// 기준 % 넷(`pools.json` 의 풀별 `assign`)과 상수 둘.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AssignPolicy {
    pub thresholds: AssignThresholds,
    /// 스냅숏을 읽은 뒤 이 러너가 배정한 스레드마다 주간 남은 양에서 뺀다(%p).
    pub per_assign_penalty_pct: f64,
    /// 점수가 1등의 이 비율 안쪽이면 동점으로 보고 5시간 사용률이 낮은 쪽을 앞에 둔다.
    pub tie_ratio: f64,
}

pub const DEFAULT_ASSIGN_POLICY: AssignPolicy = AssignPolicy {
    thresholds: DEFAULT_ASSIGN_THRESHOLDS,
    per_assign_penalty_pct: 2.0,
    tie_ratio: 0.1,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickReason {
    /// 고정된 계정을 그대로 쓴다.
    Kept,
    /// 새 스레드(또는 고정 계정이 풀에서 사라짐) — 점수로 골랐다.
    New,
    /// 고정된 계정이 옮기기 기준을 넘었다.
    Moved,
    /// 모든 계정이 새 배정 기준을 넘었다 — 걸린 창이 가장 먼저 초기화되는 계정으로 보낸다.
    AllHot,
    /// 믿을 만한 값이 하나도 없다 — 풀 순서로 떨어진다.
    Unknown,
}

pub struct PickInput<'a> {
    /// 풀 순서 그대로의 계정 이름. 비어 있으면 안 된다.
    pub accounts: &'a [String],
    /// 이 풀의 usage.json 항목(이름 → 항목).
    pub usage: &'a HashMap<String, UsageEntry>,
    /// 이 스레드에 이미 고정된 계정.
    pub pinned: Option<&'a str>,
    pub policy: &'a AssignPolicy,
    pub now: f64,
    /// 스냅숏을 읽은 뒤 이 러너가 배정한 스레드 수(계정 이름 → 수).
    pub recent_assignments: &'a HashMap<String, u32>,
    /// 에이전트 모델(`claude-opus-…`).
    pub model: Option<&'a str>,
    /// [0,1) 난수. 상위 둘 가운데 점수 비례로 흩는다.
    pub random: &'a mut dyn FnMut() -> f64,
    /// 사람이 관문을 지나야 하는 계정 — 새 배정에서 빼고 고정도 옮기되, 꼬리 맨 뒤에는 남긴다.
    pub blocked: &'a HashSet<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PickResult {
    /// 페일오버 순서: [고른 계정, 나머지 점수순].
    pub order: Vec<String>,
    pub reason: PickReason,
    /// 로그용 한 줄(이름·% 만).
    pub detail: String,
}

#[derive(Debug, Clone)]
struct Scored {
    name: String,
    index: usize,
    known: bool,
    session_pct: Option<f64>,
    weekly_pct: Option<f64>,
    score: f64,
    eligible: bool,
    must_move: bool,
    unblock_at_ms: f64,
}

fn cmp_f64(a: f64, b: f64) -> std::cmp::Ordering {
    a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
}

/// JS `Number.prototype.toFixed(2)` 에 해당한다.
fn fixed2(v: f64) -> String {
    format!("{v:.2}")
}

/// JS `Math.round`(0 이상의 값에서는 같다).
fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// 모델 이름에 들어 있는 낱말로 모델별 주간 창을 고른다(`Opus weekly` ↔ `claude-opus-4-…`).
fn model_window(entry: &UsageEntry, model: Option<&str>) -> Option<UsageWindow> {
    let m = model.filter(|m| !m.is_empty())?.to_lowercase();
    let mut tightest: Option<UsageWindow> = None;
    for mw in &entry.model_weekly {
        let label = mw.label.to_lowercase();
        // JS `split(/\s+/)[0]` — 앞이 공백이면 빈 낱말이다.
        let word = label.split(char::is_whitespace).next().unwrap_or("");
        if word.is_empty() || word == "weekly" || !m.contains(word) {
            continue;
        }
        if tightest.is_none_or(|t| mw.window.used_percent > t.used_percent) {
            tightest = Some(mw.window);
        }
    }
    tightest
}

/// 계정을 고른다. **순수 함수다.** 같은 로그인(`signIn`)은 한도를 함께 쓰므로 한 칸으로 센다.
pub fn pick_account(input: PickInput<'_>) -> PickResult {
    let blocked = input.blocked;
    let res = pick_account_inner(input);
    if blocked.is_empty() {
        return res;
    }
    // 관문 표식이 선 계정은 언제나 맨 뒤다. 모두 막혔으면 순서 그대로다.
    let (open, shut): (Vec<String>, Vec<String>) = res
        .order
        .iter()
        .cloned()
        .partition(|n| !blocked.contains(n));
    if open.is_empty() {
        return res;
    }
    PickResult {
        order: open.into_iter().chain(shut).collect(),
        ..res
    }
}

fn pick_account_inner(input: PickInput<'_>) -> PickResult {
    let PickInput {
        accounts,
        usage,
        pinned,
        policy,
        now,
        recent_assignments,
        model,
        random,
        blocked,
    } = input;
    assert!(!accounts.is_empty(), "pickAccount: 계정이 비어 있다");
    let t = &policy.thresholds;

    let group_of = |name: &str| -> String {
        match usage.get(name).and_then(|e| e.sign_in.as_deref()) {
            Some(s) => format!("s:{s}"),
            None => format!("a:{name}"),
        }
    };
    let mut group_entry: HashMap<String, &UsageEntry> = HashMap::new();
    let mut group_assigned: HashMap<String, u32> = HashMap::new();
    for name in accounts {
        let g = group_of(name);
        *group_assigned.entry(g.clone()).or_insert(0) +=
            recent_assignments.get(name).copied().unwrap_or(0);
        let Some(e) = usage.get(name) else { continue };
        if !is_usage_fresh(e, now) || e.weekly.is_none() {
            continue;
        }
        let newer = group_entry
            .get(&g)
            .is_none_or(|p| e.read_at_ms.unwrap_or(0.0) > p.read_at_ms.unwrap_or(0.0));
        if newer {
            group_entry.insert(g, e);
        }
    }

    let mut scored: Vec<Scored> = accounts
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let g = group_of(name);
            let e = group_entry.get(&g).copied();
            if blocked.contains(name) {
                return Scored {
                    name: name.clone(),
                    index,
                    known: e.is_some_and(|e| e.weekly.is_some()),
                    session_pct: e.and_then(|e| e.session).map(|w| w.used_percent),
                    weekly_pct: e.and_then(|e| e.weekly).map(|w| w.used_percent),
                    score: 0.0,
                    eligible: false,
                    must_move: true,
                    unblock_at_ms: f64::INFINITY,
                };
            }
            let Some((e, weekly)) = e.and_then(|e| e.weekly.map(|w| (e, w))) else {
                return Scored {
                    name: name.clone(),
                    index,
                    known: false,
                    session_pct: None,
                    weekly_pct: None,
                    score: 0.0,
                    eligible: true,
                    must_move: false,
                    unblock_at_ms: f64::INFINITY,
                };
            };
            let binding = match model_window(e, model) {
                Some(mw) if mw.used_percent > weekly.used_percent => mw,
                _ => weekly,
            };
            let weekly_pct = binding.used_percent;
            let session_pct = e.session.map(|w| w.used_percent);
            let penalty = f64::from(group_assigned.get(&g).copied().unwrap_or(0))
                * policy.per_assign_penalty_pct;
            let score = headroom_per_hour(&binding, now, penalty);
            let session_hot = session_pct.is_some_and(|p| p >= t.new_session_pct);
            let weekly_hot = weekly_pct >= t.new_weekly_pct;
            let unblock = f64::max(
                if session_hot {
                    e.session
                        .and_then(|w| w.resets_at_ms)
                        .unwrap_or(f64::INFINITY)
                } else {
                    f64::NEG_INFINITY
                },
                if weekly_hot {
                    binding.resets_at_ms.unwrap_or(f64::INFINITY)
                } else {
                    f64::NEG_INFINITY
                },
            );
            Scored {
                name: name.clone(),
                index,
                known: true,
                session_pct,
                weekly_pct: Some(weekly_pct),
                score,
                eligible: !session_hot && !weekly_hot,
                must_move: session_pct.is_some_and(|p| p >= t.move_session_pct)
                    || weekly_pct >= t.move_weekly_pct,
                unblock_at_ms: unblock,
            }
        })
        .collect();

    let describe = |s: &Scored| -> String {
        if s.known {
            format!(
                "{}(5h {}% · 주간 {}% · 점수 {}/h)",
                s.name,
                js_round(s.session_pct.unwrap_or(0.0)),
                js_round(s.weekly_pct.unwrap_or(0.0)),
                fixed2(s.score)
            )
        } else {
            format!("{}(모름)", s.name)
        }
    };

    let mut known_scores: Vec<f64> = scored
        .iter()
        .filter(|s| s.known && !blocked.contains(&s.name))
        .map(|s| s.score)
        .collect();

    // 믿을 만한 값이 하나도 없으면 풀 순서, 고정 계정이 있으면 그것부터. 막힌 계정은 맨 뒤.
    if known_scores.is_empty() {
        let open: Vec<&String> = accounts.iter().filter(|a| !blocked.contains(*a)).collect();
        let keep = pinned.filter(|p| open.iter().any(|a| a.as_str() == *p));
        let mut order: Vec<String> = keep.map(str::to_string).into_iter().collect();
        order.extend(
            open.iter()
                .filter(|a| Some(a.as_str()) != keep)
                .map(|a| (*a).clone()),
        );
        order.extend(accounts.iter().filter(|a| blocked.contains(*a)).cloned());
        return PickResult {
            order,
            reason: if keep.is_some() {
                PickReason::Kept
            } else {
                PickReason::Unknown
            },
            detail: "사용량을 모른다 — 풀 순서".to_string(),
        };
    }

    // 모르는 계정은 풀의 중간 점수다.
    known_scores.sort_by(|a, b| cmp_f64(*a, *b));
    let n = known_scores.len();
    let mid = if n % 2 == 1 {
        known_scores[(n - 1) / 2]
    } else {
        (known_scores[n / 2 - 1] + known_scores[n / 2]) / 2.0
    };
    for s in &mut scored {
        if !s.known && !blocked.contains(&s.name) {
            s.score = mid;
        }
    }

    // 점수 내림차순. 1등의 tieRatio 안쪽끼리는 5시간 사용률이 낮은 쪽(모르면 50%), 그다음 풀 순서.
    let by_score = |list: Vec<Scored>| -> Vec<Scored> {
        let mut desc = list;
        desc.sort_by(|a, b| cmp_f64(b.score, a.score).then(a.index.cmp(&b.index)));
        let top = desc.first().map_or(0.0, |s| s.score);
        let cut = top * (1.0 - policy.tie_ratio);
        let (mut tier, rest): (Vec<Scored>, Vec<Scored>) =
            desc.into_iter().partition(|s| s.score >= cut);
        tier.sort_by(|a, b| {
            cmp_f64(a.session_pct.unwrap_or(50.0), b.session_pct.unwrap_or(50.0))
                .then(cmp_f64(b.score, a.score))
                .then(a.index.cmp(&b.index))
        });
        tier.into_iter().chain(rest).collect()
    };
    let eligible = by_score(scored.iter().filter(|s| s.eligible).cloned().collect());
    let hot = by_score(scored.iter().filter(|s| !s.eligible).cloned().collect());

    // 같은 로그인 묶음은 후보 한 자리다 — 묶음마다 앞선 계정이 대표, 나머지는 꼬리 맨 뒤.
    let mut seen_groups: HashSet<String> = HashSet::new();
    let mut reps: Vec<&Scored> = Vec::new();
    let mut mates: Vec<&Scored> = Vec::new();
    for s in eligible.iter().chain(hot.iter()) {
        if seen_groups.insert(group_of(&s.name)) {
            reps.push(s);
        } else {
            mates.push(s);
        }
    }
    let eligible_reps: Vec<&Scored> = reps.iter().copied().filter(|s| s.eligible).collect();
    let order_from = |first: &str| -> Vec<String> {
        std::iter::once(first.to_string())
            .chain(
                reps.iter()
                    .chain(mates.iter())
                    .map(|s| s.name.clone())
                    .filter(|n| n != first),
            )
            .collect()
    };

    let pin = pinned.and_then(|p| scored.iter().find(|s| s.name == p));
    if let Some(pin) = pin.filter(|p| !p.must_move) {
        return PickResult {
            order: order_from(&pin.name),
            reason: PickReason::Kept,
            detail: describe(pin),
        };
    }

    if eligible.is_empty() {
        // 모두 뜨겁다 — 걸린 창이 가장 먼저 풀리는 계정으로 보낸다.
        let soonest = hot
            .iter()
            .min_by(|a, b| cmp_f64(a.unblock_at_ms, b.unblock_at_ms).then(a.index.cmp(&b.index)))
            .expect("hot 은 비어 있지 않다");
        return PickResult {
            order: order_from(&soonest.name),
            reason: PickReason::AllHot,
            detail: format!(
                "풀 전체가 새 배정 기준(5h {}% / 주간 {}%) 이상 — {}",
                t.new_session_pct,
                t.new_weekly_pct,
                describe(soonest)
            ),
        };
    }

    // 상위 둘(로그인 묶음 둘) 가운데 점수에 비례해 뽑는다. 둘 다 0점이면 1등이다.
    let first = eligible_reps.first().copied();
    let second = eligible_reps.get(1).copied();
    let total = match (first, second) {
        (Some(a), Some(b)) => a.score + b.score,
        _ => 0.0,
    };
    let p_second = if total > 0.0 {
        second.map_or(0.0, |s| s.score) / total
    } else {
        0.0
    };
    let pick_idx = usize::from(p_second > 0.0 && random() >= 1.0 - p_second);
    let chosen = eligible_reps[pick_idx];
    let p = if total > 0.0 {
        format!(
            " · p={}",
            fixed2(if pick_idx == 1 {
                p_second
            } else {
                1.0 - p_second
            })
        )
    } else {
        String::new()
    };
    let detail = match pin {
        Some(pin) => format!("{} → {}", describe(pin), describe(chosen)),
        None => describe(chosen),
    } + &p;
    PickResult {
        order: order_from(&chosen.name),
        reason: if pin.is_some() {
            PickReason::Moved
        } else {
            PickReason::New
        },
        detail,
    }
}

// ── 배정기 ────────────────────────────────────────────────────────────────

/// `ClaudeAccount`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeAccount {
    pub name: String,
    /// 이 계정의 `CLAUDE_CONFIG_DIR`.
    pub config_dir: PathBuf,
    /// 이 계정이 든 풀. `None` 은 뿌리(암묵 풀).
    pub pool: Option<String>,
}

/// `ClaudePoolLane`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudePoolLane {
    pub pool: String,
    pub accounts: Vec<ClaudeAccount>,
}

/// 계정 축의 한 칸. `None` 은 계정 없음(풀이 없다).
pub type Lane = Vec<Option<ClaudeAccount>>;

/// `current()` 가 돌려주는 지금의 축·풀(·풀 순서).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentLane {
    pub pool: Option<String>,
    pub lane: Lane,
    pub chain: Option<Vec<ClaudePoolLane>>,
}

type Shared<F> = Box<F>;
/// 스레드 키 → 기록 값.
pub type ThreadLookup = Shared<dyn Fn(&str) -> Option<String> + Send + Sync>;
pub type CurrentFn = Shared<dyn Fn() -> CurrentLane + Send + Sync>;
pub type HasSessionFn = Shared<dyn Fn(&str, &Path) -> bool + Send + Sync>;
pub type ClockFn = Shared<dyn Fn() -> f64 + Send + Sync>;
pub type LogFn = Shared<dyn Fn(&str) + Send + Sync>;
pub type ReadAttentionFn = Shared<dyn Fn(&Path) -> Option<Attention> + Send + Sync>;

/// `AccountAssignerDeps`. 생략할 수 있는 것은 `None` 이면 TS 와 같은 기본값을 쓴다.
pub struct AccountAssignerDeps {
    /// 기동 때 계정 축(풀 순서). `[None]` 이면 풀이 없다 — 손대지 않는다.
    pub lane: Lane,
    /// 이 러너의 풀. 평평한 구조면 `None`(usage.json 에서는 `""`).
    pub pool: Option<String>,
    /// 지금 축과 풀. 턴마다 부른다.
    pub current: Option<CurrentFn>,
    /// claude-accounts 뿌리 — usage.json·pools.json 이 여기 있다.
    pub root: PathBuf,
    /// 스레드에 고정된 계정(`SessionRecord.claudeAccount`).
    pub pinned_of: ThreadLookup,
    /// 그 계정의 풀(`SessionRecord.claudePool`). `None` 은 풀을 적기 전의 옛 레코드다.
    pub pinned_pool_of: Option<ThreadLookup>,
    /// 스레드의 claude 세션 id.
    pub session_id_of: Option<ThreadLookup>,
    /// 그 세션 파일이 이 계정 디렉터리에 있나. 기본은 [`claude_session_file_exists`].
    pub has_session: Option<HasSessionFn>,
    /// 주면 `pools.json` 을 읽지 않고 이것을 쓴다(테스트).
    pub policy: Option<AssignPolicy>,
    pub now: Option<ClockFn>,
    pub random: Option<ClockFn>,
    pub log: Option<LogFn>,
    /// 관문·로그인 풀림 표식 읽기. 기본은 [`read_account_blocked`].
    pub read_attention: Option<ReadAttentionFn>,
}

impl AccountAssignerDeps {
    /// 필수 셋만 채우고 나머지는 기본값.
    pub fn new(
        lane: Lane,
        pool: Option<String>,
        root: PathBuf,
        pinned_of: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            lane,
            pool,
            current: None,
            root,
            pinned_of: Box::new(pinned_of),
            pinned_pool_of: None,
            session_id_of: None,
            has_session: None,
            policy: None,
            now: None,
            random: None,
            log: None,
            read_attention: None,
        }
    }
}

/// 최근 배정 기록을 이만큼만 들고 있는다.
const ASSIGNMENT_MEMORY_MS: f64 = 15.0 * 60.0 * 1000.0;

#[derive(Default)]
struct AssignerState {
    /// 이 러너가 새로 배정한 기록(키, 시각).
    assigned: VecDeque<(String, f64)>,
    /// "풀 전체가 뜨겁다"는 한 번만 알린다.
    all_hot_noticed: bool,
    /// 마지막으로 알린 "새 스레드가 가는 풀".
    last_active_pool: Option<String>,
}

pub struct AccountAssigner {
    deps: AccountAssignerDeps,
    state: Mutex<AssignerState>,
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// 새 의존 없이 [0,1) 난수(`RandomState` 해시 — 암호용이 아니다).
fn default_random() -> f64 {
    use std::hash::{BuildHasher, Hasher};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(COUNTER.fetch_add(1, AtomicOrdering::Relaxed));
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    (h.finish() >> 11) as f64 / (1u64 << 53) as f64
}

fn key_of(pool: &str, name: &str) -> String {
    format!("{pool}/{name}")
}

fn what_of(reason: PickReason) -> &'static str {
    match reason {
        PickReason::Moved => "옮김",
        PickReason::AllHot => "새 스레드(풀 전체 뜨거움)",
        _ => "새 스레드",
    }
}

pub fn create_account_assigner(deps: AccountAssignerDeps) -> AccountAssigner {
    AccountAssigner {
        deps,
        state: Mutex::new(AssignerState::default()),
    }
}

impl AccountAssigner {
    fn now(&self) -> f64 {
        self.deps.now.as_ref().map_or_else(now_ms, |f| f())
    }

    fn random(&self) -> f64 {
        self.deps
            .random
            .as_ref()
            .map_or_else(default_random, |f| f())
    }

    fn log(&self, line: &str) {
        match &self.deps.log {
            Some(f) => f(line),
            None => println!("{line}"),
        }
    }

    fn read_attention(&self, dir: &Path) -> Option<Attention> {
        match &self.deps.read_attention {
            Some(f) => f(dir),
            None => read_account_blocked(dir),
        }
    }

    /// pools.json. 없거나 깨졌으면 `None`(= 기본값).
    fn read_config(&self) -> Option<AssignConfig> {
        let text = std::fs::read_to_string(self.deps.root.join(CLAUDE_POOLS_FILE)).ok()?;
        let v: Value = serde_json::from_str(&text).ok()?;
        Some(parse_assign_config(&v))
    }

    fn policy_of(&self, cfg: Option<&AssignConfig>, pool: Option<&str>) -> AssignPolicy {
        if let Some(p) = self.deps.policy {
            return p;
        }
        AssignPolicy {
            thresholds: resolve_assign_thresholds(cfg, pool),
            ..DEFAULT_ASSIGN_POLICY
        }
    }

    /// usage.json 의 모든 항목. 없으면 빈 목록(폴러가 아직 안 돌았다).
    fn read_usage_all(&self) -> Vec<UsageEntry> {
        let Ok(text) = std::fs::read_to_string(self.deps.root.join(CLAUDE_USAGE_FILE)) else {
            return Vec::new();
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(v) => parse_usage_accounts(&v),
            Err(_) => Vec::new(),
        }
    }

    /// 최근 배정 수(스냅숏이 그 뒤에 읽혔으면 세지 않는다).
    fn recent_for(
        state: &mut AssignerState,
        t: f64,
        read_at_of: impl Fn(&str) -> Option<f64>,
    ) -> HashMap<String, u32> {
        while state
            .assigned
            .front()
            .is_some_and(|(_, at)| t - at > ASSIGNMENT_MEMORY_MS)
        {
            state.assigned.pop_front();
        }
        let mut recent = HashMap::new();
        for (account, at) in &state.assigned {
            if read_at_of(account).is_some_and(|r| r >= *at) {
                continue;
            }
            *recent.entry(account.clone()).or_insert(0) += 1;
        }
        recent
    }

    /// 이 스레드의 페일오버 순서. 실패해도 던지지 않는다.
    pub fn lane_for(&self, thread_key: &str, model: Option<&str>) -> Lane {
        let cur = match &self.deps.current {
            Some(f) => f(),
            None => CurrentLane {
                pool: self.deps.pool.clone(),
                lane: self.deps.lane.clone(),
                chain: None,
            },
        };
        if let Some(chain) = cur.chain.as_ref().filter(|c| c.len() > 1) {
            return self.lane_for_chain(thread_key, model, chain, &cur.lane);
        }
        let accounts: Vec<&ClaudeAccount> = cur.lane.iter().flatten().collect();
        if accounts.len() < 2 {
            return cur.lane;
        }
        let by_name: HashMap<&str, &ClaudeAccount> =
            accounts.iter().map(|a| (a.name.as_str(), *a)).collect();
        let t = self.now();
        let pool_key = cur.pool.clone().unwrap_or_default();
        let usage: HashMap<String, UsageEntry> = self
            .read_usage_all()
            .into_iter()
            .filter(|e| e.pool == pool_key)
            .map(|e| (e.account.clone(), e))
            .collect();
        let policy = match self.deps.policy {
            Some(p) => p,
            None => self.policy_of(self.read_config().as_ref(), cur.pool.as_deref()),
        };
        let blocked: HashSet<String> = accounts
            .iter()
            .filter(|a| is_attention_active(self.read_attention(&a.config_dir).as_ref(), t))
            .map(|a| a.name.clone())
            .collect();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let recent = Self::recent_for(&mut state, t, |name| {
            usage.get(name).and_then(|e| e.read_at_ms)
        });
        let pinned_raw = (self.deps.pinned_of)(thread_key);
        let pinned = pinned_raw.as_deref().filter(|p| by_name.contains_key(p));
        let names: Vec<String> = accounts.iter().map(|a| a.name.clone()).collect();
        let mut random = || self.random();
        let res = pick_account(PickInput {
            accounts: &names,
            usage: &usage,
            pinned,
            policy: &policy,
            now: t,
            recent_assignments: &recent,
            model,
            random: &mut random,
            blocked: &blocked,
        });
        let first = res.order[0].clone();
        if matches!(
            res.reason,
            PickReason::New | PickReason::Moved | PickReason::AllHot
        ) {
            state.assigned.push_back((first.clone(), t));
        }
        if res.reason == PickReason::AllHot {
            if !state.all_hot_noticed {
                self.log(&format!("[계정 배정] {}", res.detail));
            }
            state.all_hot_noticed = true;
        } else if res.reason != PickReason::Kept {
            state.all_hot_noticed = false;
        }
        drop(state);
        if !matches!(res.reason, PickReason::Kept | PickReason::Unknown) {
            self.log(&format!(
                "[계정 배정] {thread_key}: {} → {first} — {}",
                what_of(res.reason),
                res.detail
            ));
        }
        res.order
            .iter()
            .map(|n| Some(by_name[n.as_str()].clone()))
            .collect()
    }

    /// 풀 여러 개: 새 스레드는 소진되지 않은 첫 풀에서, 붙은 스레드는 옮기기 기준 전까지 그 풀에.
    fn lane_for_chain(
        &self,
        thread_key: &str,
        model: Option<&str>,
        chain: &[ClaudePoolLane],
        fallback: &Lane,
    ) -> Lane {
        let t = self.now();
        let cfg = if self.deps.policy.is_some() {
            None
        } else {
            self.read_config()
        };
        let usage_all = self.read_usage_all();
        let blocked_keys: HashSet<String> = chain
            .iter()
            .flat_map(|c| c.accounts.iter().map(move |a| (c, a)))
            .filter(|(_, a)| is_attention_active(self.read_attention(&a.config_dir).as_ref(), t))
            .map(|(c, a)| key_of(&c.pool, &a.name))
            .collect();
        // 테스트가 기준을 직접 주면 모든 풀이 그 기준이다.
        let chain_cfg = match self.deps.policy {
            Some(p) => Some(AssignConfig {
                assign: chain
                    .iter()
                    .map(|c| (c.pool.clone(), p.thresholds.into()))
                    .collect(),
            }),
            None => cfg.clone(),
        };
        let pools: Vec<String> = chain.iter().map(|c| c.pool.clone()).collect();
        let accounts_by_pool: HashMap<String, Vec<String>> = chain
            .iter()
            .map(|c| {
                (
                    c.pool.clone(),
                    c.accounts.iter().map(|a| a.name.clone()).collect(),
                )
            })
            .collect();
        let is_blocked = |pool: &str, name: &str| blocked_keys.contains(&key_of(pool, name));
        let state_chain = pool_chain_state(&PoolChainInput {
            chain: &pools,
            accounts_by_pool: &accounts_by_pool,
            usage: &usage_all,
            cfg: chain_cfg.as_ref(),
            now: t,
            blocked: &is_blocked,
        });

        let usage_keyed: HashMap<String, &UsageEntry> = usage_all
            .iter()
            .map(|e| (key_of(&e.pool, &e.account), e))
            .collect();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let recent_all = Self::recent_for(&mut state, t, |k| {
            usage_keyed.get(k).and_then(|e| e.read_at_ms)
        });
        let pick_in = |idx: usize, pinned: Option<&str>| -> PickResult {
            let c = &chain[idx];
            let names: Vec<String> = c.accounts.iter().map(|a| a.name.clone()).collect();
            let usage: HashMap<String, UsageEntry> = usage_all
                .iter()
                .filter(|e| e.pool == c.pool)
                .map(|e| (e.account.clone(), e.clone()))
                .collect();
            let recent: HashMap<String, u32> = names
                .iter()
                .map(|n| {
                    (
                        n.clone(),
                        recent_all.get(&key_of(&c.pool, n)).copied().unwrap_or(0),
                    )
                })
                .collect();
            let blocked: HashSet<String> = names
                .iter()
                .filter(|n| blocked_keys.contains(&key_of(&c.pool, n)))
                .cloned()
                .collect();
            let policy = self.policy_of(cfg.as_ref(), Some(&c.pool));
            let mut random = || self.random();
            pick_account(PickInput {
                accounts: &names,
                usage: &usage,
                pinned,
                policy: &policy,
                now: t,
                recent_assignments: &recent,
                model,
                random: &mut random,
                blocked: &blocked,
            })
        };

        let pinned_name = (self.deps.pinned_of)(thread_key);
        let pinned_pool = self
            .deps
            .pinned_pool_of
            .as_ref()
            .and_then(|f| f(thread_key));
        let holders: Vec<usize> = match &pinned_name {
            None => Vec::new(),
            Some(pn) => chain
                .iter()
                .enumerate()
                .filter(|(_, c)| {
                    pinned_pool.as_ref().is_none_or(|pp| &c.pool == pp)
                        && c.accounts.iter().any(|a| &a.name == pn)
                })
                .map(|(i, _)| i)
                .collect(),
        };
        let mut pin_idx = holders.first().copied();
        // 풀을 모르는 옛 레코드 + 같은 이름이 여러 풀에: 세션 파일이 있는 풀을 따른다.
        if holders.len() > 1 && pinned_pool.is_none() {
            let session_id = self.deps.session_id_of.as_ref().and_then(|f| f(thread_key));
            if let (Some(sid), Some(pn)) = (session_id.filter(|s| !s.is_empty()), &pinned_name) {
                for &i in &holders {
                    let dir = &chain[i]
                        .accounts
                        .iter()
                        .find(|a| &a.name == pn)
                        .expect("holders 는 그 이름을 가진 풀이다")
                        .config_dir;
                    let has = match &self.deps.has_session {
                        Some(f) => f(&sid, dir),
                        None => claude_session_file_exists(&sid, dir),
                    };
                    if has {
                        pin_idx = Some(i);
                        break;
                    }
                }
            }
        }

        let finish =
            |state: &mut AssignerState, idx: usize, res: PickResult, reason: PickReason| -> Lane {
                let c = &chain[idx];
                let by_name: HashMap<&str, &ClaudeAccount> =
                    c.accounts.iter().map(|a| (a.name.as_str(), a)).collect();
                let head: Vec<&ClaudeAccount> =
                    res.order.iter().map(|n| by_name[n.as_str()]).collect();
                let first = head[0];
                if !matches!(reason, PickReason::Kept | PickReason::Unknown) {
                    state.assigned.push_back((key_of(&c.pool, &first.name), t));
                    self.log(&format!(
                        "[계정 배정] {thread_key}: {} → {}번 풀 {} › {} — {}",
                        what_of(reason),
                        idx + 1,
                        c.pool,
                        first.name,
                        res.detail
                    ));
                }
                head.into_iter()
                    .cloned()
                    .chain(
                        chain
                            .iter()
                            .enumerate()
                            .filter(|(i, _)| *i != idx)
                            .flat_map(|(_, o)| o.accounts.iter().cloned()),
                    )
                    .map(Some)
                    .collect()
            };

        if let Some(pi) = pin_idx {
            let res = pick_in(pi, pinned_name.as_deref());
            if res.reason == PickReason::Kept {
                return finish(&mut state, pi, res, PickReason::Kept);
            }
        }

        // 쓸 수 있는 풀이 하나도 없다 — 기동 때 축으로 떨어진다.
        let Some(active) = state_chain.active_index else {
            return fallback.clone();
        };
        let active_pool = &chain[active].pool;
        if state.last_active_pool.as_ref() != Some(active_pool) {
            let skipped: Vec<&str> = state_chain.entries[..active]
                .iter()
                .filter(|e| e.status == PoolChainStatus::Exhausted)
                .map(|e| e.pool.as_str())
                .collect();
            let line = if state_chain.all_exhausted {
                format!(
                    "[풀 순서] 모든 풀이 새 배정 기준 이상 — 가장 먼저 풀리는 {}번 {active_pool} 로 보낸다",
                    active + 1
                )
            } else if skipped.is_empty() {
                format!("[풀 순서] 새 스레드는 {}번 {active_pool}", active + 1)
            } else {
                format!(
                    "[풀 순서] 새 스레드는 {}번 {active_pool} (소진: {})",
                    active + 1,
                    skipped.join(", ")
                )
            };
            self.log(&line);
            state.last_active_pool = Some(active_pool.clone());
        }
        let res = pick_in(
            active,
            if pin_idx == Some(active) {
                pinned_name.as_deref()
            } else {
                None
            },
        );
        // 다른 풀에 붙어 있던 스레드를 옮겼으면 그것도 옮김이다.
        let reason = if pin_idx.is_some() && res.reason == PickReason::New {
            PickReason::Moved
        } else {
            res.reason
        };
        finish(&mut state, active, res, reason)
    }
}

#[cfg(test)]
#[path = "account_assign_tests.rs"]
mod tests;
