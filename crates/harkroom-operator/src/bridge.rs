//! s21b-2 배선 — 러너 링크·릴레이 다중화기·서버 전달을 한 커뮤니티의 서버 링크에 잇는다(TS `community.ts` 의
//! `onRunnerFrame`·`forward`). `serve::spawn_server_link` 가 만든다.
//!
//! 순환: 다중화기는 러너 링크로 보내야 하고 러너 링크의 핸들러는 다중화기로 넘겨야 한다. 다중화기 쪽 바깥은
//! 러너 링크를 `OnceLock<Weak<_>>` 로 늦게 받는다 — 강한 참조 고리를 만들지 않는다.
use crate::forward::{ForwardTarget, Transport, forward, strip_link_only_fields};
use crate::relay_mux::{RelayMux, RelayMuxDeps};
use crate::runner_link::{RunnerLinkHandler, RunnerLinkServer};
use crate::server_link::ServerLink;
use crate::turn_command::CommandStep;
use crate::turn_keys::TurnKeyLedger;
use crate::turn_leases::{LeaseCall, TurnLeases};
use crate::turn_peek::TurnPeek;
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
    /// 턴 임대 장부(s21b-3b) — relay 의 `secret.lease*` 통지로 채운다. 이 커뮤니티의 러너만 쓴다.
    leases: Arc<Mutex<TurnLeases>>,
    /// 턴 도중 새 글(s21b-3b) — hook 소켓의 `thread.peek`.
    peek: Arc<TurnPeek>,
}

/// 임대 끝내기·늘리기를 별도 스레드에서 보낼 때 들고 가는 것.
#[derive(Clone)]
struct LeaseIo {
    transport: Arc<dyn Transport>,
    base_url: String,
    token: String,
    leases: Arc<Mutex<TurnLeases>>,
}

impl LinkHandler {
    fn clone_for_io(&self) -> LeaseIo {
        LeaseIo {
            transport: Arc::clone(&self.transport),
            base_url: self.base_url.clone(),
            token: self.token.clone(),
            leases: Arc::clone(&self.leases),
        }
    }
}

impl LeaseIo {
    /// 장부가 돌려준 끝내기·늘리기를 이 커뮤니티 서버로 보낸다(오퍼레이터 자체 전달 — 러너 REST 허용 목록을 거치지 않는다).
    /// 늘리기면 새 만료 시각을 장부에 반영한다. 실패해도 임대는 서버에서 스스로 만료된다.
    fn run_lease_call(&self, runner_id: &str, cause: &str, c: &LeaseCall, renew: bool) {
        let url = format!("{}{}", self.base_url.trim_end_matches('/'), c.path);
        let headers = vec![
            (
                "authorization".to_string(),
                format!("Bearer {}", self.token),
            ),
            (crate::forward::AGENT_HEADER.to_string(), c.agent_id.clone()),
            ("content-type".to_string(), "application/json".to_string()),
        ];
        let res = self
            .transport
            .send("POST", &url, &headers, Some(c.body.clone().into_bytes()));
        let Ok(r) = res else { return };
        if !renew {
            if r.status != 204 && r.status != 404 {
                eprintln!("turn-leases: 임대 {} 끝내기 응답 {}", c.lease_id, r.status);
            }
            return;
        }
        // 404 = 옛 서버거나 끝났거나 만료 — 늘리지 않는다. 서버가 판정의 정본이다.
        if r.status != 200 {
            if r.status != 404 {
                eprintln!("turn-leases: 임대 {} 늘리기 응답 {}", c.lease_id, r.status);
            }
            return;
        }
        let at = serde_json::from_str::<Value>(&r.body).ok().and_then(|v| {
            v.get("expiresAt")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        if let Some(at) = at {
            lock(&self.leases).renewed(runner_id, cause, &c.lease_id, &at);
        }
    }
}

impl LinkHandler {
    /// 에이전트 자격으로 이 커뮤니티 서버에 GET(오퍼레이터 자체 요청 — 러너 REST 허용 목록을 거치지 않는다).
    fn server_get(&self, agent_id: &str, path: &str) -> Result<Value, String> {
        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        let headers = vec![
            (
                "authorization".to_string(),
                format!("Bearer {}", self.token),
            ),
            (
                crate::forward::AGENT_HEADER.to_string(),
                agent_id.to_string(),
            ),
        ];
        let bare = path.split('?').next().unwrap_or_default();
        let r = self.transport.send("GET", &url, &headers, None)?;
        if r.status != 200 {
            return Err(format!("GET {bare} → {}", r.status));
        }
        serde_json::from_str(&r.body).map_err(|e| format!("GET {bare} → {e}"))
    }
}

impl LinkHandler {
    /// 에이전트 자격으로 이 커뮤니티 서버에 JSON POST(오퍼레이터 자체 요청 — `command.check` 의 match).
    fn server_post(
        &self,
        agent_id: &str,
        path: &str,
        body: String,
    ) -> Result<(u16, String), String> {
        self.server_post_bytes(agent_id, path, "application/json", body.into_bytes())
    }

    /// 에이전트 자격으로 이 커뮤니티 서버에 POST(오퍼레이터 자체 요청 — 러너 REST 허용 목록을 거치지 않는다).
    fn server_post_bytes(
        &self,
        agent_id: &str,
        path: &str,
        content_type: &str,
        body: Vec<u8>,
    ) -> Result<(u16, String), String> {
        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        let headers = vec![
            (
                "authorization".to_string(),
                format!("Bearer {}", self.token),
            ),
            (
                crate::forward::AGENT_HEADER.to_string(),
                agent_id.to_string(),
            ),
            ("content-type".to_string(), content_type.to_string()),
        ];
        let r = self.transport.send("POST", &url, &headers, Some(body))?;
        Ok((r.status, r.body))
    }

    /// 서버로 넘긴다. agent_id 는 `expect` 가 적어 둔 값이다(러너의 주장이 아님). `req` 는 이미 링크 전용 칸을 지운 것이다.
    fn forward_to_server(
        &self,
        agent_id: &str,
        req: RunnerLinkRequest,
        kind: RunnerLinkKind,
    ) -> RunnerLinkResponse {
        let target = ForwardTarget {
            base_url: self.base_url.clone(),
            token: self.token.clone(),
            agent_id: agent_id.to_string(),
        };
        forward(self.transport.as_ref(), &target, req, kind)
    }
}

impl RunnerLinkHandler for LinkHandler {
    /// relay 통지 — 턴 임대(TS run.ts 의 `secret.lease*`). 서버 요청은 별도 스레드에서 보내 링크 읽기를 막지 않는다.
    fn on_notice(&self, runner_id: &str, agent_id: &str, notice: Value) {
        let s = |k: &str| notice.get(k).and_then(Value::as_str).unwrap_or("");
        let cause = s("cause").to_string();
        let (c, renew) = match s("type") {
            "secret.lease" => {
                lock(&self.leases).note(
                    runner_id,
                    agent_id,
                    &cause,
                    s("leaseId"),
                    s("token"),
                    s("expiresAt"),
                );
                return;
            }
            "secret.leaseEnded" => (lock(&self.leases).ended(runner_id, &cause), false),
            "secret.leaseHeartbeat" => (lock(&self.leases).heartbeat(runner_id, &cause), true),
            _ => return,
        };
        let Some(c) = c else { return };
        let me = self.clone_for_io();
        let runner_id = runner_id.to_string();
        let _ = std::thread::Builder::new()
            .name("turn-lease-call".into())
            .spawn(move || me.run_lease_call(&runner_id, &cause, &c, renew));
    }

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
        // 링크에서 온 「오퍼레이터만 채우는 칸」(commandFiles)은 어떤 처리보다 먼저 지운다(TS run.ts `stripLinkOnlyFields`, security 사전 2).
        let req = strip_link_only_fields(req);
        // 가로채기 — TS run.ts 의 순서(turnKeys → turnPeek → turnCommand → turnSlots). 서버로 나가지 않는다.
        if let Some(r) = lock(&self.turn_keys).maybe_handle(runner_id, &req, kind) {
            return Some(r);
        }
        // `thread.peek` 은 hook 소켓 가드보다 먼저(TS run.ts 순서: turnKeys → turnPeek → turnCommand).
        let cause = match &req {
            RunnerLinkRequest::McpRequest { cause, .. } => cause.clone(),
            _ => None,
        };
        let lease = lock(&self.leases).lookup_for(runner_id, agent_id, cause.as_deref());
        let get = |a: &str, p: &str| self.server_get(a, p);
        if let Some(r) = self.peek.maybe_handle(
            runner_id,
            agent_id,
            &req,
            kind,
            lease.as_ref(),
            &get,
            &|l| eprintln!("{l}"),
        ) {
            return Some(r);
        }
        // 「정확한 명령」(TS turnCommand) — hook 소켓 가드·`command.check`·`permission.request`(kind=command) 파일 재기.
        let post =
            |a: &str, body: String| self.server_post(a, crate::turn_command::MATCH_PATH, body);
        let req = match crate::turn_command::maybe_handle(
            req,
            kind,
            agent_id,
            lease.as_ref(),
            &post,
            &|l| eprintln!("{l}"),
        ) {
            CommandStep::Reply(r) => return Some(r),
            CommandStep::Forward(r) => return Some(self.forward_to_server(agent_id, r, kind)),
            CommandStep::Pass(r) => r,
        };
        if let Some(r) = lock(&self.slots).maybe_handle(runner_id, &req, kind) {
            return Some(r);
        }
        // `attachment.upload`(TS turnUploads — run.ts 가로채기의 맨 끝). 경로 판정·읽기·`/uploads` 올리기는 오퍼레이터가 한다.
        let upload = |p: &str, ct: &str, b: Vec<u8>| self.server_post_bytes(agent_id, p, ct, b);
        if let Some(r) = crate::turn_uploads::maybe_handle(
            agent_id,
            &req,
            crate::turn_uploads::UPLOAD_MAX_BYTES,
            &upload,
            &|| crate::runners::new_incarnation_id().unwrap_or_else(|_| "0".into()),
            &|l| eprintln!("{l}"),
        ) {
            return Some(r);
        }
        Some(self.forward_to_server(agent_id, req, kind))
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
        leases: Arc::new(Mutex::new(TurnLeases::system())),
        peek: Arc::new(TurnPeek::system()),
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
            leases: Arc::new(Mutex::new(TurnLeases::new(|| 0))),
            peek: Arc::new(TurnPeek::new(|| 0)),
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
    fn hook_link_answers_only_peek_and_command_check_never_forwards() {
        let (_srv, tr, b) = bridge();
        let h = LinkHandler {
            mux: Arc::clone(&b.mux),
            transport: tr.clone(),
            base_url: "https://h.example".into(),
            token: "op-token".into(),
            turn_keys: Arc::new(Mutex::new(TurnKeyLedger::new(|| 0, |_| {}))),
            slots: Arc::new(Mutex::new(TurnSlots::new(None, || 0, |_| {}))),
            leases: Arc::new(Mutex::new(TurnLeases::new(|| 0))),
            peek: Arc::new(TurnPeek::new(|| 0)),
        };
        let call = |name: &str| -> RunnerLinkRequest {
            serde_json::from_value(json!({"type":"mcp.request","id":"q","cause":"c1",
                "payload":{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":{}}}}))
            .unwrap()
        };
        let v = |r: Option<RunnerLinkResponse>| serde_json::to_value(r.unwrap()).unwrap();
        // 임대가 없으니 peek 은 서버에 묻지 않고 빈 목록.
        let r = v(h.on_request("r1", "a1", call("thread.peek"), RunnerLinkKind::Hook));
        assert_eq!(
            r["messages"][0]["result"]["content"][0]["text"],
            r#"{"posts":[]}"#
        );
        let r = v(h.on_request("r1", "a1", call("command.check"), RunnerLinkKind::Hook));
        assert_eq!(
            r["messages"][0]["result"]["content"][0]["text"],
            r#"{"allow":false}"#
        );
        let r = v(h.on_request("r1", "a1", call("message.post"), RunnerLinkKind::Hook));
        assert_eq!(r["type"], "mcp.error");
        assert_eq!(r["status"], 403);
        let rest: RunnerLinkRequest = serde_json::from_value(
            json!({"type":"http.forward","id":"h","method":"GET","path":"/accounts"}),
        )
        .unwrap();
        let r = v(h.on_request("r1", "a1", rest, RunnerLinkKind::Hook));
        assert_eq!(r["status"], 403);
        // 브릿지에서 부른 thread.peek 은 hook_only.
        let r = v(h.on_request("r1", "a1", call("thread.peek"), RunnerLinkKind::Bridge));
        assert!(
            r["messages"][0]["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("hook_only")
        );
        assert!(
            tr.0.lock().unwrap().is_empty(),
            "hook 소켓 요청은 서버로 안 나간다"
        );
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
            leases: Arc::new(Mutex::new(TurnLeases::new(|| 0))),
            peek: Arc::new(TurnPeek::new(|| 0)),
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
    fn forged_command_files_are_stripped_and_command_check_goes_to_match_with_lease() {
        let (_srv, tr, b) = bridge();
        let h = LinkHandler {
            mux: Arc::clone(&b.mux),
            transport: tr.clone(),
            base_url: "https://h.example".into(),
            token: "op-token".into(),
            turn_keys: Arc::new(Mutex::new(TurnKeyLedger::new(|| 0, |_| {}))),
            slots: Arc::new(Mutex::new(TurnSlots::new(None, || 0, |_| {}))),
            leases: Arc::new(Mutex::new(TurnLeases::new(|| 0))),
            peek: Arc::new(TurnPeek::new(|| 0)),
        };
        // 링크가 미리 채운 commandFiles 는 서버 머리에 실리지 않는다(사전 2).
        let req: RunnerLinkRequest = serde_json::from_value(json!({
            "type":"mcp.request","id":"q1","cause":"c1","commandFiles":"Zm9yZ2Vk",
            "payload":{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"message.post","arguments":{}}}
        }))
        .unwrap();
        h.on_request("r1", "a1", req, RunnerLinkKind::Bridge)
            .unwrap();
        {
            let calls = tr.0.lock().unwrap();
            assert!(calls[0].1.ends_with("/mcp"));
            assert!(
                !calls[0]
                    .2
                    .iter()
                    .any(|(n, _)| n == crate::forward::COMMAND_FILES_HEADER)
            );
        }
        // 임대가 있으면 hook 의 command.check 가 match 로 간다(오퍼레이터 자체 요청, 그 에이전트 자격).
        let dir = std::env::temp_dir().join(format!("brcc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let k = std::fs::canonicalize(&dir).unwrap().join("k");
        std::fs::write(&k, "x").unwrap();
        lock(&h.leases).note("r1", "a1", "c1", "L1", "T1", "2099-01-01T00:00:00.000Z");
        let cmd = format!("kubectl --kubeconfig {} --context rc get pods", k.display());
        let req: RunnerLinkRequest = serde_json::from_value(json!({
            "type":"mcp.request","id":"q2","cause":"c1",
            "payload":{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"command.check","arguments":{"command":cmd}}}
        }))
        .unwrap();
        h.on_request("r1", "a1", req, RunnerLinkKind::Hook).unwrap();
        let calls = tr.0.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].0, "POST");
        assert_eq!(calls[1].1, "https://h.example/agent/command-grants/match");
        assert!(calls[1].2.iter().any(|(_, v)| v == "a1"));
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
            leases: Arc::new(Mutex::new(TurnLeases::new(|| 0))),
            peek: Arc::new(TurnPeek::new(|| 0)),
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

    #[test]
    fn lease_notices_fill_ledger_and_end_renew_go_to_server() {
        let tr = Arc::new(FakeTransport::default());
        let (_srv, _tr0, b) = bridge();
        let h = LinkHandler {
            mux: Arc::clone(&b.mux),
            transport: tr.clone(),
            base_url: "https://h.example/".into(),
            token: "op".into(),
            turn_keys: Arc::new(Mutex::new(TurnKeyLedger::new(|| 0, |_| {}))),
            slots: Arc::new(Mutex::new(TurnSlots::new(None, || 0, |_| {}))),
            leases: Arc::new(Mutex::new(TurnLeases::new(|| 0))),
            peek: Arc::new(TurnPeek::new(|| 0)),
        };
        h.on_notice(
            "r1",
            "a1",
            json!({"type":"secret.lease","cause":"c1","leaseId":"L1","token":"tk","expiresAt":"2026-11-11T02:00:00.000Z"}),
        );
        let l = lock(&h.leases)
            .lookup_for("r1", "a1", Some("c1"))
            .expect("임대");
        assert_eq!(l.lease_id, "L1");
        // 늘리기 — 가짜 서버는 expiresAt 이 없는 200 을 준다 → 만료는 그대로.
        let hb = lock(&h.leases).heartbeat("r1", "c1").unwrap();
        h.clone_for_io().run_lease_call("r1", "c1", &hb, true);
        let end = lock(&h.leases).ended("r1", "c1").unwrap();
        h.clone_for_io().run_lease_call("r1", "c1", &end, false);
        let calls = tr.0.lock().unwrap();
        assert_eq!(calls[0].1, "https://h.example/agent/turn-leases/L1/renew");
        assert_eq!(calls[1].1, "https://h.example/agent/turn-leases/L1/end");
        assert!(
            calls[1]
                .2
                .iter()
                .any(|(k, v)| k == "x-harkroom-agent" && v == "a1")
        );
        assert!(lock(&h.leases).is_empty());
        // 모르는 통지·빈 cause 는 장부를 건드리지 않는다.
        h.on_notice(
            "r1",
            "a1",
            json!({"type":"secret.leaseEnded","cause":"nope"}),
        );
        assert_eq!(calls.len(), 2);
    }
}
