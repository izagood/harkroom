//! 정본 `reviewFork.ts` — 턴 뒤 리뷰 포크(D1 실험).
//!
//! 성공한 턴 몇 번마다 그 턴의 claude 세션을 **포크**(`--resume <id> --fork-session`)해 같은 대화를 다시 읽히고
//! "남길 교정·선호·절차가 있었나"를 묻는다. 있으면 포크가 `memory.set` 으로 남기고, 다른 에이전트도 쓸 절차면
//! `skill.propose` 로 **제안만** 한다. 원 세션은 그대로다(포크는 새 session id 를 받는다).
//!
//! 실험 스위치 뒤에 있다 — **켠 에이전트만** 돈다: env `HARKROOM_REVIEW_FORK_AGENTS`(에이전트 id, 쉼표) 또는 러너 상태
//! 디렉터리의 `review-fork.on` 파일(턴마다 본다).
//!
//! 안전: 포크는 `--permission-mode dontAsk` + `--allowedTools` 로 기억 도구만 허락하고 `--disallowedTools` 로
//! 발화·inbox·예약·자동화·비밀·셸·편집을 막는다. 원 턴이 `auto` 일 때만 띄운다(readonly 턴의 포크가 권한을 넓히지
//! 않게, security #1009 참고 1). 5분 넘으면 죽인다.
//!
//! 정본과 다른 점: ① 오퍼레이터처럼 std::thread 구조라 `after_turn` 은 띄운 포크의 `JoinHandle` 을 돌려준다(정본은
//! 감싼 프라미스) ② 카운터 파일·지시문 사본을 `write_private`(0600·O_NOFOLLOW 임시 파일 → rename)로 쓴다(정본은
//! 카운터를 기본 권한 `writeFile`, 사본은 `copyFile` 뒤 chmod) ③ 기록 시각은 `toISOString` 꼴(`…Z`)만 읽는다.
//! 턴 루프에 잇는 것은 B3e-7 이다.

use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::adapter::{AgentHarness, supports_review_fork};
use crate::omp_home::parse_iso_utc_ms;
use crate::pty_record::iso_utc;
use crate::turn_files::write_private;

/// 이만큼 성공한(세는) 턴마다 한 번 리뷰한다.
pub const REVIEW_FORK_EVERY_TURNS: u32 = 5;
/// 포크 프로세스 상한. 넘으면 죽인다.
pub const REVIEW_FORK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
pub const REVIEW_FORK_ENV: &str = "HARKROOM_REVIEW_FORK_AGENTS";
/// 러너 상태 디렉터리에 이 파일이 있으면 켜진다.
pub const REVIEW_FORK_ON_FILE: &str = "review-fork.on";
pub const REVIEW_FORK_STATE_FILE: &str = "review-fork.json";
pub const REVIEW_FORK_SYSTEM_PROMPT_COPY: &str = "review-fork-system-prompt.md";
/// 기록 꼬리로 읽는 크기(정본 `harnessErrors.ts::TAIL_BYTES`).
const TRANSCRIPT_TAIL_BYTES: u64 = 256 * 1024;

/// 포크가 묻지 않고 부를 수 있는 도구.
pub const REVIEW_ALLOWED_TOOLS: &[&str] = &[
    "mcp__harkroom__memory_get",
    "mcp__harkroom__memory_search",
    "mcp__harkroom__memory_list",
    "mcp__harkroom__memory_set",
    "mcp__harkroom__skill_propose",
    // MCP 도구가 지연 로드되는 판에서는 이것으로 스키마를 받아야 부를 수 있다.
    "ToolSearch",
];

/// 아예 못 쓰게 하는 도구. `dontAsk` 로도 거절되지만 이름으로 한 번 더 막는다.
pub const REVIEW_DISALLOWED_TOOLS: &[&str] = &[
    "Bash",
    "Edit",
    "Write",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "Task",
    "Agent",
    "mcp__harkroom__message_post",
    "mcp__harkroom__message_progress",
    "mcp__harkroom__message_report",
    "mcp__harkroom__message_fail",
    "mcp__harkroom__message_ask",
    "mcp__harkroom__message_askBundle",
    "mcp__harkroom__message_askBundleResolve",
    "mcp__harkroom__message_delegate",
    "mcp__harkroom__message_react",
    "mcp__harkroom__message_unreact",
    "mcp__harkroom__inbox_poll",
    "mcp__harkroom__inbox_read",
    "mcp__harkroom__turn_wake",
    "mcp__harkroom__automation_propose",
    "mcp__harkroom__automation_run",
    "mcp__harkroom__secret_mount",
];

pub const REVIEW_PROMPT: &str = "[harkroom 리뷰] 이것은 사람에게 가는 턴이 아니다. 방금 대화를 돌아보고 **다음 턴의 네가 알아야 할 것**만 기억에 남겨라.

남길 것(있을 때만):
- 사람이 너를 **교정**했거나 선호를 말했다(말투·절차·하지 말 것). 1급 신호다.
- 이 대화에서 처음 알아낸, 되풀이해 쓸 사실(저장소·도구·환경의 규칙)과 그 이유.

쓰는 법:
- 먼저 memory.list·memory.search·memory.get 으로 이미 있는 항목을 찾는다. 있으면 그것을 고친다(ifUpdatedAt). 새 slug 를 늘리지 않는다.
- 사건 서술·PR 번호·날짜별 경위는 쓰지 않는다. 일반 규칙과 **왜 그런지**를 쓴다.
- core 에는 포인터 한 줄만. 주제는 mem/<이름> 에, 언제 열어 볼지 알 수 있는 description 과 kind(topic=되풀이할 사실·교훈 | procedure=절차)를 함께.
- 스킬(skill.propose)은 같은 절차를 세 번쯤 되풀이했고 **다른 에이전트도 그대로 따라 할 수 있을 때만** 제안한다. 확실하지 않으면 제안하지 않는다.

**남길 것이 없으면 아무 도구도 부르지 말고 끝내라 — 그것이 가장 흔한 정답이다.**
발화(message.*)·예약·셸·파일 편집은 하지 않는다. 끝낼 때 무엇을 남겼는지 한 줄로만 적는다.";

/// 원 턴의 plan 중 포크가 물려받는 칸(정본 `TurnPlan`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkPlan {
    pub command: String,
    pub args: Vec<String>,
    /// 자식 env 전체 — 러너 env 를 물려주지 않는다.
    pub env: Vec<(String, String)>,
}

/// 리뷰 포크가 받는 재료 — 방금 끝난 턴의 사실들(정본 `ReviewForkTurn`).
#[derive(Debug, Clone)]
pub struct ReviewForkTurn {
    pub agent_id: String,
    pub harness: AgentHarness,
    pub session_id: Option<String>,
    /// 원 턴의 cwd. claude 세션 기록은 cwd 로 찾으므로 같아야 이어진다.
    pub cwd: PathBuf,
    pub plan: ForkPlan,
    pub claude_config_dir: Option<PathBuf>,
    /// 예약·위임 결말·자동화로 깨어난 턴. 세지도 돌리지도 않는다.
    pub skip: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkTokenUsage {
    pub input: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
    pub output: u64,
}

/// `--output-format json` 결과에서 읽은 칸(정본 `parseForkResult` 의 반환).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ForkResult {
    pub fork_session_id: Option<String>,
    pub usage: Option<ForkTokenUsage>,
    pub cache_read_ratio: Option<f64>,
    pub num_turns: Option<u64>,
    pub is_error: Option<bool>,
    pub result: Option<String>,
}

/// 실험이 모으는 한 줄(정본 `ReviewUsage`). 칸 이름·순서는 정본 로그 JSON 과 같다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewUsage {
    pub fork_session_id: Option<String>,
    pub usage: Option<ForkTokenUsage>,
    pub cache_read_ratio: Option<f64>,
    pub num_turns: Option<u64>,
    pub is_error: Option<bool>,
    pub result: Option<String>,
    pub source_session_id: String,
    pub duration_ms: u64,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub tools: Vec<String>,
}

/// 원 턴 argv 의 `--permission-mode` 값(`--permission-mode x`·`--permission-mode=x` 둘 다). 없으면 `None`.
pub fn original_permission_mode(args: &[String]) -> Option<&str> {
    for (i, a) in args.iter().enumerate() {
        if a == "--permission-mode" {
            return args.get(i + 1).map(String::as_str);
        }
        if let Some(v) = a.strip_prefix("--permission-mode=") {
            return Some(v);
        }
    }
    None
}

/// 원 턴의 argv 에서 세션·권한 인자를 빼고 리뷰 포크의 argv 를 만든다. 순수 함수다.
///
/// 프롬프트는 stdin 으로 준다 — `--disallowedTools <tools...>` 가 가변 인자라 뒤의 위치 인자를 도구 이름으로 먹는다.
/// stdin 이면 argv(`ps`)에도 안 뜬다.
pub fn review_fork_args(
    turn_args: &[String],
    session_id: &str,
    system_prompt_copy: Option<&str>,
) -> Vec<String> {
    const DROP: [&str; 4] = ["--session-id", "-r", "--resume", "--permission-mode"];
    let mut kept: Vec<String> = Vec::with_capacity(turn_args.len());
    let mut i = 0;
    while i < turn_args.len() {
        let a = &turn_args[i];
        if DROP.contains(&a.as_str()) {
            i += 2;
            continue;
        }
        if a == "--append-system-prompt-file"
            && let Some(copy) = system_prompt_copy
        {
            kept.push(a.clone());
            kept.push(copy.to_owned());
            i += 2;
            continue;
        }
        kept.push(a.clone());
        i += 1;
    }
    let mut out: Vec<String> = [
        "-p",
        "--resume",
        session_id,
        "--fork-session",
        "--output-format",
        "json",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    out.extend(kept);
    out.extend([
        "--permission-mode".to_owned(),
        "dontAsk".to_owned(),
        "--allowedTools".to_owned(),
        REVIEW_ALLOWED_TOOLS.join(","),
        "--disallowedTools".to_owned(),
        REVIEW_DISALLOWED_TOOLS.join(","),
    ]);
    out
}

/// 정본 `result.slice(0, 500)` — UTF-16 코드 단위 500 개. 대리쌍 가운데서 잘리면 그 반쪽은 버린다.
fn slice_utf16(s: &str, n: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (i, c) in s.char_indices() {
        let w = c.len_utf16();
        if units + w > n {
            break;
        }
        units += w;
        end = i + c.len_utf8();
    }
    s[..end].to_owned()
}

/// `--output-format json` 의 결과 한 덩어리를 읽는다. 못 읽으면 `None` 칸으로 채운다. 순수 함수다.
pub fn parse_fork_result(stdout: &str) -> ForkResult {
    let trimmed = stdout.trim();
    let parsed = serde_json::from_str::<Value>(trimmed).ok().or_else(|| {
        // 앞에 다른 줄이 섞였으면 마지막 줄을 본다.
        serde_json::from_str::<Value>(trimmed.rsplit('\n').next().unwrap_or("")).ok()
    });
    let Some(Value::Object(j)) = parsed else {
        return ForkResult::default();
    };
    let n = |u: &serde_json::Map<String, Value>, k: &str| {
        u.get(k).and_then(Value::as_f64).unwrap_or(0.0) as u64
    };
    let usage = match j.get("usage") {
        Some(Value::Object(u)) => Some(ForkTokenUsage {
            input: n(u, "input_tokens"),
            cache_read: n(u, "cache_read_input_tokens"),
            cache_creation: n(u, "cache_creation_input_tokens"),
            output: n(u, "output_tokens"),
        }),
        _ => None,
    };
    let cache_read_ratio = usage.and_then(|u| {
        let total = u.input + u.cache_read + u.cache_creation;
        (total > 0).then(|| (u.cache_read as f64 / total as f64 * 1000.0).round() / 1000.0)
    });
    ForkResult {
        fork_session_id: j
            .get("session_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        usage,
        cache_read_ratio,
        num_turns: j.get("num_turns").and_then(Value::as_f64).map(|v| v as u64),
        is_error: j.get("is_error").and_then(Value::as_bool),
        result: j
            .get("result")
            .and_then(Value::as_str)
            .map(|s| slice_utf16(s, 500)),
    }
}

/// 이 에이전트에서 켜졌는가 — env 목록(`HARKROOM_REVIEW_FORK_AGENTS` 값) 또는 상태 디렉터리의 켜기 파일.
pub fn review_fork_enabled(agent_id: &str, state_dir: &Path, env_list: Option<&str>) -> bool {
    if env_list
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .any(|s| !s.is_empty() && s == agent_id)
    {
        return true;
    }
    // 정본 `stat` — 링크를 따라간다(링크가 가리키는 것이 있으면 켜짐).
    fs::metadata(state_dir.join(REVIEW_FORK_ON_FILE)).is_ok()
}

/// 정본 `claudeSessionFilePath` — `<configDir 또는 ~/.claude>/projects/*/<id>.jsonl`. 없으면 `None`.
pub fn claude_session_file_path(
    session_id: &str,
    config_dir: Option<&Path>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    // 세션 id 는 파일 이름 하나여야 한다 — 경로 구분자·`..` 이면 찾지 않는다.
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\0')
        || session_id == ".."
    {
        return None;
    }
    let root = match config_dir {
        Some(d) => d.join("projects"),
        None => home?.join(".claude").join("projects"),
    };
    let wanted = format!("{session_id}.jsonl");
    for entry in fs::read_dir(&root).ok()?.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let candidate = entry.path().join(&wanted);
        if fs::symlink_metadata(&candidate).is_ok() {
            return Some(candidate);
        }
    }
    None
}

/// 정본 `readTranscriptTail` — 기록 파일의 꼬리 256KiB(잘렸으면 첫 줄 조각은 버린다). 못 읽으면 `None`.
pub fn read_transcript_tail(path: &Path) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let len = size.min(TRANSCRIPT_TAIL_BYTES);
    f.seek(SeekFrom::Start(size - len)).ok()?;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if len < size {
        Some(
            text.find('\n')
                .map_or_else(String::new, |i| text[i + 1..].to_owned()),
        )
    } else {
        Some(text)
    }
}

/// 정본 `defaultReadToolNames` 의 순수 절반 — `since_ms` 이후 주 대화의 어시스턴트 레코드가 부른 도구 이름, 앞에서부터.
pub fn tool_names_since(text: &str, since_ms: i64) -> Vec<String> {
    let mut names = Vec::new();
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(Value::Object(r)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // recordsSince: user·assistant 만, 곁가지 아님, 시각이 since 이상.
        if r.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if r.get("isSidechain") == Some(&Value::Bool(true)) {
            continue;
        }
        let at = r
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso_utc_ms);
        if at.is_none_or(|at| at < since_ms) {
            continue;
        }
        let Some(Value::Array(content)) = r.get("message").and_then(|m| m.get("content")) else {
            continue;
        };
        for part in content {
            if part.get("type").and_then(Value::as_str) == Some("tool_use")
                && let Some(name) = part.get("name").and_then(Value::as_str)
            {
                names.push(name.to_owned());
            }
        }
    }
    names
}

fn default_read_tool_names(
    fork_session_id: &str,
    config_dir: Option<&Path>,
    since_ms: i64,
) -> Vec<String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    claude_session_file_path(fork_session_id, config_dir, home.as_deref())
        .and_then(|p| read_transcript_tail(&p))
        .map(|t| tool_names_since(&t, since_ms))
        .unwrap_or_default()
}

/// 띄운 포크 자식(시험에서 바꿔 끼운다).
pub trait ForkChild: Send {
    /// stdout 을 한 번 넘긴다.
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>>;
    /// 프롬프트를 stdin 에 쓰고 닫는다.
    fn feed_stdin(&mut self, text: &str) -> io::Result<()>;
    /// 끝났으면 `Some(종료 코드)`(신호로 죽었으면 `Some(None)`), 아직이면 `None`.
    fn try_wait(&mut self) -> io::Result<Option<Option<i32>>>;
    /// SIGKILL.
    fn kill(&mut self);
}

pub type ForkSpawn = dyn Fn(&str, &[String], &Path, &[(String, String)]) -> io::Result<Box<dyn ForkChild>>
    + Send
    + Sync;
pub type ForkLog = dyn Fn(&str) + Send + Sync;
pub type ForkNow = dyn Fn() -> i64 + Send + Sync;
pub type ForkReadToolNames = dyn Fn(&str, Option<&Path>, i64) -> Vec<String> + Send + Sync;

struct OsChild(std::process::Child);

impl ForkChild for OsChild {
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
        // drop 으로 닫힌다.
    }
    fn try_wait(&mut self) -> io::Result<Option<Option<i32>>> {
        Ok(self.0.try_wait()?.map(|s| s.code()))
    }
    fn kill(&mut self) {
        // std 의 kill 은 SIGKILL 이다. 거둬서 좀비를 남기지 않는다.
        let _ = self.0.kill();
        let _ = self.0.wait();
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
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(Box::new(OsChild(child)))
}

/// 정본 `ReviewForkDeps`.
pub struct ReviewForkDeps {
    /// 러너 상태 디렉터리(카운터·켜기 파일·지시문 사본).
    pub state_dir: PathBuf,
    /// `HARKROOM_REVIEW_FORK_AGENTS` 값(러너 env 에서 읽어 넘긴다).
    pub env_list: Option<String>,
    pub spawn: Option<Box<ForkSpawn>>,
    pub log: Option<Box<ForkLog>>,
    pub now_ms: Option<Box<ForkNow>>,
    pub timeout: Option<Duration>,
    pub read_tool_names: Option<Box<ForkReadToolNames>>,
}

impl ReviewForkDeps {
    pub fn new(state_dir: PathBuf, env_list: Option<String>) -> Self {
        Self {
            state_dir,
            env_list,
            spawn: None,
            log: None,
            now_ms: None,
            timeout: None,
            read_tool_names: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForkState {
    #[serde(default)]
    count: u32,
    #[serde(default)]
    last_review_at: Option<String>,
}

/// 러너 하나(=에이전트 하나)에 하나. `after_turn` 은 **기다리지 않는다** — 세고, 때가 되면 포크를 스레드로 띄우고 바로
/// 돌아온다. 동시에 하나만, 5분 상한.
pub struct ReviewFork {
    deps: Arc<ReviewForkDeps>,
    in_flight: Arc<AtomicBool>,
    /// 세기(카운터 읽고 쓰기)를 한 줄로 세운다 — 정본은 이벤트 루프 하나라 겹치지 않았다.
    count_lock: Mutex<()>,
}

impl ReviewFork {
    pub fn new(deps: ReviewForkDeps) -> Self {
        Self {
            deps: Arc::new(deps),
            in_flight: Arc::new(AtomicBool::new(false)),
            count_lock: Mutex::new(()),
        }
    }

    /// 지금 포크가 도는가.
    pub fn running(&self) -> bool {
        self.in_flight.load(Ordering::SeqCst)
    }

    /// 성공한 턴 하나를 센다. 때가 되면 포크를 띄우고 그 스레드를 돌려준다(결말은 `join`). 아니면 `None`.
    pub fn after_turn(&self, turn: &ReviewForkTurn) -> Option<JoinHandle<Option<ReviewUsage>>> {
        if turn.skip || !supports_review_fork(turn.harness) {
            return None;
        }
        let session_id = turn.session_id.as_deref()?;
        // 포크는 권한 모드를 dontAsk 로 **바꾼다**. 원 턴이 readonly(`plan`)였다면 포크가 원래 없던 memory.set 권한을
        // 얻는다(security #1009 참고 1). 그래서 원 턴이 `auto` 일 때만 돌아본다. 모르면 띄우지 않는다.
        let mode = original_permission_mode(&turn.plan.args);
        if mode != Some("auto") {
            log(
                &self.deps,
                &format!(
                    "[reviewFork] 건너뜀 — 원 턴 권한 모드가 {} 이라 포크가 권한을 넓힐 수 있다",
                    mode.unwrap_or("(없음)")
                ),
            );
            return None;
        }
        if !review_fork_enabled(
            &turn.agent_id,
            &self.deps.state_dir,
            self.deps.env_list.as_deref(),
        ) {
            return None;
        }

        let _g = self.count_lock.lock().unwrap_or_else(|e| e.into_inner());
        let state = self.read_state();
        let count = state.count.saturating_add(1);
        // 앞 포크가 아직 돌면 이번엔 띄우지 않는다 — 세기는 계속하고, 다음 턴에 다시 본다.
        if count < REVIEW_FORK_EVERY_TURNS || self.in_flight.load(Ordering::SeqCst) {
            self.write_state(&ForkState { count, ..state });
            return None;
        }
        self.write_state(&ForkState {
            count: 0,
            last_review_at: Some(iso_utc(now_ms(&self.deps).max(0) as u128)),
        });
        self.in_flight.store(true, Ordering::SeqCst);
        let deps = Arc::clone(&self.deps);
        let flag = Arc::clone(&self.in_flight);
        let turn = turn.clone();
        let session_id = session_id.to_owned();
        let spawned = std::thread::Builder::new()
            .name("review-fork".into())
            .spawn(move || {
                let out = match run(&deps, &turn, &session_id) {
                    Ok(u) => Some(u),
                    Err(e) => {
                        log(&deps, &format!("[reviewFork] 실패(턴과 무관) — {e}"));
                        None
                    }
                };
                flag.store(false, Ordering::SeqCst);
                out
            });
        match spawned {
            Ok(h) => Some(h),
            Err(e) => {
                self.in_flight.store(false, Ordering::SeqCst);
                log(&self.deps, &format!("[reviewFork] 실패(턴과 무관) — {e}"));
                None
            }
        }
    }

    fn read_state(&self) -> ForkState {
        fs::read_to_string(self.deps.state_dir.join(REVIEW_FORK_STATE_FILE))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .map(|j| ForkState {
                count: j
                    .get("count")
                    .and_then(Value::as_f64)
                    .map_or(0, |v| v as u32),
                last_review_at: j
                    .get("lastReviewAt")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
            .unwrap_or_default()
    }

    fn write_state(&self, s: &ForkState) {
        let body = serde_json::to_string(s).unwrap_or_else(|_| "{}".into());
        if let Err(e) = write_private(&self.deps.state_dir.join(REVIEW_FORK_STATE_FILE), &body) {
            log(
                &self.deps,
                &format!("[reviewFork] 카운터를 못 썼다 — {}", e.kind()),
            );
        }
    }
}

fn log(deps: &ReviewForkDeps, line: &str) {
    match &deps.log {
        Some(f) => f(line),
        None => eprintln!("{line}"),
    }
}

fn now_ms(deps: &ReviewForkDeps) -> i64 {
    match &deps.now_ms {
        Some(f) => f(),
        None => SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64),
    }
}

/// 지시문 파일은 **사본**을 넘긴다. 원본은 다음 턴(다른 스레드)이 곧바로 덮어쓸 수 있다.
fn copy_system_prompt(deps: &ReviewForkDeps, args: &[String]) -> io::Result<Option<String>> {
    let Some(i) = args.iter().position(|a| a == "--append-system-prompt-file") else {
        return Ok(None);
    };
    let Some(src) = args.get(i + 1).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let body = fs::read_to_string(src)?;
    let dest = deps.state_dir.join(REVIEW_FORK_SYSTEM_PROMPT_COPY);
    write_private(&dest, &body)?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

fn run(
    deps: &ReviewForkDeps,
    turn: &ReviewForkTurn,
    session_id: &str,
) -> Result<ReviewUsage, String> {
    let started_at = now_ms(deps);
    let started = Instant::now();
    let prompt_copy = copy_system_prompt(deps, &turn.plan.args)
        .map_err(|e| format!("지시문 사본을 못 만들었다({})", e.kind()))?;
    let args = review_fork_args(&turn.plan.args, session_id, prompt_copy.as_deref());

    let spawned = match &deps.spawn {
        Some(f) => f(&turn.plan.command, &args, &turn.cwd, &turn.plan.env),
        None => default_spawn(&turn.plan.command, &args, &turn.cwd, &turn.plan.env),
    };
    let mut stdout = String::new();
    let mut timed_out = false;
    let exit_code = match spawned {
        Err(e) => {
            log(deps, &format!("[reviewFork] 띄우기 실패 — {}", e.kind()));
            None
        }
        Ok(mut child) => {
            let reader = child.take_stdout().map(|mut r| {
                std::thread::spawn(move || {
                    let mut buf = Vec::new();
                    let _ = r.read_to_end(&mut buf);
                    String::from_utf8_lossy(&buf).into_owned()
                })
            });
            let _ = child.feed_stdin(REVIEW_PROMPT);
            let timeout = deps.timeout.unwrap_or(REVIEW_FORK_TIMEOUT);
            let code = loop {
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
            if let Some(h) = reader {
                stdout = h.join().unwrap_or_default();
            }
            code
        }
    };

    let parsed = parse_fork_result(&stdout);
    let tools = match parsed.fork_session_id.as_deref() {
        Some(fork) => match &deps.read_tool_names {
            Some(f) => f(fork, turn.claude_config_dir.as_deref(), started_at),
            None => default_read_tool_names(fork, turn.claude_config_dir.as_deref(), started_at),
        },
        None => Vec::new(),
    };
    let usage = ReviewUsage {
        fork_session_id: parsed.fork_session_id,
        usage: parsed.usage,
        cache_read_ratio: parsed.cache_read_ratio,
        num_turns: parsed.num_turns,
        is_error: parsed.is_error,
        result: parsed.result,
        source_session_id: session_id.to_owned(),
        duration_ms: (now_ms(deps) - started_at).max(0) as u64,
        exit_code,
        timed_out,
        tools,
    };
    // 실험이 이 줄을 모은다 — 한 줄 JSON 이어야 grep 한 번으로 표가 된다.
    log(
        deps,
        &format!(
            "[reviewFork] review.usage {}",
            serde_json::to_string(&usage).unwrap_or_default()
        ),
    );
    Ok(usage)
}

#[cfg(test)]
#[path = "review_fork_tests.rs"]
mod tests;
