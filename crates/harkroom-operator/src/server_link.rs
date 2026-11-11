//! 서버 링크(S2 s21a) — `/operator` WS 클라이언트. 정본은 `packages/operator/src/serverLink.ts`.
//!
//! TS 와 같은 것: 재접속 backoff(1초에서 두 배, 30초 천장), **서버 ping 침묵으로 서버 죽음 판정**(기본 75초),
//! 연결마다 새로 만드는 hello, 모르는 서버 프레임은 버림, 닫힘 한 줄(`describe_close`).
//!
//! TS 와 다른 것(구조): 오퍼레이터가 std::thread 구조라 링크는 스레드 하나가 소켓을 쥔다. 읽기는 짧은 read timeout 으로
//! 돌고, 그 사이에 보낼 줄(`send` 가 큐에 넣은 것)을 비운다. `send` 는 TS 처럼 「붙어 있어 큐에 넣었는가」까지다.
//!
//! 전송은 `Dialer`·`Conn` 으로 주입한다 — 시험이 소켓 없이 backoff·침묵·hello 순서를 잰다.
use harkroom_proto::p2::{OperatorToServerFrame, ServerToOperatorFrame};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const BACKOFF_CEILING_MS: u64 = 30_000;

/// 한 번 읽기의 결과.
#[derive(Debug, PartialEq)]
pub enum ReadEvent {
    Text(String),
    Ping,
    /// read timeout — 아무것도 안 왔다.
    Idle,
    /// 이 연결의 끝(닫힘 사유 한 줄).
    Closed(String),
}

pub trait Conn: Send {
    fn read(&mut self) -> ReadEvent;
    fn send(&mut self, text: &str) -> Result<(), String>;
    fn close(&mut self);
}

pub trait Dialer: Send {
    fn dial(&mut self, url: &str, token: &str) -> Result<Box<dyn Conn>, String>;
}

pub trait Clock: Send {
    fn now_ms(&self) -> u64;
    fn sleep_ms(&self, ms: u64);
}

pub struct SystemClock;
impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
    fn sleep_ms(&self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

/// TS `operatorUrl` — 끝 `/` 를 떼고 `http` → `ws` 로.
pub fn operator_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    let ws = match trimmed.strip_prefix("http") {
        Some(rest) => format!("ws{rest}"),
        None => trimmed.to_string(),
    };
    format!("{ws}/operator")
}

/// 줄을 깨지 않게 공백을 하나로 접고 앞뒤를 자른 뒤 120자(UTF-16 이 아니라 글자 단위)로 자른다.
fn one_line(s: &str, max: usize) -> String {
    let folded = s.split_whitespace().collect::<Vec<_>>().join(" ");
    folded.chars().take(max).collect()
}

/// TS `describeClose`.
pub fn describe_close(
    code: u16,
    reason: &str,
    since_last_ping_ms: Option<u64>,
    error: Option<&str>,
) -> String {
    let mut parts = vec![format!("close {code}")];
    let r = one_line(reason, 120);
    if !r.is_empty() {
        parts.push(r);
    }
    if let Some(e) = error {
        parts.push(format!("오류 {}", one_line(e, 120)));
    }
    parts.push(match since_last_ping_ms {
        None => "서버 ping 받은 적 없음".to_string(),
        Some(ms) => format!(
            "마지막 서버 ping {}초 전",
            (ms as f64 / 1000.0).round() as u64
        ),
    });
    parts.join(", ")
}

pub type CloseHook = Box<dyn Fn(&str) + Send>;

pub struct ServerLinkOptions {
    pub base_url: String,
    pub token: String,
    pub hello: Box<dyn Fn() -> OperatorToServerFrame + Send>,
    pub on_frame: Box<dyn Fn(ServerToOperatorFrame) + Send>,
    pub on_open: Option<Box<dyn Fn() + Send>>,
    pub on_close: Option<CloseHook>,
    pub initial_backoff_ms: u64,
    pub silence_ms: u64,
}

impl ServerLinkOptions {
    pub fn new(
        base_url: impl Into<String>,
        token: impl Into<String>,
        hello: Box<dyn Fn() -> OperatorToServerFrame + Send>,
        on_frame: Box<dyn Fn(ServerToOperatorFrame) + Send>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            token: token.into(),
            hello,
            on_frame,
            on_open: None,
            on_close: None,
            initial_backoff_ms: 1_000,
            silence_ms: 75_000,
        }
    }
}

impl std::fmt::Debug for ServerLinkOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerLinkOptions")
            .field("base_url", &self.base_url)
            .field("token", &"<redacted>")
            .field("initial_backoff_ms", &self.initial_backoff_ms)
            .field("silence_ms", &self.silence_ms)
            .finish()
    }
}

/// 링크 손잡이. `run` 은 링크 스레드에서 돈다(멈출 때까지 돌아오지 않는다).
#[derive(Clone)]
pub struct ServerLink {
    connected: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    outbox: Arc<Mutex<Option<Sender<String>>>>,
}

impl Default for ServerLink {
    fn default() -> Self {
        Self::new()
    }
}

impl ServerLink {
    pub fn new() -> Self {
        Self {
            connected: Arc::new(AtomicBool::new(false)),
            stopped: Arc::new(AtomicBool::new(false)),
            outbox: Arc::new(Mutex::new(None)),
        }
    }

    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }

    /// 보냈는가(큐에 넣었는가)까지다 — 안 붙어 있으면 false.
    pub fn send(&self, frame: &OperatorToServerFrame) -> bool {
        if !self.connected() {
            return false;
        }
        let Ok(text) = serde_json::to_string(frame) else {
            return false;
        };
        let guard = self.outbox.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(tx) => tx.send(text).is_ok(),
            None => false,
        }
    }

    /// 접속·재접속 고리. `stop` 뒤 현재 연결을 닫고 돌아온다.
    pub fn run(&self, opts: &ServerLinkOptions, dialer: &mut dyn Dialer, clock: &dyn Clock) {
        let url = operator_url(&opts.base_url);
        let mut backoff = opts.initial_backoff_ms;
        let tick_ms = (opts.silence_ms / 3).min(10_000);
        while !self.stopped.load(Ordering::SeqCst) {
            let reason = match dialer.dial(&url, &opts.token) {
                Err(e) => e,
                Ok(mut conn) => {
                    backoff = opts.initial_backoff_ms;
                    self.serve_conn(opts, conn.as_mut(), clock, tick_ms)
                }
            };
            self.connected.store(false, Ordering::SeqCst);
            *self.outbox.lock().unwrap_or_else(|e| e.into_inner()) = None;
            if let Some(cb) = &opts.on_close {
                cb(&reason);
            }
            if self.stopped.load(Ordering::SeqCst) {
                break;
            }
            // 다음 값을 먼저 정한다(TS 와 같은 순서).
            let delay = backoff;
            backoff = (backoff * 2).min(BACKOFF_CEILING_MS);
            clock.sleep_ms(delay);
        }
    }

    fn serve_conn(
        &self,
        opts: &ServerLinkOptions,
        conn: &mut dyn Conn,
        clock: &dyn Clock,
        tick_ms: u64,
    ) -> String {
        let hello = match serde_json::to_string(&(opts.hello)()) {
            Ok(h) => h,
            Err(e) => {
                conn.close();
                return format!("hello 직렬화 실패: {e}");
            }
        };
        if let Err(e) = conn.send(&hello) {
            conn.close();
            return e;
        }
        let (tx, rx): (Sender<String>, Receiver<String>) = channel();
        *self.outbox.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
        self.connected.store(true, Ordering::SeqCst);
        if let Some(cb) = &opts.on_open {
            cb();
        }
        let mut last_ping = clock.now_ms();
        let mut next_tick = last_ping + tick_ms;
        loop {
            if self.stopped.load(Ordering::SeqCst) {
                conn.close();
                return "stopped".to_string();
            }
            while let Ok(text) = rx.try_recv() {
                if let Err(e) = conn.send(&text) {
                    conn.close();
                    return e;
                }
            }
            match conn.read() {
                ReadEvent::Text(raw) => {
                    if let Ok(frame) = serde_json::from_str::<ServerToOperatorFrame>(&raw) {
                        (opts.on_frame)(frame);
                    }
                }
                ReadEvent::Ping => last_ping = clock.now_ms(),
                ReadEvent::Idle => {}
                ReadEvent::Closed(reason) => return reason,
            }
            let now = clock.now_ms();
            if now >= next_tick {
                if now.saturating_sub(last_ping) > opts.silence_ms {
                    conn.close();
                    return describe_close(1006, "", Some(now - last_ping), Some("서버 ping 침묵"));
                }
                next_tick = now + tick_ms;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harkroom_proto::p2::ProtocolOne;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicU64;

    #[test]
    fn url_and_close_line() {
        assert_eq!(
            operator_url("https://h.example/"),
            "wss://h.example/operator"
        );
        assert_eq!(
            operator_url("http://127.0.0.1:3000//"),
            "ws://127.0.0.1:3000/operator"
        );
        assert_eq!(
            describe_close(1006, "  a\n b ", Some(31_400), Some("x\ty")),
            "close 1006, a b, 오류 x y, 마지막 서버 ping 31초 전"
        );
        assert_eq!(
            describe_close(1001, "", None, None),
            "close 1001, 서버 ping 받은 적 없음"
        );
    }

    #[derive(Clone)]
    struct FakeClock(Arc<AtomicU64>, Arc<Mutex<Vec<u64>>>);
    impl Clock for FakeClock {
        fn now_ms(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
        fn sleep_ms(&self, ms: u64) {
            self.1.lock().unwrap().push(ms);
            self.0.fetch_add(ms, Ordering::SeqCst);
        }
    }

    struct ScriptConn {
        events: VecDeque<ReadEvent>,
        sent: Arc<Mutex<Vec<String>>>,
        clock: FakeClock,
        step_ms: u64,
    }
    impl Conn for ScriptConn {
        fn read(&mut self) -> ReadEvent {
            self.clock.0.fetch_add(self.step_ms, Ordering::SeqCst);
            self.events.pop_front().unwrap_or(ReadEvent::Idle)
        }
        fn send(&mut self, text: &str) -> Result<(), String> {
            self.sent.lock().unwrap().push(text.to_string());
            Ok(())
        }
        fn close(&mut self) {}
    }

    /// 다이얼 n 번: 앞의 실패 수만큼 실패, 그 뒤 스크립트 연결 하나, 그 뒤 link 를 멈춘다.
    struct ScriptDialer {
        fails: usize,
        conns: VecDeque<ScriptConn>,
        link: ServerLink,
        dials: Arc<Mutex<Vec<String>>>,
    }
    impl Dialer for ScriptDialer {
        fn dial(&mut self, url: &str, _token: &str) -> Result<Box<dyn Conn>, String> {
            self.dials.lock().unwrap().push(url.to_string());
            if self.fails > 0 {
                self.fails -= 1;
                return Err("refused".into());
            }
            match self.conns.pop_front() {
                Some(c) => Ok(Box::new(c)),
                None => {
                    self.link.stop();
                    Err("done".into())
                }
            }
        }
    }

    fn hello() -> OperatorToServerFrame {
        OperatorToServerFrame::Hello {
            protocol: ProtocolOne,
            capabilities: json!({}),
            runners: vec![],
            sessions: vec![],
            version: None,
        }
    }

    #[test]
    fn backoff_doubles_to_ceiling_and_resets_after_open() {
        let clock = FakeClock(Arc::new(AtomicU64::new(0)), Arc::new(Mutex::new(vec![])));
        let link = ServerLink::new();
        let sent = Arc::new(Mutex::new(vec![]));
        let conn = ScriptConn {
            events: VecDeque::from([ReadEvent::Closed("close 1001".into())]),
            sent: sent.clone(),
            clock: clock.clone(),
            step_ms: 1,
        };
        let mut dialer = ScriptDialer {
            fails: 7,
            conns: VecDeque::from([conn]),
            link: link.clone(),
            dials: Arc::new(Mutex::new(vec![])),
        };
        let opts =
            ServerLinkOptions::new("https://h.example", "t", Box::new(hello), Box::new(|_| {}));
        link.run(&opts, &mut dialer, &clock);
        let sleeps = clock.1.lock().unwrap().clone();
        // 실패 7번: 1,2,4,8,16,30,30 → 연결 뒤 끊김: 다시 1 → 마지막 dial 이 멈춤
        assert_eq!(
            sleeps,
            vec![1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 1_000]
        );
        assert_eq!(dialer.dials.lock().unwrap()[0], "wss://h.example/operator");
        let first = sent.lock().unwrap()[0].clone();
        assert!(first.contains("\"type\":\"hello\""), "{first}");
        assert!(!link.connected());
    }

    #[test]
    fn silence_closes_and_ping_keeps_alive_and_frames_parse() {
        let clock = FakeClock(Arc::new(AtomicU64::new(0)), Arc::new(Mutex::new(vec![])));
        let link = ServerLink::new();
        let sent = Arc::new(Mutex::new(vec![]));
        let mut events = VecDeque::new();
        events.push_back(ReadEvent::Text("not json".into()));
        events.push_back(ReadEvent::Text(json!({"type": "nope"}).to_string()));
        events.push_back(ReadEvent::Text(
            json!({"type": "runner.kill", "runnerId": "r1"}).to_string(),
        ));
        // 60초 동안 ping 이 매 20초 — 살아 있다. 그 뒤 침묵.
        for _ in 0..3 {
            events.push_back(ReadEvent::Ping);
        }
        let conn = ScriptConn {
            events,
            sent,
            clock: clock.clone(),
            step_ms: 20_000,
        };
        let mut dialer = ScriptDialer {
            fails: 0,
            conns: VecDeque::from([conn]),
            link: link.clone(),
            dials: Arc::new(Mutex::new(vec![])),
        };
        let frames = Arc::new(Mutex::new(vec![]));
        let f2 = frames.clone();
        let closes = Arc::new(Mutex::new(vec![]));
        let c2 = closes.clone();
        let mut opts = ServerLinkOptions::new(
            "http://127.0.0.1:1",
            "t",
            Box::new(hello),
            Box::new(move |f| f2.lock().unwrap().push(f)),
        );
        opts.on_close = Some(Box::new(move |r| c2.lock().unwrap().push(r.to_string())));
        link.run(&opts, &mut dialer, &clock);
        assert_eq!(
            *frames.lock().unwrap(),
            vec![ServerToOperatorFrame::RunnerKill {
                runner_id: "r1".into()
            }]
        );
        let first_close = closes.lock().unwrap()[0].clone();
        assert!(first_close.contains("서버 ping 침묵"), "{first_close}");
        // ping 마지막(120초) 뒤 75초를 넘긴 때 끊겼다 — 그 전에는 끊지 않았다.
        assert!(clock.now_ms() > 120_000 + 75_000);
    }

    #[test]
    fn send_only_while_connected_and_debug_hides_token() {
        let link = ServerLink::new();
        assert!(!link.send(&hello()));
        let opts =
            ServerLinkOptions::new("https://h", "sekret-xyz", Box::new(hello), Box::new(|_| {}));
        let d = format!("{opts:?}");
        assert!(!d.contains("sekret-xyz") && d.contains("<redacted>"), "{d}");
    }
}
