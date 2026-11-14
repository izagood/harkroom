use std::os::unix::fs::PermissionsExt;

use serde_json::{Value, json};

use super::*;
use crate::adapter::{AgentHarness, MentionPermission};
use crate::mention_target::build_mention_target;
use crate::pty_turn::{PromptHooks, TurnResult};
use crate::turn_preset::TurnMode;

struct Pages {
    fail: bool,
}
impl PrepareIo for Pages {
    fn thread_pages(
        &mut self,
        _c: &str,
        _r: &str,
        _s: u64,
    ) -> Result<(Vec<Value>, Vec<Value>), String> {
        if self.fail {
            return Err("SERVER_ERROR_TEXT".into());
        }
        Ok((
            vec![],
            vec![
                json!({ "id": "m2", "seq": 2, "channelId": "c1", "threadRootId": "root",
                "authorId": "human-1", "body": "THREAD_BODY_TEXT", "kind": "user" }),
            ],
        ))
    }
}

#[derive(Default)]
struct Sink;
impl PromptHooks for Sink {}
impl PtyTurnSink for Sink {}

fn target() -> MentionTarget {
    let m = json!({ "id": "m2", "seq": 2, "channelId": "c1", "threadRootId": "root",
        "authorId": "human-1", "body": "THREAD_BODY_TEXT", "kind": "user" });
    build_mention_target(&json!({ "id": 7, "reason": "mention" }), &m, "root", &[])
}

struct World {
    root: PathBuf,
}
impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn world(tag: &str) -> World {
    let root = std::env::temp_dir().join(format!("hk-mparts-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    World { root }
}

#[allow(clippy::result_large_err)]
fn parts<'a>(
    w: &'a World,
    store: &'a SessionStore,
    stale: &'a Path,
    fail: bool,
) -> MentionParts<'a, Pages, Sink> {
    let mut base = TurnCommandOptions::new(
        AgentHarness::ClaudeCode,
        TurnMode::Mention,
        MentionPermission::Auto,
        "/bin/op",
    );
    base.claude_config_dir = Some(stale);
    let mut p = MentionParts::with_parts(
        Pages { fail },
        store,
        base,
        SystemInputs {
            handle: "agent".into(),
            channel_name: "general".into(),
            instructions: "OWNER_INSTRUCTIONS".into(),
            guide: "GUIDE".into(),
            memory: MemoryContext::Unavailable,
            read_only: false,
            turn_budget_ms: None,
            merge: None,
            permissions: None,
            api: None,
            secret_create: false,
            lane_model: None,
        },
        Box::new(|| PtyTurnOptions::at(std::env::temp_dir())),
        Sink,
        Box::new(|_a, _s, _l, end, _o| {
            assert_eq!(end.last_data_at_ms, 55, "감시 자리의 끝 상태 사본");
            Ok(TurnOk::default())
        }),
        Box::new(|_, _| Ok(())),
        Box::new(|_| Ok(())),
    );
    p.key = "c1:root".into();
    p.me_id = "agent".into();
    p.state_dir = w.root.join("state");
    std::fs::create_dir_all(&p.state_dir).unwrap();
    p.new_workspace_dir = "/ws/new".into();
    p.home = w.root.join("home");
    p
}

fn acct(name: &str, dir: &str) -> ClaudeAccount {
    ClaudeAccount {
        name: name.into(),
        config_dir: PathBuf::from(dir),
        pool: None,
    }
}

/// 준비 → 명령: 이 시도 계정의 폴더가 마지막에 얹힌다(기본의 남은 폴더가 아니라) · 지시문 파일 0600 · 기록 찾기도 그 폴더 ·
/// 프롬프트에 스레드 글은 있고 계정 폴더는 없다.
#[test]
fn prepare_then_command_uses_attempt_account_folder() {
    let w = world("prep");
    let store = SessionStore::new(w.root.join("sessions.json"));
    let stale = PathBuf::from("/acct/STALE_BASE");
    let mut p = parts(&w, &store, &stale, false);
    let a = acct("a1", "/acct/MARKER_A1_DIR");
    let prep = p.prepare(&target(), Some(&a), false, "t-1").unwrap();
    assert_eq!(prep.cause, "m2");
    assert_eq!(
        prep.homes.claude_config_dir.as_deref(),
        Some(Path::new("/acct/MARKER_A1_DIR"))
    );
    let cmd = p.command_for("t-1").unwrap();
    assert_eq!(
        cmd.claude_config_dir,
        Some(Path::new("/acct/MARKER_A1_DIR"))
    );
    assert_eq!(cmd.turn_id, Some("t-1"));
    assert_eq!(cmd.cause_message_id, Some("m2"));
    let file = cmd.system_prompt_file.unwrap();
    let m = std::fs::metadata(file).unwrap();
    assert_eq!(m.permissions().mode() & 0o777, 0o600);
    let body = std::fs::read_to_string(file).unwrap();
    assert!(body.contains("OWNER_INSTRUCTIONS"));
    assert!(!body.contains("MARKER_A1_DIR"));
    let prompt = p.prompt().unwrap();
    assert!(prompt.contains("THREAD_BODY_TEXT"));
    assert!(!prompt.contains("MARKER_A1_DIR"));

    // 다음 시도(계정 없음) — 앞 시도 계정 폴더도, 기본 폴더도 남지 않는다.
    p.prepare(&target(), None, true, "t-2").unwrap();
    assert_eq!(p.command_for("t-2").unwrap().claude_config_dir, None);

    // 지시문 파일은 그 스레드 것(열쇠 해시 이름)이고, 멘션이 끝나면(값이 떨어지면) 없다.
    let file = PathBuf::from(p.command_for("t-2").unwrap().system_prompt_file.unwrap());
    assert_eq!(
        file,
        crate::turn_files::system_prompt_path(&p.state_dir, &p.key)
    );
    assert!(file.exists());
    drop(p);
    assert!(!file.exists(), "턴이 끝나면 지시문 파일이 없다");
}

/// 준비 실패는 종류만 담은 오류(서버 오류 원문 없음) — 띄우기 전이라 아무것도 받지 않았다.
#[test]
fn prepare_failure_is_kind_only() {
    let w = world("fail");
    let store = SessionStore::new(w.root.join("sessions.json"));
    let stale = PathBuf::from("/x");
    let mut p = parts(&w, &store, &stale, true);
    let e = p.prepare(&target(), None, true, "t-1").unwrap_err();
    assert_eq!(e.message, PREPARE_FAILED);
    assert!(!format!("{e:?}").contains("SERVER_ERROR_TEXT"));
    assert!(p.command_for("t-1").is_none());
}

/// 결과 접기는 감시 자리의 끝 상태 사본을 받는다 · 듣기는 멘션 슬롯 · 칩은 순번만.
#[test]
fn outcome_live_and_ranks() {
    let w = world("misc");
    let store = SessionStore::new(w.root.join("sessions.json"));
    let stale = PathBuf::from("/x");
    let mut p = parts(&w, &store, &stale, false);
    p.watch.lock().unwrap().end.last_data_at_ms = 55;
    let s = TurnSecrets::build("pat", &[], None);
    let live = LiveTurn::default();
    let r = p.outcome(
        Attempted::Ran(Ok(TurnResult {
            exit_code: 0,
            timed_out: false,
            tail: String::new(),
        })),
        &s,
        &live,
    );
    assert!(r.is_ok());
    p.bind_live(Some(Arc::new(LiveTurn::default())));
    assert!(p.slot.is_bound());
    p.bind_live(None);
    assert!(!p.slot.is_bound());
    p.lane = LaneSnapshot {
        lane: vec![Some(acct("a1", "/a1")), Some(acct("a2", "/a2"))],
        ..LaneSnapshot::default()
    };
    assert_eq!(
        p.account_ranks(Some(&acct("a2", "/a2"))),
        (Some(Some(2)), None)
    );
    assert_eq!(p.account_ranks(None), (Some(None), None));
}

/// security: 감시 자리는 시도마다 새것 — a1 이 남긴 API 오류·화면 꼬리가 a2 의 결과 접기·화면 줄에 섞이지 않는다.
#[test]
#[allow(clippy::result_large_err)]
fn watch_is_fresh_per_attempt() {
    let w = world("fresh");
    let store = SessionStore::new(w.root.join("sessions.json"));
    let stale = PathBuf::from("/x");
    let mut p = parts(&w, &store, &stale, false);
    p.outcome = Box::new(|_a, _s, _l, end, _o| {
        assert!(end.api_error.is_none(), "앞 시도의 API 오류가 없다");
        assert!(!end.exited && !end.spoke);
        Ok(TurnOk::default())
    });
    // a1: 출력·API 오류를 남긴다.
    p.bind_live(Some(Arc::new(LiveTurn::default())));
    {
        let now = || 1_i64;
        let mut inner = Sink;
        let mut sink = WatchSink {
            inner: &mut inner,
            watch: p.watch.clone(),
            now_ms: &now,
            stop_on_spawn: None,
        };
        sink.on_output(b"A1_SCREEN_LINE You've hit your usage limit\n");
        let mut g = p.watch.lock().unwrap();
        g.end.api_error = Some("You've hit your usage limit".into());
        g.end.exited = true;
        g.end.spoke = true;
    }
    p.bind_live(None);
    // a2
    p.bind_live(Some(Arc::new(LiveTurn::default())));
    let line = p
        .watch
        .lock()
        .unwrap()
        .screen_line_for_post(&crate::turn_probe_records::NoticeSecrets::default());
    assert!(line.is_none(), "a1 화면 줄이 없다: {line:?}");
    let s = TurnSecrets::build("pat", &[], None);
    let r = p.outcome(
        Attempted::Ran(Ok(TurnResult {
            exit_code: 0,
            timed_out: false,
            tail: String::new(),
        })),
        &s,
        &LiveTurn::default(),
    );
    assert!(r.is_ok());
}

/// security: 감시 루프는 띄우는 그 시도의 자리를 받는다 — a2 의 루프는 a2 자리에만 적고 a1 자리는 그대로다. 루프는 PTY 턴이
/// 끝나면 멈춘다(시도 범위를 넘지 않는다).
#[test]
fn watch_loop_gets_this_attempts_watch() {
    let w = world("loop");
    let store = SessionStore::new(w.root.join("sessions.json"));
    let stale = PathBuf::from("/x");
    let mut p = parts(&w, &store, &stale, false);
    p.watch_loop = Some(Box::new(|watch, _notice, _ctx, stop| {
        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
            watch.lock().unwrap().end.stalled_idle_ms += 1;
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        watch.lock().unwrap().end.spoke = true;
    }));
    let secrets = crate::turn_probe_records::NoticeSecrets::default();

    p.bind_live(Some(Arc::new(LiveTurn::default())));
    let a1 = p.attempt_watch();
    run_beside(
        &p.attempt_watch(),
        &secrets,
        &LoopCtx::default(),
        p.watch_loop.as_ref(),
        || {
            std::thread::sleep(std::time::Duration::from_millis(5));
        },
    );
    assert!(
        a1.lock().unwrap().end.spoke,
        "a1 루프는 a1 자리에 적고 멈췄다"
    );
    let a1_count = a1.lock().unwrap().end.stalled_idle_ms;

    p.bind_live(None);
    p.bind_live(Some(Arc::new(LiveTurn::default())));
    let a2 = p.attempt_watch();
    assert!(!Arc::ptr_eq(&a1, &a2), "a2 는 새 자리");
    run_beside(
        &p.attempt_watch(),
        &secrets,
        &LoopCtx::default(),
        p.watch_loop.as_ref(),
        || {
            std::thread::sleep(std::time::Duration::from_millis(5));
        },
    );
    assert!(a2.lock().unwrap().end.spoke, "a2 루프는 a2 자리에 적었다");
    assert_eq!(
        a1.lock().unwrap().end.stalled_idle_ms,
        a1_count,
        "a1 자리는 그대로"
    );
}

/// 지시문의 머지·권한·API 절 재료가 채워지면 지시문 파일에 그 절이 실린다(빈칸이면 빠진다).
#[test]
fn system_prompt_sections_are_filled() {
    let w = world("sys");
    let store = SessionStore::new(w.root.join("sessions.json"));
    let stale = PathBuf::from("/x");
    let mut p = parts(&w, &store, &stale, false);
    let bare = crate::prompt_system::build_system_prompt(&p.system.opts());
    p.system.merge = Some(MergeInputs {
        operator_bin: "/opt/OPBIN_MERGE".into(),
        repos: vec!["owner/repo".into()],
        approved: vec![],
    });
    p.system.permissions = Some(PermissionInputs::default());
    p.system.api = Some(ApiInputs {
        operator_bin: "/opt/OPBIN_API".into(),
        ..ApiInputs::default()
    });
    p.prepare(&target(), None, true, "t-1").unwrap();
    let file = p
        .command_for("t-1")
        .unwrap()
        .system_prompt_file
        .unwrap()
        .to_string();
    let body = std::fs::read_to_string(file).unwrap();
    assert_eq!(
        body,
        crate::prompt_system::build_system_prompt(&p.system.opts())
    );
    assert!(body.contains("OPBIN_MERGE"), "머지 절");
    assert!(body.len() > bare.len());
    assert!(!bare.contains("OPBIN_MERGE"));
}

/// security: PTY 턴(`f`)이 패닉해도 멈춤 신호가 서서 감시 루프가 끝나고, 패닉은 제한 시간 안에 밖으로 나온다 — 그래서 바깥
/// 정리 가드가 돈다(가드 차례 자체는 #2037·#2049·#2051 시험이 고정).
#[test]
fn panic_in_turn_still_stops_watch_loop() {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let watch = Watch::default();
        let lf: WatchLoopFn<'static> = Box::new(|_w, _n, _c, stop| {
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        });
        let secrets = crate::turn_probe_records::NoticeSecrets::default();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_beside(
                &watch,
                &secrets,
                &LoopCtx::default(),
                Some(&lf),
                || -> () { panic!("PTY 턴 도중 패닉") },
            )
        }));
        let _ = tx.send(r.is_err());
    });
    let panicked = rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("감시 루프가 끝나 패닉이 제한 시간 안에 밖으로 나온다");
    assert!(panicked);
}

/// 이 시도의 끝 신호는 PTY 턴이 끝나면(정상·패닉 모두) 선다 — 시계·SIGTERM·탐침 `exited()` 가 이것을 본다.
#[test]
fn run_beside_raises_this_attempts_end_signal() {
    let secrets = crate::turn_probe_records::NoticeSecrets::default();
    let ctx = LoopCtx::default();
    assert!(!ctx.ended.load(std::sync::atomic::Ordering::SeqCst));
    run_beside(&Watch::default(), &secrets, &ctx, None, || ());
    assert!(ctx.ended.load(std::sync::atomic::Ordering::SeqCst));

    let ctx = LoopCtx::default();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_beside(&Watch::default(), &secrets, &ctx, None, || -> () {
            panic!("PTY 턴 도중 패닉")
        })
    }));
    assert!(r.is_err());
    assert!(
        ctx.ended.load(std::sync::atomic::Ordering::SeqCst),
        "패닉에도 선다"
    );
}

/// 마운트 단계 실물은 아무것도 하지 않는다(마운트는 오퍼레이터의 `secret.mount`).
#[test]
fn no_mount_is_a_noop() {
    let mut m = no_mount();
    assert!(m("m7").is_ok());
}

fn read_json(p: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// T1·T2 — 기본 로그인(계정 없음): 띄우기 전 준비가 사람의 `<home>/.claude.json`(claude 가 실제로 읽는 자리)에 **이 턴의 작업 폴더 하나만** 신뢰로 적는다.
/// 이미 있던 값(onboarding·다른 프로젝트)은 그대로이고 상위 폴더는 열지 않는다 · bypass 수락은 `<home>/.claude/settings.json`.
#[test]
fn prepare_trusts_only_this_workspace_default_login() {
    let w = world("trust-default");
    let store = SessionStore::new(w.root.join("sessions.json"));
    let stale = PathBuf::from("/x");
    let mut p = parts(&w, &store, &stale, false);
    let ws = w.root.join("ws").join("thread-1");
    p.new_workspace_dir = ws.to_string_lossy().into_owned();
    let cfg = p.home.join(".claude");
    std::fs::create_dir_all(&cfg).unwrap();
    let ledger = p.home.join(".claude.json");
    std::fs::write(
        &ledger,
        json!({"hasCompletedOnboarding": false, "projects": {"/other": {"x": 1}}}).to_string(),
    )
    .unwrap();

    p.prepare(&target(), None, true, "t-1").unwrap();

    let doc = read_json(&ledger);
    assert_eq!(
        doc["hasCompletedOnboarding"],
        json!(false),
        "기본 로그인 onboarding 은 건드리지 않는다"
    );
    let projects = doc["projects"].as_object().unwrap();
    assert_eq!(
        projects.len(),
        2,
        "이 턴의 작업 폴더 하나만 더한다: {projects:?}"
    );
    assert_eq!(projects["/other"], json!({"x": 1}));
    assert_eq!(
        projects[ws.to_str().unwrap()],
        json!({"hasTrustDialogAccepted": true})
    );
    let settings = read_json(&cfg.join("settings.json"));
    assert_eq!(settings["skipDangerousModePermissionPrompt"], json!(true));
}

/// T1 — 계정 폴더가 있는 시도: 그 폴더의 장부에 적고 기본 집(`<home>/.claude`)은 건드리지 않는다. 계정 관문·설정 걷기는 아직 없다(L3c-3).
#[test]
fn prepare_trusts_in_attempt_account_folder() {
    let w = world("trust-acct");
    let store = SessionStore::new(w.root.join("sessions.json"));
    let stale = PathBuf::from("/x");
    let mut p = parts(&w, &store, &stale, false);
    let ws = w.root.join("ws2");
    p.new_workspace_dir = ws.to_string_lossy().into_owned();
    let acc_dir = w.root.join("acct-a1");
    std::fs::create_dir_all(&acc_dir).unwrap();
    std::fs::write(
        acc_dir.join("settings.json"),
        json!({"permissions": {"allow": ["Bash"]}}).to_string(),
    )
    .unwrap();
    let a = acct("a1", acc_dir.to_str().unwrap());

    p.prepare(&target(), Some(&a), false, "t-1").unwrap();

    let doc = read_json(&acc_dir.join(".claude.json"));
    assert_eq!(
        doc["projects"][ws.to_str().unwrap()]["hasTrustDialogAccepted"],
        json!(true)
    );
    assert!(
        doc.get("hasCompletedOnboarding").is_none(),
        "계정 관문은 L3c-3"
    );
    let settings = read_json(&acc_dir.join("settings.json"));
    assert_eq!(settings["skipDangerousModePermissionPrompt"], json!(true));
    assert!(settings.get("permissions").is_some(), "설정 걷기는 L3c-3");
    assert!(
        !p.home.join(".claude").exists(),
        "기본 집은 건드리지 않는다"
    );
}

// ── T3: PTY 옵션은 이 시도의 값으로 ─────────────────────────────────────────────

fn ws_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("hk-t3-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// TUI(claude): cwd = 작업 폴더 · 시한 0 · 주입 = 이 시도의 프롬프트(그것만) + 어댑터 준비 표지. 크기 등은 기본값 그대로.
#[test]
fn attempt_pty_options_fill_cwd_inject_timeout() {
    let ws = ws_dir("tui");
    let base = PtyTurnOptions::at(PathBuf::new());
    let (cols, rows) = (base.cols, base.rows);
    let o = attempt_pty_options(
        base,
        AgentHarness::ClaudeCode,
        ws.to_str().unwrap(),
        "PROMPT_TEXT".into(),
        1234,
    )
    .unwrap();
    assert_eq!(o.cwd, ws);
    assert_eq!(o.timeout_ms, 0, "TUI 는 무기한(무발화 시계가 잰다)");
    let i = o.inject.expect("TUI 턴은 프롬프트를 주입한다");
    assert_eq!(i.text, "PROMPT_TEXT", "주입 글자는 턴 프롬프트뿐");
    let facts = crate::adapter::injection_facts_for(AgentHarness::ClaudeCode).unwrap();
    assert_eq!(
        i.ready_pattern.as_ref().map(|r| r.as_str()),
        Some(facts.ready_pattern.as_str())
    );
    assert_eq!((o.cols, o.rows), (cols, rows));
}

/// TUI 가 아닌 하네스(`exec`): 주입 없음(stdin 이 프롬프트) · 시한 = 턴 시한. TUI 하네스는 모두 주입이 있다.
#[test]
fn attempt_pty_options_inject_follows_execution_model() {
    let ws = ws_dir("exec");
    for h in AgentHarness::ALL {
        let Ok(tui) = crate::adapter::uses_tui_for_mention(h) else {
            continue;
        };
        let o = attempt_pty_options(
            PtyTurnOptions::at(PathBuf::new()),
            h,
            ws.to_str().unwrap(),
            "P".into(),
            1234,
        )
        .unwrap();
        assert_eq!(o.inject.is_some(), tui, "{h:?}");
        assert_eq!(o.timeout_ms, if tui { 0 } else { 1234 }, "{h:?}");
        assert_eq!(o.cwd, ws);
    }
}

/// 작업 폴더가 비었거나·상대 경로거나·루트(`/`)거나·없으면 띄우지 않는다(security S1·S6).
#[test]
fn attempt_pty_options_refuse_bad_workspace() {
    let missing = std::env::temp_dir().join(format!("hk-t3-missing-{}", std::process::id()));
    for ws in ["", "rel/ws", "/", missing.to_str().unwrap()] {
        assert!(
            attempt_pty_options(
                PtyTurnOptions::at(PathBuf::new()),
                AgentHarness::ClaudeCode,
                ws,
                "P".into(),
                1
            )
            .is_err(),
            "{ws:?}"
        );
    }
}

/// T3a: 시도를 준비할 때 이 멘션의 임대 폴더를 묻는다 — 가림 바늘(꼬리·통지·기록)이 그 폴더를 본다.
#[test]
fn prepare_asks_lease_dir_for_this_mention() {
    let w = world("lease");
    let store = SessionStore::new(w.root.join("sessions.json"));
    let stale = PathBuf::from("/x");
    let mut p = parts(&w, &store, &stale, false);
    let dir = w.root.join("lease-1");
    let d2 = dir.clone();
    p.lease_dir_of = Some(Box::new(move || Some(d2.clone())));
    let prep = p.prepare(&target(), None, true, "t-1").unwrap();
    assert_eq!(prep.lease_dir, Some(dir));
}

fn fixed_clock() -> crate::prompt_turn::TurnClock {
    crate::prompt_turn::TurnClock {
        now_ms: 1_794_640_000_000,
        time_zone: "Asia/Seoul".into(),
        utc_offset_minutes: 540,
    }
}

/// T4a: 시도를 준비할 때 시계를 재 턴 프롬프트에 「지금 시각」 줄이 실린다(정본 `now: new Date()`). 시계가 없으면 줄도 없다.
#[test]
fn prepare_puts_turn_clock_line_into_prompt() {
    let w = world("clock");
    let store = SessionStore::new(w.root.join("sessions.json"));
    let stale = PathBuf::from("/x");
    let mut p = parts(&w, &store, &stale, false);
    p.prepare(&target(), None, true, "t-0").unwrap();
    assert!(!p.prompt().unwrap().contains("지금 시각(이 턴을 시작한 때)"));
    p.clock = Some(fixed_clock);
    p.prepare(&target(), None, true, "t-1").unwrap();
    let prompt = p.prompt().unwrap();
    assert!(
        prompt.contains("지금 시각(이 턴을 시작한 때):")
            && prompt.contains("(Asia/Seoul, UTC+09:00)"),
        "{prompt}"
    );
}

/// T4d: TUI 턴은 주입 확인을 건다(정본 `confirmDelivery`, 15초) — exec 턴은 주입 자체가 없다.
#[test]
fn attempt_pty_options_ask_delivery_confirmation() {
    let ws = std::env::temp_dir().join(format!("hk-t4d-{}", std::process::id()));
    std::fs::create_dir_all(&ws).unwrap();
    let o = attempt_pty_options(
        PtyTurnOptions::at(PathBuf::new()),
        AgentHarness::ClaudeCode,
        ws.to_str().unwrap(),
        "P".into(),
        1,
    )
    .unwrap();
    let c = o
        .inject
        .unwrap()
        .confirm
        .expect("TUI 턴은 주입 확인을 건다");
    assert_eq!(c.within_ms, CONFIRM_DELIVERY_WITHIN_MS);
    assert_eq!(c.resend_grace_ms, None);
}
