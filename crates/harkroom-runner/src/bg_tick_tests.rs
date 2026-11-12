//! 정본 `packages/agent/test/bgExecutor.test.ts` 의 틱 루프 시험(172~235행) + security 요구(종류·env·그룹 kill·요약 가림).

use super::*;
use std::io::{BufRead, BufReader, Cursor};
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};

const JOB_ID: &str = "11111111-1111-1111-1111-111111111111";
/// 2026-10-21 04:00 KST(창 안).
const IN_WINDOW: i64 = 1_792_522_800_000;
/// 2026-10-21 12:00 KST.
const NOON: i64 = IN_WINDOW + 8 * 3_600_000;

fn job(kind: &str) -> BgJob {
    BgJob {
        id: JOB_ID.into(),
        kind: kind.into(),
        day: "2026-10-21".into(),
        input: serde_json::Map::new(),
    }
}

/// 띄운 자식 하나: (cwd, env, argv).
type Spawned = (PathBuf, Vec<(String, String)>, Vec<String>);

#[derive(Default)]
struct Rec {
    completed: Mutex<Vec<(String, BgOutcome)>>,
    acquired: Mutex<Vec<u32>>,
    released: AtomicUsize,
    harness_reads: AtomicUsize,
    plan_releases: AtomicUsize,
    spawned: Mutex<Vec<Spawned>>,
    claims: AtomicUsize,
}

struct H(Arc<Rec>, Option<BgJob>);
impl BgHarkroom for H {
    fn claim_bg(&self) -> Result<Option<BgJob>, String> {
        self.0.claims.fetch_add(1, Ordering::SeqCst);
        Ok(self.1.clone())
    }
    fn complete_bg(&self, job_id: &str, o: &BgOutcome) -> Result<(), String> {
        self.0
            .completed
            .lock()
            .unwrap()
            .push((job_id.into(), o.clone()));
        Ok(())
    }
}

struct S(Arc<Rec>, SlotGrant);
impl BgSlots for S {
    fn acquire(&self, _key: &str, keep_free: u32) -> SlotGrant {
        self.0.acquired.lock().unwrap().push(keep_free);
        self.1
    }
    fn release(&self, _key: &str) {
        self.0.released.fetch_add(1, Ordering::SeqCst);
    }
}

/// 가짜 자식 — stdout 한 덩어리를 내고 `code` 로 끝난다. `hang` 이면 죽일 때까지 끝나지 않는다.
struct Fake {
    stdout: Option<String>,
    code: Option<i32>,
    hang: bool,
    killed: bool,
    stdin: Arc<Mutex<String>>,
}
impl ForkChild for Fake {
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.stdout
            .take()
            .map(|s| Box::new(Cursor::new(s.into_bytes())) as Box<dyn Read + Send>)
    }
    fn feed_stdin(&mut self, text: &str) -> io::Result<()> {
        self.stdin.lock().unwrap().push_str(text);
        Ok(())
    }
    fn try_wait(&mut self) -> io::Result<Option<Option<i32>>> {
        if self.killed {
            return Ok(Some(None));
        }
        Ok(if self.hang { None } else { Some(self.code) })
    }
    fn kill(&mut self) {
        self.killed = true;
    }
}

struct Opts {
    harness: AgentHarness,
    now: i64,
    slot: SlotGrant,
    job: Option<BgJob>,
    out: Option<serde_json::Value>,
    code: Option<i32>,
    hang: bool,
    spawn_fails: bool,
    timeout: Duration,
}

impl Default for Opts {
    fn default() -> Self {
        Self {
            harness: AgentHarness::ClaudeCode,
            now: IN_WINDOW,
            slot: SlotGrant::Granted,
            job: Some(job("distill")),
            out: Some(serde_json::json!({
                "result": "mem/x 갱신\n둘째 줄", "is_error": false, "num_turns": 3,
                "usage": { "input_tokens": 5, "output_tokens": 10 }
            })),
            code: Some(0),
            hang: false,
            spawn_fails: false,
            timeout: Duration::from_secs(5),
        }
    }
}

fn state_dir() -> PathBuf {
    let d = std::env::temp_dir().join(format!("bg-tick-{}", random_uuid()));
    fs::create_dir_all(&d).unwrap();
    d
}

fn make(o: Opts) -> (BgExecutor, Arc<Rec>, Arc<Mutex<String>>, PathBuf) {
    let rec = Arc::new(Rec::default());
    let stdin = Arc::new(Mutex::new(String::new()));
    let dir = state_dir();
    let r1 = Arc::clone(&rec);
    let r2 = Arc::clone(&rec);
    let r3 = Arc::clone(&rec);
    let st = Arc::clone(&stdin);
    let harness = o.harness;
    let (out, code, hang, spawn_fails) = (o.out, o.code, o.hang, o.spawn_fails);
    let now = o.now;
    let deps = BgExecutorDeps {
        harness: Box::new(move || {
            r1.harness_reads.fetch_add(1, Ordering::SeqCst);
            Ok(harness)
        }),
        harkroom: Box::new(H(Arc::clone(&rec), o.job)),
        build_plan: Box::new(move |j, sid, _cwd| {
            let r = Arc::clone(&r2);
            Ok(BgPlan {
                command: "claude".into(),
                args: vec![
                    "--mcp-config".into(),
                    "/x/bg-mcp.json".into(),
                    "--model".into(),
                    "opus".into(),
                ],
                env: vec![
                    ("HARKROOM_TURN_CAUSE".into(), format!("bg:{}", j.id)),
                    ("SID".into(), sid.into()),
                ],
                release: Some(Box::new(move || {
                    r.plan_releases.fetch_add(1, Ordering::SeqCst);
                    panic!("release 가 던져도 보고는 간다");
                })),
            })
        }),
        slots: Box::new(S(Arc::clone(&rec), o.slot)),
        state_dir: dir.clone(),
        spawn: Some(Box::new(move |_cmd, args, cwd, env| {
            r3.spawned
                .lock()
                .unwrap()
                .push((cwd.to_path_buf(), env.to_vec(), args.to_vec()));
            if spawn_fails {
                return Err(io::Error::from(io::ErrorKind::NotFound));
            }
            Ok(Box::new(Fake {
                stdout: Some(out.as_ref().map(|v| v.to_string()).unwrap_or_default()),
                code,
                hang,
                killed: false,
                stdin: Arc::clone(&st),
            }) as Box<dyn ForkChild>)
        })),
        now_ms: Some(Box::new(move || now)),
        timeout: Some(o.timeout),
        log: Some(Box::new(|_| {})),
    };
    (BgExecutor::new(deps), rec, stdin, dir)
}

fn outcome(rec: &Rec) -> BgOutcome {
    let c = rec.completed.lock().unwrap();
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].0, JOB_ID);
    c[0].1.clone()
}

#[test]
fn gates_not_claude_outside_window_no_slot_none_and_always_releases_slot() {
    let (ex, _, _, _) = make(Opts {
        harness: AgentHarness::Codex,
        ..Opts::default()
    });
    assert_eq!(ex.tick(), BgTickResult::NotClaude);

    let (ex, rec, _, _) = make(Opts {
        now: NOON,
        ..Opts::default()
    });
    assert_eq!(ex.tick(), BgTickResult::OutsideWindow);
    // 창 밖 틱은 하네스(GET /agent/config)를 읽지 않는다.
    assert_eq!(rec.harness_reads.load(Ordering::SeqCst), 0);

    let (ex, rec, _, _) = make(Opts {
        slot: SlotGrant::Full,
        ..Opts::default()
    });
    assert_eq!(ex.tick(), BgTickResult::NoSlot);
    assert_eq!(*rec.acquired.lock().unwrap(), vec![1]);
    assert_eq!(rec.claims.load(Ordering::SeqCst), 0);

    let (ex, rec, _, _) = make(Opts {
        job: None,
        ..Opts::default()
    });
    assert_eq!(ex.tick(), BgTickResult::None);
    assert_eq!(rec.released.load(Ordering::SeqCst), 1);
    assert!(!ex.running());

    // 옛 오퍼레이터(unsupported)는 상한 없음으로 본다.
    let (ex, _, _, _) = make(Opts {
        slot: SlotGrant::Unsupported,
        ..Opts::default()
    });
    assert_eq!(ex.tick(), BgTickResult::Ran);
}

#[test]
fn busy_tick_backs_off_without_reading_harness() {
    let (ex, rec, _, _) = make(Opts {
        hang: true,
        timeout: Duration::from_millis(400),
        ..Opts::default()
    });
    let ex = Arc::new(ex);
    let e2 = Arc::clone(&ex);
    let first = std::thread::spawn(move || e2.tick());
    let t0 = Instant::now();
    while !ex.running() && t0.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(5));
    }
    while rec.spawned.lock().unwrap().is_empty() && t0.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(5));
    }
    let reads = rec.harness_reads.load(Ordering::SeqCst);
    assert_eq!(ex.tick(), BgTickResult::Busy);
    assert_eq!(rec.harness_reads.load(Ordering::SeqCst), reads);
    assert_eq!(first.join().unwrap(), BgTickResult::Ran);
    assert!(!ex.running());
}

#[test]
fn runs_new_session_cause_bg_stdin_prompt_reports_done_and_removes_workdir() {
    let (ex, rec, stdin, dir) = make(Opts::default());
    assert_eq!(ex.tick(), BgTickResult::Ran);
    let spawned = rec.spawned.lock().unwrap();
    assert_eq!(spawned.len(), 1);
    let (cwd, env, args) = &spawned[0];
    assert_eq!(*cwd, dir.join("bg").join(JOB_ID));
    assert!(
        env.iter()
            .any(|(k, v)| k == "HARKROOM_TURN_CAUSE" && v == &format!("bg:{JOB_ID}"))
    );
    // 새 세션: argv 의 session-id 가 plan 에 넘긴 것과 같다.
    let sid = &env.iter().find(|(k, _)| k == "SID").unwrap().1;
    let i = args.iter().position(|a| a == "--session-id").unwrap();
    assert_eq!(&args[i + 1], sid);
    assert!(stdin.lock().unwrap().contains("백그라운드 회차 distill"));
    let o = outcome(&rec);
    assert_eq!(o.status, BgStatus::Done);
    assert_eq!(o.summary.as_deref(), Some("mem/x 갱신"));
    assert_eq!(o.tokens, Some(15));
    assert!(!cwd.exists());
    assert_eq!(rec.plan_releases.load(Ordering::SeqCst), 1);
    assert_eq!(rec.released.load(Ordering::SeqCst), 1);
}

#[test]
fn timeout_quota_max_turns_and_bad_exit_are_classified() {
    let (ex, rec, _, _) = make(Opts {
        hang: true,
        out: None,
        timeout: Duration::from_millis(50),
        ..Opts::default()
    });
    ex.tick();
    let o = outcome(&rec);
    assert_eq!(
        (o.status, o.error.as_deref()),
        (BgStatus::Failed, Some("timeout"))
    );

    let cases = [
        (
            serde_json::json!({ "is_error": true, "result": "Claude usage limit reached" }),
            BgStatus::Skipped,
            "quota",
        ),
        (
            serde_json::json!({ "subtype": "error_max_turns", "is_error": true, "num_turns": 41 }),
            BgStatus::Failed,
            "max_turns",
        ),
        (
            serde_json::json!({ "is_error": true, "result": "boom" }),
            BgStatus::Failed,
            "exit 1",
        ),
    ];
    for (out, status, err) in cases {
        let (ex, rec, _, _) = make(Opts {
            out: Some(out),
            code: Some(1),
            ..Opts::default()
        });
        ex.tick();
        let o = outcome(&rec);
        assert_eq!((o.status, o.error.as_deref()), (status, Some(err)));
    }
}

#[test]
fn plan_release_runs_once_on_ok_timeout_and_spawn_failure() {
    let (ex, rec, _, _) = make(Opts::default());
    ex.tick();
    assert_eq!(rec.plan_releases.load(Ordering::SeqCst), 1);

    let (ex, rec, _, _) = make(Opts {
        hang: true,
        timeout: Duration::from_millis(30),
        ..Opts::default()
    });
    ex.tick();
    assert_eq!(rec.plan_releases.load(Ordering::SeqCst), 1);

    let (ex, rec, _, dir) = make(Opts {
        spawn_fails: true,
        ..Opts::default()
    });
    ex.tick();
    assert_eq!(rec.plan_releases.load(Ordering::SeqCst), 1);
    let o = outcome(&rec);
    assert_eq!(
        (o.status, o.error.as_deref()),
        (BgStatus::Failed, Some("runner"))
    );
    assert!(!dir.join("bg").join(JOB_ID).exists());
}

#[test]
fn unknown_kind_and_bad_id_are_skipped_without_spawning() {
    let (ex, rec, _, _) = make(Opts {
        job: Some(job("shell")),
        ..Opts::default()
    });
    assert_eq!(ex.tick(), BgTickResult::Ran);
    assert!(rec.spawned.lock().unwrap().is_empty());
    let o = outcome(&rec);
    assert_eq!(
        (o.status, o.error.as_deref()),
        (BgStatus::Skipped, Some("unknown_kind"))
    );

    let mut bad = job("distill");
    bad.id = "../../etc/xxxxxxxxxxxxxxxxxxxxxxxxxx".into();
    let (ex, rec, _, _) = make(Opts {
        job: Some(bad),
        ..Opts::default()
    });
    ex.tick();
    assert!(rec.spawned.lock().unwrap().is_empty());
    let c = rec.completed.lock().unwrap();
    assert_eq!(c[0].1.error.as_deref(), Some("bad_job"));
    assert_eq!(rec.released.load(Ordering::SeqCst), 1);
}

#[test]
fn summary_hides_state_dir_and_home_paths() {
    let r = vec![
        ("/s/state".to_owned(), "<state>"),
        ("/Users/me".to_owned(), "~"),
    ];
    let out =
        serde_json::json!({ "is_error": false, "result": "남김 /s/state/bg/x · /Users/me/k" })
            .to_string();
    let o = classify(&out, Some(0), false, 1, &r);
    assert_eq!(o.summary.as_deref(), Some("남김 <state>/bg/x · ~/k"));
    // 오류 코드는 고정이다 — 하네스 출력이 실리지 않는다.
    let out =
        serde_json::json!({ "is_error": true, "result": "/Users/me/secret boom" }).to_string();
    let o = classify(&out, Some(2), false, 1, &r);
    assert_eq!(o.error.as_deref(), Some("exit 2"));
    assert_eq!(o.summary, None);
    // 빈 요약.
    let out = serde_json::json!({ "is_error": false, "result": "" }).to_string();
    assert_eq!(
        classify(&out, Some(0), false, 1, &[]).summary.as_deref(),
        Some("(요약 없음)")
    );
}

#[test]
fn default_spawn_clears_env() {
    let dir = state_dir();
    let mut c =
        default_spawn("/usr/bin/env", &[], &dir, &[("BG_ONLY".into(), "1".into())]).unwrap();
    let mut s = String::new();
    c.take_stdout().unwrap().read_to_string(&mut s).unwrap();
    while c.try_wait().unwrap().is_none() {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(s, "BG_ONLY=1\n");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn default_spawn_kill_takes_down_the_whole_group() {
    let dir = state_dir();
    let mut c = default_spawn(
        "/bin/sh",
        &["-c".into(), "/bin/sleep 30 & echo $!; /bin/sleep 30".into()],
        &dir,
        &[],
    )
    .unwrap();
    let mut line = String::new();
    BufReader::new(c.take_stdout().unwrap())
        .read_line(&mut line)
        .unwrap();
    let grandchild: libc::pid_t = line.trim().parse().unwrap();
    c.kill();
    let t0 = Instant::now();
    // SAFETY: 신호 0 은 살아 있는지만 본다.
    while unsafe { libc::kill(grandchild, 0) } == 0 && t0.elapsed() < Duration::from_secs(3) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_ne!(
        unsafe { libc::kill(grandchild, 0) },
        0,
        "손자 프로세스가 남았다"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn default_spawn_normal_exit_also_takes_down_the_group() {
    // security #1961 낮음: 자식이 정상으로 끝나도 stdout 을 쥔 손자가 남지 않고, 읽기가 끝나야 한다.
    let dir = state_dir();
    let mut c = default_spawn(
        "/bin/sh",
        &["-c".into(), "/bin/sleep 30 & echo $!; exit 0".into()],
        &dir,
        &[],
    )
    .unwrap();
    let mut out = BufReader::new(c.take_stdout().unwrap());
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    let grandchild: libc::pid_t = line.trim().parse().unwrap();
    let t0 = Instant::now();
    let code = loop {
        if let Some(code) = c.try_wait().unwrap() {
            break code;
        }
        assert!(t0.elapsed() < Duration::from_secs(3), "끝남을 못 봤다");
        std::thread::sleep(Duration::from_millis(5));
    };
    assert_eq!(code, Some(0));
    // 손자가 죽었으니 파이프가 닫혀 읽기가 곧 끝난다.
    let mut rest = String::new();
    out.read_to_string(&mut rest).unwrap();
    assert!(
        t0.elapsed() < Duration::from_secs(3),
        "읽기가 손자에 묶였다"
    );
    while unsafe { libc::kill(grandchild, 0) } == 0 && t0.elapsed() < Duration::from_secs(3) {
        std::thread::sleep(Duration::from_millis(20));
    }
    // SAFETY: 신호 0 은 살아 있는지만 본다.
    assert_ne!(
        unsafe { libc::kill(grandchild, 0) },
        0,
        "손자 프로세스가 남았다"
    );
    let _ = fs::remove_dir_all(&dir);
}
