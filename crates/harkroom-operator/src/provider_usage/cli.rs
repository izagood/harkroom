//! 계정별 한도 사용률을 **각 하네스 CLI** 로 읽는다. TS 정본은 `packages/operator/src/cliUsage.ts`.
//! API 를 직접 부르는 `fetch_*_provider_usage` 보다 먼저 쓴다(`cli_then_api`).
//!
//! - Claude: `claude -p /usage` 를 `CLAUDE_CONFIG_DIR=<계정>` 으로 돌려 텍스트를 해석한다.
//! - Codex: `codex app-server` 의 JSON-RPC `account/rateLimits/read` 를 `CODEX_HOME=<계정>` 으로.
//!
//! 토큰은 이 프로세스를 지나지 않는다 — CLI 가 자기 로그인으로 묻는다. 깨지면 던지지 않고 꼬리표
//! (`cli-unavailable`·`cli-unparsed`·`cli-error`·`timeout`)만 싣는다. stderr·RPC 에러 본문은 싣지 않는다.

use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::LazyLock;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::Value;

use super::tz::{civil_from_days, days_from_civil};
use super::{ExtraWindow, Measured, UsageWindow, clamp_percent};

/// 프로브 하나의 상한(TS `PROBE_TIMEOUT_MS`). claude 는 node 앱이라 뜨는 데 몇 초가 걸린다.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(45);
/// stdout 을 모으는 상한(TS 256 KiB).
const STDOUT_CAP: usize = 256 * 1024;

/// TS `usageProbeDir` — 사람의 프로젝트 안에서 돌리지 않는다(신뢰 대화상자·설정 상속).
pub fn usage_probe_dir(override_dir: Option<&OsStr>, home: Option<&OsStr>) -> PathBuf {
    match override_dir {
        Some(d) => PathBuf::from(d),
        None => PathBuf::from(home.unwrap_or_default())
            .join(".harkroom-agent")
            .join("usage-probe"),
    }
}

/// 이 프로세스의 환경으로 [`usage_probe_dir`].
pub fn default_usage_probe_dir() -> PathBuf {
    usage_probe_dir(
        std::env::var_os("HARKROOM_USAGE_PROBE_DIR").as_deref(),
        std::env::var_os("HOME").as_deref(),
    )
}

fn ensure_probe_dir(dir: &Path) {
    use std::os::unix::fs::DirBuilderExt;
    let _ = std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir);
}

// ── Claude `/usage` ─────────────────────────────────────────────────────────────

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const DAY_MS: f64 = 86_400_000.0;

/// 그 시간대의 벽시계 시각 → epoch ms. TS `zonedToEpoch` 와 같게 추정값의 오프셋으로 한 번 보정한다
/// (DST 경계 1시간 오차는 감수). `mo` 는 0부터.
fn zoned_to_epoch(y: i64, mo: i64, d: i64, h: i64, mi: i64, tz: &str) -> Option<f64> {
    let zone = super::tz::load(tz)?;
    let guess_s = days_from_civil(y, mo + 1, d) * 86_400 + h * 3600 + mi * 60;
    Some((guess_s - zone.offset_at(guess_s)) as f64 * 1000.0)
}

static RESET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:([A-Za-z]{3})[a-z]*\.? (\d{1,2})(?:,? at)? )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)\s*$")
        .expect("reset regex")
});

/// TS `parseClaudeReset` — `resets Sep 29 at 5:29am (Asia/Seoul)` · `7pm (Asia/Seoul)` → epoch ms.
/// 연도는 출력에 없으므로 지금 이후로 가장 가까운 해로 잡는다.
pub fn parse_claude_reset(text: &str, now: f64) -> Option<f64> {
    let m = RESET_RE.captures(text.trim())?;
    let num = |i: usize| m.get(i).and_then(|g| g.as_str().parse::<i64>().ok());
    let mut hour = num(3)? % 12;
    if m[5].eq_ignore_ascii_case("pm") {
        hour += 12;
    }
    let minute = num(4).unwrap_or(0);
    let tz = &m[6];
    let (mut year, now_m, now_d) = civil_from_days((now / DAY_MS).floor() as i64);
    let dated = m.get(1).is_some();
    let (month, day) = if let Some(mon) = m.get(1) {
        let lower = mon.as_str().to_ascii_lowercase();
        (MONTHS.iter().position(|x| *x == lower)? as i64, num(2)?)
    } else {
        // 날짜가 없으면 "오늘" — 이미 지났으면 내일이다.
        (now_m - 1, now_d)
    };
    let mut at = zoned_to_epoch(year, month, day, hour, minute, tz)?;
    if !dated && at < now {
        at += DAY_MS;
    }
    if dated && at < now - DAY_MS {
        year += 1;
        at = zoned_to_epoch(year, month, day, hour, minute, tz)?;
    }
    Some(at)
}

static ANSI_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").expect("ansi regex"));
static LINE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*Current (session|week(?: \(([^)]+)\))?):\s*(\d+(?:\.\d+)?)% used(?:\s*[·•-]\s*resets\s+(.+))?\s*$")
        .expect("usage line regex")
});
static ALL_MODELS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^all models$").expect("all models regex"));

/// TS `parseClaudeUsageText` — 세션·주간 창이 하나도 없으면 `None`(로그인 안 됨·판본 바뀜).
pub fn parse_claude_usage_text(text: &str, now: f64) -> Option<Measured> {
    let mut session = None;
    let mut weekly = None;
    let mut extra = Vec::new();
    let clean = ANSI_RE.replace_all(text, "");
    for line in clean.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(m) = LINE_RE.captures(line) else {
            continue;
        };
        let Ok(used) = m[3].parse::<f64>() else {
            continue;
        };
        let w = UsageWindow {
            used_percent: clamp_percent(used),
            resets_at_ms: m.get(4).and_then(|r| parse_claude_reset(r.as_str(), now)),
            window_minutes: None,
        };
        if m[1].eq_ignore_ascii_case("session") {
            session = Some(w);
        } else {
            match m.get(2) {
                Some(label) if !ALL_MODELS_RE.is_match(label.as_str()) => extra.push(ExtraWindow {
                    label: format!("{} weekly", label.as_str()),
                    window: w,
                }),
                _ => weekly = Some(w),
            }
        }
    }
    (session.is_some() || weekly.is_some()).then_some(Measured {
        fetched_at_ms: now,
        session,
        weekly,
        extra: Some(extra),
        plan: None,
        error: None,
        source: None,
    })
}

/// 명령 하나를 돌려 (종료 코드, stdout) 을 받는다. 테스트가 가짜를 끼운다(TS `RunCommand`).
/// 코드가 `None` 이면 못 띄웠거나 시한에 죽였거나 신호로 끝났다.
pub trait RunCommand {
    fn run(
        &self,
        cmd: &str,
        args: &[&str],
        envs: &[(&str, &OsStr)],
        cwd: &Path,
        timeout: Duration,
    ) -> (Option<i32>, String);
}

/// 기본 실행기. stdout 만 모은다 — stderr 에는 무엇이 섞일지 모른다(결과에 싣지 않는다).
pub struct StdRunCommand;

impl RunCommand for StdRunCommand {
    fn run(
        &self,
        cmd: &str,
        args: &[&str],
        envs: &[(&str, &OsStr)],
        cwd: &Path,
        timeout: Duration,
    ) -> (Option<i32>, String) {
        let mut c = Command::new(cmd);
        c.args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (k, v) in envs {
            c.env(k, v);
        }
        let Ok(mut child) = c.spawn() else {
            return (None, String::new());
        };
        let reader = child.stdout.take().map(|mut out| {
            std::thread::spawn(move || {
                // 상한을 넘으면 버리면서 끝까지 읽는다 — 파이프가 차서 자식이 멈추지 않게.
                let mut keep = Vec::new();
                let mut buf = [0u8; 8192];
                while let Ok(n) = out.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let room = STDOUT_CAP.saturating_sub(keep.len());
                    keep.extend_from_slice(&buf[..n.min(room)]);
                }
                String::from_utf8_lossy(&keep).into_owned()
            })
        });
        let deadline = Instant::now() + timeout;
        let code = loop {
            match child.try_wait() {
                Ok(Some(st)) => break st.code(),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
            }
        };
        let out = reader.and_then(|r| r.join().ok()).unwrap_or_default();
        (code, out)
    }
}

/// TS `claudeCliUsage`.
pub fn claude_cli_usage(
    config_dir: &Path,
    now: f64,
    run: &dyn RunCommand,
    probe_dir: &Path,
) -> Measured {
    ensure_probe_dir(probe_dir);
    let (code, stdout) = run.run(
        "claude",
        &[
            "-p",
            "/usage",
            "--no-session-persistence",
            "--allowed-tools",
            "",
            // 프로브 프로세스에서만 Remote Control 기동을 끈다(저장된 설정은 그대로).
            "--settings",
            r#"{"remoteControlAtStartup":false}"#,
        ],
        &[("CLAUDE_CONFIG_DIR", config_dir.as_os_str())],
        probe_dir,
        PROBE_TIMEOUT,
    );
    if code.is_none() {
        return Measured::failed(now, "cli-unavailable");
    }
    parse_claude_usage_text(&stdout, now).unwrap_or_else(|| Measured::failed(now, "cli-unparsed"))
}

// ── Codex `app-server` ──────────────────────────────────────────────────────────

/// JSON-RPC 한 줄씩 주고받는 자식(TS `RpcChild`). `terminate` 는 끝낼 때 한 번 부른다.
pub struct RpcChild {
    pub stdin: Box<dyn Write + Send>,
    pub stdout: Box<dyn Read + Send>,
    pub terminate: Box<dyn FnOnce() + Send>,
}

/// 테스트가 가짜를 끼운다(TS `SpawnRpc`). 못 띄우면 `None`.
pub trait SpawnRpc {
    fn spawn(&self, codex_home: &Path, cwd: &Path) -> Option<RpcChild>;
}

pub struct StdSpawnRpc;

/// SIGTERM 을 보내고, 뒤에서 거둔다 — 5초 안에 안 끝나면 SIGKILL.
fn terminate_child(mut child: Child) {
    if let Ok(pid) = libc::pid_t::try_from(child.id()) {
        // SAFETY: 우리가 띄운 자식의 pid 에 신호만 보낸다.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
            }
        }
    });
}

impl SpawnRpc for StdSpawnRpc {
    fn spawn(&self, codex_home: &Path, cwd: &Path) -> Option<RpcChild> {
        let mut child = Command::new("codex")
            .args(["-s", "read-only", "-a", "never", "app-server"])
            .env("CODEX_HOME", codex_home)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        Some(RpcChild {
            stdin: Box::new(stdin),
            stdout: Box::new(stdout),
            terminate: Box::new(move || terminate_child(child)),
        })
    }
}

fn codex_rpc_window(raw: Option<&Value>) -> Option<UsageWindow> {
    let o = raw?.as_object()?;
    let used = o.get("usedPercent")?.as_f64()?;
    Some(UsageWindow {
        used_percent: clamp_percent(used),
        resets_at_ms: o
            .get("resetsAt")
            .and_then(Value::as_f64)
            .map(|s| s * 1000.0),
        window_minutes: o.get("windowDurationMins").and_then(Value::as_f64),
    })
}

/// TS `parseCodexRateLimits` — 창이 하나도 없으면 `None`.
pub fn parse_codex_rate_limits(result: &Value, now: f64) -> Option<Measured> {
    let rl = result.get("rateLimits")?;
    let session = codex_rpc_window(rl.get("primary"));
    let weekly = codex_rpc_window(rl.get("secondary"));
    if session.is_none() && weekly.is_none() {
        return None;
    }
    Some(Measured {
        fetched_at_ms: now,
        session,
        weekly,
        extra: None,
        plan: rl
            .get("planType")
            .and_then(Value::as_str)
            .map(str::to_owned),
        error: None,
        source: None,
    })
}

/// JS 의 참거짓(`if (msg.error)`).
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn send_line(stdin: &mut dyn Write, v: &Value) {
    // 쓰기 실패는 무시한다 — 자식이 끝나면 stdout 이 닫혀 끝난다(TS 와 같다).
    let _ = writeln!(stdin, "{v}").and_then(|()| stdin.flush());
}

/// TS `codexCliUsage` — initialize → initialized → account/rateLimits/read.
pub fn codex_cli_usage(
    codex_home: &Path,
    now: f64,
    spawn: &dyn SpawnRpc,
    probe_dir: &Path,
    timeout: Duration,
) -> Measured {
    ensure_probe_dir(probe_dir);
    let Some(RpcChild {
        mut stdin,
        stdout,
        terminate,
    }) = spawn.spawn(codex_home, probe_dir)
    else {
        return Measured::failed(now, "cli-unavailable");
    };
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
        // 여기서 tx 가 떨어지면 받는 쪽은 Disconnected — 자식이 끝났다.
    });
    send_line(
        &mut *stdin,
        &serde_json::json!({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "harkroom", "version": "0"}}}),
    );
    let deadline = Instant::now() + timeout;
    let result = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let line = match rx.recv_timeout(left) {
            Ok(l) => l,
            Err(mpsc::RecvTimeoutError::Timeout) => break Measured::failed(now, "timeout"),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break Measured::failed(now, "cli-unavailable");
            }
        };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match msg.get("id").and_then(Value::as_f64) {
            Some(1.0) => {
                send_line(&mut *stdin, &serde_json::json!({"method": "initialized"}));
                send_line(
                    &mut *stdin,
                    &serde_json::json!({"id": 2, "method": "account/rateLimits/read", "params": null}),
                );
            }
            Some(2.0) => {
                // 에러 본문은 싣지 않는다 — 무엇이 들어 있을지 모른다.
                if msg.get("error").is_some_and(truthy) {
                    break Measured::failed(now, "cli-error");
                }
                let parsed = msg
                    .get("result")
                    .and_then(|r| parse_codex_rate_limits(r, now));
                break parsed.unwrap_or_else(|| Measured::failed(now, "cli-unparsed"));
            }
            _ => {}
        }
    };
    drop(stdin);
    terminate();
    result
}

#[cfg(test)]
mod tests;
