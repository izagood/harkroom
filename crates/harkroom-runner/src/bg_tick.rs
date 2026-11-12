//! 정본 `bgExecutor.ts` 의 틱 루프 절반(B3e-5b) — 자리 잡기·`bg.claim`·spawn·시한·결과 분류·`bg.complete`·작업 폴더 지움.
//!
//! 판정·조립(argv·지시문·MCP 설정·프롬프트)은 `bg_executor`(B3e-5a)에 있다. 결과 읽기는 `review_fork::parse_fork_result`.
//! 오퍼레이터와 같이 std::thread 구조다 — `tick` 은 부른 스레드에서 회차 하나를 끝까지 돈다(정본은 `await run`).
//!
//! 정본과 다른 점:
//! ① `tick` 이 처음부터 끝까지 한 번에 하나다 — 다른 스레드가 같은 실행기로 틱을 돌리는 중이면 자리·claim 전이라도
//!   `Busy` 로 물러난다(정본은 회차가 돌기 시작한 뒤에만 busy). 하네스 읽기는 그때도 하지 않는다.
//! ② 일감 꼴 검사(security): `kind` 는 서버 `BG_KINDS`(distill·cleanup·organize)만 돌린다 — 정본은 모르는 종류를 cleanup
//!   프롬프트로 돌렸다. `id` 는 작업 폴더 이름이 되므로 uuid 꼴만 받는다. 둘 다 아니면 띄우지 않고 skipped 로 닫는다.
//! ③ 자식은 자기 프로세스 그룹(`process_group(0)`)으로 띄우고 env 를 비운 뒤 plan env 만 준다(security). 시한에는
//!   `killpg(SIGKILL)` 로 그룹째 죽이고 거둔다 — claude 가 띄운 MCP 브릿지 자식이 남지 않는다.
//! ④ `bg.complete` 의 `error` 는 고정 코드만(timeout·quota·max_turns·exit N·runner·unknown_kind·bad_job), 요약은 하네스의
//!   마지막 답 첫 줄에서 상태 디렉터리·HOME 경로를 가린다(security: 행에 경로·키가 남지 않게). 러너 오류 본문은 로그에만.

use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::Serialize;

use crate::adapter::AgentHarness;
use crate::bg_executor::{
    BG_SLOT_KEY, BG_TIMEOUT, BgJob, bg_executor_args, bg_prompt, in_bg_window,
};
use crate::link::random_uuid;
use crate::review_fork::{ForkChild, ForkSpawn, parse_fork_result};

/// 서버 `bgJobs.ts::BG_KINDS` 와 같아야 한다. 이 밖의 종류는 돌리지 않는다.
pub const BG_KINDS: &[&str] = &["distill", "cleanup", "organize"];

/// 할당량·로그인 문제로 보이는 끝 — 실패가 아니라 「다음 창」(skipped). 정본 `QUOTA_RE`.
static QUOTA_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)usage limit|rate limit|quota|credit balance|Please run /login|not logged in")
        .expect("QUOTA_RE")
});

/// max-turns 에 닿은 끝(정본: claude 2.1.305 실측 subtype error_max_turns·exit 1).
static MAX_TURNS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""subtype"\s*:\s*"error_max_turns""#).expect("MAX_TURNS_RE"));

/// `bg.complete` 의 status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BgStatus {
    Done,
    Failed,
    Skipped,
}

/// `bg.complete` 에 싣는 결말(정본 `completeBg` 의 `r`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BgOutcome {
    pub status: BgStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

impl BgOutcome {
    fn fail(status: BgStatus, error: &str, tokens: Option<u64>, duration_ms: u64) -> Self {
        Self {
            status,
            summary: None,
            error: Some(error.to_owned()),
            tokens,
            duration_ms: Some(duration_ms),
        }
    }
}

/// 서버 쪽 `bg.claim`·`bg.complete`(정본 `BgHarkroom`).
pub trait BgHarkroom: Send + Sync {
    fn claim_bg(&self) -> Result<Option<BgJob>, String>;
    fn complete_bg(&self, job_id: &str, outcome: &BgOutcome) -> Result<(), String>;
}

/// 동시 턴 자리 답(오퍼레이터 `HARKROOM_MAX_TURNS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotGrant {
    Granted,
    Full,
    /// 옛 오퍼레이터 — 상한이 없는 것으로 본다.
    Unsupported,
}

/// 동시 턴 자리(정본 `slots`). `keep_free: 1` — 한 칸은 사람 턴 몫으로 남긴다.
pub trait BgSlots: Send + Sync {
    fn acquire(&self, key: &str, keep_free: u32) -> SlotGrant;
    fn release(&self, key: &str);
}

/// 일반 턴과 같은 조립으로 만든 plan(원인 `bg:<jobId>`, 새 세션 id). `release` 는 턴 열쇠·턴 MCP 설정을 놓는다 —
/// 띄우기 실패·시한 초과에도 한 번 부른다.
pub struct BgPlan {
    pub command: String,
    pub args: Vec<String>,
    /// 자식 env 전체 — 러너 env 를 물려주지 않는다.
    pub env: Vec<(String, String)>,
    pub release: Option<Box<dyn FnOnce() + Send>>,
}

pub type BgHarnessFn = dyn Fn() -> Result<AgentHarness, String> + Send + Sync;
pub type BgBuildPlan = dyn Fn(&BgJob, &str, &Path) -> Result<BgPlan, String> + Send + Sync;
pub type BgLog = dyn Fn(&str) + Send + Sync;
pub type BgNow = dyn Fn() -> i64 + Send + Sync;

/// 정본 `BgExecutorDeps`.
pub struct BgExecutorDeps {
    /// 지금 이 에이전트의 하네스(정의는 바뀔 수 있어 매번 읽는다).
    pub harness: Box<BgHarnessFn>,
    pub harkroom: Box<dyn BgHarkroom>,
    pub build_plan: Box<BgBuildPlan>,
    pub slots: Box<dyn BgSlots>,
    pub state_dir: PathBuf,
    pub spawn: Option<Box<ForkSpawn>>,
    /// 유닉스 밀리초.
    pub now_ms: Option<Box<BgNow>>,
    pub timeout: Option<Duration>,
    pub log: Option<Box<BgLog>>,
}

/// 정본 `BgTickResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BgTickResult {
    NotClaude,
    Busy,
    OutsideWindow,
    NoSlot,
    None,
    Ran,
}

/// 러너 하나에 하나. `tick` 을 주기적으로 부른다 — 창 안·빈 칸이 있으면 일감 하나를 끝까지 돈다.
pub struct BgExecutor {
    deps: BgExecutorDeps,
    in_flight: AtomicBool,
}

/// 틱이 끝나면(어느 길로든) 도는 표시를 내린다.
struct InFlight<'a>(&'a AtomicBool);

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl BgExecutor {
    pub fn new(deps: BgExecutorDeps) -> Self {
        Self {
            deps,
            in_flight: AtomicBool::new(false),
        }
    }

    /// 지금 틱(회차)이 도는가.
    pub fn running(&self) -> bool {
        self.in_flight.load(Ordering::SeqCst)
    }

    pub fn tick(&self) -> BgTickResult {
        // 공짜인 로컬 판정을 먼저 — 하네스 읽기(GET /agent/config)는 이 틱이 실제로 일감을 볼 때만 한다.
        if self
            .in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return BgTickResult::Busy;
        }
        let _flight = InFlight(&self.in_flight);
        if !in_bg_window(self.now_ms()) {
            return BgTickResult::OutsideWindow;
        }
        if (self.deps.harness)().ok() != Some(AgentHarness::ClaudeCode) {
            return BgTickResult::NotClaude;
        }
        // 자리를 **먼저** 잡는다 — 집은 뒤에 자리가 없으면 회차가 running 으로 매달린다.
        if self.deps.slots.acquire(BG_SLOT_KEY, 1) == SlotGrant::Full {
            return BgTickResult::NoSlot;
        }
        let out = match self.deps.harkroom.claim_bg() {
            Err(e) => {
                self.log(&format!("[bg] claim 실패 — 다음 주기에 다시: {e}"));
                BgTickResult::None
            }
            Ok(None) => BgTickResult::None,
            Ok(Some(job)) => {
                self.run(&job);
                BgTickResult::Ran
            }
        };
        self.deps.slots.release(BG_SLOT_KEY);
        out
    }

    fn run(&self, job: &BgJob) {
        let started = Instant::now();
        let outcome = match check_job(job) {
            Some(code) => {
                self.log(&format!("[bg] job 건너뜀 — {code}"));
                BgOutcome::fail(BgStatus::Skipped, code, None, 0)
            }
            None => self.run_checked(job, started),
        };
        // 채팅이 아니라 행에만 남긴다. 보고가 실패하면 서버 sweep 이 시한 뒤 timeout 으로 닫는다.
        if let Err(e) = self.deps.harkroom.complete_bg(&job.id, &outcome) {
            self.log(&format!(
                "[bg] complete 보고 실패 — 서버가 시한 뒤 닫는다: {e}"
            ));
        }
    }

    fn run_checked(&self, job: &BgJob, started: Instant) -> BgOutcome {
        let session_id = random_uuid();
        let cwd = self.deps.state_dir.join("bg").join(&job.id);
        let mut release: Option<Box<dyn FnOnce() + Send>> = None;
        let outcome = match self.spawn_and_wait(job, &session_id, &cwd, &mut release, started) {
            Ok(o) => o,
            Err(e) => {
                self.log(&format!("[bg] job {} 러너 오류: {e}", job.id));
                BgOutcome::fail(BgStatus::Failed, "runner", None, elapsed_ms(started))
            }
        };
        if let Some(r) = release.take() {
            // 정본은 release 의 실패를 삼킨다 — 여기서는 panic 도 회차 보고를 막지 않게 가둔다.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(r));
        }
        let _ = fs::remove_dir_all(&cwd);
        outcome
    }

    fn spawn_and_wait(
        &self,
        job: &BgJob,
        session_id: &str,
        cwd: &Path,
        release: &mut Option<Box<dyn FnOnce() + Send>>,
        started: Instant,
    ) -> Result<BgOutcome, String> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(cwd)
            .map_err(|e| format!("작업 폴더를 못 만들었다({})", e.kind()))?;
        let plan = (self.deps.build_plan)(job, session_id, cwd)?;
        *release = plan.release;
        let args = bg_executor_args(&plan.args, session_id).map_err(|e| e.to_string())?;
        let mut child = match &self.deps.spawn {
            Some(f) => f(&plan.command, &args, cwd, &plan.env),
            None => default_spawn(&plan.command, &args, cwd, &plan.env),
        }
        .map_err(|e| format!("띄우기 실패({})", e.kind()))?;

        // 읽기는 채널로 받는다 — 자식이 끝난 뒤 남은 손자가 파이프를 쥐고 있어도 `READER_GRACE` 만 기다린다.
        let reader = child.take_stdout().map(|mut r| {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = r.read_to_end(&mut buf);
                let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
            });
            rx
        });
        let _ = child.feed_stdin(&bg_prompt(job));
        let timeout = self.deps.timeout.unwrap_or(BG_TIMEOUT);
        let mut timed_out = false;
        let exit_code: Option<i32> = loop {
            match child.try_wait() {
                Ok(Some(code)) => break code,
                Ok(None) => {}
                Err(_) => {
                    child.kill();
                    break None;
                }
            }
            if started.elapsed() >= timeout {
                timed_out = true;
                child.kill();
                break None;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let stdout = reader
            .and_then(|rx| rx.recv_timeout(READER_GRACE).ok())
            .unwrap_or_default();
        let outcome = classify(
            &stdout,
            exit_code,
            timed_out,
            elapsed_ms(started),
            &self.redactions(),
        );
        let parsed = parse_fork_result(&stdout);
        self.log(&format!(
            "[bg] job {} {}: {:?}{} turns={} tokens={} ms={}",
            job.id,
            job.kind,
            outcome.status,
            outcome
                .error
                .as_deref()
                .map(|e| format!(" {e}"))
                .unwrap_or_default(),
            parsed
                .num_turns
                .map_or_else(|| "?".into(), |n| n.to_string()),
            outcome.tokens.map_or_else(|| "?".into(), |n| n.to_string()),
            outcome.duration_ms.unwrap_or(0),
        ));
        Ok(outcome)
    }

    /// 요약에서 가릴 경로 — 상태 디렉터리와 HOME.
    fn redactions(&self) -> Vec<(String, &'static str)> {
        let mut v = vec![(
            self.deps.state_dir.to_string_lossy().into_owned(),
            "<state>",
        )];
        if let Some(h) = std::env::var_os("HOME") {
            v.push((h.to_string_lossy().into_owned(), "~"));
        }
        v.retain(|(p, _)| p.len() > 1);
        v
    }

    fn now_ms(&self) -> i64 {
        match &self.deps.now_ms {
            Some(f) => f(),
            None => SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as i64),
        }
    }

    fn log(&self, line: &str) {
        match &self.deps.log {
            Some(f) => f(line),
            None => eprintln!("{line}"),
        }
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

/// 일감 꼴 검사 — 돌릴 수 없으면 고정 코드.
fn check_job(job: &BgJob) -> Option<&'static str> {
    let uuid = job.id.len() == 36 && job.id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
    if !uuid {
        return Some("bad_job");
    }
    if !BG_KINDS.contains(&job.kind.as_str()) {
        return Some("unknown_kind");
    }
    None
}

/// 정본 `run` 의 결과 분류. 순수 함수다.
pub fn classify(
    stdout: &str,
    exit_code: Option<i32>,
    timed_out: bool,
    duration_ms: u64,
    redactions: &[(String, &'static str)],
) -> BgOutcome {
    let parsed = parse_fork_result(stdout);
    let tokens = parsed
        .usage
        .map(|u| u.input + u.cache_read + u.cache_creation + u.output);
    if timed_out {
        return BgOutcome::fail(BgStatus::Failed, "timeout", tokens, duration_ms);
    }
    if parsed.is_error == Some(true)
        && QUOTA_RE.is_match(parsed.result.as_deref().unwrap_or(stdout))
    {
        return BgOutcome::fail(BgStatus::Skipped, "quota", tokens, duration_ms);
    }
    if MAX_TURNS_RE.is_match(stdout) {
        return BgOutcome::fail(BgStatus::Failed, "max_turns", tokens, duration_ms);
    }
    if exit_code != Some(0) || parsed.is_error != Some(false) {
        let code = exit_code.map_or_else(|| "spawn".to_owned(), |c| c.to_string());
        return BgOutcome::fail(
            BgStatus::Failed,
            &format!("exit {code}"),
            tokens,
            duration_ms,
        );
    }
    let mut first = parsed
        .result
        .as_deref()
        .unwrap_or("")
        .split('\n')
        .next()
        .unwrap_or("")
        .to_owned();
    for (from, to) in redactions {
        first = first.replace(from.as_str(), to);
    }
    BgOutcome {
        status: BgStatus::Done,
        summary: Some(if first.is_empty() {
            "(요약 없음)".into()
        } else {
            first
        }),
        error: None,
        tokens,
        duration_ms: Some(duration_ms),
    }
}

/// 자식이 끝난 뒤 읽기 스레드를 기다리는 상한.
const READER_GRACE: Duration = Duration::from_secs(2);

/// 자기 프로세스 그룹으로 띄운 자식 — 죽일 때 그룹째(`killpg`) 죽이고 거둔다.
struct GroupChild(std::process::Child);

impl ForkChild for GroupChild {
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.0
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>)
    }
    fn feed_stdin(&mut self, text: &str) -> io::Result<()> {
        let Some(mut stdin) = self.0.stdin.take() else {
            return Ok(());
        };
        stdin.write_all(text.as_bytes())
    }
    /// 끝났는지는 회수하지 않고(`WNOWAIT`) 본다. 끝났으면 **회수 전에** 그룹을 걷어(손자 MCP 브릿지 등) 그 뒤 회수한다 —
    /// 먼저 회수하면 그룹 번호가 재사용될 틈이 생기고, 남은 손자가 stdout 을 쥐어 읽기가 끝나지 않는다(security #1961 낮음).
    fn try_wait(&mut self) -> io::Result<Option<Option<i32>>> {
        let pid = self.0.id() as libc::pid_t;
        if !crate::pi_home::exited_unreaped(pid)? {
            return Ok(None);
        }
        self.kill_group();
        Ok(Some(self.0.wait()?.code()))
    }
    fn kill(&mut self) {
        self.kill_group();
        let _ = self.0.wait();
    }
}

impl GroupChild {
    /// 그룹째 SIGKILL — process_group(0) 이라 그룹 id = 자식 pid. 그룹이 없으면 자식만.
    fn kill_group(&mut self) {
        let pid = self.0.id() as libc::pid_t;
        // SAFETY: killpg 는 신호만 보낸다 — 메모리를 건드리지 않는다. 자식은 아직 회수 전이라 번호가 살아 있다.
        if pid <= 0 || unsafe { libc::killpg(pid, libc::SIGKILL) } != 0 {
            let _ = self.0.kill();
        }
    }
}

fn default_spawn(
    command: &str,
    args: &[String],
    cwd: &Path,
    env: &[(String, String)],
) -> io::Result<Box<dyn ForkChild>> {
    let child = Command::new(command)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(Box::new(GroupChild(child)))
}

#[cfg(test)]
#[path = "bg_tick_tests.rs"]
mod tests;
