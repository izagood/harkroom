//! s21b-2 배선 — 러너 링크·릴레이 다중화기·서버 전달을 한 커뮤니티의 서버 링크에 잇는다(TS `community.ts` 의
//! `onRunnerFrame`·`forward`). `serve::spawn_server_link` 가 만든다.
//!
//! 순환: 다중화기는 러너 링크로 보내야 하고 러너 링크의 핸들러는 다중화기로 넘겨야 한다. 다중화기 쪽 바깥은
//! 러너 링크를 `OnceLock<Weak<_>>` 로 늦게 받는다 — 강한 참조 고리를 만들지 않는다.
use crate::forward::{ForwardTarget, Transport, forward, strip_link_only_fields};
use crate::relay_mux::{RelayMux, RelayMuxDeps};
use crate::runner_link::{RunnerLinkHandler, RunnerLinkServer};
use crate::server_link::ServerLink;
use crate::turn_keys::TurnKeyLedger;
use crate::turn_slots::TurnSlots;
use harkroom_proto::p1::{RunnerLinkKind, RunnerLinkRequest, RunnerLinkResponse};
use harkroom_proto::p2::OperatorToServerFrame;
use serde_json::Value;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// 서버 채널로 보내는 쪽 — 시험은 가짜를 준다.
pub trait ServerSend: Send + Sync {
    fn send(&self, frame: &OperatorToServerFrame) -> bool;
}

impl ServerSend for ServerLink {
    fn send(&self, frame: &OperatorToServerFrame) -> bool {
        ServerLink::send(self, frame)
    }
}

/// 다중화기의 바깥: 러너 링크(늦게 받음)와 서버 링크.
pub struct MuxDeps {
    runner_link: Arc<OnceLock<Weak<RunnerLinkServer>>>,
    server: Arc<dyn ServerSend>,
}

impl MuxDeps {
    fn link(&self) -> Option<Arc<RunnerLinkServer>> {
        self.runner_link.get().and_then(Weak::upgrade)
    }
}

impl RelayMuxDeps for MuxDeps {
    fn send_to_runner(&self, runner_id: &str, frame: &Value) -> bool {
        self.link().is_some_and(|l| l.send(runner_id, frame))
    }
    fn is_linked(&self, runner_id: &str) -> bool {
        self.link().is_some_and(|l| l.is_linked(runner_id))
    }
    fn send_to_server(&self, frame: &OperatorToServerFrame) -> bool {
        self.server.send(frame)
    }
    fn log(&self, line: &str) {
        eprintln!("{line}");
    }
}

/// 러너 링크의 콜백 — 프레임은 다중화기로, 요청은 서버로.
pub struct LinkHandler {
    mux: Arc<RelayMux>,
    transport: Arc<dyn Transport>,
    base_url: String,
    token: String,
    /// 턴 열쇠 장부(s21b-3a) — 맡기기·끝내기는 여기서 답하고 서버로 넘기지 않는다.
    turn_keys: Arc<Mutex<TurnKeyLedger>>,
    /// 동시 턴 상한(s21b-3a) — 프로세스 하나에 하나(`TurnSlots::process`).
    slots: Arc<Mutex<TurnSlots>>,
}

impl RunnerLinkHandler for LinkHandler {
    fn on_frame(&self, runner_id: &str, _agent_id: &str, frame: Value) {
        // 감사 바이트(`local.input`)는 오퍼레이터 허브만 올린다 — 러너의 주장은 버린다(TS community.ts).
        if frame.get("type").and_then(Value::as_str) == Some("local.input") {
            eprintln!(
                "러너가 올린 local.input 을 버린다: runner={runner_id} — 감사 바이트는 오퍼레이터 허브만 올린다"
            );
            return;
        }
        self.mux.on_runner_frame(runner_id, frame);
    }

    fn on_request(
        &self,
        runner_id: &str,
        agent_id: &str,
        req: RunnerLinkRequest,
        kind: RunnerLinkKind,
    ) -> Option<RunnerLinkResponse> {
        // 가로채기 — TS run.ts 의 순서(turnKeys → … → turnSlots). 서버로 나가지 않는다.
        if let Some(r) = lock(&self.turn_keys).maybe_handle(runner_id, &req, kind) {
            return Some(r);
        }
        if let Some(r) = lock(&self.slots).maybe_handle(runner_id, &req, kind) {
            return Some(r);
        }
        // agent_id 는 `expect` 가 적어 둔 값이다(러너의 주장이 아님) — 서버에 그 에이전트로 넘긴다.
        let target = ForwardTarget {
            base_url: self.base_url.clone(),
            token: self.token.clone(),
            agent_id: agent_id.to_string(),
        };
        Some(forward(
            self.transport.as_ref(),
            &target,
            strip_link_only_fields(req),
            kind,
        ))
    }

    fn on_close(&self, runner_id: &str) {
        eprintln!("러너 링크가 끊겼다: runner={runner_id}");
        lock(&self.slots).release_runner(runner_id);
    }

    /// relay 가 다시 붙었다 — 끊긴 사이 사라진 놓기 요청 때문에 상한이 조용히 줄지 않게 돌려받는다(security #1127 L1).
    fn on_relay_attach(&self, runner_id: &str) {
        lock(&self.slots).release_runner(runner_id);
    }

    fn log(&self, line: &str) {
        eprintln!("{line}");
    }
}

/// 배선 한 벌. `runner_link` 는 소켓 서버(`ServerState::set_runner_link`)에, `mux` 는 서버 링크 콜백에 건다.
pub struct Bridge {
    pub mux: Arc<RelayMux>,
    pub runner_link: Arc<RunnerLinkServer>,
}

pub fn build_bridge(
    server: Arc<dyn ServerSend>,
    transport: Arc<dyn Transport>,
    base_url: String,
    token: String,
    turn_keys: Arc<Mutex<TurnKeyLedger>>,
    slots: Arc<Mutex<TurnSlots>>,
) -> Bridge {
    let slot: Arc<OnceLock<Weak<RunnerLinkServer>>> = Arc::new(OnceLock::new());
    let mux = Arc::new(RelayMux::new(Box::new(MuxDeps {
        runner_link: Arc::clone(&slot),
        server,
    })));
    let handler = Arc::new(LinkHandler {
        mux: Arc::clone(&mux),
        transport,
        base_url,
        token,
        turn_keys: Arc::clone(&turn_keys),
        slots,
    });
    // 턴 열쇠 장부(s21b-3a) — 하네스의 bridge·hook·wrapper 소켓이 맡긴 열쇠로 붙는다.
    let runner_link = RunnerLinkServer::new(handler, Some(turn_keys));
    let _ = slot.set(Arc::downgrade(&runner_link));
    Bridge { mux, runner_link }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forward::HttpReply;
    use serde_json::json;

    #[derive(Default)]
    struct FakeServer(Mutex<Vec<Value>>);
    impl ServerSend for FakeServer {
        fn send(&self, frame: &OperatorToServerFrame) -> bool {
            self.0
                .lock()
                .unwrap()
                .push(serde_json::to_value(frame).unwrap());
            true
        }
    }

    type Call = (String, String, Vec<(String, String)>);
    #[derive(Default)]
    struct FakeTransport(Mutex<Vec<Call>>);
    impl Transport for FakeTransport {
        fn send(
            &self,
            method: &str,
            url: &str,
            headers: &[(String, String)],
            _body: Option<Vec<u8>>,
        ) -> Result<HttpReply, String> {
            self.0
                .lock()
                .unwrap()
                .push((method.into(), url.into(), headers.to_vec()));
            Ok(HttpReply {
                status: 200,
                content_type: "application/json".into(),
                body: r#"{"jsonrpc":"2.0","id":1,"result":{}}"#.into(),
            })
        }
    }

    fn bridge() -> (Arc<FakeServer>, Arc<FakeTransport>, Bridge) {
        let srv = Arc::new(FakeServer::default());
        let tr = Arc::new(FakeTransport::default());
        let b = build_bridge(
            srv.clone(),
            tr.clone(),
            "https://h.example".into(),
            "op-token".into(),
            Arc::new(Mutex::new(TurnKeyLedger::new(|| 0, |_| {}))),
            Arc::new(Mutex::new(TurnSlots::new(Some(1), || 0, |_| {}))),
        );
        (srv, tr, b)
    }

    #[test]
    fn runner_local_input_is_dropped_and_other_frames_reach_server() {
        let (srv, _tr, b) = bridge();
        let h = LinkHandler {
            mux: Arc::clone(&b.mux),
            transport: Arc::new(FakeTransport::default()),
            base_url: String::new(),
            token: String::new(),
            turn_keys: Arc::new(Mutex::new(TurnKeyLedger::new(|| 0, |_| {}))),
            slots: Arc::new(Mutex::new(TurnSlots::new(Some(1), || 0, |_| {}))),
        };
        h.on_frame(
            "r1",
            "a1",
            json!({"type":"local.input","sessionId":"s","gen":1,"bytes":2}),
        );
        assert!(
            srv.0.lock().unwrap().is_empty(),
            "러너의 local.input 은 서버로 안 간다"
        );
        h.on_frame("r1", "a1", json!({"type":"session.ended","sessionId":"s"}));
        let sent = srv.0.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["runnerId"], "r1");
    }

    #[test]
    fn request_forwards_as_expected_agent_with_operator_token() {
        let (_srv, tr, b) = bridge();
        let h = LinkHandler {
            mux: Arc::clone(&b.mux),
            transport: tr.clone(),
            base_url: "https://h.example".into(),
            token: "op-token".into(),
            turn_keys: Arc::new(Mutex::new(TurnKeyLedger::new(|| 0, |_| {}))),
            slots: Arc::new(Mutex::new(TurnSlots::new(None, || 0, |_| {}))),
        };
        let req: RunnerLinkRequest = serde_json::from_value(json!({
            "type":"mcp.request","id":"q1","payload":{"jsonrpc":"2.0","id":1,"method":"x"}
        }))
        .unwrap();
        let res = h
            .on_request("r1", "agent-x", req, RunnerLinkKind::Relay)
            .expect("배선돼 있으면 답이 있다");
        let v = serde_json::to_value(&res).unwrap();
        assert_eq!(v["id"], "q1");
        let calls = tr.0.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].1.starts_with("https://h.example/"));
        let hdr = |k: &str| {
            calls[0]
                .2
                .iter()
                .find(|(n, _)| n.eq_ignore_ascii_case(k))
                .map(|(_, v)| v.clone())
        };
        assert_eq!(hdr("authorization").as_deref(), Some("Bearer op-token"));
        assert!(
            calls[0].2.iter().any(|(_, v)| v == "agent-x"),
            "에이전트 id 는 expect 가 적은 값으로 실린다: {:?}",
            calls[0].2
        );
    }

    #[test]
    fn mux_sees_runner_link_without_strong_cycle() {
        let (_srv, _tr, b) = bridge();
        let input = harkroom_proto::p2::ServerToOperatorFrame::PtyInput {
            runner_id: "r9".into(),
            session_id: "s".into(),
            bytes: "eA==".into(),
        };
        assert!(!b.mux.on_server_frame(&input), "붙지 않은 러너로는 안 간다");
        let weak = Arc::downgrade(&b.runner_link);
        drop(b);
        assert!(weak.upgrade().is_none(), "러너 링크가 고리로 새지 않는다");
    }

    fn fwd(path: &str, body: Value) -> RunnerLinkRequest {
        RunnerLinkRequest::HttpForward {
            id: "q".into(),
            method: "POST".into(),
            path: path.into(),
            body: Some(body.to_string()),
            body_base64: None,
            content_type: Some("application/json".into()),
        }
    }

    fn status_of(r: Option<RunnerLinkResponse>) -> u16 {
        match r.expect("answered") {
            RunnerLinkResponse::HttpResponse { status, .. } => status,
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn turn_keys_and_slots_are_answered_locally_not_forwarded() {
        let tr = Arc::new(FakeTransport::default());
        let (_srv, _tr0, b) = bridge();
        let h = LinkHandler {
            mux: Arc::clone(&b.mux),
            transport: tr.clone(),
            base_url: "https://h.example".into(),
            token: "t".into(),
            turn_keys: Arc::new(Mutex::new(TurnKeyLedger::new(|| 0, |_| {}))),
            slots: Arc::new(Mutex::new(TurnSlots::new(Some(1), || 0, |_| {}))),
        };
        let keys = json!({"turnId":"t1","keys":{"bridge":"a".repeat(64),"shell":"b".repeat(64)}});
        assert_eq!(
            status_of(h.on_request(
                "r1",
                "a1",
                fwd("/agent/turn-keys", keys),
                RunnerLinkKind::Relay
            )),
            200
        );
        assert_eq!(
            status_of(h.on_request(
                "r1",
                "a1",
                fwd("/agent/turn-slots", json!({"key":"k1"})),
                RunnerLinkKind::Relay
            )),
            200
        );
        assert_eq!(
            status_of(h.on_request(
                "r2",
                "a2",
                fwd("/agent/turn-slots", json!({"key":"k1"})),
                RunnerLinkKind::Relay
            )),
            409
        );
        // 하네스 소켓은 자리를 못 잡는다.
        assert_eq!(
            status_of(h.on_request(
                "r1",
                "a1",
                fwd("/agent/turn-slots", json!({"key":"k2"})),
                RunnerLinkKind::Bridge
            )),
            403
        );
        assert!(
            tr.0.lock().unwrap().is_empty(),
            "nothing reached the server"
        );
        // relay 가 다시 붙으면 그 러너의 자리를 돌려받는다.
        h.on_relay_attach("r1");
        assert_eq!(
            status_of(h.on_request(
                "r2",
                "a2",
                fwd("/agent/turn-slots", json!({"key":"k1"})),
                RunnerLinkKind::Relay
            )),
            200
        );
        // 끊기면 돌려받는다.
        h.on_close("r2");
        assert_eq!(lock(&h.slots).in_use(), 0);
        // 나머지는 그대로 서버로 넘긴다.
        h.on_request(
            "r1",
            "a1",
            fwd("/agent/activity", json!({})),
            RunnerLinkKind::Relay,
        );
        assert_eq!(tr.0.lock().unwrap().len(), 1);
    }
}
