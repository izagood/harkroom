//! 러너 ↔ 오퍼레이터 unix 링크의 오퍼레이터 쪽 — TS `packages/operator/src/runnerLink.ts` 이식(s21b-1).
//!
//! 러너는 spawn 때 받은 `HARKROOM_RUNNER_ID`·`HARKROOM_RUNNER_SECRET` 으로 앱과 **같은 소켓**에 붙어
//! 첫 줄에 `hello{role:'runner'}` 를 보낸다. `socket::serve_connection` 이 첫 줄의 `role` 로 갈라 이리로 넘긴다.
//!
//! - 인증은 장부 하나다: `expect` 가 spawn 직전에 적고(spawn 마다 새 secret), `forget` 이 지운다. 비교는 상수 시간.
//! - 턴 열쇠(`turn_keys`)로도 붙는다 — 그 열쇠를 맡긴 러너·범위(kind)에서만. relay 는 어떤 열쇠로도 못 연다.
//!   열쇠로 붙은 소켓은 `mcp.request` 만 받고, cause·턴 id 는 장부 값으로 덮는다.
//! - 이 모듈은 릴레이 프레임을 **해석하지 않는다** — 얕게 type 만 보고 `on_frame` 으로 넘긴다.
//!
//! TS 와 다른 점: 요청 답(`on_request`)은 Node 의 Promise 대신 요청마다 스레드 하나로 기다린다. 한 소켓에서
//! 동시에 기다리는 요청은 [`MAX_INFLIGHT_PER_SOCKET`] 개까지이고, 넘치면 같은 id 로 곧바로 거절한다(삼키지 않는다).

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use harkroom_proto::p1::{
    PROVIDER_LANE_FAILURE_CODES, RUNNER_LINK_PROTOCOL_VERSION, RunnerLinkKind, RunnerLinkRequest,
    RunnerLinkResponse,
};
use serde_json::{Value, json};

use crate::socket::{Decoded, NdjsonDecoder};
use crate::turn_keys::{TurnKeyLedger, ct_eq};

/// TS `RUNNER_LINK_MAX_LINE_BYTES`.
pub const RUNNER_LINK_MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
/// 같은 러너의 거절을 묶는 창(TS `LINK_REJECT_LOG_WINDOW_MS`).
pub const LINK_REJECT_LOG_WINDOW_MS: u64 = 10 * 60_000;
/// 묶음 표의 키 상한(TS `LINK_REJECT_LOG_MAX_KEYS`) — runnerId 를 지어내 표를 키우지 못한다.
pub const LINK_REJECT_LOG_MAX_KEYS: usize = 256;
/// 한 소켓에서 답을 기다리는 요청 수 상한(Rust 판만). 하네스 MCP 호출은 직렬이라 평소엔 1~2개다.
pub const MAX_INFLIGHT_PER_SOCKET: usize = 32;
/// 인증된 러너 소켓 상한(security C3 후속, 10:56 A안). 러너 하나가 relay·bridge·hook·wrapper 를 열므로
/// 러너 표(`expect` 된 러너) 수×[`RUNNER_SOCKETS_PER_RUNNER`], 그래도 [`MAX_RUNNER_SOCKETS`] 를 넘지 않는다.
/// 인증 전 소켓은 `socket::MAX_CONNECTIONS` 자리를 쓰고, 인증되면 그 자리를 놓고 이 몫으로 옮긴다.
pub const RUNNER_SOCKETS_PER_RUNNER: usize = 4;
pub const MAX_RUNNER_SOCKETS: usize = 512;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 경계 검사 — TS `checkRunnerHello`·`isRunnerLinkNotice`·`isRunnerLinkRequest`
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelloClaim {
    pub runner_id: String,
    pub secret: Option<String>,
    pub turn_key: Option<String>,
    pub kind: RunnerLinkKind,
}

/// `secret` 과 `turnKey` 중 정확히 하나, `kind` 가 없으면 relay.
pub fn check_runner_hello(v: &Value) -> Option<HelloClaim> {
    let m = v.as_object()?;
    if m.get("type")?.as_str()? != "hello" || m.get("role")?.as_str()? != "runner" {
        return None;
    }
    if m.get("version")?.as_f64()? != f64::from(RUNNER_LINK_PROTOCOL_VERSION) {
        return None;
    }
    let runner_id = m.get("runnerId")?.as_str()?.to_string();
    let secret = m.get("secret").and_then(Value::as_str).map(str::to_string);
    let turn_key = m.get("turnKey").and_then(Value::as_str).map(str::to_string);
    if secret.is_none() == turn_key.is_none() {
        return None;
    }
    let kind = match m.get("kind") {
        None => RunnerLinkKind::Relay,
        Some(k) => serde_json::from_value(k.clone()).ok()?,
    };
    Some(HelloClaim {
        runner_id,
        secret,
        turn_key,
        kind,
    })
}

pub fn is_runner_link_request(v: &Value) -> bool {
    matches!(
        v.get("type").and_then(Value::as_str),
        Some("mcp.request" | "http.forward")
    ) && v.get("id").is_some_and(Value::is_string)
}

pub fn is_runner_link_notice(v: &Value) -> bool {
    let Some(m) = v.as_object() else { return false };
    let s = |k: &str| {
        m.get(k)
            .and_then(Value::as_str)
            .is_some_and(|x| !x.is_empty() && x.chars().count() <= 200)
    };
    let ids = |k: &str| {
        m.get(k)
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().all(|x| x.is_i64() || x.is_u64()))
    };
    match m.get("type").and_then(Value::as_str) {
        Some("mcp.authRejected") => {
            m.get("servers").and_then(Value::as_array).is_some_and(|a| {
                !a.is_empty() && a.iter().all(|x| x.as_str().is_some_and(|s| !s.is_empty()))
            }) && m.get("turnStartedAtMs").is_some_and(Value::is_number)
        }
        Some("secret.lease") => s("cause") && s("leaseId") && s("token") && s("expiresAt"),
        Some("secret.leaseEnded" | "secret.leaseHeartbeat") => s("cause"),
        Some("providerLane.mode") => m.get("on").is_some_and(Value::is_boolean),
        Some("providerLane.turn") => m.get("ok").is_some_and(Value::is_boolean),
        Some("providerLane.result") => {
            m.get("ok").is_some_and(Value::is_boolean)
                && match m.get("code") {
                    None => true,
                    Some(c) => c
                        .as_str()
                        .is_some_and(|c| PROVIDER_LANE_FAILURE_CODES.contains(&c)),
                }
        }
        Some("runner.pollStopped") => ids("holding") && (!m.contains_key("done") || ids("done")),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// 거절 로그 묶기 — TS `createRejectLogThrottle`
// ---------------------------------------------------------------------------

/// 첫 거절은 그대로, 그 뒤로는 창이 지난 다음 거절에서 「N번 더」 한 줄만. 거절이 멈추면 남은 수는 쓰지 않는다.
pub struct RejectLogThrottle {
    window_ms: u64,
    max_keys: usize,
    /// 맨 뒤가 가장 최근에 쓰인 키다.
    order: VecDeque<String>,
    seen: HashMap<String, (u64, u64)>,
}

impl RejectLogThrottle {
    pub fn new(window_ms: u64, max_keys: usize) -> Self {
        Self {
            window_ms,
            max_keys,
            order: VecDeque::new(),
            seen: HashMap::new(),
        }
    }

    /// 쓸 줄이 있으면 돌려준다.
    pub fn hit(&mut self, key: &str, first_line: &str, t: u64) -> Option<String> {
        let Some(&(since, count)) = self.seen.get(key) else {
            if self.seen.len() >= self.max_keys
                && let Some(oldest) = self.order.pop_front()
            {
                self.seen.remove(&oldest);
            }
            self.seen.insert(key.to_string(), (t, 0));
            self.order.push_back(key.to_string());
            return Some(first_line.to_string());
        };
        // 쓰일 때마다 맨 뒤로 — 상한에서 버리는 것은 가장 오래 조용한 키다.
        if let Some(i) = self.order.iter().position(|k| k == key) {
            self.order.remove(i);
        }
        self.order.push_back(key.to_string());
        let count = count + 1;
        if t.saturating_sub(since) >= self.window_ms {
            self.seen.insert(key.to_string(), (t, 0));
            let mins = (self.window_ms as f64 / 60_000.0).round() as u64;
            return Some(format!(
                "러너 링크 거절: {key} — 지난 {mins}분 동안 {count}번 더"
            ));
        }
        self.seen.insert(key.to_string(), (since, count));
        None
    }
}

// ---------------------------------------------------------------------------
// 소켓·배선
// ---------------------------------------------------------------------------

/// 받아들인 소켓의 쓰는 쪽. 시험은 가짜를 준다.
pub trait LinkConn: Send + Sync {
    fn write_line(&self, bytes: &[u8]) -> std::io::Result<()>;
    /// 양쪽을 닫는다 — 읽는 스레드도 EOF 로 빠진다.
    fn destroy(&self);
}

impl LinkConn for Mutex<UnixStream> {
    fn write_line(&self, bytes: &[u8]) -> std::io::Result<()> {
        lock(self).write_all(bytes)
    }
    fn destroy(&self) {
        let _ = lock(self).shutdown(Shutdown::Both);
    }
}

pub type Conn = Arc<dyn LinkConn>;

/// TS `RunnerLinkDeps` 의 콜백들. `agent_id` 는 `expect` 가 적어 둔 값이다 — 러너의 주장이 아니다.
pub trait RunnerLinkHandler: Send + Sync {
    fn on_frame(&self, runner_id: &str, agent_id: &str, frame: Value);
    /// 요청 하나의 답. `None` 이면 배선이 없다 — status 0 으로 거절된다. 요청마다 따로 스레드에서 불린다.
    fn on_request(
        &self,
        _runner_id: &str,
        _agent_id: &str,
        _req: RunnerLinkRequest,
        _kind: RunnerLinkKind,
    ) -> Option<RunnerLinkResponse> {
        None
    }
    /// 단방향 통지 — 서버로 안 나간다.
    fn on_notice(&self, _runner_id: &str, _agent_id: &str, _notice: Value) {}
    fn on_close(&self, _runner_id: &str) {}
    /// relay 소켓이 (다시) 붙었다 — 재접속은 앞 소켓의 close 를 부르지 않을 수 있다(security #1127 L1).
    fn on_relay_attach(&self, _runner_id: &str) {}
    fn log(&self, line: &str);
}

/// 턴 열쇠로 붙은 소켓의 턴 — 요청의 cause·턴 id 를 이 값으로 덮는다.
#[derive(Debug, Clone, PartialEq, Eq)]
struct KeyedTurn {
    turn_id: String,
    cause: Option<String>,
}

struct Expected {
    agent_id: String,
    secret: String,
}

pub struct RunnerLinkServer {
    handler: Arc<dyn RunnerLinkHandler>,
    turn_keys: Option<Arc<Mutex<TurnKeyLedger>>>,
    max_line_bytes: usize,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    reject_log: Mutex<RejectLogThrottle>,
    expected: Mutex<HashMap<String, Expected>>,
    /// relay 만 — 러너당 하나, send 의 대상.
    linked: Mutex<HashMap<String, Conn>>,
    /// 받아들인 소켓 전부(relay·bridge·hook·wrapper). `close` 가 전부 끊는다 — 남기면 종료가 멈춘다(2026-09-21).
    accepted: Mutex<Vec<Conn>>,
    /// 인증된 소켓 수 — [`RunnerLinkServer::socket_limit`] 과 견준다.
    sockets: Arc<AtomicUsize>,
}

/// 인증된 러너 소켓 자리. 소켓이 끝나면(패닉이어도) 돌려준다.
struct RunnerSlot(Arc<AtomicUsize>);

impl Drop for RunnerSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn same(a: &Conn, b: &Conn) -> bool {
    std::ptr::addr_eq(Arc::as_ptr(a), Arc::as_ptr(b))
}

fn refuse(req: &RunnerLinkRequest, message: &str) -> RunnerLinkResponse {
    match req {
        RunnerLinkRequest::McpRequest { id, .. } => RunnerLinkResponse::McpError {
            id: id.clone(),
            status: 0,
            message: message.to_string(),
        },
        RunnerLinkRequest::HttpForward { id, .. } => RunnerLinkResponse::HttpResponse {
            id: id.clone(),
            status: 0,
            body: message.to_string(),
        },
    }
}

fn req_id(req: &RunnerLinkRequest) -> &str {
    match req {
        RunnerLinkRequest::McpRequest { id, .. } | RunnerLinkRequest::HttpForward { id, .. } => id,
    }
}

fn encode(v: &impl serde::Serialize, limit: usize) -> Result<Vec<u8>, String> {
    let mut s = serde_json::to_vec(v)
        .map_err(|e| format!("응답을 러너 링크 한 줄로 만들지 못했다: {e}"))?;
    if s.len() > limit {
        return Err(format!(
            "응답이 {} 바이트로 러너 링크 한 줄 상한({limit} 바이트)을 넘어 전달하지 못했다",
            s.len()
        ));
    }
    s.push(b'\n');
    Ok(s)
}

/// 턴 열쇠 소켓의 `mcp.request` 에서 cause·turnId 를 장부 값으로 덮는다(셸 env 가 지어 넣은 값을 믿지 않는다).
fn pin_turn(req: RunnerLinkRequest, turn: Option<&KeyedTurn>) -> RunnerLinkRequest {
    match (req, turn) {
        (
            RunnerLinkRequest::McpRequest {
                id,
                payload,
                cwd,
                command_files,
                ..
            },
            Some(t),
        ) => RunnerLinkRequest::McpRequest {
            id,
            payload,
            cause: t.cause.clone(),
            cwd,
            turn_id: Some(t.turn_id.clone()),
            command_files,
        },
        (req, _) => req,
    }
}

/// 소켓 하나의 받은 상태.
struct Session {
    runner_id: String,
    agent_id: String,
    kind: RunnerLinkKind,
    turn: Option<KeyedTurn>,
    conn: Conn,
    inflight: Arc<AtomicUsize>,
}

impl RunnerLinkServer {
    pub fn new(
        handler: Arc<dyn RunnerLinkHandler>,
        turn_keys: Option<Arc<Mutex<TurnKeyLedger>>>,
    ) -> Arc<Self> {
        Self::with_options(
            handler,
            turn_keys,
            RUNNER_LINK_MAX_LINE_BYTES,
            Box::new(now_ms),
        )
    }

    pub fn with_options(
        handler: Arc<dyn RunnerLinkHandler>,
        turn_keys: Option<Arc<Mutex<TurnKeyLedger>>>,
        max_line_bytes: usize,
        now: Box<dyn Fn() -> u64 + Send + Sync>,
    ) -> Arc<Self> {
        Arc::new(Self {
            handler,
            turn_keys,
            max_line_bytes,
            now,
            reject_log: Mutex::new(RejectLogThrottle::new(
                LINK_REJECT_LOG_WINDOW_MS,
                LINK_REJECT_LOG_MAX_KEYS,
            )),
            expected: Mutex::new(HashMap::new()),
            linked: Mutex::new(HashMap::new()),
            accepted: Mutex::new(Vec::new()),
            sockets: Arc::new(AtomicUsize::new(0)),
        })
    }

    /// 지금 받을 수 있는 인증된 러너 소켓 수.
    pub fn socket_limit(&self) -> usize {
        (lock(&self.expected).len() * RUNNER_SOCKETS_PER_RUNNER).min(MAX_RUNNER_SOCKETS)
    }

    fn take_socket_slot(&self) -> Option<RunnerSlot> {
        let limit = self.socket_limit();
        let mut n = self.sockets.load(Ordering::Acquire);
        loop {
            if n >= limit {
                return None;
            }
            match self
                .sockets
                .compare_exchange_weak(n, n + 1, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => return Some(RunnerSlot(Arc::clone(&self.sockets))),
                Err(now) => n = now,
            }
        }
    }

    /// spawn 직전에 적는다. 같은 runnerId 를 다시 적으면 덮어쓴다(재spawn).
    pub fn expect(&self, runner_id: &str, agent_id: &str, secret: &str) {
        lock(&self.expected).insert(
            runner_id.to_string(),
            Expected {
                agent_id: agent_id.to_string(),
                secret: secret.to_string(),
            },
        );
    }

    /// 러너가 죽었다 — 그 secret·턴 열쇠로는 더 못 붙고, relay 소켓은 끊는다.
    pub fn forget(&self, runner_id: &str) {
        lock(&self.expected).remove(runner_id);
        if let Some(tk) = &self.turn_keys {
            lock(tk).forget_runner(runner_id);
        }
        if let Some(c) = lock(&self.linked).remove(runner_id) {
            c.destroy();
        }
    }

    pub fn is_linked(&self, runner_id: &str) -> bool {
        lock(&self.linked).contains_key(runner_id)
    }

    pub fn agent_of(&self, runner_id: &str) -> Option<String> {
        lock(&self.expected)
            .get(runner_id)
            .map(|e| e.agent_id.clone())
    }

    /// relay 로 지금 붙어 있는 러너들의 에이전트 id.
    pub fn linked_agents(&self) -> HashSet<String> {
        let linked: Vec<String> = lock(&self.linked).keys().cloned().collect();
        let exp = lock(&self.expected);
        linked
            .iter()
            .filter_map(|r| exp.get(r).map(|e| e.agent_id.clone()))
            .collect()
    }

    /// 릴레이 프레임·오퍼레이터 통지를 relay 소켓으로. 소켓이 없거나 못 쓰면 false.
    pub fn send(&self, runner_id: &str, frame: &Value) -> bool {
        let Some(c) = lock(&self.linked).get(runner_id).cloned() else {
            return false;
        };
        match encode(frame, self.max_line_bytes) {
            Ok(b) => c.write_line(&b).is_ok(),
            Err(_) => false,
        }
    }

    /// 붙어 있는 소켓 전부를 끊는다(종료 경로). 러너 프로세스는 건드리지 않는다.
    pub fn close(&self) {
        for (_, c) in lock(&self.linked).drain() {
            c.destroy();
        }
        for c in lock(&self.accepted).drain(..) {
            c.destroy();
        }
    }

    fn drop_relay(&self, runner_id: &str, conn: &Conn) {
        let mut linked = lock(&self.linked);
        if linked.get(runner_id).is_some_and(|c| same(c, conn)) {
            linked.remove(runner_id);
            drop(linked);
            self.handler.on_close(runner_id);
        }
    }

    /// 첫 줄 검사. 받으면 소켓 상태를, 거절이면 `link.rejected` 한 줄을 쓰고 끊은 뒤 `None`.
    fn admit(&self, conn: &Conn, hello: &Value) -> Option<Session> {
        let claim = check_runner_hello(hello);
        let entry = claim.as_ref().and_then(|c| {
            lock(&self.expected)
                .get(&c.runner_id)
                .map(|e| (e.agent_id.clone(), e.secret.clone()))
        });
        let keyed = match (&claim, &self.turn_keys) {
            (
                Some(HelloClaim {
                    turn_key: Some(k), ..
                }),
                Some(tk),
            ) => lock(tk).lookup(k),
            _ => None,
        };
        let key_ok = match (&keyed, &claim) {
            (Some(k), Some(c)) => k.runner_id == c.runner_id && k.scope.opens(c.kind),
            _ => false,
        };
        let secret_ok = match (&claim, &entry) {
            (
                Some(HelloClaim {
                    secret: Some(got), ..
                }),
                Some((_, want)),
            ) => {
                !want.is_empty()
                    && want.len() == got.len()
                    && ct_eq(want.as_bytes(), got.as_bytes())
            }
            _ => false,
        };
        let (Some(claim), Some((agent_id, _))) = (claim.clone(), entry) else {
            self.reject(conn, claim.as_ref());
            return None;
        };
        if !(secret_ok || key_ok) {
            self.reject(conn, Some(&claim));
            return None;
        }
        let turn = if key_ok {
            keyed.map(|k| KeyedTurn {
                turn_id: k.turn_id,
                cause: k.cause,
            })
        } else {
            None
        };
        Some(Session {
            runner_id: claim.runner_id,
            agent_id,
            kind: claim.kind,
            turn,
            conn: Arc::clone(conn),
            inflight: Arc::new(AtomicUsize::new(0)),
        })
    }

    fn reject(&self, conn: &Conn, claim: Option<&HelloClaim>) {
        let who = claim.map_or_else(
            || "hello 형식 아님".to_string(),
            |c| format!("runnerId={}", c.runner_id),
        );
        let line = lock(&self.reject_log).hit(
            &who,
            &format!("러너 링크 거절: {who} — 모르는 러너이거나 secret 이 다르다"),
            (self.now)(),
        );
        if let Some(l) = line {
            self.handler.log(&l);
        }
        // 끊기 전에 「받아 주지 않는다」를 한 줄 — 러너가 1초마다 다시 붙지 않고 물러나게.
        let _ = conn.write_line(b"{\"type\":\"link.rejected\",\"reason\":\"unknown_runner\"}\n");
        conn.destroy();
    }

    /// 답 한 줄. 상한 초과는 삼키지 않고 같은 id 로 작은 거절을 대신 보낸다(2026-10-02).
    fn write_answer(&self, conn: &Conn, req: &RunnerLinkRequest, res: &RunnerLinkResponse) {
        let line = match encode(res, self.max_line_bytes) {
            Ok(b) => b,
            Err(why) => {
                self.handler.log(&format!(
                    "러너 링크 답을 거절로 바꿔 보낸다: id={} — {why}",
                    req_id(req)
                ));
                match encode(&refuse(req, &why), self.max_line_bytes) {
                    Ok(b) => b,
                    Err(_) => return,
                }
            }
        };
        let _ = conn.write_line(&line);
    }

    fn handle_line(self: &Arc<Self>, s: &Session, value: Value) {
        if is_runner_link_request(&value) {
            let Ok(req) = serde_json::from_value::<RunnerLinkRequest>(value.clone()) else {
                // 꼴이 틀린 요청 — id 는 있으니 같은 id 로 거절한다.
                let id = value
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let ty = value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let res = if ty == "mcp.request" {
                    json!({"type":"mcp.error","id":id,"status":0,"message":"요청 꼴이 틀렸다"})
                } else {
                    json!({"type":"http.response","id":id,"status":0,"body":"요청 꼴이 틀렸다"})
                };
                if let Ok(b) = encode(&res, self.max_line_bytes) {
                    let _ = s.conn.write_line(&b);
                }
                return;
            };
            // 턴 열쇠 소켓은 MCP 요청만 — http.forward 는 cause 를 본문에 실어 나가므로 장부 값으로 묶을 수 없다.
            if s.turn.is_some() && !matches!(req, RunnerLinkRequest::McpRequest { .. }) {
                let res = RunnerLinkResponse::HttpResponse {
                    id: req_id(&req).to_string(),
                    status: 403,
                    body: "a turn-key link only carries mcp.request".into(),
                };
                self.write_answer(&s.conn, &req, &res);
                return;
            }
            let req = pin_turn(req, s.turn.as_ref());
            if s.inflight.fetch_add(1, Ordering::AcqRel) >= MAX_INFLIGHT_PER_SOCKET {
                s.inflight.fetch_sub(1, Ordering::AcqRel);
                let res = refuse(&req, "이 링크에서 답을 기다리는 요청이 너무 많다");
                self.write_answer(&s.conn, &req, &res);
                return;
            }
            let me = Arc::clone(self);
            let conn = Arc::clone(&s.conn);
            let inflight = Arc::clone(&s.inflight);
            let (runner_id, agent_id, kind) = (s.runner_id.clone(), s.agent_id.clone(), s.kind);
            std::thread::spawn(move || {
                let res = me
                    .handler
                    .on_request(&runner_id, &agent_id, req.clone(), kind)
                    .unwrap_or_else(|| refuse(&req, "이 오퍼레이터에는 전달이 배선되지 않았다"));
                me.write_answer(&conn, &req, &res);
                inflight.fetch_sub(1, Ordering::AcqRel);
            });
            return;
        }
        // 브릿지·hook·래퍼는 PTY 를 모른다 — 요청이 아닌 것은 버린다.
        if s.kind != RunnerLinkKind::Relay {
            return;
        }
        // 통지는 릴레이 프레임보다 먼저 가른다 — 흘려보내면 서버 허브가 모르는 타입으로 버린다.
        let ty = value
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_string);
        if is_runner_link_notice(&value) {
            self.handler.on_notice(&s.runner_id, &s.agent_id, value);
            return;
        }
        // 통지 이름인데 꼴이 틀렸으면 서버로 보내지 않는다(TS 는 허브의 wrap 이 버린다 — 여기서 먼저 버린다).
        match ty {
            Some(t) if harkroom_proto::p1::RUNNER_LINK_NOTICE_TYPES.contains(&t.as_str()) => {}
            Some(_) => self.handler.on_frame(&s.runner_id, &s.agent_id, value),
            None => {}
        }
    }

    /// `socket::serve_connection` 이 첫 줄을 읽고 넘긴다. `pending` 은 hello 뒤로 이미 풀린 줄,
    /// `buffered` 는 그 뒤에 붙어 온 아직 안 끝난 줄의 머리다. 받으면 이 스레드에서 소켓이 닫힐 때까지 돈다.
    /// `release` 는 인증 전 자리를 놓는다 — 인증되고 러너 몫 자리를 잡은 뒤에 부른다(못 받으면 돌아갈 때 놓인다).
    pub fn serve(
        self: &Arc<Self>,
        stream: UnixStream,
        hello: &Value,
        pending: Vec<Value>,
        buffered: Vec<u8>,
        release: impl FnOnce(),
    ) -> bool {
        let Ok(write_half) = stream.try_clone() else {
            return false;
        };
        let conn: Conn = Arc::new(Mutex::new(write_half));
        self.run_with(conn, stream, hello, pending, buffered, release)
    }

    #[cfg(test)]
    fn run(
        self: &Arc<Self>,
        conn: Conn,
        reader: impl Read,
        hello: &Value,
        pending: Vec<Value>,
        buffered: Vec<u8>,
    ) -> bool {
        self.run_with(conn, reader, hello, pending, buffered, || {})
    }

    fn run_with(
        self: &Arc<Self>,
        conn: Conn,
        mut reader: impl Read,
        hello: &Value,
        pending: Vec<Value>,
        buffered: Vec<u8>,
        release: impl FnOnce(),
    ) -> bool {
        let Some(s) = self.admit(&conn, hello) else {
            return false;
        };
        let Some(_slot) = self.take_socket_slot() else {
            self.handler.log(&format!(
                "러너 링크 거절: runnerId={} — 인증된 러너 소켓 상한({})을 넘었다",
                s.runner_id,
                self.socket_limit()
            ));
            let _ =
                conn.write_line(b"{\"type\":\"link.rejected\",\"reason\":\"too_many_sockets\"}\n");
            conn.destroy();
            return false;
        };
        release();
        if s.kind == RunnerLinkKind::Relay {
            // 같은 러너가 다시 붙으면 앞 소켓을 놓는다 — 재접속이 앞 소켓의 close 보다 먼저 올 수 있다.
            let prev = lock(&self.linked).insert(s.runner_id.clone(), Arc::clone(&conn));
            if let Some(p) = prev.filter(|p| !same(p, &conn)) {
                p.destroy();
            }
            self.handler.on_relay_attach(&s.runner_id);
        }
        lock(&self.accepted).push(Arc::clone(&conn));
        let kind_name = serde_json::to_value(s.kind)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        self.handler.log(&format!(
            "러너 링크 연결({kind_name}{}): runnerId={} agent={}",
            if s.turn.is_some() { ", 턴 열쇠" } else { "" },
            s.runner_id,
            s.agent_id
        ));
        for v in pending {
            self.handle_line(&s, v);
        }
        let mut decoder = NdjsonDecoder::new(self.max_line_bytes);
        let mut chunk = buffered;
        let mut buf = vec![0u8; 64 * 1024];
        'read: loop {
            for line in decoder.push(&chunk) {
                match line {
                    Decoded::Ok(v) => self.handle_line(&s, v),
                    Decoded::Err(e)
                        if e.code == harkroom_proto::p3::DaemonErrorCode::LineTooLong =>
                    {
                        // 넘긴 줄은 id 를 모른다 — 답 대신 끊는다. 브릿지는 끊김을 보고 나간 요청을 즉시 실패로 답한다.
                        self.handler.log(&format!(
                            "러너 링크({kind_name}) 줄이 상한을 넘어 끊는다: runnerId={} {}",
                            s.runner_id, e.message
                        ));
                        break 'read;
                    }
                    Decoded::Err(_) => {}
                }
            }
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => chunk = buf[..n].to_vec(),
            }
        }
        if s.kind == RunnerLinkKind::Relay {
            self.drop_relay(&s.runner_id, &conn);
        }
        conn.destroy();
        lock(&self.accepted).retain(|c| !same(c, &conn));
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn_keys::TurnKeyLedger;
    use std::io::Cursor;
    use std::sync::atomic::AtomicU64;

    #[derive(Default)]
    struct FakeConn {
        out: Mutex<Vec<u8>>,
        destroyed: std::sync::atomic::AtomicBool,
    }
    impl LinkConn for FakeConn {
        fn write_line(&self, b: &[u8]) -> std::io::Result<()> {
            lock(&self.out).extend_from_slice(b);
            Ok(())
        }
        fn destroy(&self) {
            self.destroyed.store(true, Ordering::SeqCst);
        }
    }
    impl FakeConn {
        fn lines(&self) -> Vec<Value> {
            String::from_utf8(lock(&self.out).clone())
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect()
        }
    }

    #[derive(Default)]
    struct Rec {
        frames: Mutex<Vec<(String, String, Value)>>,
        notices: Mutex<Vec<Value>>,
        requests: Mutex<Vec<(RunnerLinkRequest, RunnerLinkKind)>>,
        logs: Mutex<Vec<String>>,
        closes: Mutex<Vec<String>>,
        attaches: Mutex<Vec<String>>,
        big: bool,
    }
    impl RunnerLinkHandler for Rec {
        fn on_frame(&self, r: &str, a: &str, f: Value) {
            lock(&self.frames).push((r.into(), a.into(), f));
        }
        fn on_request(
            &self,
            _r: &str,
            _a: &str,
            req: RunnerLinkRequest,
            k: RunnerLinkKind,
        ) -> Option<RunnerLinkResponse> {
            lock(&self.requests).push((req.clone(), k));
            let id = req_id(&req).to_string();
            let body = if self.big {
                "x".repeat(4096)
            } else {
                "ok".into()
            };
            Some(RunnerLinkResponse::HttpResponse {
                id,
                status: 200,
                body,
            })
        }
        fn on_notice(&self, _r: &str, _a: &str, n: Value) {
            lock(&self.notices).push(n);
        }
        fn on_close(&self, r: &str) {
            lock(&self.closes).push(r.into());
        }
        fn on_relay_attach(&self, r: &str) {
            lock(&self.attaches).push(r.into());
        }
        fn log(&self, l: &str) {
            lock(&self.logs).push(l.into());
        }
    }

    fn hello(runner: &str, secret: &str, kind: Option<&str>) -> Value {
        let mut v =
            json!({"type":"hello","version":1,"role":"runner","runnerId":runner,"secret":secret});
        if let Some(k) = kind {
            v["kind"] = json!(k);
        }
        v
    }

    fn server(rec: &Arc<Rec>, limit: usize, clock: Arc<AtomicU64>) -> Arc<RunnerLinkServer> {
        RunnerLinkServer::with_options(
            Arc::clone(rec) as Arc<dyn RunnerLinkHandler>,
            None,
            limit,
            Box::new(move || clock.load(Ordering::SeqCst)),
        )
    }

    fn wait_for(f: impl Fn() -> bool) {
        for _ in 0..200 {
            if f() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        panic!("시간 안에 안 왔다");
    }

    #[test]
    fn runner_sockets_have_their_own_cap_and_release_pre_auth_only_after_admit() {
        let rec = Arc::new(Rec::default());
        let srv = server(
            &rec,
            RUNNER_LINK_MAX_LINE_BYTES,
            Arc::new(AtomicU64::new(0)),
        );
        // 러너가 없으면 인증된 자리도 없다.
        assert_eq!(srv.socket_limit(), 0);
        srv.expect("r1", "a1", "s1");
        assert_eq!(srv.socket_limit(), RUNNER_SOCKETS_PER_RUNNER);
        let mut held: Vec<_> = (0..RUNNER_SOCKETS_PER_RUNNER)
            .map(|_| srv.take_socket_slot().expect("자리"))
            .collect();
        assert!(srv.take_socket_slot().is_none());

        // 자리가 꽉 찼으면 맞는 secret 이어도 거절 한 줄 + 끊음, 인증 전 자리는 링크가 놓지 않는다(돌아간 뒤 호출자가 놓는다).
        let c = Arc::new(FakeConn::default());
        let released = std::sync::atomic::AtomicBool::new(false);
        let ok = srv.run_with(
            c.clone(),
            Cursor::new(Vec::new()),
            &hello("r1", "s1", None),
            vec![],
            vec![],
            || released.store(true, Ordering::SeqCst),
        );
        assert!(!ok);
        assert!(!released.load(Ordering::SeqCst));
        assert!(c.destroyed.load(Ordering::SeqCst));
        assert_eq!(c.lines()[0]["reason"], "too_many_sockets");

        // 하나 놓으면 다시 받고, 그때 인증 전 자리를 놓는다. 끝나면 러너 자리도 돌려준다.
        drop(held.pop());
        let c = Arc::new(FakeConn::default());
        let released = std::sync::atomic::AtomicBool::new(false);
        assert!(srv.run_with(
            c.clone(),
            Cursor::new(Vec::new()),
            &hello("r1", "s1", None),
            vec![],
            vec![],
            || released.store(true, Ordering::SeqCst),
        ));
        assert!(released.load(Ordering::SeqCst));
        assert_eq!(
            srv.sockets.load(Ordering::SeqCst),
            RUNNER_SOCKETS_PER_RUNNER - 1
        );

        // 나쁜 secret 은 자리를 잡지 않고 인증 전 자리도 놓지 않는다.
        let c = Arc::new(FakeConn::default());
        let released = std::sync::atomic::AtomicBool::new(false);
        assert!(!srv.run_with(
            c.clone(),
            Cursor::new(Vec::new()),
            &hello("r1", "nope", None),
            vec![],
            vec![],
            || released.store(true, Ordering::SeqCst),
        ));
        assert!(!released.load(Ordering::SeqCst));
        assert_eq!(c.lines()[0]["reason"], "unknown_runner");
    }

    #[test]
    fn runner_socket_cap_is_bounded() {
        let rec = Arc::new(Rec::default());
        let srv = server(
            &rec,
            RUNNER_LINK_MAX_LINE_BYTES,
            Arc::new(AtomicU64::new(0)),
        );
        for i in 0..(MAX_RUNNER_SOCKETS / RUNNER_SOCKETS_PER_RUNNER + 10) {
            srv.expect(&format!("r{i}"), "a", "s");
        }
        assert_eq!(srv.socket_limit(), MAX_RUNNER_SOCKETS);
    }

    #[test]
    fn hello_shape() {
        assert!(
            check_runner_hello(&hello("r", "s", None))
                .is_some_and(|c| c.kind == RunnerLinkKind::Relay)
        );
        assert!(
            check_runner_hello(&hello("r", "s", Some("bridge")))
                .is_some_and(|c| c.kind == RunnerLinkKind::Bridge)
        );
        assert!(check_runner_hello(&hello("r", "s", Some("pty"))).is_none());
        // secret·turnKey 둘 다 / 둘 다 없음
        let mut both = hello("r", "s", None);
        both["turnKey"] = json!("k");
        assert!(check_runner_hello(&both).is_none());
        assert!(
            check_runner_hello(&json!({"type":"hello","version":1,"role":"runner","runnerId":"r"}))
                .is_none()
        );
        assert!(
            check_runner_hello(
                &json!({"type":"hello","version":2,"role":"runner","runnerId":"r","secret":"s"})
            )
            .is_none()
        );
        assert!(
            check_runner_hello(
                &json!({"type":"hello","version":1,"role":"app","runnerId":"r","secret":"s"})
            )
            .is_none()
        );
    }

    #[test]
    fn unknown_or_wrong_secret_is_rejected_with_one_line_and_throttled_log() {
        let rec = Arc::new(Rec::default());
        let clock = Arc::new(AtomicU64::new(0));
        let srv = server(&rec, 1024, Arc::clone(&clock));
        srv.expect("r1", "a1", "sec");
        for (h, t) in [
            (hello("r1", "bad", None), 0),
            (hello("r1", "sec-", None), 1),
            (hello("r9", "sec", None), 2),
        ] {
            clock.store(t, Ordering::SeqCst);
            let c = Arc::new(FakeConn::default());
            assert!(!srv.run(c.clone(), Cursor::new(Vec::new()), &h, vec![], vec![]));
            assert_eq!(
                c.lines(),
                vec![json!({"type":"link.rejected","reason":"unknown_runner"})]
            );
            assert!(c.destroyed.load(Ordering::SeqCst));
        }
        // r1 은 첫 줄만, r9 는 따로 첫 줄.
        assert_eq!(lock(&rec.logs).len(), 2);
        clock.store(LINK_REJECT_LOG_WINDOW_MS, Ordering::SeqCst);
        let c = Arc::new(FakeConn::default());
        srv.run(
            c,
            Cursor::new(Vec::new()),
            &hello("r1", "bad", None),
            vec![],
            vec![],
        );
        assert!(
            lock(&rec.logs)
                .last()
                .unwrap()
                .contains("지난 10분 동안 2번 더")
        );
    }

    #[test]
    fn throttle_evicts_oldest_quiet_key() {
        let mut t = RejectLogThrottle::new(1000, 2);
        assert!(t.hit("a", "a1", 0).is_some());
        assert!(t.hit("b", "b1", 0).is_some());
        assert!(t.hit("a", "a1", 1).is_none()); // a 가 최근 → b 가 가장 조용하다
        assert!(t.hit("c", "c1", 2).is_some()); // b 를 버린다
        assert!(t.hit("a", "a1", 3).is_none());
        assert!(t.hit("b", "b1", 4).is_some()); // b 는 다시 처음
    }

    #[test]
    fn relay_routes_frames_notices_and_requests() {
        let rec = Arc::new(Rec::default());
        let srv = server(&rec, 1 << 20, Arc::new(AtomicU64::new(0)));
        srv.expect("r1", "a1", "sec");
        let c = Arc::new(FakeConn::default());
        let tail = b"{\"type\":\"session.data\",\"x\":2}\n{\"type\":\"runner.pollStopped\",\"holding\":[1]}\n".to_vec();
        let pending = vec![
            json!({"type":"session.data","x":1}),
            json!({"type":"mcp.request","id":"q1","payload":{}}),
            json!({"type":"secret.lease","cause":""}), // 통지 이름인데 꼴이 틀림 → 버림
            json!({"noType":true}),
        ];
        let conn: Conn = c.clone();
        assert!(srv.run(
            conn,
            Cursor::new(tail),
            &hello("r1", "sec", None),
            pending,
            vec![]
        ));
        let frames = lock(&rec.frames).clone();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].1, "a1");
        assert_eq!(lock(&rec.notices).len(), 1);
        wait_for(|| c.lines().len() == 1);
        assert_eq!(c.lines()[0]["id"], "q1");
        assert_eq!(lock(&rec.attaches).as_slice(), ["r1"]);
        // EOF → relay 가 내려가고 on_close
        assert_eq!(lock(&rec.closes).as_slice(), ["r1"]);
        assert!(!srv.is_linked("r1"));
    }

    #[test]
    fn bridge_ignores_non_requests_and_buffered_head_is_kept() {
        let rec = Arc::new(Rec::default());
        let srv = server(&rec, 1 << 20, Arc::new(AtomicU64::new(0)));
        srv.expect("r1", "a1", "sec");
        let c = Arc::new(FakeConn::default());
        let buffered = b"{\"type\":\"mcp.req".to_vec();
        let rest = b"uest\",\"id\":\"q2\",\"payload\":{}}\n{\"type\":\"session.data\"}\n".to_vec();
        srv.run(
            c.clone(),
            Cursor::new(rest),
            &hello("r1", "sec", Some("bridge")),
            vec![],
            buffered,
        );
        assert!(lock(&rec.frames).is_empty());
        wait_for(|| c.lines().len() == 1);
        let reqs = lock(&rec.requests).clone();
        assert_eq!(reqs[0].1, RunnerLinkKind::Bridge);
        assert!(!srv.is_linked("r1"));
        assert!(lock(&rec.closes).is_empty());
    }

    #[test]
    fn oversize_answer_becomes_same_id_refusal() {
        let rec = Arc::new(Rec {
            big: true,
            ..Default::default()
        });
        let srv = server(&rec, 1024, Arc::new(AtomicU64::new(0)));
        srv.expect("r1", "a1", "sec");
        let c = Arc::new(FakeConn::default());
        srv.run(
            c.clone(),
            Cursor::new(Vec::new()),
            &hello("r1", "sec", None),
            vec![json!({"type":"http.forward","id":"h1","method":"GET","path":"/x"})],
            vec![],
        );
        wait_for(|| c.lines().len() == 1);
        let l = &c.lines()[0];
        assert_eq!(
            (l["id"].as_str(), l["status"].as_u64()),
            (Some("h1"), Some(0))
        );
        assert!(l["body"].as_str().unwrap().contains("상한"));
    }

    #[test]
    fn overlong_line_cuts_the_link() {
        let rec = Arc::new(Rec::default());
        let srv = server(&rec, 64, Arc::new(AtomicU64::new(0)));
        srv.expect("r1", "a1", "sec");
        let c = Arc::new(FakeConn::default());
        let mut big = vec![b'x'; 200];
        big.extend_from_slice(b"\n{\"type\":\"session.data\"}\n");
        srv.run(
            c.clone(),
            Cursor::new(big),
            &hello("r1", "sec", None),
            vec![],
            vec![],
        );
        assert!(lock(&rec.frames).is_empty(), "끊은 뒤의 줄은 읽지 않는다");
        assert!(
            lock(&rec.logs)
                .iter()
                .any(|l| l.contains("상한을 넘어 끊는다"))
        );
        assert!(c.destroyed.load(Ordering::SeqCst));
    }

    #[test]
    fn relay_reattach_destroys_previous_and_forget_cuts() {
        let rec = Arc::new(Rec::default());
        let srv = server(&rec, 1 << 20, Arc::new(AtomicU64::new(0)));
        srv.expect("r1", "a1", "sec");
        let old = Arc::new(FakeConn::default());
        let old_c: Conn = old.clone();
        lock(&srv.linked).insert("r1".into(), old_c);
        // 새 relay 를 붙이고(읽기는 막아 두려고 끝나지 않는 대신 빈 입력) — 붙는 순간 앞 소켓을 끊는다.
        let new = Arc::new(FakeConn::default());
        srv.run(
            new.clone(),
            Cursor::new(Vec::new()),
            &hello("r1", "sec", None),
            vec![],
            vec![],
        );
        assert!(old.destroyed.load(Ordering::SeqCst));
        assert_eq!(srv.agent_of("r1").as_deref(), Some("a1"));
        srv.forget("r1");
        assert_eq!(srv.agent_of("r1"), None);
        let c = Arc::new(FakeConn::default());
        assert!(!srv.run(
            c,
            Cursor::new(Vec::new()),
            &hello("r1", "sec", None),
            vec![],
            vec![]
        ));
    }

    #[test]
    fn turn_key_opens_only_its_scope_and_pins_turn() {
        let rec = Arc::new(Rec::default());
        let ledger = Arc::new(Mutex::new(TurnKeyLedger::new(|| 0, |_| {})));
        let srv = RunnerLinkServer::with_options(
            Arc::clone(&rec) as Arc<dyn RunnerLinkHandler>,
            Some(Arc::clone(&ledger)),
            1 << 20,
            Box::new(|| 0),
        );
        srv.expect("r1", "a1", "sec");
        let bridge = "b".repeat(64);
        let shell = "c".repeat(64);
        let deposit = RunnerLinkRequest::HttpForward {
            id: "d".into(),
            method: "POST".into(),
            path: crate::turn_keys::TURN_KEYS_PATH.into(),
            body: Some(
                json!({"turnId":"t1","cause":"m1","keys":{"bridge":bridge,"shell":shell}})
                    .to_string(),
            ),
            body_base64: None,
            content_type: None,
        };
        let res = lock(&ledger).maybe_handle("r1", &deposit, RunnerLinkKind::Relay);
        assert!(
            matches!(
                res,
                Some(RunnerLinkResponse::HttpResponse { status: 200, .. })
            ),
            "{res:?}"
        );
        let keyed = |key: &str, kind: &str| json!({"type":"hello","version":1,"role":"runner","runnerId":"r1","turnKey":key,"kind":kind});
        // relay·남의 범위는 못 연다
        for h in [
            keyed(&bridge, "relay"),
            keyed(&bridge, "hook"),
            keyed(&shell, "bridge"),
        ] {
            assert!(!srv.run(
                Arc::new(FakeConn::default()),
                Cursor::new(Vec::new()),
                &h,
                vec![],
                vec![]
            ));
        }
        let c = Arc::new(FakeConn::default());
        let pending = vec![
            json!({"type":"mcp.request","id":"q","payload":{},"cause":"forged","turnId":"forged"}),
            json!({"type":"http.forward","id":"f","method":"GET","path":"/x"}),
        ];
        assert!(srv.run(
            c.clone(),
            Cursor::new(Vec::new()),
            &keyed(&shell, "wrapper"),
            pending,
            vec![]
        ));
        wait_for(|| c.lines().len() == 2);
        let reqs = lock(&rec.requests).clone();
        assert_eq!(reqs.len(), 1, "http.forward 는 서버로 넘기지 않는다");
        match &reqs[0].0 {
            RunnerLinkRequest::McpRequest { cause, turn_id, .. } => {
                assert_eq!(
                    (cause.as_deref(), turn_id.as_deref()),
                    (Some("m1"), Some("t1"))
                );
            }
            other => panic!("{other:?}"),
        }
        assert!(
            c.lines()
                .iter()
                .any(|l| l["id"] == "f" && l["status"] == 403)
        );
        // 러너를 잊으면 열쇠도 죽는다
        srv.forget("r1");
        srv.expect("r1", "a1", "sec");
        assert!(!srv.run(
            Arc::new(FakeConn::default()),
            Cursor::new(Vec::new()),
            &keyed(&shell, "hook"),
            vec![],
            vec![]
        ));
    }

    #[test]
    fn close_cuts_bridge_sockets_too() {
        let rec = Arc::new(Rec::default());
        let srv = server(&rec, 1 << 20, Arc::new(AtomicU64::new(0)));
        let b = Arc::new(FakeConn::default());
        let bc: Conn = b.clone();
        lock(&srv.accepted).push(bc);
        srv.close();
        assert!(b.destroyed.load(Ordering::SeqCst));
    }
}
