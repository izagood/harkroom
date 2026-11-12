//! 정본 `relay.test.ts` 의 세션 약속을 가짜 sink 로 본다(링크·소켓 없이).

use super::*;
use std::sync::mpsc;
use std::time::Duration;

fn ledger(handler: Option<InteractiveOpenHandler>) -> (Arc<RelaySessions>, Arc<Mutex<Vec<Value>>>) {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let l = RelaySessions::new(handler, Box::new(|_| {}));
    let s = sent.clone();
    l.set_sink(Arc::new(move |f: &Value| s.lock().unwrap().push(f.clone())));
    (l, sent)
}

fn types(sent: &Arc<Mutex<Vec<Value>>>) -> Vec<String> {
    sent.lock()
        .unwrap()
        .iter()
        .map(|f| f["type"].as_str().unwrap().to_string())
        .collect()
}

#[derive(Default)]
struct FakePty {
    written: Mutex<Vec<u8>>,
    sizes: Mutex<Vec<(u16, u16)>>,
}
impl PtyInput for FakePty {
    fn write(&self, chunk: &[u8]) {
        self.written.lock().unwrap().extend_from_slice(chunk);
    }
    fn resize(&self, cols: u16, rows: u16) {
        self.sizes.lock().unwrap().push((cols, rows));
    }
}

fn input() -> OpenSessionInput {
    OpenSessionInput {
        agent_account_id: "a1".into(),
        channel_id: "c1".into(),
        thread_root_id: Some("t1".into()),
        harness: "claude".into(),
        accepts_input: true,
        ..Default::default()
    }
}

#[test]
fn open_push_close_frames_and_announce() {
    let (l, sent) = ledger(None);
    let h = l.open_session(OpenSessionInput {
        claude_account: Some(None),
        claude_pool_rank: Some(2),
        ..input()
    });
    let started = sent.lock().unwrap()[0].clone();
    assert_eq!(started["type"], "session.started");
    let s = &started["session"];
    assert_eq!(s["sessionId"], h.session_id());
    assert_eq!(s["mode"], "mention");
    assert_eq!(s["acceptsInput"], true);
    assert_eq!(s["threadRootId"], "t1");
    // null(시스템 기본)은 싣고, 모르는 풀은 생략한다.
    assert!(s["claudeAccount"].is_null() && s.as_object().unwrap().contains_key("claudeAccount"));
    assert!(!s.as_object().unwrap().contains_key("claudePool"));
    assert_eq!(s["claudePoolRank"], 2);
    assert!(s["startedAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(l.announce(), vec![s.clone()]);

    h.push(b"hi");
    assert_eq!(sent.lock().unwrap()[1]["data"], B64.encode(b"hi"));
    h.close();
    h.close();
    h.push(b"late");
    assert_eq!(types(&sent), ["session.started", "output", "session.ended"]);
    assert!(l.is_empty());
}

#[test]
fn drop_closes_once() {
    let (l, sent) = ledger(None);
    {
        let h = l.open_session(input());
        h.close();
    }
    {
        let _h = l.open_session(input());
    }
    assert_eq!(
        types(&sent),
        [
            "session.started",
            "session.ended",
            "session.started",
            "session.ended"
        ]
    );
}

#[test]
fn replay_answers_only_known_sessions_with_ring() {
    let (l, sent) = ledger(None);
    let h = l.open_session(input());
    h.push(b"abc");
    h.push(b"def");
    l.on_frame(json!({"type": "replay.request", "sessionId": "nope"}));
    l.on_frame(json!({"type": "replay.request", "sessionId": h.session_id()}));
    let last = sent.lock().unwrap().last().unwrap().clone();
    assert_eq!(last["type"], "replay");
    assert_eq!(last["data"], B64.encode(b"abcdef"));
    assert_eq!(types(&sent).iter().filter(|t| *t == "replay").count(), 1);
}

#[test]
fn ring_fills_without_sink() {
    // 링크가 끊겨 있어도(sink 없음) ring 은 쌓인다 — 재접속 뒤 재생.
    let l = RelaySessions::new(None, Box::new(|_| {}));
    let h = l.open_session(input());
    h.push(b"while-down");
    let sent = Arc::new(Mutex::new(Vec::new()));
    let s = sent.clone();
    l.set_sink(Arc::new(move |f: &Value| s.lock().unwrap().push(f.clone())));
    l.on_frame(json!({"type": "replay.request", "sessionId": h.session_id()}));
    assert_eq!(sent.lock().unwrap()[0]["data"], B64.encode(b"while-down"));
}

#[test]
fn input_and_resize_dropped_before_bind_then_routed() {
    let (l, _) = ledger(None);
    let h = l.open_session(input());
    let sid = h.session_id().to_string();
    l.on_frame(json!({"type": "input", "sessionId": sid, "data": B64.encode(b"early")}));
    l.on_frame(json!({"type": "resize", "sessionId": sid, "cols": 80, "rows": 24}));
    let pty = Arc::new(FakePty::default());
    h.bind_input(pty.clone());
    l.on_frame(json!({"type": "input", "sessionId": sid, "data": B64.encode(b"yes\r")}));
    l.on_frame(json!({"type": "input", "sessionId": sid, "data": "%%not-b64"}));
    l.on_frame(json!({"type": "input", "sessionId": "other", "data": B64.encode(b"x")}));
    l.on_frame(json!({"type": "resize", "sessionId": sid, "cols": 100, "rows": 30}));
    l.on_frame(json!({"type": "resize", "sessionId": sid, "cols": 0, "rows": 30}));
    l.on_frame(json!({"type": "resize", "sessionId": sid, "cols": 70000, "rows": 30}));
    assert_eq!(&*pty.written.lock().unwrap(), b"yes\r");
    assert_eq!(&*pty.sizes.lock().unwrap(), &[(100, 30)]);
    h.close();
    l.on_frame(json!({"type": "input", "sessionId": sid, "data": B64.encode(b"after")}));
    assert_eq!(&*pty.written.lock().unwrap(), b"yes\r");
}

#[test]
fn viewer_count_cancel_and_link_down() {
    let (l, _) = ledger(None);
    let views = Arc::new(Mutex::new(Vec::new()));
    let cancels = Arc::new(Mutex::new(Vec::new()));
    let (v, c) = (views.clone(), cancels.clone());
    let h = l.open_session(OpenSessionInput {
        on_viewer_count: Some(Arc::new(move |n| v.lock().unwrap().push(n))),
        on_cancel: Some(Arc::new(move |by: &str| {
            c.lock().unwrap().push(by.to_string())
        })),
        ..input()
    });
    // 패닉하는 다른 세션의 콜백이 장부를 죽이지 않는다.
    let _bad = l.open_session(OpenSessionInput {
        on_viewer_count: Some(Arc::new(|_| panic!("boom"))),
        on_cancel: Some(Arc::new(|_| panic!("boom"))),
        ..input()
    });
    let sid = h.session_id().to_string();
    l.on_frame(json!({"type": "viewer.count", "sessionId": sid, "count": 2}));
    l.on_frame(json!({"type": "session.cancel", "sessionId": sid, "byHandle": "jb"}));
    l.on_frame(json!({"type": "session.cancel", "sessionId": "gone", "byHandle": "jb"}));
    l.on_link_down();
    l.cancel_sessions();
    assert_eq!(&*views.lock().unwrap(), &[2, 0]);
    assert_eq!(
        &*cancels.lock().unwrap(),
        &["jb".to_string(), "operator".to_string()]
    );
}

#[test]
fn attention_screen_is_capped_tail() {
    let (l, sent) = ledger(None);
    let h = l.open_session(input());
    let long = format!("{}끝", "가".repeat(2_000));
    h.needs_attention(&long, "acct");
    let f = sent.lock().unwrap().last().unwrap().clone();
    assert_eq!(f["type"], "attention.required");
    assert_eq!(f["accountLabel"], "acct");
    let screen = String::from_utf8(B64.decode(f["screen"].as_str().unwrap()).unwrap()).unwrap();
    assert!(screen.len() <= ATTENTION_SCREEN_MAX_BYTES);
    assert!(screen.ends_with("가끝"));
}

#[test]
fn interactive_open_without_handler_errors() {
    let (l, sent) = ledger(None);
    l.on_frame(json!({"type": "interactive.open", "requestId": "q1", "channelId": "c", "threadRootId": "t", "openedByHandle": "jb"}));
    let f = sent.lock().unwrap()[0].clone();
    assert_eq!(
        f,
        json!({"type": "interactive.error", "requestId": "q1", "message": INTERACTIVE_NOT_WIRED})
    );
}

#[test]
fn interactive_open_runs_handler_off_thread() {
    let (tx, rx) = mpsc::channel();
    let handler: InteractiveOpenHandler = Arc::new(move |req: InteractiveOpenRequest| {
        tx.send(req.clone()).unwrap();
        if req.thread_root_id == "bad" {
            Err("codex 는 인터랙티브를 지원하지 않는다".into())
        } else {
            Ok(("s9".into(), true))
        }
    });
    let (l, sent) = ledger(Some(handler));
    l.on_frame(json!({"type": "interactive.open", "requestId": "q1", "channelId": "c", "threadRootId": "t", "openedByHandle": "jb", "cols": 90, "rows": 20}));
    let req = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(
        req,
        InteractiveOpenRequest {
            channel_id: "c".into(),
            thread_root_id: "t".into(),
            opened_by_handle: "jb".into(),
            cols: Some(90),
            rows: Some(20),
        }
    );
    l.on_frame(json!({"type": "interactive.open", "requestId": "q2", "channelId": "c", "threadRootId": "bad", "openedByHandle": "jb"}));
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    for _ in 0..200 {
        if sent.lock().unwrap().len() >= 2 {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let mut got = sent.lock().unwrap().clone();
    got.sort_by_key(|f| f["requestId"].as_str().unwrap().to_string());
    assert_eq!(
        got,
        vec![
            json!({"type": "interactive.opened", "requestId": "q1", "sessionId": "s9", "created": true}),
            json!({"type": "interactive.error", "requestId": "q2", "message": "codex 는 인터랙티브를 지원하지 않는다"}),
        ]
    );
}

#[test]
fn tail_str_respects_char_boundary() {
    assert_eq!(tail_str("abc", 5), "abc");
    assert_eq!(tail_str("가나", 4), "나");
    assert_eq!(tail_str("가나", 3), "나");
}

#[test]
fn wire_give_up_cancels_sessions_then_calls_previous_hook() {
    use crate::config::OperatorLink;
    let (l, _) = ledger(None);
    let order = Arc::new(Mutex::new(Vec::new()));
    let o1 = order.clone();
    let _h = l.open_session(OpenSessionInput {
        on_cancel: Some(Arc::new(move |by: &str| {
            o1.lock().unwrap().push(format!("cancel:{by}"))
        })),
        on_viewer_count: Some(Arc::new({
            let o = order.clone();
            move |n| o.lock().unwrap().push(format!("view:{n}"))
        })),
        ..input()
    });
    let mut opts = LinkOptions::new(OperatorLink {
        socket_path: "/nonexistent".into(),
        runner_id: "r".into(),
        secret: "s".into(),
    });
    let o2 = order.clone();
    opts.on_rejected_give_up = Box::new(move || o2.lock().unwrap().push("prev-give-up".into()));
    let o3 = order.clone();
    opts.on_link_down = Box::new(move || o3.lock().unwrap().push("prev-down".into()));
    let opts = l.wire(opts);
    assert_eq!((opts.announce_sessions)().len(), 1);
    (opts.on_link_down)();
    (opts.on_rejected_give_up)();
    assert_eq!(
        &*order.lock().unwrap(),
        &["view:0", "prev-down", "cancel:operator", "prev-give-up"]
    );
}

#[test]
fn interactive_error_text_hides_paths_and_control_chars() {
    assert_eq!(
        public_error_text("codex 는 인터랙티브를 지원하지 않는다"),
        "codex 는 인터랙티브를 지원하지 않는다"
    );
    let shown = public_error_text(
        "spawn 실패: /Users/someone/secret/bin/claude (\"~/x\") \u{1b}[31m빨강\n둘째 줄",
    );
    assert!(!shown.contains("/Users"), "{shown}");
    assert!(!shown.contains("~/x"), "{shown}");
    assert!(!shown.chars().any(char::is_control), "{shown}");
    assert!(shown.contains("<경로>"), "{shown}");
    let long = "가".repeat(INTERACTIVE_ERROR_MAX_CHARS + 50);
    assert_eq!(
        public_error_text(&long).chars().count(),
        INTERACTIVE_ERROR_MAX_CHARS + 1
    );
    assert_eq!(public_error_text(" \n\t"), "인터랙티브 열기가 실패했다");
}
