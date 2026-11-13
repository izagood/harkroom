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
