//! `harkroom-operator-rs mcp-bridge` — 하네스와 오퍼레이터 사이의 stdio 파이프(TS `mcpBridge.ts` 이식, s21b-2b).
//!
//! stdin 의 JSON-RPC 한 줄 → 오퍼레이터 소켓에 `mcp.request{id, payload}` · 소켓의 `mcp.response` → 그 안의
//! 메시지들을 stdout 에 한 줄씩 · `mcp.error` → 그 요청의 JSON-RPC 오류 한 줄. **해석하지 않는다** — JSON 인지만 본다.
//!
//! 정본의 규칙을 그대로 지킨다(까닭은 `mcpBridge.ts` 머리 주석):
//! - 소켓이 끊겨도 끝내지 않는다. 같은 경로에 백오프(200ms → 5초)로 다시 붙고, **stdin 이 닫힐 때만** 끝난다.
//! - 끊긴 순간 소켓에 나간 요청은 「처리됐는지 모른다」 오류로 답하고 다시 보내지 않는다(같은 말이 두 번 나가지 않게).
//!   아직 못 나간 줄은 큐에 두었다가 다시 붙으면 그대로 보낸다.
//! - 그 연결의 **첫 프레임**이 `link.rejected` 면 그 연결로 나간 줄은 처리되지 않은 것이 확실하다 → 큐로 되돌린다.
//! - 링크가 `LINK_DOWN_GRACE` 넘게 없으면 그때부터는 바로 거절한다. 요청 하나는 `REQUEST_TIMEOUT` 을 넘기면 오류로 답한다
//!   (시한은 stdin 에 들어온 순간부터 잰다).
//! - 한 줄 상한을 넘는 요청은 보내지 않고 그 요청만 거절한다(오퍼레이터가 받으면 링크째 끊는다).
//!
//! 구조: 오퍼레이터 Rust 는 std::thread 구조다. 상태는 사건 고리(`run_loop`) 하나가 쥐고, stdin 읽기·소켓 읽기·접속은
//! 각자 스레드에서 사건을 보낸다. 시한은 고리의 짧은 틱으로 잰다(타이머 스레드를 요청마다 띄우지 않는다).
use crate::runner_link::RUNNER_LINK_MAX_LINE_BYTES;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

pub const REQUEST_TIMEOUT: Duration = Duration::from_millis(90_000);
pub const RECONNECT_INITIAL: Duration = Duration::from_millis(200);
pub const RECONNECT_MAX: Duration = Duration::from_millis(5_000);
pub const LINK_DOWN_GRACE: Duration = Duration::from_millis(15_000);
/// relay 의 `LINK_DOWN_MESSAGE` 와 같은 뜻(정본 문구 그대로).
pub const LINK_DOWN_MESSAGE: &str = "오퍼레이터 링크가 없다 — 재접속 중이다. 잠시 뒤 다시 불러라";
const DISCONNECT_MESSAGE: &str = "오퍼레이터 링크가 끊겼다(오퍼레이터 교체·재시작) — 이 요청이 처리됐는지는 알 수 없다. 결과를 확인한 뒤에 다시 불러라. 링크는 곧 스스로 다시 붙는다";
const TICK: Duration = Duration::from_millis(20);

pub const ENV_SOCKET: &str = "HARKROOM_OPERATOR_SOCKET";
pub const ENV_RUNNER_ID: &str = "HARKROOM_RUNNER_ID";
pub const ENV_SECRET: &str = "HARKROOM_RUNNER_SECRET";
pub const ENV_BRIDGE_KEY: &str = "HARKROOM_TURN_BRIDGE_KEY";
pub const ENV_CAUSE: &str = "HARKROOM_TURN_CAUSE";
pub const ENV_TURN_ID: &str = "HARKROOM_TURN_ID";
pub const ENV_READY_FILE: &str = "HARKROOM_MCP_READY_FILE";

/// 브릿지가 붙는 자리와 자격. 자격은 `secret` 또는 `turn_key` 하나 — 둘 다 있으면 턴 열쇠로 붙는다(정본과 같음).
#[derive(Clone)]
pub struct BridgeLink {
    pub socket_path: String,
    pub runner_id: String,
    pub secret: Option<String>,
    pub turn_key: Option<String>,
    pub cause: Option<String>,
    pub turn_id: Option<String>,
    pub cwd: Option<String>,
    /// `tools/list` 첫 답 때 만들 표식 파일(러너가 기다린다). 없으면 안 만든다.
    pub ready_file: Option<String>,
    /// hello 의 kind — 하네스 MCP 는 `bridge`.
    pub kind: &'static str,
}

/// secret·턴 열쇠는 로그·`{:?}` 에 나가지 않는다.
impl std::fmt::Debug for BridgeLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BridgeLink")
            .field("socket_path", &self.socket_path)
            .field("runner_id", &self.runner_id)
            .field("secret", &self.secret.as_ref().map(|_| "<redacted>"))
            .field("turn_key", &self.turn_key.as_ref().map(|_| "<redacted>"))
            .field("kind", &self.kind)
            .finish()
    }
}

impl BridgeLink {
    /// env 에서 읽는다. 소켓·러너 id·(secret 또는 다리 열쇠)가 없으면 `None`(정본: exit 2).
    pub fn from_env(get: impl Fn(&str) -> Option<String>, cwd: Option<String>) -> Option<Self> {
        let nonempty = |k: &str| get(k).filter(|v| !v.is_empty());
        let socket_path = nonempty(ENV_SOCKET)?;
        let runner_id = nonempty(ENV_RUNNER_ID)?;
        let secret = nonempty(ENV_SECRET);
        let turn_key = nonempty(ENV_BRIDGE_KEY);
        if secret.is_none() && turn_key.is_none() {
            return None;
        }
        Some(Self {
            socket_path,
            runner_id,
            secret,
            turn_key,
            cause: nonempty(ENV_CAUSE),
            turn_id: nonempty(ENV_TURN_ID),
            cwd,
            ready_file: nonempty(ENV_READY_FILE),
            kind: "bridge",
        })
    }

    fn hello(&self) -> Value {
        let mut h =
            json!({ "type": "hello", "version": 1, "role": "runner", "runnerId": self.runner_id });
        match &self.turn_key {
            Some(k) => h["turnKey"] = Value::String(k.clone()),
            None => h["secret"] = Value::String(self.secret.clone().unwrap_or_default()),
        }
        h["kind"] = Value::String(self.kind.to_string());
        h
    }
}

/// 시한·재접속 간격. 기본값을 쓰는 것이 정상이고 바꾸는 것은 시험 몫이다.
#[derive(Clone, Copy, Debug)]
pub struct BridgeTuning {
    pub request_timeout: Duration,
    pub reconnect_initial: Duration,
    pub reconnect_max: Duration,
    pub link_down_grace: Duration,
    pub max_line_bytes: usize,
}

impl Default for BridgeTuning {
    fn default() -> Self {
        Self {
            request_timeout: REQUEST_TIMEOUT,
            reconnect_initial: RECONNECT_INITIAL,
            reconnect_max: RECONNECT_MAX,
            link_down_grace: LINK_DOWN_GRACE,
            max_line_bytes: RUNNER_LINK_MAX_LINE_BYTES,
        }
    }
}

enum Event {
    Stdin(Vec<u8>),
    StdinEnd,
    /// 접속 시도 결과. `gen` 은 그 시도의 세대.
    Connected(u64, UnixStream),
    ConnectFailed(u64),
    SocketLine(u64, Vec<u8>),
    SocketClosed(u64),
}

struct Pending {
    rpc_id: Value,
    deadline: Instant,
    tools_list: bool,
}

/// 줄을 상한 안에서 읽어 사건으로 보낸다. 상한을 넘은 줄은 버리고(`over` 콜백) 다음 줄부터 이어 간다.
fn pump_lines<R: Read>(
    r: R,
    max: usize,
    mut emit: impl FnMut(Vec<u8>) -> bool,
    mut over: impl FnMut(),
) {
    let mut reader = BufReader::new(r);
    let mut buf = Vec::new();
    let mut skipping = false;
    loop {
        let chunk = match reader.fill_buf() {
            Ok([]) | Err(_) => return,
            Ok(c) => c,
        };
        let (take, newline) = match chunk.iter().position(|&b| b == b'\n') {
            Some(i) => (i + 1, true),
            None => (chunk.len(), false),
        };
        if !skipping {
            let body = if newline { &chunk[..take - 1] } else { chunk };
            if buf.len() + body.len() > max {
                skipping = true;
                buf.clear();
                over();
            } else {
                buf.extend_from_slice(body);
            }
        }
        reader.consume(take);
        if newline {
            if !skipping && !emit(std::mem::take(&mut buf)) {
                return;
            }
            buf.clear();
            skipping = false;
        }
    }
}

fn new_link_id() -> String {
    crate::runners::new_incarnation_id().unwrap_or_else(|_| {
        // /dev/urandom 을 못 읽는 일은 사실상 없다 — 그래도 상관만 지키면 되니 시각으로 대신한다.
        format!("b-{}", Instant::now().elapsed().as_nanos())
    })
}

/// 브릿지 본체. stdin 이 닫히면 돌아온다.
pub fn run_bridge<R, W, E>(link: BridgeLink, stdin: R, stdout: W, stderr: E, tuning: BridgeTuning)
where
    R: Read + Send + 'static,
    W: Write,
    E: Write,
{
    let (tx, rx) = channel::<Event>();
    {
        let tx = tx.clone();
        let max = tuning.max_line_bytes;
        std::thread::spawn(move || {
            let tx2 = tx.clone();
            pump_lines(
                stdin,
                max,
                |l| tx.send(Event::Stdin(l)).is_ok(),
                || {
                    // 상한을 넘긴 줄은 JSON-RPC id 를 모른다 — 답할 수 없으니 표시만 한다(빈 줄 = 넘친 줄).
                    let _ = tx2.send(Event::Stdin(Vec::new()));
                },
            );
            let _ = tx.send(Event::StdinEnd);
        });
    }
    run_loop(link, tx, rx, stdout, stderr, tuning);
}

fn spawn_connect(path: String, gen_id: u64, tx: Sender<Event>, delay: Duration) {
    std::thread::spawn(move || {
        if !delay.is_zero() {
            std::thread::sleep(delay);
        }
        match UnixStream::connect(&path) {
            Ok(s) => {
                let _ = tx.send(Event::Connected(gen_id, s));
            }
            Err(_) => {
                let _ = tx.send(Event::ConnectFailed(gen_id));
            }
        }
    });
}

fn spawn_reader(stream: UnixStream, gen_id: u64, tx: Sender<Event>, max: usize) {
    std::thread::spawn(move || {
        let tx2 = tx.clone();
        pump_lines(
            stream,
            max,
            |l| tx.send(Event::SocketLine(gen_id, l)).is_ok(),
            // 오퍼레이터가 상한을 넘는 줄을 보냈다 — 그 줄만 버린다(정본: decoder 오류 줄을 버림).
            || {},
        );
        let _ = tx2.send(Event::SocketClosed(gen_id));
    });
}

fn run_loop<W: Write, E: Write>(
    link: BridgeLink,
    tx: Sender<Event>,
    rx: Receiver<Event>,
    mut stdout: W,
    mut stderr: E,
    t: BridgeTuning,
) {
    let mut pending: HashMap<String, Pending> = HashMap::new();
    let mut queued: VecDeque<(String, String)> = VecDeque::new();
    let mut sent_unconfirmed: Vec<(String, String)> = Vec::new();
    let mut socket: Option<UnixStream> = None;
    let mut gen_id: u64 = 0;
    let mut frames_this_link: u64 = 0;
    let mut reconnect_delay = t.reconnect_initial;
    let mut delay_before_connect = t.reconnect_initial;
    let mut link_down_hard = false;
    let mut grace_deadline: Option<Instant> = None;
    let mut tools_listed = false;

    macro_rules! out {
        ($v:expr) => {{
            let _ = writeln!(stdout, "{}", $v);
            let _ = stdout.flush();
        }};
    }
    macro_rules! note {
        ($($a:tt)*) => {{
            let _ = writeln!(stderr, $($a)*);
        }};
    }
    let answer_error = |out: &mut W, rpc: &Value, msg: &str| {
        if rpc.is_null() {
            return;
        }
        let _ = writeln!(
            out,
            "{}",
            json!({ "jsonrpc": "2.0", "id": rpc, "error": { "code": -32000, "message": msg } })
        );
        let _ = out.flush();
    };

    spawn_connect(link.socket_path.clone(), gen_id, tx.clone(), Duration::ZERO);

    loop {
        let ev = match rx.recv_timeout(TICK) {
            Ok(e) => Some(e),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
            Err(_) => return,
        };
        let now = Instant::now();
        match ev {
            None => {}
            Some(Event::StdinEnd) => {
                if let Some(s) = socket.take() {
                    let _ = s.shutdown(std::net::Shutdown::Both);
                }
                return;
            }
            Some(Event::Stdin(line)) => {
                if line.is_empty() {
                    note!("하네스 stdin 에서 버린 줄: 한 줄 상한을 넘었다");
                    continue;
                }
                let payload: Value = match serde_json::from_slice(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        note!("하네스 stdin 에서 버린 줄: {e}");
                        continue;
                    }
                };
                let rpc_id = payload
                    .as_object()
                    .and_then(|o| o.get("id"))
                    .cloned()
                    .unwrap_or(Value::Null);
                if link_down_hard {
                    answer_error(&mut stdout, &rpc_id, LINK_DOWN_MESSAGE);
                    continue;
                }
                let tools_list = !rpc_id.is_null()
                    && payload.get("method").and_then(Value::as_str) == Some("tools/list");
                let id = new_link_id();
                let mut req = json!({ "type": "mcp.request", "id": id, "payload": payload });
                if let Some(c) = &link.cause {
                    req["cause"] = Value::String(c.clone());
                }
                if let Some(c) = &link.turn_id {
                    req["turnId"] = Value::String(c.clone());
                }
                if let Some(c) = &link.cwd {
                    req["cwd"] = Value::String(c.clone());
                }
                let text = format!("{req}\n");
                let bytes = text.len() - 1;
                if bytes > t.max_line_bytes {
                    answer_error(
                        &mut stdout,
                        &rpc_id,
                        &format!(
                            "요청이 {bytes} 바이트로 러너 링크 한 줄 상한({} 바이트)을 넘어 보내지 않았다",
                            t.max_line_bytes
                        ),
                    );
                    continue;
                }
                pending.insert(
                    id.clone(),
                    Pending {
                        rpc_id,
                        deadline: now + t.request_timeout,
                        tools_list,
                    },
                );
                match socket.as_mut() {
                    Some(s) => {
                        let _ = s.write_all(text.as_bytes());
                        if frames_this_link == 0 {
                            sent_unconfirmed.push((id, text));
                        }
                    }
                    None => queued.push_back((id, text)),
                }
            }
            Some(Event::ConnectFailed(g)) => {
                if g != gen_id {
                    continue;
                }
                // 접속을 못 했다 — 나간 요청이 없으니 큐는 그대로. 유예 시계는 끊긴 동안 한 번만 건다.
                if grace_deadline.is_none() && !link_down_hard {
                    grace_deadline = Some(now + t.link_down_grace);
                }
                gen_id += 1;
                let delay = reconnect_delay;
                reconnect_delay = (reconnect_delay * 2).min(t.reconnect_max);
                spawn_connect(link.socket_path.clone(), gen_id, tx.clone(), delay);
            }
            Some(Event::Connected(g, mut s)) => {
                if g != gen_id {
                    continue;
                }
                link_down_hard = false;
                grace_deadline = None;
                delay_before_connect = reconnect_delay;
                reconnect_delay = t.reconnect_initial;
                frames_this_link = 0;
                let _ = s.write_all(format!("{}\n", link.hello()).as_bytes());
                sent_unconfirmed = queued.drain(..).collect();
                for (_, line) in &sent_unconfirmed {
                    let _ = s.write_all(line.as_bytes());
                }
                if let Ok(r) = s.try_clone() {
                    spawn_reader(r, gen_id, tx.clone(), t.max_line_bytes);
                }
                socket = Some(s);
            }
            Some(Event::SocketLine(g, line)) => {
                if g != gen_id {
                    continue;
                }
                let v: Value = match serde_json::from_slice(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        note!("오퍼레이터 소켓에서 버린 줄: {e}");
                        continue;
                    }
                };
                let first = frames_this_link == 0;
                frames_this_link += 1;
                if v.get("type").and_then(Value::as_str) == Some("link.rejected") {
                    if !first {
                        continue;
                    }
                    // 거절된 연결로 나간 줄은 나간 적이 없는 것과 같다 — 큐 앞으로 되돌린다.
                    let back: Vec<_> = sent_unconfirmed
                        .drain(..)
                        .filter(|(id, _)| pending.contains_key(id))
                        .collect();
                    for item in back.into_iter().rev() {
                        queued.push_front(item);
                    }
                    reconnect_delay = delay_before_connect;
                    if let Some(s) = socket.take() {
                        let _ = s.shutdown(std::net::Shutdown::Both);
                    }
                    // 읽기 스레드가 곧 SocketClosed 를 보낸다 — 그때 다음 접속을 건다(되돌린 지연으로).
                    continue;
                }
                sent_unconfirmed.clear();
                let ty = v.get("type").and_then(Value::as_str);
                let Some(id) = v.get("id").and_then(Value::as_str) else {
                    continue;
                };
                if ty != Some("mcp.response") && ty != Some("mcp.error") {
                    continue;
                }
                let Some(entry) = pending.remove(id) else {
                    continue;
                };
                if ty == Some("mcp.response") {
                    if let Some(msgs) = v.get("messages").and_then(Value::as_array) {
                        for m in msgs {
                            out!(m);
                        }
                    }
                    if entry.tools_list && !tools_listed {
                        tools_listed = true;
                        if let Some(p) = &link.ready_file {
                            write_ready_marker(p);
                        }
                    }
                } else {
                    let status = v.get("status").and_then(Value::as_i64).unwrap_or(0);
                    let msg = v.get("message").and_then(Value::as_str).unwrap_or("");
                    answer_error(
                        &mut stdout,
                        &entry.rpc_id,
                        &format!("harkroom 서버가 거절했다 ({status}): {msg}"),
                    );
                }
            }
            Some(Event::SocketClosed(g)) => {
                if g != gen_id {
                    continue;
                }
                let was = socket.take().is_some();
                // 보낸(= 큐에 없는) 요청은 처리됐는지 모른다 — 실패로 답하고 다시 보내지 않는다.
                let not_sent: std::collections::HashSet<String> =
                    queued.iter().map(|(id, _)| id.clone()).collect();
                let lost: Vec<String> = pending
                    .keys()
                    .filter(|id| !not_sent.contains(*id))
                    .cloned()
                    .collect();
                for id in lost {
                    if let Some(p) = pending.remove(&id) {
                        answer_error(&mut stdout, &p.rpc_id, DISCONNECT_MESSAGE);
                    }
                }
                sent_unconfirmed.clear();
                if was {
                    note!("오퍼레이터 링크가 끊겼다 — 다시 붙는다");
                }
                if grace_deadline.is_none() && !link_down_hard {
                    grace_deadline = Some(now + t.link_down_grace);
                }
                gen_id += 1;
                let delay = reconnect_delay;
                reconnect_delay = (reconnect_delay * 2).min(t.reconnect_max);
                spawn_connect(link.socket_path.clone(), gen_id, tx.clone(), delay);
            }
        }

        // 시계: 유예와 요청 시한.
        if let Some(d) = grace_deadline
            && now >= d
        {
            grace_deadline = None;
            if socket.is_none() {
                link_down_hard = true;
                for (id, _) in queued.drain(..) {
                    if let Some(p) = pending.remove(&id) {
                        answer_error(&mut stdout, &p.rpc_id, LINK_DOWN_MESSAGE);
                    }
                }
                note!(
                    "오퍼레이터 링크가 {}ms 째 없다 — 이제부터 요청을 바로 거절한다",
                    t.link_down_grace.as_millis()
                );
            }
        }
        let expired: Vec<String> = pending
            .iter()
            .filter(|(_, p)| now >= p.deadline)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            if let Some(p) = pending.remove(&id) {
                queued.retain(|(q, _)| q != &id);
                answer_error(
                    &mut stdout,
                    &p.rpc_id,
                    &format!(
                        "harkroom 오퍼레이터가 {}ms 안에 답하지 않았다 — 이 요청이 처리됐는지는 알 수 없다. 결과를 확인한 뒤에 다시 불러라",
                        t.request_timeout.as_millis()
                    ),
                );
            }
        }
    }
}

/// 러너가 기다리는 표식. 이미 있거나 못 쓰면 그만이다(러너가 시한까지 기다린다).
pub fn write_ready_marker(path: &str) {
    let _ = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path);
}

/// `mcp-bridge` 하위 명령. 종료 코드를 돌려준다(env 가 모자라면 2 — 정본과 같음).
pub fn mcp_bridge_main() -> i32 {
    let cwd = std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let Some(link) = BridgeLink::from_env(|k| std::env::var(k).ok(), cwd) else {
        eprintln!(
            "mcp-bridge: {ENV_SOCKET}·{ENV_RUNNER_ID}·{ENV_SECRET} 이 필요하다 — 러너가 띄운 하네스 안에서만 돈다"
        );
        return 2;
    };
    run_bridge(
        link,
        std::io::stdin(),
        std::io::stdout(),
        std::io::stderr(),
        BridgeTuning::default(),
    );
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Sink {
        fn lines(&self) -> Vec<Value> {
            String::from_utf8_lossy(&self.0.lock().unwrap())
                .lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect()
        }
    }

    fn link(path: &str) -> BridgeLink {
        BridgeLink {
            socket_path: path.into(),
            runner_id: "r1".into(),
            secret: Some("s3cr3t-value".into()),
            turn_key: None,
            cause: Some("c1".into()),
            turn_id: Some("t1".into()),
            cwd: None,
            ready_file: None,
            kind: "bridge",
        }
    }

    fn fast() -> BridgeTuning {
        BridgeTuning {
            request_timeout: Duration::from_millis(1500),
            reconnect_initial: Duration::from_millis(20),
            reconnect_max: Duration::from_millis(80),
            link_down_grace: Duration::from_millis(300),
            max_line_bytes: 4096,
        }
    }

    fn tmp_sock(name: &str) -> String {
        let d = std::env::temp_dir().join(format!("hkbr-{}-{name}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        let p = d.join("s");
        let _ = std::fs::remove_file(&p);
        p.to_string_lossy().into_owned()
    }

    /// stdin 을 손으로 넣는 파이프.
    fn pipe() -> (UnixStream, UnixStream) {
        UnixStream::pair().unwrap()
    }

    #[test]
    fn debug_hides_credentials() {
        let s = format!("{:?}", link("/x"));
        assert!(!s.contains("s3cr3t-value"), "{s}");
        assert!(s.contains("<redacted>"));
    }

    #[test]
    fn from_env_needs_socket_runner_and_a_credential() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(a, _)| *a == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert!(
            BridgeLink::from_env(env(&[(ENV_SOCKET, "/s"), (ENV_RUNNER_ID, "r")]), None).is_none()
        );
        let l = BridgeLink::from_env(
            env(&[
                (ENV_SOCKET, "/s"),
                (ENV_RUNNER_ID, "r"),
                (ENV_SECRET, "x"),
                (ENV_BRIDGE_KEY, "k"),
            ]),
            None,
        )
        .unwrap();
        // 둘 다 있으면 턴 열쇠로 붙는다.
        let h = l.hello();
        assert_eq!(h["turnKey"], "k");
        assert!(h.get("secret").is_none());
        assert_eq!(h["kind"], "bridge");
    }

    #[test]
    fn relays_request_and_response_and_marks_tools_list() {
        let path = tmp_sock("ok");
        let listener = UnixListener::bind(&path).unwrap();
        let ready = std::env::temp_dir().join(format!("hkbr-ready-{}", std::process::id()));
        let _ = std::fs::remove_file(&ready);
        let srv = std::thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut w = s.try_clone().unwrap();
            let mut r = BufReader::new(s);
            let mut hello = String::new();
            r.read_line(&mut hello).unwrap();
            let mut req = String::new();
            r.read_line(&mut req).unwrap();
            let v: Value = serde_json::from_str(&req).unwrap();
            writeln!(
                w,
                "{}",
                json!({ "type": "mcp.response", "id": v["id"], "messages": [{ "jsonrpc": "2.0", "id": 7, "result": { "tools": [] } }] })
            )
            .unwrap();
            (serde_json::from_str::<Value>(&hello).unwrap(), v)
        });
        let (mut feed, stdin) = pipe();
        let out = Sink::default();
        let mut l = link(&path);
        l.ready_file = Some(ready.to_string_lossy().into_owned());
        let out2 = out.clone();
        let h = std::thread::spawn(move || run_bridge(l, stdin, out2, std::io::sink(), fast()));
        writeln!(feed, r#"{{"jsonrpc":"2.0","id":7,"method":"tools/list"}}"#).unwrap();
        let (hello, req) = srv.join().unwrap();
        for _ in 0..100 {
            if !out.lines().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(feed);
        h.join().unwrap();
        assert_eq!(hello["role"], "runner");
        assert_eq!(hello["secret"], "s3cr3t-value");
        assert_eq!(req["type"], "mcp.request");
        assert_eq!(req["cause"], "c1");
        assert_eq!(req["turnId"], "t1");
        assert_eq!(req["payload"]["method"], "tools/list");
        assert_eq!(
            out.lines(),
            vec![json!({ "jsonrpc": "2.0", "id": 7, "result": { "tools": [] } })]
        );
        assert!(ready.exists(), "tools/list 첫 답에 표식 파일을 만든다");
        let _ = std::fs::remove_file(&ready);
    }

    #[test]
    fn mcp_error_becomes_jsonrpc_error_and_notifications_get_no_answer() {
        let path = tmp_sock("err");
        let listener = UnixListener::bind(&path).unwrap();
        std::thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut w = s.try_clone().unwrap();
            let mut r = BufReader::new(s);
            let mut line = String::new();
            r.read_line(&mut line).unwrap(); // hello
            for _ in 0..2 {
                line.clear();
                r.read_line(&mut line).unwrap();
                let v: Value = serde_json::from_str(&line).unwrap();
                writeln!(
                    w,
                    "{}",
                    json!({ "type": "mcp.error", "id": v["id"], "status": 403, "message": "no" })
                )
                .unwrap();
            }
            std::thread::sleep(Duration::from_millis(300));
        });
        let (mut feed, stdin) = pipe();
        let out = Sink::default();
        let out2 = out.clone();
        let h = std::thread::spawn(move || {
            run_bridge(link(&path), stdin, out2, std::io::sink(), fast())
        });
        writeln!(
            feed,
            r#"{{"jsonrpc":"2.0","method":"notifications/initialized"}}"#
        )
        .unwrap();
        writeln!(
            feed,
            r#"{{"jsonrpc":"2.0","id":"a","method":"tools/call"}}"#
        )
        .unwrap();
        for _ in 0..100 {
            if !out.lines().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(feed);
        h.join().unwrap();
        let lines = out.lines();
        assert_eq!(lines.len(), 1, "알림에는 답하지 않는다: {lines:?}");
        assert_eq!(lines[0]["id"], "a");
        assert!(
            lines[0]["error"]["message"]
                .as_str()
                .unwrap()
                .contains("(403)")
        );
    }

    #[test]
    fn rejected_first_frame_requeues_and_next_link_delivers_once() {
        let path = tmp_sock("rej");
        let listener = UnixListener::bind(&path).unwrap();
        let srv = std::thread::spawn(move || {
            // 1번째 연결: hello 와 요청을 받고 거절만 한 뒤 끊는다(요청은 처리하지 않음).
            let (s, _) = listener.accept().unwrap();
            let mut w = s.try_clone().unwrap();
            let mut r = BufReader::new(s);
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            writeln!(
                w,
                "{}",
                json!({ "type": "link.rejected", "reason": "unknown" })
            )
            .unwrap();
            drop(w);
            drop(r);
            // 2번째 연결: 같은 요청이 그대로 다시 온다 → 답한다.
            let (s, _) = listener.accept().unwrap();
            let mut w = s.try_clone().unwrap();
            let mut r = BufReader::new(s);
            line.clear();
            r.read_line(&mut line).unwrap(); // hello
            line.clear();
            r.read_line(&mut line).unwrap();
            let v: Value = serde_json::from_str(&line).unwrap();
            writeln!(w, "{}", json!({ "type": "mcp.response", "id": v["id"], "messages": [{ "jsonrpc": "2.0", "id": 1, "result": {} }] })).unwrap();
            std::thread::sleep(Duration::from_millis(200));
        });
        let (mut feed, stdin) = pipe();
        let out = Sink::default();
        let out2 = out.clone();
        let h = std::thread::spawn(move || {
            run_bridge(link(&path), stdin, out2, std::io::sink(), fast())
        });
        writeln!(feed, r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call"}}"#).unwrap();
        for _ in 0..200 {
            if !out.lines().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        srv.join().unwrap();
        drop(feed);
        h.join().unwrap();
        assert_eq!(
            out.lines(),
            vec![json!({ "jsonrpc": "2.0", "id": 1, "result": {} })],
            "거절된 연결의 줄은 다음 연결로 한 번만 간다"
        );
    }

    #[test]
    fn sent_request_on_dropped_link_fails_with_unknown_and_is_not_resent() {
        let path = tmp_sock("drop");
        let listener = UnixListener::bind(&path).unwrap();
        let seen = Arc::new(Mutex::new(0usize));
        let seen2 = seen.clone();
        std::thread::spawn(move || {
            // 첫 프레임(ping 같은 무해한 줄)을 보내 「확인됨」으로 만든 뒤, 요청을 받고 답 없이 끊는다.
            let (s, _) = listener.accept().unwrap();
            let mut w = s.try_clone().unwrap();
            let mut r = BufReader::new(s);
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            writeln!(w, "{}", json!({ "type": "pong" })).unwrap();
            line.clear();
            r.read_line(&mut line).unwrap();
            *seen2.lock().unwrap() += 1;
            drop(w);
            drop(r);
            // 다시 붙어도 같은 요청이 오지 않아야 한다.
            if let Ok((s, _)) = listener.accept() {
                s.set_read_timeout(Some(Duration::from_millis(300)))
                    .unwrap();
                let mut r = BufReader::new(s);
                line.clear();
                let _ = r.read_line(&mut line); // hello
                line.clear();
                if r.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
                    *seen2.lock().unwrap() += 1;
                }
            }
        });
        let (mut feed, stdin) = pipe();
        let out = Sink::default();
        let out2 = out.clone();
        let h = std::thread::spawn(move || {
            run_bridge(link(&path), stdin, out2, std::io::sink(), fast())
        });
        std::thread::sleep(Duration::from_millis(150));
        writeln!(feed, r#"{{"jsonrpc":"2.0","id":9,"method":"tools/call"}}"#).unwrap();
        for _ in 0..200 {
            if !out.lines().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(500));
        drop(feed);
        h.join().unwrap();
        let lines = out.lines();
        assert_eq!(lines.len(), 1);
        assert!(
            lines[0]["error"]["message"]
                .as_str()
                .unwrap()
                .contains("처리됐는지는 알 수 없다")
        );
        assert_eq!(*seen.lock().unwrap(), 1, "다시 보내지 않는다");
    }

    #[test]
    fn no_operator_rejects_after_grace() {
        let path = tmp_sock("none");
        let (mut feed, stdin) = pipe();
        let out = Sink::default();
        let out2 = out.clone();
        let h = std::thread::spawn(move || {
            run_bridge(link(&path), stdin, out2, std::io::sink(), fast())
        });
        writeln!(feed, r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call"}}"#).unwrap();
        // 유예(300ms) 안에는 큐에 둔다 → 유예가 지나면 그 요청을 거절하고, 그 뒤 요청은 바로 거절한다.
        for _ in 0..100 {
            if !out.lines().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        writeln!(feed, r#"{{"jsonrpc":"2.0","id":2,"method":"tools/call"}}"#).unwrap();
        for _ in 0..100 {
            if out.lines().len() >= 2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(feed);
        h.join().unwrap();
        let lines = out.lines();
        assert_eq!(lines.len(), 2, "{lines:?}");
        for l in &lines {
            assert_eq!(l["error"]["message"], LINK_DOWN_MESSAGE);
        }
    }
}
