//! 정본 `packages/agent/test/reviewFork.test.ts` 의 대조 시험.

use std::io::{Cursor, Read};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;
use crate::adapter::AgentHarness;

const AGENT: &str = "00000000-0000-4000-8000-0000000000aa";

const RESULT_JSON: &str = r#"{"type":"result","is_error":false,"num_turns":3,"result":"mem/x 를 고쳤다","session_id":"fork-1","usage":{"input_tokens":2,"cache_creation_input_tokens":73,"cache_read_input_tokens":18913,"output_tokens":40}}"#;

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| (*x).to_owned()).collect()
}

fn turn_args() -> Vec<String> {
    s(&[
        "-r",
        "sess-1",
        "--permission-mode",
        "auto",
        "--mcp-config",
        "/tmp/mcp.json",
        "--strict-mcp-config",
        "--model",
        "claude-opus-5-5",
        "--effort",
        "high",
        "--append-system-prompt-file",
        "/state/system-prompt.md",
    ])
}

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "rfork-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// 가짜 자식 — stdin 으로 받은 것을 남기고, 정해 둔 stdout 을 낸 뒤 닫힌다. `hang` 이면 죽일 때까지 안 끝난다.
struct FakeChild {
    stdout: Option<String>,
    hang: bool,
    killed: Arc<Mutex<Vec<&'static str>>>,
    stdin: Arc<Mutex<String>>,
    dead: bool,
}
impl ForkChild for FakeChild {
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        if self.hang {
            // 죽기 전엔 내는 것이 없다.
            return Some(Box::new(Cursor::new(Vec::new())));
        }
        self.stdout
            .take()
            .map(|s| Box::new(Cursor::new(s.into_bytes())) as Box<dyn Read + Send>)
    }
    fn feed_stdin(&mut self, text: &str) -> io::Result<()> {
        self.stdin.lock().unwrap().push_str(text);
        Ok(())
    }
    fn try_wait(&mut self) -> io::Result<Option<Option<i32>>> {
        if self.dead {
            return Ok(Some(None));
        }
        Ok(if self.hang { None } else { Some(Some(0)) })
    }
    fn kill(&mut self) {
        self.killed.lock().unwrap().push("SIGKILL");
        self.dead = true;
    }
}

#[derive(Debug, Clone)]
struct Spawned {
    command: String,
    args: Vec<String>,
    cwd: PathBuf,
    env: Vec<(String, String)>,
}

struct Setup {
    dir: TempDir,
    rf: ReviewFork,
    spawns: Arc<Mutex<Vec<Spawned>>>,
    logs: Arc<Mutex<Vec<String>>>,
    hang: Arc<AtomicBool>,
    killed: Arc<Mutex<Vec<&'static str>>>,
    stdin: Arc<Mutex<String>>,
}

impl Setup {
    fn state(&self) -> &Path {
        &self.dir.0
    }
    fn turn(&self) -> ReviewForkTurn {
        let mut args = turn_args();
        let last = args.len() - 1;
        args[last] = self
            .state()
            .join("system-prompt.md")
            .to_string_lossy()
            .into_owned();
        ReviewForkTurn {
            agent_id: AGENT.into(),
            harness: AgentHarness::ClaudeCode,
            session_id: Some("sess-1".into()),
            cwd: PathBuf::from("/ws"),
            plan: ForkPlan {
                command: "claude".into(),
                args,
                env: vec![("CLAUDE_CONFIG_DIR".into(), "/acct".into())],
            },
            claude_config_dir: Some(PathBuf::from("/acct")),
            skip: false,
        }
    }
    fn count(&self) -> Option<u64> {
        let t = fs::read_to_string(self.state().join(REVIEW_FORK_STATE_FILE)).ok()?;
        serde_json::from_str::<Value>(&t).ok()?["count"].as_u64()
    }
}

fn setup(on: bool, env_list: Option<&str>, timeout: Duration) -> Setup {
    let dir = TempDir::new();
    fs::write(dir.0.join("system-prompt.md"), "SYSTEM").unwrap();
    if on {
        fs::write(dir.0.join(REVIEW_FORK_ON_FILE), "").unwrap();
    }
    let spawns = Arc::new(Mutex::new(Vec::new()));
    let logs = Arc::new(Mutex::new(Vec::new()));
    let hang = Arc::new(AtomicBool::new(false));
    let killed = Arc::new(Mutex::new(Vec::new()));
    let stdin = Arc::new(Mutex::new(String::new()));
    let mut deps = ReviewForkDeps::new(dir.0.clone(), env_list.map(str::to_owned));
    {
        let (spawns, hang, killed, stdin) =
            (spawns.clone(), hang.clone(), killed.clone(), stdin.clone());
        deps.spawn = Some(Box::new(move |command, args, cwd, env| {
            spawns.lock().unwrap().push(Spawned {
                command: command.into(),
                args: args.to_vec(),
                cwd: cwd.to_path_buf(),
                env: env.to_vec(),
            });
            stdin.lock().unwrap().clear();
            Ok(Box::new(FakeChild {
                stdout: Some(RESULT_JSON.into()),
                hang: hang.load(Ordering::SeqCst),
                killed: killed.clone(),
                stdin: stdin.clone(),
                dead: false,
            }) as Box<dyn ForkChild>)
        }));
    }
    {
        let logs = logs.clone();
        deps.log = Some(Box::new(move |l| logs.lock().unwrap().push(l.to_owned())));
    }
    deps.read_tool_names = Some(Box::new(|_, _, _| {
        s(&["mcp__harkroom__memory_get", "mcp__harkroom__memory_set"])
    }));
    deps.timeout = Some(timeout);
    Setup {
        rf: ReviewFork::new(deps),
        dir,
        spawns,
        logs,
        hang,
        killed,
        stdin,
    }
}

fn turns(
    rf: &ReviewFork,
    make: impl Fn() -> ReviewForkTurn,
    n: u32,
) -> Option<JoinHandle<Option<ReviewUsage>>> {
    let mut run = None;
    for _ in 0..n {
        if let Some(h) = rf.after_turn(&make()) {
            run = Some(h);
        }
    }
    run
}

// ── reviewForkArgs ──

#[test]
fn args_drop_session_and_mode_and_add_fork_limits() {
    let args = review_fork_args(
        &turn_args(),
        "sess-1",
        Some("/state/review-fork-system-prompt.md"),
    );
    assert_eq!(
        args[..6],
        s(&[
            "-p",
            "--resume",
            "sess-1",
            "--fork-session",
            "--output-format",
            "json"
        ])[..]
    );
    assert!(!args.contains(&"-r".to_owned()));
    assert_eq!(args.iter().filter(|a| *a == "--permission-mode").count(), 1);
    let at = |k: &str| args[args.iter().position(|a| a == k).unwrap() + 1].clone();
    assert_eq!(at("--permission-mode"), "dontAsk");
    for want in [
        "--mcp-config",
        "/tmp/mcp.json",
        "--strict-mcp-config",
        "--model",
        "claude-opus-5-5",
        "--effort",
        "high",
    ] {
        assert!(args.contains(&want.to_owned()), "{want}");
    }
    assert_eq!(
        at("--append-system-prompt-file"),
        "/state/review-fork-system-prompt.md"
    );
    assert_eq!(at("--allowedTools"), REVIEW_ALLOWED_TOOLS.join(","));
    assert_eq!(at("--disallowedTools"), REVIEW_DISALLOWED_TOOLS.join(","));
    // 가변 인자 뒤에 위치 인자(프롬프트)를 두지 않는다 — 프롬프트는 stdin 이다.
    assert_eq!(args[args.len() - 2], "--disallowedTools");
}

#[test]
fn args_drop_first_turn_session_id_too() {
    let args = review_fork_args(
        &s(&["--session-id", "abc", "--permission-mode", "plan"]),
        "abc",
        None,
    );
    assert!(!args.contains(&"--session-id".to_owned()));
    assert!(!args.contains(&"plan".to_owned()));
}

#[test]
fn args_without_copy_keep_original_prompt_file() {
    let args = review_fork_args(&turn_args(), "sess-1", None);
    let i = args
        .iter()
        .position(|a| a == "--append-system-prompt-file")
        .unwrap();
    assert_eq!(args[i + 1], "/state/system-prompt.md");
}

/// 정본 골든: `reviewForkArgs(TURN_ARGS, 'sess-1', '/c')` 의 전체 배열.
#[test]
fn args_golden_matches_ts() {
    let args = review_fork_args(&turn_args(), "sess-1", Some("/c"));
    let mut want = s(&[
        "-p",
        "--resume",
        "sess-1",
        "--fork-session",
        "--output-format",
        "json",
        "--mcp-config",
        "/tmp/mcp.json",
        "--strict-mcp-config",
        "--model",
        "claude-opus-5-5",
        "--effort",
        "high",
        "--append-system-prompt-file",
        "/c",
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
    ]);
    want.push(REVIEW_ALLOWED_TOOLS.join(","));
    want.push("--disallowedTools".into());
    want.push(REVIEW_DISALLOWED_TOOLS.join(","));
    assert_eq!(args, want);
}

/// 원 턴(auto 멘션 턴)의 허락·금지 목록(가변 인자)·hook 설정은 포크에 넘어가지 않는다 — 포크 목록만 실린다.
#[test]
fn args_drop_original_allow_deny_and_settings() {
    let turn = s(&[
        "-r",
        "sess-1",
        "--permission-mode",
        "auto",
        "--disallowedTools",
        "Bash(deny-a:*)",
        "Edit(deny-b)",
        "--allowedTools",
        "mcp__harkroom__message_post",
        "Bash(allow-x:*)",
        "--settings",
        "{\"hooks\":{}}",
        "--allowed-tools=Bash(eq-form:*)",
        "--tools",
        "Read",
        "--mcp-config",
        "/tmp/mcp.json",
        "--model",
        "m",
    ]);
    let args = review_fork_args(&turn, "sess-1", None);
    for gone in [
        "Bash(deny-a:*)",
        "Edit(deny-b)",
        "Bash(allow-x:*)",
        "{\"hooks\":{}}",
        "--settings",
        "--allowed-tools=Bash(eq-form:*)",
        "--tools",
        "Read",
    ] {
        assert!(
            !args.iter().any(|a| a == gone),
            "{gone} 가 남았다: {args:?}"
        );
    }
    assert_eq!(args.iter().filter(|a| *a == "--allowedTools").count(), 1);
    assert_eq!(args.iter().filter(|a| *a == "--disallowedTools").count(), 1);
    let at = |k: &str| args[args.iter().position(|a| a == k).unwrap() + 1].clone();
    assert_eq!(at("--allowedTools"), REVIEW_ALLOWED_TOOLS.join(","));
    assert_eq!(at("--mcp-config"), "/tmp/mcp.json");
    assert_eq!(at("--model"), "m");
}

#[test]
fn allow_list_is_memory_only_and_speech_is_blocked() {
    assert!(!REVIEW_ALLOWED_TOOLS.iter().any(|t| {
        ["message", "inbox", "turn_wake", "Bash"]
            .iter()
            .any(|b| t.contains(b))
    }));
    for want in [
        "mcp__harkroom__message_post",
        "mcp__harkroom__turn_wake",
        "Bash",
        "Edit",
        "Write",
        "mcp__harkroom__permission_request",
        "mcp__harkroom__grant_delegate",
    ] {
        assert!(REVIEW_DISALLOWED_TOOLS.contains(&want), "{want}");
    }
}

// ── parseForkResult ──

#[test]
fn parse_reads_usage_and_cache_ratio() {
    let r = parse_fork_result(RESULT_JSON);
    assert_eq!(r.fork_session_id.as_deref(), Some("fork-1"));
    assert_eq!(
        r.usage,
        Some(ForkTokenUsage {
            input: 2,
            cache_read: 18913,
            cache_creation: 73,
            output: 40
        })
    );
    assert_eq!(r.cache_read_ratio, Some(0.996));
    assert_eq!(r.num_turns, Some(3));
    assert_eq!(r.is_error, Some(false));
    assert_eq!(r.result.as_deref(), Some("mem/x 를 고쳤다"));
}

#[test]
fn parse_reads_last_line_or_gives_none_fields() {
    assert_eq!(
        parse_fork_result(&format!("warn\n{RESULT_JSON}"))
            .fork_session_id
            .as_deref(),
        Some("fork-1")
    );
    assert_eq!(parse_fork_result("not json"), ForkResult::default());
    // 배열·숫자 같은 객체 아닌 JSON 도 빈 칸.
    assert_eq!(parse_fork_result("[1]"), ForkResult::default());
}

#[test]
fn parse_zero_input_has_no_ratio_and_result_is_cut_at_500_utf16() {
    let long = "가".repeat(600);
    let r = parse_fork_result(&format!(
        r#"{{"usage":{{"input_tokens":0}},"result":"{long}","num_turns":"x"}}"#
    ));
    assert_eq!(r.cache_read_ratio, None);
    assert_eq!(r.num_turns, None);
    assert_eq!(r.result.unwrap().chars().count(), 500);
    // 대리쌍은 반쪽으로 자르지 않는다(정본은 반쪽을 남긴다 — 문자열로 못 담으니 버린다).
    assert_eq!(
        slice_utf16(&format!("{}😀", "a".repeat(499)), 500),
        "a".repeat(499)
    );
}

// ── reviewForkEnabled ──

#[test]
fn enabled_by_env_list_or_on_file() {
    let off = setup(false, None, Duration::from_millis(200));
    assert!(!review_fork_enabled(AGENT, off.state(), None));
    assert!(review_fork_enabled(
        AGENT,
        off.state(),
        Some(&format!("x, {AGENT}"))
    ));
    assert!(!review_fork_enabled(AGENT, off.state(), Some(" , x")));
    let on = setup(true, None, Duration::from_millis(200));
    assert!(review_fork_enabled(AGENT, on.state(), None));
}

// ── afterTurn ──

#[test]
fn only_claude_can_fork() {
    assert!(supports_review_fork(AgentHarness::ClaudeCode));
    assert!(!supports_review_fork(AgentHarness::Codex));
    assert!(!supports_review_fork(AgentHarness::Opencode));
    assert!(!supports_review_fork(AgentHarness::Gemini));
}

#[test]
fn forks_on_fifth_turn_and_counter_persists() {
    let su = setup(true, None, Duration::from_millis(2_000));
    for _ in 1..REVIEW_FORK_EVERY_TURNS {
        assert!(su.rf.after_turn(&su.turn()).is_none());
    }
    assert!(su.spawns.lock().unwrap().is_empty());
    assert_eq!(su.count(), Some(u64::from(REVIEW_FORK_EVERY_TURNS - 1)));

    let run = su.rf.after_turn(&su.turn()).expect("다섯째 턴에 뜬다");
    let usage = run.join().unwrap().expect("포크 결말");
    let spawns = su.spawns.lock().unwrap().clone();
    assert_eq!(spawns.len(), 1);
    let sp = &spawns[0];
    assert_eq!(sp.command, "claude");
    assert_eq!(sp.cwd, PathBuf::from("/ws"));
    assert_eq!(
        sp.env,
        vec![("CLAUDE_CONFIG_DIR".to_owned(), "/acct".to_owned())]
    );
    assert_eq!(
        sp.args[..4],
        s(&["-p", "--resume", "sess-1", "--fork-session"])[..]
    );
    // 지시문은 사본으로 넘기고(0600), 프롬프트는 stdin 으로 갔다.
    let copy = &sp.args[sp
        .args
        .iter()
        .position(|a| a == "--append-system-prompt-file")
        .unwrap()
        + 1];
    assert_eq!(
        Path::new(copy),
        su.state().join(REVIEW_FORK_SYSTEM_PROMPT_COPY)
    );
    assert_eq!(fs::read_to_string(copy).unwrap(), "SYSTEM");
    assert_eq!(
        fs::metadata(copy).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(*su.stdin.lock().unwrap(), REVIEW_PROMPT);

    assert_eq!(usage.fork_session_id.as_deref(), Some("fork-1"));
    assert_eq!(usage.source_session_id, "sess-1");
    assert_eq!(usage.exit_code, Some(0));
    assert!(!usage.timed_out);
    assert_eq!(usage.cache_read_ratio, Some(0.996));
    assert_eq!(
        usage.tools,
        s(&["mcp__harkroom__memory_get", "mcp__harkroom__memory_set"])
    );
    let logs = su.logs.lock().unwrap().clone();
    let line = logs
        .iter()
        .find_map(|l| l.strip_prefix("[reviewFork] review.usage "))
        .expect("usage 줄");
    let j: Value = serde_json::from_str(line).unwrap();
    assert_eq!(j["forkSessionId"], "fork-1");
    assert_eq!(j["usage"]["cacheRead"], 18913);
    assert_eq!(j["sourceSessionId"], "sess-1");
    assert_eq!(su.count(), Some(0));
    let state: Value =
        serde_json::from_str(&fs::read_to_string(su.state().join(REVIEW_FORK_STATE_FILE)).unwrap())
            .unwrap();
    assert!(state["lastReviewAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        fs::metadata(su.state().join(REVIEW_FORK_STATE_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(!su.rf.running());
}

#[test]
fn off_unsupported_no_session_or_skip_neither_count_nor_fork() {
    let n = REVIEW_FORK_EVERY_TURNS * 2;
    let off = setup(false, None, Duration::from_millis(200));
    assert!(turns(&off.rf, || off.turn(), n).is_none());
    let su = setup(true, None, Duration::from_millis(200));
    assert!(
        turns(
            &su.rf,
            || ReviewForkTurn {
                harness: AgentHarness::Codex,
                ..su.turn()
            },
            n
        )
        .is_none()
    );
    assert!(
        turns(
            &su.rf,
            || ReviewForkTurn {
                session_id: None,
                ..su.turn()
            },
            n
        )
        .is_none()
    );
    assert!(
        turns(
            &su.rf,
            || ReviewForkTurn {
                skip: true,
                ..su.turn()
            },
            n
        )
        .is_none()
    );
    assert_eq!(
        off.spawns.lock().unwrap().len() + su.spawns.lock().unwrap().len(),
        0
    );
    // 건너뛴 턴은 세지 않았다 — 카운터 파일이 아직 없다.
    assert!(!su.state().join(REVIEW_FORK_STATE_FILE).exists());
}

// security 검토(#1009 참고 1): 원 턴이 auto 일 때만 띄운다.
#[test]
fn non_auto_turns_neither_count_nor_fork_and_log() {
    let su = setup(true, None, Duration::from_millis(200));
    let sur = &su;
    let with_mode = |mode: &[&str]| {
        let mut args = s(&["-r", "sess-1"]);
        args.extend(s(mode));
        args.extend(s(&["--mcp-config", "/tmp/mcp.json"]));
        move || ReviewForkTurn {
            plan: ForkPlan {
                command: "claude".into(),
                args: args.clone(),
                env: vec![],
            },
            ..sur.turn()
        }
    };
    let n = REVIEW_FORK_EVERY_TURNS * 2;
    assert!(turns(&su.rf, with_mode(&["--permission-mode", "plan"]), n).is_none());
    assert!(turns(&su.rf, with_mode(&["--permission-mode=plan"]), n).is_none());
    assert!(turns(&su.rf, with_mode(&[]), n).is_none());
    assert!(su.spawns.lock().unwrap().is_empty());
    assert!(
        su.logs
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.contains("권한 모드가 plan"))
    );
    assert!(
        su.logs
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.contains("권한 모드가 (없음)"))
    );
    assert!(!su.state().join(REVIEW_FORK_STATE_FILE).exists());
}

#[test]
fn original_permission_mode_reads_both_forms() {
    assert_eq!(
        original_permission_mode(&s(&["--permission-mode", "auto"])),
        Some("auto")
    );
    assert_eq!(
        original_permission_mode(&s(&["--permission-mode=plan"])),
        Some("plan")
    );
    assert_eq!(original_permission_mode(&s(&["--model", "x"])), None);
    assert_eq!(original_permission_mode(&s(&["--permission-mode"])), None);
}

#[test]
fn only_one_at_a_time_and_timeout_kills() {
    let su = setup(true, None, Duration::from_millis(1_500));
    su.hang.store(true, Ordering::SeqCst);
    let first = turns(&su.rf, || su.turn(), REVIEW_FORK_EVERY_TURNS).expect("첫 포크");
    assert!(su.rf.running());
    assert!(turns(&su.rf, || su.turn(), REVIEW_FORK_EVERY_TURNS).is_none());
    assert_eq!(su.spawns.lock().unwrap().len(), 1);
    // 시한(1.5초)에 죽는다.
    let usage = first.join().unwrap().unwrap();
    assert!(usage.timed_out);
    assert_eq!(usage.exit_code, None);
    assert_eq!(*su.killed.lock().unwrap(), vec!["SIGKILL"]);
    // 앞 포크가 끝났으니 다음 턴에 바로 뜬다(밀린 카운트가 이미 찼다).
    su.hang.store(false, Ordering::SeqCst);
    let next = su.rf.after_turn(&su.turn()).expect("다음 턴에 뜬다");
    next.join().unwrap().unwrap();
    assert_eq!(su.spawns.lock().unwrap().len(), 2);
}

#[test]
fn spawn_failure_logs_kind_and_returns_null_fields() {
    let su = setup(true, None, Duration::from_millis(200));
    let mut deps = ReviewForkDeps::new(su.state().to_path_buf(), None);
    let logs = Arc::new(Mutex::new(Vec::<String>::new()));
    {
        let logs = logs.clone();
        deps.log = Some(Box::new(move |l| logs.lock().unwrap().push(l.to_owned())));
    }
    deps.spawn = Some(Box::new(|_, _, _, _| {
        Err(io::Error::from(io::ErrorKind::NotFound))
    }));
    let rf = ReviewFork::new(deps);
    let usage = turns(&rf, || su.turn(), REVIEW_FORK_EVERY_TURNS)
        .unwrap()
        .join()
        .unwrap()
        .unwrap();
    assert_eq!(usage.exit_code, None);
    assert_eq!(usage.fork_session_id, None);
    assert!(usage.tools.is_empty());
    assert!(
        logs.lock()
            .unwrap()
            .iter()
            .any(|l| l.starts_with("[reviewFork] 띄우기 실패"))
    );
}

#[test]
fn missing_system_prompt_fails_quietly_and_frees_slot() {
    let su = setup(true, None, Duration::from_millis(200));
    fs::remove_file(su.state().join("system-prompt.md")).unwrap();
    let out = turns(&su.rf, || su.turn(), REVIEW_FORK_EVERY_TURNS)
        .unwrap()
        .join()
        .unwrap();
    assert!(out.is_none());
    assert!(su.spawns.lock().unwrap().is_empty());
    assert!(!su.rf.running());
    let logs = su.logs.lock().unwrap().clone();
    let line = logs.iter().find(|l| l.contains("실패(턴과 무관)")).unwrap();
    // 오류 문구에 경로를 싣지 않는다.
    assert!(!line.contains(&*su.state().to_string_lossy()));
}

// ── 기록 읽기(defaultReadToolNames) ──

#[test]
fn session_path_and_tool_names_since() {
    let d = TempDir::new();
    let proj = d.0.join("projects").join("-ws");
    fs::create_dir_all(&proj).unwrap();
    let lines = [
        r#"{"type":"assistant","timestamp":"2026-11-12T03:00:00.000Z","message":{"content":[{"type":"tool_use","name":"old"}]}}"#,
        r#"{"type":"assistant","timestamp":"2026-11-12T03:00:02.000Z","isSidechain":true,"message":{"content":[{"type":"tool_use","name":"side"}]}}"#,
        "garbage",
        r#"{"type":"user","timestamp":"2026-11-12T03:00:03.000Z","message":{"content":[{"type":"tool_use","name":"user"}]}}"#,
        r#"{"type":"assistant","timestamp":"2026-11-12T03:00:04.000Z","message":{"content":[{"type":"text","text":"x"},{"type":"tool_use","name":"mcp__harkroom__memory_get"}]}}"#,
        r#"{"type":"assistant","timestamp":"2026-11-12T03:00:05.5Z","message":{"content":[{"type":"tool_use","name":"mcp__harkroom__memory_set"}]}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"no-time"}]}}"#,
    ];
    fs::write(proj.join("fork-1.jsonl"), lines.join("\n")).unwrap();
    let path = claude_session_file_path("fork-1", Some(&d.0), None).unwrap();
    assert_eq!(path, proj.join("fork-1.jsonl"));
    assert!(claude_session_file_path("nope", Some(&d.0), None).is_none());
    assert!(claude_session_file_path("../x", Some(&d.0), None).is_none());
    let since = parse_iso_utc_ms("2026-11-12T03:00:01.000Z").unwrap();
    let text = read_transcript_tail(&path).unwrap();
    assert_eq!(
        tool_names_since(&text, since),
        s(&["mcp__harkroom__memory_get", "mcp__harkroom__memory_set"])
    );
    assert_eq!(
        default_read_tool_names("fork-1", Some(&d.0), since),
        s(&["mcp__harkroom__memory_get", "mcp__harkroom__memory_set"])
    );
}

#[test]
fn transcript_tail_drops_partial_first_line() {
    let d = TempDir::new();
    let p = d.0.join("t.jsonl");
    let head = "x".repeat(TRANSCRIPT_TAIL_BYTES as usize);
    fs::write(&p, format!("{head}\nlast")).unwrap();
    assert_eq!(read_transcript_tail(&p).unwrap(), "last");
    assert!(read_transcript_tail(&d.0.join("none")).is_none());
}

// ── 실제 자식(OsChild) ──

#[test]
fn os_child_feeds_stdin_reads_stdout_and_clears_env() {
    let mut c = default_spawn(
        "/bin/sh",
        &s(&[
            "-c",
            "read -r line; printf '%s|%s' \"$line\" \"${HOME:-none}\"",
        ]),
        Path::new("/"),
        &[("PATH".into(), "/usr/bin:/bin".into())],
    )
    .unwrap();
    let mut out = c.take_stdout().unwrap();
    c.feed_stdin("hello\n").unwrap();
    let mut text = String::new();
    out.read_to_string(&mut text).unwrap();
    // env 는 넘긴 것만 — 러너의 HOME 을 물려주지 않는다.
    assert_eq!(text, "hello|none");
    let code = loop {
        if let Some(code) = c.try_wait().unwrap() {
            break code;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(code, Some(0));
}

#[test]
fn os_child_kill_reaps() {
    let mut c = default_spawn("/bin/sleep", &s(&["30"]), Path::new("/"), &[]).unwrap();
    assert_eq!(c.try_wait().unwrap(), None);
    c.kill();
    // 신호로 죽어 코드가 없다.
    assert_eq!(c.try_wait().unwrap(), Some(None));
}
