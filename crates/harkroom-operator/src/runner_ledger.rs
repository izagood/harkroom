//! 러너 장부(s21c-2a) — 오퍼레이터가 죽어도 사는 러너(고아)를 다음 오퍼레이터가 다시 알아보게 하는 파일.
//! 정본은 `packages/operator/src/runnerLedger.ts` 다. **TS 와 같은 파일·같은 모양**을 읽고 쓴다 — 스위치(node↔rust)로
//! 오퍼레이터가 갈려도 앞 오퍼레이터가 띄운 러너를 채택할 수 있어야 하기 때문이다.
//!
//! **옮긴 성질**(TS 와 같다):
//! - 자리는 `<appDataDir>/operator/runners-v1.json`, 개명 전 자리는 `<appDataDir>/daemon/runners-v1.json`(읽기만).
//! - 장부는 **spawn 순간의 사실만** 담는다(살아 있는지는 읽는 쪽이 `kill(pid, 0)`·커널 시작 시각으로 묻는다).
//! - 읽기는 **던지지 않는다** — 없음·깨짐·버전 다름·배열 아님은 빈 목록, 모양이 틀린 줄은 그 줄만 버린다(`isEntry`).
//! - 쓰기는 **임시 파일(난수 이름) + rename**, 0600, 실패해도 던지지 않고 로그만.
//! - 쓰기 창구는 **줄 세우고 합친다** — 한 번에 하나, 기다리는 동안 온 새 스냅샷이 앞 것을 대신한다. 마지막 `save` 가
//!   마지막으로 디스크에 앉는다. `save` 는 디스크를 기다리지 않는다(spawn 응답을 늦추지 않는다).
//!
//! **TS 와 다른 점**: JS 는 단일 스레드라 `save` 를 부른 순서가 곧 스냅샷 순서다. 여기는 스레드가 여럿이므로
//! **부르는 쪽(러너 표)이 표 잠금을 쥔 채** `save` 를 불러야 같은 보장이 선다(배선은 c2b).
use serde::Serialize;
use serde_json::Value;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

/// 장부 파일 이름에 박힌 버전. 항목 모양이 바뀌면 올린다 — 신·구 오퍼레이터가 서로의 장부를 아예 안 본다.
pub const RUNNER_LEDGER_VERSION: u32 = 1;

pub fn runner_ledger_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir
        .join("operator")
        .join(format!("runners-v{RUNNER_LEDGER_VERSION}.json"))
}

/// 개명 전(`daemon/`) 장부 — 옛 daemon 이 띄운 고아를 다시 소유하려고 읽기만 한다.
pub fn legacy_runner_ledger_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir
        .join("daemon")
        .join(format!("runners-v{RUNNER_LEDGER_VERSION}.json"))
}

/// 회수 중 세대가 「인박스를 놓았다」고 알릴 때 실어 온 entry 들(TS `retiring`).
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct RetiringFacts {
    pub holding: Vec<i64>,
    pub done: Vec<i64>,
}

/// 장부 한 줄(TS `RunnerLedgerEntry`). 직렬화 키 순서는 TS 와 맞춘다(읽기에는 상관없다).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerLedgerEntry {
    pub agent_id: String,
    pub pid: i32,
    pub incarnation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_secret: Option<String>,
    pub started_at_ms: i64,
    /// 커널 시작 시각(초). 못 읽었으면 None — 그러면 채택하지 않는다(`adopt.ts::judgeCandidate`).
    /// TS 는 키가 **있어야** 하고 값이 null 일 수 있다 — 그래서 None 도 `null` 로 쓴다.
    pub boot_time_sec: Option<i64>,
    pub spawned_by_nonce: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawned_by_app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retiring: Option<RetiringFacts>,
}

/// JS `Number.isInteger` 와 같은 판정으로 정수를 꺼낸다(`3.0` 은 정수, `3.5` 는 아니다).
fn js_int(v: &Value) -> Option<i64> {
    if let Some(i) = v.as_i64() {
        return Some(i);
    }
    let f = v.as_f64()?;
    if f.is_finite() && f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0 {
        Some(f as i64)
    } else {
        None
    }
}

fn int_array(v: Option<&Value>) -> Option<Vec<i64>> {
    v?.as_array()?.iter().map(js_int).collect()
}

/// TS `isEntry` 이식. 맞지 않으면 None(그 줄만 버린다).
fn parse_entry(v: &Value) -> Option<RunnerLedgerEntry> {
    let o = v.as_object()?;
    let agent_id = o.get("agentId")?.as_str()?;
    if agent_id.is_empty() {
        return None;
    }
    let pid = js_int(o.get("pid")?)?;
    if pid <= 0 || pid > i64::from(i32::MAX) {
        return None;
    }
    let incarnation_id = o.get("incarnationId")?.as_str()?;
    // startedAtMs 는 TS 에서 typeof number 만 본다 — 소수도 받는다(잘라서 담는다).
    let started = o.get("startedAtMs")?;
    let started_at_ms = started.as_f64().filter(|f| f.is_finite())? as i64;
    // bootTimeSec: null 또는 number. 키가 없으면(undefined) 거절 — TS 와 같다.
    let boot_time_sec = match o.get("bootTimeSec")? {
        Value::Null => None,
        n => Some(n.as_f64().filter(|f| f.is_finite())? as i64),
    };
    let link_secret = match o.get("linkSecret") {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return None,
    };
    let retiring = match o.get("retiring") {
        None => None,
        Some(r) => {
            let r = r.as_object()?;
            Some(RetiringFacts {
                holding: int_array(r.get("holding"))?,
                done: int_array(r.get("done"))?,
            })
        }
    };
    // spawnedByNonce·spawnedByAppVersion 은 TS 가 검사하지 않는다 — 문자열이 아니면 없는 것으로 본다.
    let spawned_by_nonce = o
        .get("spawnedByNonce")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let spawned_by_app_version = o
        .get("spawnedByAppVersion")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(RunnerLedgerEntry {
        agent_id: agent_id.to_string(),
        pid: pid as i32,
        incarnation_id: incarnation_id.to_string(),
        link_secret,
        started_at_ms,
        boot_time_sec,
        spawned_by_nonce,
        spawned_by_app_version,
        retiring,
    })
}

/// 장부 본문을 읽는다(TS `readRunnerLedger` 의 파싱 부분). 던지지 않는다.
pub fn parse_runner_ledger(text: &str) -> Vec<RunnerLedgerEntry> {
    let Ok(parsed) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let Some(file) = parsed.as_object() else {
        return Vec::new();
    };
    if file.get("version").and_then(js_int) != Some(i64::from(RUNNER_LEDGER_VERSION)) {
        return Vec::new();
    }
    let Some(runners) = file.get("runners").and_then(Value::as_array) else {
        return Vec::new();
    };
    runners.iter().filter_map(parse_entry).collect()
}

/// 장부를 읽는다. 없거나 깨졌으면 빈 목록 — 던지지 않는다(첫 기동과 같게 다룬다).
pub fn read_runner_ledger(path: &Path) -> Vec<RunnerLedgerEntry> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse_runner_ledger(&text),
        Err(_) => Vec::new(),
    }
}

#[derive(Serialize)]
struct LedgerFile<'a> {
    version: u32,
    runners: &'a [RunnerLedgerEntry],
}

/// 장부를 통째로 다시 쓴다 — 난수 임시 이름 + rename, 0600. 실패는 로그만 남기고 던지지 않는다.
pub fn write_runner_ledger(app_data_dir: &Path, entries: &[RunnerLedgerEntry], log: &dyn Fn(&str)) {
    let path = runner_ledger_path(app_data_dir);
    let suffix = crate::endpoint::random_hex(16).unwrap_or_else(|_| {
        // 난수를 못 얻으면 시각으로라도 겹침을 피한다(같은 프로세스 겹침은 창구가 줄 세워 막는다).
        format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        )
    });
    let tmp = PathBuf::from(format!(
        "{}.tmp-{}-{suffix}",
        path.display(),
        std::process::id()
    ));
    let body = LedgerFile {
        version: RUNNER_LEDGER_VERSION,
        runners: entries,
    };
    let result = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(app_data_dir.join("operator"))?;
        let text = serde_json::to_string(&body).map_err(std::io::Error::other)?;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(text.as_bytes())?;
        drop(f);
        std::fs::rename(&tmp, &path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        log(&format!("러너 장부를 쓰지 못했다: {e}"));
    }
}

type WriteFn = dyn Fn(&Path, &[RunnerLedgerEntry], &dyn Fn(&str)) + Send + Sync;
type LogFn = dyn Fn(&str) + Send + Sync;

#[derive(Default)]
struct WriterState {
    /// 아직 디스크에 안 앉은 **최신** 스냅샷. 하나만 드는 것이 합치기다.
    pending: Option<Vec<RunnerLedgerEntry>>,
    running: bool,
}

struct WriterInner {
    app_data_dir: PathBuf,
    log: Box<LogFn>,
    write: Box<WriteFn>,
    state: Mutex<WriterState>,
    idle: Condvar,
}

/// 줄 세우는 장부 쓰기 창구(TS `createRunnerLedgerWriter`).
#[derive(Clone)]
pub struct RunnerLedgerWriter {
    inner: Arc<WriterInner>,
}

impl RunnerLedgerWriter {
    pub fn new(app_data_dir: PathBuf, log: Box<LogFn>) -> Self {
        Self::with_write(
            app_data_dir,
            log,
            Box::new(
                |dir: &Path, entries: &[RunnerLedgerEntry], log: &dyn Fn(&str)| {
                    write_runner_ledger(dir, entries, log)
                },
            ),
        )
    }

    /// `write` 주입 — 겹침은 느린 쓰기에서만 드러나므로 시험이 첫 쓰기를 늦춘다.
    pub fn with_write(app_data_dir: PathBuf, log: Box<LogFn>, write: Box<WriteFn>) -> Self {
        RunnerLedgerWriter {
            inner: Arc::new(WriterInner {
                app_data_dir,
                log,
                write,
                state: Mutex::new(WriterState::default()),
                idle: Condvar::new(),
            }),
        }
    }

    /// 스냅샷을 예약한다. 기다리지 않는다.
    pub fn save(&self, entries: Vec<RunnerLedgerEntry>) {
        let mut st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        st.pending = Some(entries);
        if st.running {
            return;
        }
        st.running = true;
        drop(st);
        let inner = Arc::clone(&self.inner);
        let spawned = std::thread::Builder::new()
            .name("runner-ledger".into())
            .spawn(move || pump(&inner));
        if spawned.is_err() {
            // 스레드를 못 띄우면 이 자리에서 쓴다 — 느려도 잃지 않는 쪽.
            pump(&self.inner);
        }
    }

    /// 예약된 쓰기가 전부 끝날 때까지 기다린다(시험·종료 자리).
    pub fn drain(&self) {
        let mut st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        while st.running {
            st = self.inner.idle.wait(st).unwrap_or_else(|e| e.into_inner());
        }
    }
}

fn pump(inner: &WriterInner) {
    loop {
        let next = {
            let mut st = inner.state.lock().unwrap_or_else(|e| e.into_inner());
            match st.pending.take() {
                Some(n) => n,
                None => {
                    st.running = false;
                    inner.idle.notify_all();
                    return;
                }
            }
        };
        // 주입된 write 가 패닉해도 루프가 끊겨 뒤 스냅샷이 영영 안 써지는 일이 없게 한다(TS try/catch).
        let wrote = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            (inner.write)(&inner.app_data_dir, &next, &*inner.log)
        }));
        if wrote.is_err() {
            (inner.log)("러너 장부를 쓰지 못했다: 쓰기가 패닉했다");
        }
    }
}

#[cfg(test)]
mod tests;
