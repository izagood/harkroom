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
        Box::new(PtyTurnOptions::default),
        Sink,
        Box::new(|_a, _s, _l, end| {
            assert_eq!(end.last_data_at_ms, 55, "감시 자리의 끝 상태 사본");
            Ok(TurnOk::default())
        }),
        Box::new(|_| Ok(())),
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
    p.outcome = Box::new(|_a, _s, _l, end| {
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
    p.watch_loop = Some(Box::new(|watch, _notice, stop| {
        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
            watch.lock().unwrap().end.stalled_idle_ms += 1;
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        watch.lock().unwrap().end.spoke = true;
    }));
    let secrets = crate::turn_probe_records::NoticeSecrets::default();

    p.bind_live(Some(Arc::new(LiveTurn::default())));
    let a1 = p.attempt_watch();
    run_beside(&p.attempt_watch(), &secrets, p.watch_loop.as_ref(), || {
        std::thread::sleep(std::time::Duration::from_millis(5));
    });
    assert!(
        a1.lock().unwrap().end.spoke,
        "a1 루프는 a1 자리에 적고 멈췄다"
    );
    let a1_count = a1.lock().unwrap().end.stalled_idle_ms;

    p.bind_live(None);
    p.bind_live(Some(Arc::new(LiveTurn::default())));
    let a2 = p.attempt_watch();
    assert!(!Arc::ptr_eq(&a1, &a2), "a2 는 새 자리");
    run_beside(&p.attempt_watch(), &secrets, p.watch_loop.as_ref(), || {
        std::thread::sleep(std::time::Duration::from_millis(5));
    });
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
