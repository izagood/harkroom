use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};

use super::*;
use crate::relay_session::{OpenSessionInput, PtyInput, RelaySessions};

fn ledger() -> (Arc<RelaySessions>, Arc<Mutex<Vec<Value>>>) {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let l = RelaySessions::new(None, Box::new(|_| {}));
    let s = sent.clone();
    l.set_sink(Arc::new(move |f: &Value| s.lock().unwrap().push(f.clone())));
    (l, sent)
}

fn input() -> OpenSessionInput {
    OpenSessionInput {
        agent_account_id: "agent".into(),
        channel_id: "c".into(),
        thread_root_id: Some("t".into()),
        harness: "claude-code".into(),
        accepts_input: true,
        ..Default::default()
    }
}

#[derive(Default)]
struct FakePty(Mutex<Vec<u8>>);
impl PtyInput for FakePty {
    fn write(&self, chunk: &[u8]) {
        self.0.lock().unwrap().extend_from_slice(chunk);
    }
    fn resize(&self, _c: u16, _r: u16) {}
}

fn type_input(l: &Arc<RelaySessions>, sid: &str, text: &[u8]) {
    l.on_frame(json!({"type": "input", "sessionId": sid, "data": B64.encode(text)}));
}

/// security: 시도 도중 패닉해도 가드가 떨어지며 그 시도의 PTY 입력 통로를 놓는다 — 그 뒤(다음 시도 전) 온 입력은 앞
/// 시도 PTY 로 가지 않는다. 세션은 멘션 것이라 그대로 열려 있다.
#[test]
fn panic_during_attempt_still_unbinds_input() {
    let (l, _sent) = ledger();
    let h = l.open_session(input());
    let sid = h.session_id().to_string();
    let pty = Arc::new(FakePty::default());
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let a = RelayAttempt::begin(&h, Some(Some(1)), None);
        a.session().bind_input(pty.clone());
        type_input(&l, &sid, b"during");
        panic!("띄우기 도중 패닉");
    }));
    assert!(r.is_err());
    type_input(&l, &sid, b"after");
    assert_eq!(
        *pty.0.lock().unwrap(),
        b"during",
        "패닉 뒤 입력은 앞 PTY 로 안 간다"
    );
    assert_eq!(l.len(), 1, "세션은 멘션 것이라 열려 있다");
}

/// 정상 끝에서도 놓는다 · 시작에 계정 칩(순번만)을 고쳐 알린다 · 다음 시도는 자기 통로만 받는다.
#[test]
fn attempt_guard_restates_and_unbinds_each_attempt() {
    let (l, sent) = ledger();
    let h = l.open_session(input());
    let sid = h.session_id().to_string();
    let (p1, p2) = (Arc::new(FakePty::default()), Arc::new(FakePty::default()));
    {
        let a = RelayAttempt::begin(&h, Some(Some(1)), Some(1));
        a.session().bind_input(p1.clone());
        type_input(&l, &sid, b"one");
    }
    type_input(&l, &sid, b"between");
    {
        let a = RelayAttempt::begin(&h, Some(Some(2)), Some(1));
        a.session().bind_input(p2.clone());
        type_input(&l, &sid, b"two");
    }
    assert_eq!(*p1.0.lock().unwrap(), b"one");
    assert_eq!(*p2.0.lock().unwrap(), b"two");
    let ranks: Vec<Value> = sent
        .lock()
        .unwrap()
        .iter()
        .filter(|f| f["type"] == "session.started")
        .map(|f| f["session"]["claudeAccountRank"].clone())
        .collect();
    assert_eq!(
        ranks,
        [Value::Null, json!(1), json!(2)],
        "열기 + 시도마다 칩"
    );
}

#[derive(Default)]
struct Rec {
    out: Vec<u8>,
    injected: u32,
}
impl PromptHooks for Rec {}
impl PtyTurnSink for Rec {
    fn on_output(&mut self, frame: &[u8]) {
        self.out.extend_from_slice(frame);
    }
    fn on_injected(&mut self) {
        self.injected += 1;
    }
}

/// 출력은 세션(`output` 프레임)과 안쪽 sink 둘 다로 간다 · 다른 갈래는 안쪽으로 그대로.
#[test]
fn relay_sink_pushes_output_and_forwards() {
    let (l, sent) = ledger();
    let h = l.open_session(input());
    let a = RelayAttempt::begin(&h, None, None);
    let mut inner = Rec::default();
    {
        let mut s = RelaySink {
            inner: &mut inner,
            relay: &a,
        };
        s.on_output(b"hello");
        s.on_injected();
    }
    assert_eq!(inner.out, b"hello");
    assert_eq!(inner.injected, 1);
    let out: Vec<Value> = sent
        .lock()
        .unwrap()
        .iter()
        .filter(|f| f["type"] == "output")
        .cloned()
        .collect();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["data"], B64.encode(b"hello"));
}

/// security ②: `RelaySink` 와 `DeliveredSink` 를 겹쳐도 주입 신호가 둘 다 지난다 — `delivered` 가 서고 맨 안쪽 sink 도 받는다.
#[test]
fn relay_sink_over_delivered_sink_passes_injected_through() {
    let (l, sent) = ledger();
    let h = l.open_session(input());
    let a = RelayAttempt::begin(&h, None, None);
    let mut inner = Rec::default();
    let mut delivered = false;
    {
        let mut d = crate::turn_assemble::DeliveredSink {
            inner: &mut inner,
            delivered: &mut delivered,
        };
        let mut s = RelaySink {
            inner: &mut d,
            relay: &a,
        };
        s.on_output(b"x");
        assert!(!*s.inner.delivered);
        s.on_injected();
    }
    assert!(delivered, "DeliveredSink 를 지났다");
    assert_eq!(inner.injected, 1, "맨 안쪽까지 갔다");
    assert_eq!(inner.out, b"x");
    // security ③: 세션으로 나가는 것은 이 세션의 `output` 프레임뿐이다(새 수신자·다른 갈래 없음).
    let kinds: Vec<String> = sent
        .lock()
        .unwrap()
        .iter()
        .map(|f| f["type"].as_str().unwrap_or("").to_string())
        .collect();
    // 열기 + 시도 시작의 칩 다시 알림 + 출력.
    assert_eq!(kinds, ["session.started", "session.started", "output"]);
}
