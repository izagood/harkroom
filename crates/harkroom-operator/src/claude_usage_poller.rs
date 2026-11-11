//! TS `claudeUsagePoller.ts` — claude 계정 사용률을 **뒤에서** 재서 `<뿌리>/usage.json` 에 쓴다.
//!
//! 읽는 쪽은 러너다 — 새 스레드에 계정을 고를 때 이 파일의 %·초기화 시각으로 점수를 매긴다.
//! 파일의 모양·뜻은 TS `@harkroom/shared/claudeUsage`(이 crate 는 쓰기만 한다).
//!
//! ## 얼마나 자주 재나
//! 계정마다 CLI 프로세스가 하나씩 뜬다. 그래서 **쓰이는 계정만 자주** 잰다 — 쓰이는 계정
//! [`USAGE_POLL_ACTIVE_MS`](2분), 쉬는 계정 [`USAGE_POLL_IDLE_MS`](10분). "쓰이는가"는 지난 번과 값이 달라졌는가로 본다.
//!
//! ## 실패를 다루는 법
//! 조회가 실패하면 **앞 값을 지우지 않는다** — `readAtMs` 도 그대로 둔다. 읽는 쪽은 `readAtMs` 로 신선도를 잰다.
//!
//! TS 와 다른 점: 오퍼레이터는 tokio 없는 std::thread 구조다. `running` Promise 대신 `run` 잠금으로 겹침을 막고
//! (겹쳐 부른 쪽은 앞 회차가 끝나기를 기다렸다 돌아온다 — TS `if (running) return running`), 계정별 조회는
//! `thread::scope` 로 함께 돌린다(TS `Promise.all`). 타이머는 멈출 수 있는 스레드 하나다.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::claude_accounts::read_layout;
use crate::file_lock::{FileLockOptions, with_file_lock};
use crate::provider_usage::{Measured, UsageWindow};

/// TS `CLAUDE_USAGE_FILE`·`CLAUDE_USAGE_VERSION`.
pub const CLAUDE_USAGE_FILE: &str = "usage.json";
pub const CLAUDE_USAGE_VERSION: u64 = 1;

pub const USAGE_POLL_ACTIVE_MS: f64 = 2.0 * 60.0 * 1000.0;
pub const USAGE_POLL_IDLE_MS: f64 = 10.0 * 60.0 * 1000.0;
/// 깨어나는 주기. 계정마다 기한이 따로라 가장 짧은 기한보다 촘촘해야 한다.
pub const USAGE_POLL_TICK: Duration = Duration::from_secs(60);
/// 기동 직후 첫 조회까지의 유예 — 기동 순간은 러너 입양·서버 연결로 바쁘다.
pub const USAGE_POLL_FIRST_DELAY: Duration = Duration::from_secs(15);

type MeasureFn = Box<dyn Fn(&Path) -> Measured + Send + Sync>;
type SignInFn = Box<dyn Fn(&Path) -> Option<String> + Send + Sync>;
type NowFn = Box<dyn Fn() -> f64 + Send + Sync>;
type LogFn = Box<dyn Fn(&str) + Send + Sync>;

/// TS `ClaudeUsageEntry` 한 줄. 키 순서는 TS 가 쓰는 순서(`pool, account, signIn, session, weekly, modelWeekly, readAtMs, error`).
#[derive(Debug, Clone, PartialEq)]
pub struct UsageEntry {
    pub pool: String,
    pub account: String,
    pub sign_in: Option<String>,
    pub session: Option<UsageWindow>,
    pub weekly: Option<UsageWindow>,
    pub model_weekly: Vec<(String, UsageWindow)>,
    pub read_at_ms: Option<f64>,
    pub error: Option<String>,
}

/// JS 수(정수로 떨어지는 f64 는 정수로) — TS `JSON.stringify` 와 같은 글자가 나오게.
fn js_num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9.0e15 {
        json!(f as i64)
    } else {
        json!(f)
    }
}

fn window_json(w: &Option<UsageWindow>) -> Value {
    let Some(w) = w else { return Value::Null };
    let mut o = Map::new();
    o.insert("usedPercent".into(), js_num(w.used_percent));
    o.insert(
        "resetsAtMs".into(),
        w.resets_at_ms.map(js_num).unwrap_or(Value::Null),
    );
    if let Some(m) = w.window_minutes {
        o.insert("windowMinutes".into(), js_num(m));
    }
    Value::Object(o)
}

impl UsageEntry {
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("pool".into(), json!(self.pool));
        o.insert("account".into(), json!(self.account));
        o.insert("signIn".into(), json!(self.sign_in));
        o.insert("session".into(), window_json(&self.session));
        o.insert("weekly".into(), window_json(&self.weekly));
        o.insert(
            "modelWeekly".into(),
            Value::Array(
                self.model_weekly
                    .iter()
                    .map(|(label, w)| json!({ "label": label, "window": window_json(&Some(w.clone())) }))
                    .collect(),
            ),
        );
        o.insert(
            "readAtMs".into(),
            self.read_at_ms.map(js_num).unwrap_or(Value::Null),
        );
        if let Some(e) = &self.error {
            o.insert("error".into(), json!(e));
        }
        Value::Object(o)
    }
}

struct AccountState {
    entry: UsageEntry,
    /// 마지막으로 **시도한** 시각(성공·실패 무관). 다음 기한의 기준이다.
    tried_at_ms: f64,
    active: bool,
}

fn due(s: Option<&AccountState>, at: f64) -> bool {
    match s {
        None => true,
        Some(s) => {
            at - s.tried_at_ms
                >= if s.active {
                    USAGE_POLL_ACTIVE_MS
                } else {
                    USAGE_POLL_IDLE_MS
                }
        }
    }
}

/// 초기화 시각은 분 단위로 비교한다 — 재는 방식(CLI 글자·API)에 따라 초 단위가 흔들릴 수 있다.
fn minute(ms: Option<f64>) -> Option<i64> {
    ms.map(|m| (m / 60_000.0).round() as i64)
}

/// 창 가운데 하나라도 %가 달라졌거나 새 창이 시작됐으면 움직인 것이다(TS `moved`).
fn moved(a: &UsageEntry, b: &UsageEntry) -> bool {
    fn windows(x: &UsageEntry) -> Vec<Option<&UsageWindow>> {
        let mut v = vec![x.session.as_ref(), x.weekly.as_ref()];
        v.extend(x.model_weekly.iter().map(|(_, w)| Some(w)));
        v
    }
    let (pa, pb) = (windows(a), windows(b));
    if pa.len() != pb.len() {
        return true;
    }
    pa.iter().zip(pb.iter()).any(|(x, y)| {
        x.map(|w| w.used_percent) != y.map(|w| w.used_percent)
            || minute(x.and_then(|w| w.resets_at_ms)) != minute(y.and_then(|w| w.resets_at_ms))
    })
}

fn usage_key(pool: &str, account: &str) -> String {
    format!("{pool}\u{0}{account}")
}

fn value_key(v: &Value) -> Option<String> {
    let pool = v.get("pool").and_then(Value::as_str).unwrap_or("");
    let account = v.get("account").and_then(Value::as_str)?;
    Some(usage_key(pool, account))
}

/// 디스크의 `usage.json` 항목들. 판본이 다르거나 깨졌으면 빈 목록(TS `readUsageFile`). 항목은 **그대로** 둔다 —
/// 남이 쓴 항목을 다시 쓸 때 모르는 키까지 지키려고.
fn read_usage_file(path: &Path) -> Vec<Value> {
    let Ok(raw) = fs::read(path) else {
        return Vec::new();
    };
    let Ok(file) = serde_json::from_slice::<Value>(&raw) else {
        return Vec::new();
    };
    if file.get("version").and_then(Value::as_u64) != Some(CLAUDE_USAGE_VERSION) {
        return Vec::new();
    }
    match file.get("accounts") {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    }
}

/// TS `mergeUsageEntries` — 같은 계정은 더 최근에 잰(`readAtMs`) 쪽, 같으면 내 쪽. 내가 모르는 계정은 남기고,
/// 내가 사라진 것을 본 계정(`removed`)만 뺀다. 순서는 TS `Map` 처럼 처음 들어온 자리를 지킨다.
pub fn merge_usage_entries(
    on_disk: Vec<Value>,
    mine: Vec<Value>,
    removed: &HashSet<String>,
) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut out: HashMap<String, Value> = HashMap::new();
    let read_at = |v: &Value| v.get("readAtMs").and_then(Value::as_f64).unwrap_or(-1.0);
    fn put(out: &mut HashMap<String, Value>, order: &mut Vec<String>, k: String, v: Value) {
        if out.insert(k.clone(), v).is_none() {
            order.push(k);
        }
    }
    for e in on_disk {
        // TS 는 `account` 가 없는 항목도 `pool\0undefined` 키로 남긴다 — 여기서는 키를 못 지으면 버린다(러너 파서도 버린다).
        let Some(k) = value_key(&e) else { continue };
        if !removed.contains(&k) {
            put(&mut out, &mut order, k, e);
        }
    }
    for e in mine {
        let Some(k) = value_key(&e) else { continue };
        let newer = match out.get(&k) {
            None => true,
            Some(other) => read_at(&e) >= read_at(other),
        };
        if newer {
            put(&mut out, &mut order, k, e);
        }
    }
    order.into_iter().filter_map(|k| out.remove(&k)).collect()
}

/// `tmp` 에 0600 으로 쓰고 rename 으로 바꿔 끼운다 — 러너가 반쯤 쓴 파일을 읽지 않게.
fn write_all(root: &Path, at: f64, accounts: Vec<Value>) -> std::io::Result<()> {
    let file =
        json!({ "version": CLAUDE_USAGE_VERSION, "writtenAtMs": js_num(at), "accounts": accounts });
    fs::create_dir_all(root)?;
    let tmp = root.join(format!(".{CLAUDE_USAGE_FILE}.{}.tmp", std::process::id()));
    let mut body = serde_json::to_string_pretty(&file).map_err(std::io::Error::other)?;
    body.push('\n');
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(body.as_bytes())?;
    }
    fs::rename(&tmp, root.join(CLAUDE_USAGE_FILE))
}

pub struct PollerOpts {
    pub root: PathBuf,
    /// 계정 풀 설정 파일(`pools_file_path`). 커뮤니티마다 프로세스 모드면 뿌리 밖에 있다.
    pub pools_path: PathBuf,
    pub measure: MeasureFn,
    pub read_sign_in: SignInFn,
    pub now: NowFn,
    pub log: Option<LogFn>,
    /// writer 가 여럿인가(커뮤니티마다 오퍼레이터 프로세스). 켜면 `usage.json.lock` 을 잡고 디스크의 값과 합쳐 쓴다.
    pub shared_file: bool,
}

#[derive(Default)]
struct PollState {
    /// 키는 `CLAUDE_CONFIG_DIR` 경로 — 계정 이름은 풀 사이에서 겹칠 수 있다. 순서는 처음 잰 순서(TS `Map`).
    states: Vec<(PathBuf, AccountState)>,
    /// 이번 주기에 디스크에서 사라진 것을 본 계정(풀·이름 키).
    removed_keys: HashSet<String>,
}

impl PollState {
    fn get(&self, dir: &Path) -> Option<&AccountState> {
        self.states.iter().find(|(d, _)| d == dir).map(|(_, s)| s)
    }
    fn set(&mut self, dir: PathBuf, s: AccountState) {
        match self.states.iter_mut().find(|(d, _)| *d == dir) {
            Some(slot) => slot.1 = s,
            None => self.states.push((dir, s)),
        }
    }
    fn remove(&mut self, dir: &Path) -> Option<AccountState> {
        let i = self.states.iter().position(|(d, _)| d == dir)?;
        Some(self.states.remove(i).1)
    }
}

struct Inner {
    opts: PollerOpts,
    /// 한 회차씩만 돈다. 겹쳐 부른 쪽은 이것을 기다렸다 돌아온다.
    run: Mutex<PollState>,
    stop: Mutex<bool>,
    wake: Condvar,
}

/// TS `ClaudeUsagePoller`. 복제는 같은 폴러를 가리킨다.
#[derive(Clone)]
pub struct ClaudeUsagePoller(Arc<Inner>);

impl ClaudeUsagePoller {
    pub fn new(opts: PollerOpts) -> Self {
        ClaudeUsagePoller(Arc::new(Inner {
            opts,
            run: Mutex::new(PollState::default()),
            stop: Mutex::new(false),
            wake: Condvar::new(),
        }))
    }

    /// 기한이 된 계정을 재고 파일을 쓴다. 앞 회차가 돌고 있으면 새로 돌지 않고 그것이 끝나기를 기다린다
    /// (CLI 는 45초까지 걸린다).
    pub fn tick(&self) {
        match self.0.run.try_lock() {
            Ok(mut st) => self.run_logged(&mut st),
            Err(std::sync::TryLockError::Poisoned(p)) => self.run_logged(&mut p.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => {
                drop(self.0.run.lock().unwrap_or_else(|e| e.into_inner()));
            }
        }
    }

    /// 그 계정(`CLAUDE_CONFIG_DIR`)의 값을 버리고 곧바로 다시 잰다. 다시 로그인한 계정이 부른다.
    /// 돌던 회차가 끝난 **뒤에** 버린다 — 그 회차가 로그인 전에 잰 값을 다시 넣을 수 있다.
    pub fn forget(&self, config_dir: &Path) {
        let mut st = self.0.run.lock().unwrap_or_else(|e| e.into_inner());
        st.remove(config_dir);
        self.run_logged(&mut st);
    }

    /// 뒤 스레드를 띄운다. 첫 조회는 [`USAGE_POLL_FIRST_DELAY`] 뒤, 그다음은 [`USAGE_POLL_TICK`] 마다.
    pub fn start(&self) -> std::io::Result<std::thread::JoinHandle<()>> {
        self.start_with(USAGE_POLL_FIRST_DELAY, USAGE_POLL_TICK)
    }

    pub fn start_with(
        &self,
        first: Duration,
        every: Duration,
    ) -> std::io::Result<std::thread::JoinHandle<()>> {
        let me = self.clone();
        std::thread::Builder::new()
            .name("claude-usage-poller".into())
            .spawn(move || {
                let mut wait = first;
                loop {
                    {
                        let g = me.0.stop.lock().unwrap_or_else(|e| e.into_inner());
                        let (g, _) =
                            me.0.wake
                                .wait_timeout_while(g, wait, |stopped| !*stopped)
                                .unwrap_or_else(|e| e.into_inner());
                        if *g {
                            return;
                        }
                    }
                    me.tick();
                    wait = every;
                }
            })
    }

    /// 뒤 스레드를 멈춘다. 돌던 회차는 끝까지 돈다.
    pub fn stop(&self) {
        *self.0.stop.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.0.wake.notify_all();
    }

    fn run_logged(&self, st: &mut PollState) {
        if let Err(e) = self.tick_once(st)
            && let Some(log) = &self.0.opts.log
        {
            log(&format!("claude usage poll failed: {e}"));
        }
    }

    fn measure_one(
        &self,
        prev: Option<&AccountState>,
        pool: &str,
        account: &str,
        dir: &Path,
        at: f64,
    ) -> AccountState {
        let o = &self.0.opts;
        let (m, sign_in) = std::thread::scope(|s| {
            let h = s.spawn(|| (o.read_sign_in)(dir));
            // 잼 함수가 panic 하면 TS 의 catch 처럼 `network` 실패로 본다.
            let m = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (o.measure)(dir)))
                .unwrap_or_else(|_| Measured::failed(at, "network"));
            (m, h.join().ok().flatten())
        });
        let entry = match (&m.error, prev) {
            (Some(err), Some(p)) => UsageEntry {
                pool: pool.into(),
                account: account.into(),
                sign_in: sign_in.or_else(|| p.entry.sign_in.clone()),
                error: Some(err.clone()),
                ..p.entry.clone()
            },
            (Some(err), None) => UsageEntry {
                pool: pool.into(),
                account: account.into(),
                sign_in,
                session: None,
                weekly: None,
                model_weekly: Vec::new(),
                read_at_ms: None,
                error: Some(err.clone()),
            },
            (None, _) => UsageEntry {
                pool: pool.into(),
                account: account.into(),
                sign_in,
                session: m.session.clone(),
                weekly: m.weekly.clone(),
                // `extra` 는 지금 모델별 주간 창뿐이다.
                model_weekly: m
                    .extra
                    .clone()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|x| (x.label, x.window))
                    .collect(),
                read_at_ms: Some(m.fetched_at_ms),
                error: None,
            },
        };
        // 실패는 쓰이는지를 말해 주지 않는다 — 앞 판정을 그대로 둔다.
        let active = if m.error.is_some() {
            prev.map(|p| p.active).unwrap_or(false)
        } else {
            prev.is_some_and(|p| p.entry.read_at_ms.is_some() && moved(&p.entry, &entry))
        };
        AccountState {
            entry,
            tried_at_ms: at,
            active,
        }
    }

    fn tick_once(&self, st: &mut PollState) -> std::io::Result<()> {
        let o = &self.0.opts;
        let at = (o.now)();
        let layout = read_layout(&o.root, &o.pools_path);
        let targets: Vec<(String, String, PathBuf)> = layout
            .pools
            .iter()
            .flat_map(|(pool, accts)| {
                accts
                    .iter()
                    .map(move |a| (pool.clone(), a.name.clone(), a.dir.clone()))
            })
            .collect();
        let present: HashSet<&PathBuf> = targets.iter().map(|t| &t.2).collect();
        let mut changed = false;
        // 디스크에서 사라진 계정은 파일에서도 뺀다 — 디스크가 멤버십의 진실이다.
        let gone: Vec<PathBuf> = st
            .states
            .iter()
            .filter(|(d, _)| !present.contains(d))
            .map(|(d, _)| d.clone())
            .collect();
        for d in gone {
            if let Some(g) = st.remove(&d) {
                st.removed_keys
                    .insert(usage_key(&g.entry.pool, &g.entry.account));
            }
            changed = true;
        }
        let due_now: Vec<&(String, String, PathBuf)> =
            targets.iter().filter(|t| due(st.get(&t.2), at)).collect();
        if !due_now.is_empty() {
            // 동시에 재는 계정은 `MAX_PARALLEL`(4) 개까지 — 계정이 많아도 CLI 를 한꺼번에 띄우지 않는다(security c3d-4 메모).
            let mut measured: Vec<(PathBuf, AccountState)> = Vec::with_capacity(due_now.len());
            for chunk in due_now.chunks(crate::usage_meter::MAX_PARALLEL) {
                let st = &*st;
                measured.extend(std::thread::scope(|s| {
                    let hs: Vec<_> = chunk
                        .iter()
                        .map(|(pool, name, dir)| {
                            let prev = st.get(dir);
                            s.spawn(move || {
                                (dir.clone(), self.measure_one(prev, pool, name, dir, at))
                            })
                        })
                        .collect();
                    hs.into_iter()
                        .filter_map(|h| h.join().ok())
                        .collect::<Vec<_>>()
                }));
            }
            for (d, s) in measured {
                st.set(d, s);
            }
            changed = true;
        }
        if changed {
            self.write(st, at)?;
        }
        Ok(())
    }

    fn write(&self, st: &mut PollState, at: f64) -> std::io::Result<()> {
        let o = &self.0.opts;
        let mine: Vec<Value> = st.states.iter().map(|(_, s)| s.entry.to_json()).collect();
        if !o.shared_file {
            return write_all(&o.root, at, mine);
        }
        fs::create_dir_all(&o.root)?;
        let lock = o.root.join(format!("{CLAUDE_USAGE_FILE}.lock"));
        let removed = std::mem::take(&mut st.removed_keys);
        let r = with_file_lock(&lock, &FileLockOptions::default(), || {
            let on_disk = read_usage_file(&o.root.join(CLAUDE_USAGE_FILE));
            write_all(&o.root, at, merge_usage_entries(on_disk, mine, &removed))
        });
        match r {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) | Err(e) => {
                // TS 는 실패하면 `removedKeys` 를 비우지 않는다 — 다음 회차에 다시 뺀다.
                st.removed_keys.extend(removed);
                Err(e)
            }
        }
    }
}

/// TS `readSignInKey` — "같은 로그인인가"의 비교 키. `.claude.json` 의 `oauthAccount` 의 uuid 둘(조직·계정)을
/// `org:acct` 로 이어 sha256 한 hex 앞 16자다. 식별자 원문은 파일에 남기지 않는다. 못 읽으면 `None`.
pub fn read_sign_in_key(config_dir: &Path) -> Option<String> {
    let raw = fs::read(config_dir.join(".claude.json")).ok()?;
    let v: Value = serde_json::from_slice(&raw).ok()?;
    let oa = v.get("oauthAccount")?;
    let org = oa
        .get("organizationUuid")?
        .as_str()
        .filter(|s| !s.is_empty())?;
    let acct = oa.get("accountUuid")?.as_str().filter(|s| !s.is_empty())?;
    let d = ring::digest::digest(&ring::digest::SHA256, format!("{org}:{acct}").as_bytes());
    let hex: String = d.as_ref().iter().map(|b| format!("{b:02x}")).collect();
    Some(hex[..16].to_string())
}

#[cfg(test)]
mod tests;
