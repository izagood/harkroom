//! 러너 → 오퍼레이터 링크 클라이언트 — 정본 `packages/agent/src/relay.ts` 의 연결·요청 부분 이식(B3a).
//!
//! 세션(PTY 바이트·ring·input·resize·cancel)은 B3b 몫이다. 여기서는 그 자리를 두 개의 고리로 남긴다:
//! `announce_sessions`(재접속마다 실을 세션 목록)와 `on_frame`(요청 응답·거절·이관 통지가 아닌 서버 프레임).
//!
//! 지키는 약속(정본 주석이 근거다):
//! - 첫 줄은 `hello`, 붙을 때마다 `announce` → (끈끈한) `runner.pollStopped` → `providerLane.mode` → `on_link_open` 순서.
//! - 링크가 없으면 요청은 **즉시** `status: 0` 으로 거절한다(큐 없음). 끊기면 기다리던 요청도 전부 그렇게 끝난다.
//! - `link.rejected` 는 연결의 **첫 줄일 때만** 거절로 센다. 연달아 `LINK_REJECTED_GIVE_UP` 번이면 물러난다.
//! - 거절 백오프와 일반 백오프는 따로 간다(1초에서 두 배씩, 60초 상한 — `policy.ts::nextBackoffMs`).
//! - 못 붙는 장애는 장애당 한 줄만 외친다.

use harkroom_proto::p1::{
    RUNNER_LINK_PROTOCOL_VERSION, RunnerHello, RunnerLinkKind, RunnerLinkNotice, RunnerLinkRequest,
    RunnerLinkResponse,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::config::OperatorLink;

/// 링크 한 줄의 바이트 상한(`RUNNER_LINK_MAX_LINE_BYTES`). REST 본문·MCP 결과가 이 줄로 온다.
pub const RUNNER_LINK_MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
pub const LINK_DOWN_MESSAGE: &str = "오퍼레이터 링크가 없다 — 재접속 중이다";
pub const LINK_REJECTED_GIVE_UP: u32 = 10;
/// 이 러너가 다룰 줄 아는 개입 능력(`RUNNER_CAPS`). 세션 쪽(B3b)이 실제로 받는다.
pub const RUNNER_CAPS: [&str; 4] = ["input", "interactive", "attention", "cancel"];
const BACKOFF_CEILING_MS: u64 = 60_000;

pub fn next_backoff_ms(current: u64) -> u64 {
    (current * 2).min(BACKOFF_CEILING_MS)
}

type Hook = Box<dyn Fn() + Send + Sync>;

pub struct LinkOptions {
    pub link: OperatorLink,
    /// `HARKROOM_PROVIDER_LANE` — 붙을 때마다 `providerLane.mode` 로 알린다. `None` 은 알리지 않는다.
    pub provider_lane: Option<bool>,
    pub initial_backoff_ms: u64,
    /// 재접속마다 `announce` 에 실을 세션들(`AgentSessionView`). B3b 가 세션 장부로 채운다.
    pub announce_sessions: Box<dyn Fn() -> Vec<Value> + Send + Sync>,
    /// 응답·거절·이관 통지가 아닌 서버 프레임(replay.request·input·resize·viewer.count·session.cancel·interactive.open).
    pub on_frame: Box<dyn Fn(Value) + Send + Sync>,
    pub on_handover_released: Hook,
    pub on_link_open: Hook,
    /// 링크가 끊길 때(사유). B3b 가 뷰어 수를 0 으로 돌리는 자리다.
    pub on_link_down: Box<dyn Fn() + Send + Sync>,
    pub on_rejected_give_up: Hook,
    pub log: Box<dyn Fn(&str) + Send + Sync>,
}

impl LinkOptions {
    pub fn new(link: OperatorLink) -> Self {
        LinkOptions {
            link,
            provider_lane: None,
            initial_backoff_ms: 1_000,
            announce_sessions: Box::new(Vec::new),
            on_frame: Box::new(|_| {}),
            on_handover_released: Box::new(|| {}),
            on_link_open: Box::new(|| {}),
            on_link_down: Box::new(|| {}),
            on_rejected_give_up: Box::new(|| {}),
            log: Box::new(|l| println!("{l}")),
        }
    }
}

type Pending = std::sync::mpsc::Sender<RunnerLinkResponse>;

#[derive(Default)]
struct State {
    writer: Option<UnixStream>,
    pending: HashMap<String, (RunnerLinkRequest, Pending)>,
    poll_stopped: Option<(Vec<i64>, Vec<i64>)>,
    stopped: bool,
}

pub struct LinkClient {
    opts: LinkOptions,
    state: Mutex<State>,
    /// 붙음·멈춤이 바뀔 때 깨운다(`when_connected`·재접속 대기).
    changed: Condvar,
}

/// `request` 의 입력 — id 는 클라이언트가 붙인다.
pub enum LinkRequest {
    Mcp {
        payload: Value,
    },
    Http {
        method: String,
        path: String,
        body: Option<String>,
        content_type: Option<String>,
    },
}

fn down_response(req: &RunnerLinkRequest, message: &str) -> RunnerLinkResponse {
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

fn resp_id(res: &RunnerLinkResponse) -> &str {
    match res {
        RunnerLinkResponse::McpResponse { id, .. }
        | RunnerLinkResponse::McpError { id, .. }
        | RunnerLinkResponse::HttpResponse { id, .. } => id,
    }
}

/// 랜덤 UUID v4(`/dev/urandom`). 요청 id·세션 id 용 — 비밀이 아니라 충돌만 피하면 된다.
pub fn random_uuid() -> String {
    use std::io::Read;
    let mut b = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .expect("/dev/urandom");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// NDJSON 한 줄을 상한 안에서 읽는다. 넘긴 줄은 개행까지 버리고 `Some(None)` — 정본 `NdjsonDecoder` 처럼 다음 줄로 간다.
/// EOF 는 `None`.
fn read_line_limited(r: &mut impl BufRead, max: usize) -> std::io::Result<Option<Option<Vec<u8>>>> {
    let mut buf = Vec::new();
    let mut over = false;
    loop {
        let avail = r.fill_buf()?;
        if avail.is_empty() {
            return Ok(None);
        }
        let (chunk, done) = match avail.iter().position(|&c| c == b'\n') {
            Some(i) => (&avail[..i], Some(i + 1)),
            None => (avail, None),
        };
        if !over {
            if buf.len() + chunk.len() > max {
                over = true;
                buf = Vec::new();
            } else {
                buf.extend_from_slice(chunk);
            }
        }
        let used = done.unwrap_or(avail.len());
        r.consume(used);
        if done.is_some() {
            return Ok(Some(if over { None } else { Some(buf) }));
        }
    }
}

impl LinkClient {
    pub fn new(opts: LinkOptions) -> Arc<Self> {
        Arc::new(LinkClient {
            opts,
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
        })
    }

    /// 접속을 시작한다(스레드 하나). 이 뒤로는 끊겨도 스스로 다시 붙는다.
    pub fn start(self: &Arc<Self>) {
        let me = Arc::clone(self);
        std::thread::Builder::new()
            .name("runner-link".into())
            .spawn(move || me.run())
            .expect("runner-link thread");
    }

    /// 더 붙지 않는다. 열린 소켓도 닫는다.
    pub fn stop(&self) {
        let mut st = self.state.lock().unwrap();
        st.stopped = true;
        if let Some(w) = st.writer.take() {
            let _ = w.shutdown(std::net::Shutdown::Both);
        }
        self.changed.notify_all();
    }

    /// 이 뒤로 **다시** 붙지 않는다 — 지금 열린 링크는 그대로 둔다(드레인용).
    pub fn hold_reconnect(&self) {
        self.state.lock().unwrap().stopped = true;
        self.changed.notify_all();
    }

    pub fn connected(&self) -> bool {
        self.state.lock().unwrap().writer.is_some()
    }

    /// 붙을 때까지 기다린다. 시간 안에 못 붙으면 false(던지지 않는다).
    pub fn when_connected(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut st = self.state.lock().unwrap();
        while st.writer.is_none() {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            st = self.changed.wait_timeout(st, deadline - now).unwrap().0;
        }
        true
    }

    fn send_line(st: &mut State, line: &str) -> bool {
        let Some(w) = st.writer.as_mut() else {
            return false;
        };
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        w.write_all(&bytes).is_ok()
    }

    /// 프레임 하나를 보낸다(통지·릴레이 프레임). 링크가 없으면 버린다 — 재접속의 announce 가 복구한다.
    pub fn send_frame(&self, frame: &Value) {
        let mut st = self.state.lock().unwrap();
        let _ = Self::send_line(&mut st, &frame.to_string());
    }

    fn send_notice(&self, notice: &RunnerLinkNotice) {
        self.send_frame(&serde_json::to_value(notice).expect("notice"));
    }

    /// 오퍼레이터에게 요청 하나. 답이 올 때까지 막는다. 링크가 없으면 즉시 `status: 0`.
    pub fn request(&self, req: LinkRequest) -> RunnerLinkResponse {
        let id = random_uuid();
        let req = match req {
            LinkRequest::Mcp { payload } => RunnerLinkRequest::McpRequest {
                id,
                payload,
                cause: None,
                cwd: None,
                turn_id: None,
                command_files: None,
            },
            LinkRequest::Http {
                method,
                path,
                body,
                content_type,
            } => RunnerLinkRequest::HttpForward {
                id,
                method,
                path,
                body,
                body_base64: None,
                content_type,
            },
        };
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let mut st = self.state.lock().unwrap();
            if st.writer.is_none() {
                return down_response(&req, LINK_DOWN_MESSAGE);
            }
            let line = serde_json::to_string(&req).expect("request");
            st.pending
                .insert(req_id(&req).to_string(), (req.clone(), tx));
            if !Self::send_line(&mut st, &line) {
                st.pending.remove(req_id(&req));
                return down_response(&req, LINK_DOWN_MESSAGE);
            }
        }
        // 링크가 끊기면 run 이 pending 을 전부 down 으로 푼다 — 그래서 여기는 시한 없이 기다려도 된다.
        rx.recv()
            .unwrap_or_else(|_| down_response(&req, LINK_DOWN_MESSAGE))
    }

    /// 폴 루프를 빠져나왔다. **끈끈하다** — 재접속마다 다시 보낸다.
    pub fn notify_poll_stopped(&self, holding: &[i64], done: &[i64]) {
        let mut st = self.state.lock().unwrap();
        st.poll_stopped = Some((holding.to_vec(), done.to_vec()));
        Self::send_poll_stopped(&mut st);
    }

    fn send_poll_stopped(st: &mut State) {
        let Some((holding, done)) = st.poll_stopped.clone() else {
            return;
        };
        let n = RunnerLinkNotice::PollStopped {
            holding,
            done: if done.is_empty() { None } else { Some(done) },
        };
        let _ = Self::send_line(st, &serde_json::to_string(&n).expect("notice"));
    }

    /// 끈끈하지 않다 — 링크가 없거나 이름이 없으면 버린다.
    pub fn notify_mcp_auth_rejected(&self, servers: &[String], turn_started_at_ms: i64) {
        if servers.is_empty() {
            return;
        }
        self.send_notice(&RunnerLinkNotice::McpAuthRejected {
            servers: servers.to_vec(),
            turn_started_at_ms,
        });
    }

    pub fn notify_secret_lease(&self, cause: &str, lease_id: &str, token: &str, expires_at: &str) {
        self.send_notice(&RunnerLinkNotice::SecretLease {
            cause: cause.into(),
            lease_id: lease_id.into(),
            token: token.into(),
            expires_at: expires_at.into(),
        });
    }

    pub fn notify_secret_lease_ended(&self, cause: &str) {
        self.send_notice(&RunnerLinkNotice::SecretLeaseEnded {
            cause: cause.into(),
        });
    }

    pub fn notify_secret_lease_heartbeat(&self, cause: &str) {
        self.send_notice(&RunnerLinkNotice::SecretLeaseHeartbeat {
            cause: cause.into(),
        });
    }

    /// 실패에만 `code` 를 싣는다(정본 `ok || !code ? {} : { code }`).
    pub fn notify_provider_lane_result(&self, ok: bool, code: Option<&str>) {
        self.send_notice(&RunnerLinkNotice::ProviderLaneResult {
            ok,
            code: if ok { None } else { code.map(str::to_string) },
        });
    }

    pub fn notify_provider_lane_turn(&self, ok: bool) {
        self.send_notice(&RunnerLinkNotice::ProviderLaneTurn { ok });
    }

    fn on_open(&self, stream: UnixStream) -> bool {
        let mut st = self.state.lock().unwrap();
        if st.stopped {
            return false;
        }
        st.writer = Some(stream);
        let hello = RunnerHello {
            ty: Default::default(),
            version: RUNNER_LINK_PROTOCOL_VERSION,
            role: Default::default(),
            runner_id: self.opts.link.runner_id.clone(),
            secret: Some(self.opts.link.secret.clone()),
            turn_key: None,
            kind: None::<RunnerLinkKind>,
        };
        let _ = Self::send_line(&mut st, &serde_json::to_string(&hello).expect("hello"));
        let announce = json!({ "type": "announce", "sessions": (self.opts.announce_sessions)(), "caps": RUNNER_CAPS });
        let _ = Self::send_line(&mut st, &announce.to_string());
        Self::send_poll_stopped(&mut st);
        if let Some(on) = self.opts.provider_lane {
            let n = RunnerLinkNotice::ProviderLaneMode { on };
            let _ = Self::send_line(&mut st, &serde_json::to_string(&n).expect("notice"));
        }
        self.changed.notify_all();
        drop(st);
        (self.opts.on_link_open)();
        true
    }

    /// 한 연결의 읽기 루프. 첫 줄이 `link.rejected` 였으면 true.
    fn read_loop(&self, stream: UnixStream) -> bool {
        let mut reader = BufReader::new(stream);
        let mut first = true;
        let mut rejected = false;
        while let Ok(Some(line)) = read_line_limited(&mut reader, RUNNER_LINK_MAX_LINE_BYTES) {
            let was_first = std::mem::replace(&mut first, false);
            let Some(line) = line else { continue };
            let Ok(v) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            if !v.is_object() {
                continue;
            }
            let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
            match ty {
                "link.rejected" => {
                    if was_first {
                        rejected = true;
                    }
                }
                "mcp.response" | "mcp.error" | "http.response" => {
                    let Ok(res) = serde_json::from_value::<RunnerLinkResponse>(v) else {
                        continue;
                    };
                    let pending = self.state.lock().unwrap().pending.remove(resp_id(&res));
                    if let Some((_, tx)) = pending {
                        let _ = tx.send(res);
                    }
                }
                "handover.released" => (self.opts.on_handover_released)(),
                _ => (self.opts.on_frame)(v),
            }
        }
        rejected
    }

    /// 끊긴 뒤 처리. 다시 붙을지(그리고 얼마나 기다릴지)를 돌려준다.
    fn on_close(&self, reason: Option<&str>) {
        let mut st = self.state.lock().unwrap();
        st.writer = None;
        let msg = match reason {
            Some(r) => format!("{LINK_DOWN_MESSAGE} ({r})"),
            None => LINK_DOWN_MESSAGE.to_string(),
        };
        for (_, (req, tx)) in st.pending.drain() {
            let _ = tx.send(down_response(&req, &msg));
        }
        drop(st);
        (self.opts.on_link_down)();
    }

    /// 멈춤이 오거나 시간이 지날 때까지 잔다. 멈췄으면 false.
    fn sleep_unless_stopped(&self, ms: u64) -> bool {
        let deadline = Instant::now() + Duration::from_millis(ms);
        let mut st = self.state.lock().unwrap();
        loop {
            if st.stopped {
                return false;
            }
            let now = Instant::now();
            if now >= deadline {
                return true;
            }
            st = self.changed.wait_timeout(st, deadline - now).unwrap().0;
        }
    }

    fn run(&self) {
        let initial = self.opts.initial_backoff_ms;
        let mut backoff = initial;
        let mut reject_backoff = initial;
        let mut rejected_in_a_row = 0u32;
        let mut outage_reported = false;
        loop {
            if self.state.lock().unwrap().stopped {
                return;
            }
            match UnixStream::connect(&self.opts.link.socket_path) {
                Err(e) => {
                    // 못 붙은 것(ENOENT 등)은 거절 셈을 그대로 둔다 — 오퍼레이터 교체 중의 소켓 없음은 거절도 수락도 아니다.
                    if !outage_reported {
                        outage_reported = true;
                        eprintln!(
                            "오퍼레이터 링크에 붙지 못한다 — 재시도한다(관찰·개입·서버 호출이 그동안 안 된다): {e}"
                        );
                    }
                    self.on_close(Some(&e.to_string()));
                    if !self.sleep_unless_stopped(backoff) {
                        return;
                    }
                    backoff = next_backoff_ms(backoff);
                }
                Ok(stream) => {
                    let Ok(reader) = stream.try_clone() else {
                        continue;
                    };
                    if !self.on_open(stream) {
                        return;
                    }
                    outage_reported = false;
                    backoff = initial;
                    let rejected = self.read_loop(reader);
                    self.on_close(None);
                    if self.state.lock().unwrap().stopped {
                        return;
                    }
                    if rejected {
                        rejected_in_a_row += 1;
                        if rejected_in_a_row >= LINK_REJECTED_GIVE_UP {
                            self.state.lock().unwrap().stopped = true;
                            (self.opts.log)(&format!(
                                "[relay] 오퍼레이터가 {LINK_REJECTED_GIVE_UP}번 연달아 받아 주지 않았다 — 장부에서 빠진 러너로 보고 물러난다"
                            ));
                            (self.opts.on_rejected_give_up)();
                            return;
                        }
                        if rejected_in_a_row == 1 {
                            (self.opts.log)(&format!(
                                "[relay] 오퍼레이터가 이 러너를 받아 주지 않는다(모르는 러너) — 물러나며 다시 시도한다, {LINK_REJECTED_GIVE_UP}번 연달아면 끝낸다"
                            ));
                        }
                        if !self.sleep_unless_stopped(reject_backoff) {
                            return;
                        }
                        reject_backoff = next_backoff_ms(reject_backoff);
                        continue;
                    }
                    rejected_in_a_row = 0;
                    reject_backoff = initial;
                    if !self.sleep_unless_stopped(backoff) {
                        return;
                    }
                    backoff = next_backoff_ms(backoff);
                }
            }
        }
    }
}
