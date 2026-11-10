//! 앱(Tauri) ↔ 오퍼레이터 소켓 서버(경계 P3, S2 A2). 정본은 `packages/operator/src/server.ts`(`DaemonServer`)와
//! `packages/shared/src/daemonProtocol.ts`(`NdjsonDecoder`·`checkHello`·`tokensMatch`·`parseRequest`)다.
//!
//! A2 는 문지기(`hello`: 버전 → role → 토큰 순, 상수시간 비교)와 `ping`·`listRunners` 를, A3b 는 러너 표
//! (`spawnRunner`·`killRunner`, `runners.rs`)와 `runnerExit` 이벤트를 옮긴다. 프로토콜이 아는 나머지 요청에는
//! `unknown-request` 가 아니라 `internal`("이 오퍼레이터에는 아직 없다")로 답한다 — 모른다고 하면 앱이 프로토콜 판이
//! 갈렸다고 읽는다(TS 주석).
//!
//! 이벤트는 **인증된** 접속에만 흘린다(TS `broadcastEvent`). 접속마다 쓰는 쪽을 잠금 하나로 묶어, 응답 줄과
//! 이벤트 줄이 서로 끼어들어 한 줄이 깨지지 않게 한다.
//!
//! 접속마다 스레드 하나다. 앱 하나가 붙는 로컬 소켓이라 async 런타임을 들이지 않는다(의존이 늘지 않는다).
use crate::runners::{RunnerLaunch, RunnerTable, SpawnOutcome};
use harkroom_proto::p3::{
    DAEMON_PROTOCOL_VERSION, DaemonError, DaemonErrorCode, DaemonIdentity, EVENT_NAMES,
    MAX_LINE_BYTES, REQUEST_TYPES,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 접속마다의 쓰기 시간 제한. 인증은 됐지만 읽지 않는 접속 하나가 이벤트 흘리기(`broadcast_event`, 러너 종료를
/// 기다리는 스레드에서 돈다)를 그 자리에 붙잡지 못하게 한다. 넘기면 그 접속은 끊는다 — 앱은 다시 붙는다.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

fn err(code: DaemonErrorCode, message: impl Into<String>) -> DaemonError {
    DaemonError {
        code,
        message: message.into(),
    }
}

/// 디코더가 내놓는 한 줄 — 성공·실패가 순서대로 섞여 온다(TS `DecodedLine`).
#[derive(Debug, PartialEq)]
pub enum Decoded {
    Ok(Value),
    Err(DaemonError),
}

/// TS `NdjsonDecoder` 와 같은 규칙: 개행까지 들고 있고, 상한을 넘기면 그 줄을 버리고 다음 개행까지 버린다.
pub struct NdjsonDecoder {
    buf: Vec<u8>,
    discarding: bool,
    limit: usize,
}

impl Default for NdjsonDecoder {
    fn default() -> Self {
        Self::new(MAX_LINE_BYTES)
    }
}

impl NdjsonDecoder {
    pub fn new(limit: usize) -> Self {
        Self {
            buf: Vec::new(),
            discarding: false,
            limit,
        }
    }

    pub fn pending_bytes(&self) -> usize {
        self.buf.len()
    }

    fn too_long(&self, n: usize) -> DaemonError {
        err(
            DaemonErrorCode::LineTooLong,
            format!("한 줄이 상한을 넘었다: {n} > {} 바이트", self.limit),
        )
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<Decoded> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            let Some(nl) = self.buf.iter().position(|&b| b == b'\n') else {
                if self.discarding {
                    self.buf.clear();
                } else if self.buf.len() > self.limit {
                    out.push(Decoded::Err(self.too_long(self.buf.len())));
                    self.buf.clear();
                    self.discarding = true;
                }
                return out;
            };
            let line: Vec<u8> = self.buf.drain(..=nl).take(nl).collect();
            if self.discarding {
                self.discarding = false;
                continue;
            }
            if line.len() > self.limit {
                out.push(Decoded::Err(self.too_long(line.len())));
                continue;
            }
            let text = String::from_utf8_lossy(&line);
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(text) {
                Ok(v) => out.push(Decoded::Ok(v)),
                Err(e) => out.push(Decoded::Err(err(
                    DaemonErrorCode::InvalidJson,
                    e.to_string(),
                ))),
            }
        }
    }
}

/// 한 메시지를 한 줄로. 보내는 쪽에서도 상한을 잰다(TS `encodeLine`).
pub fn encode_line(v: &Value) -> Result<Vec<u8>, DaemonError> {
    let mut s = serde_json::to_vec(v).map_err(|e| err(DaemonErrorCode::Internal, e.to_string()))?;
    if s.len() > MAX_LINE_BYTES {
        return Err(err(
            DaemonErrorCode::LineTooLong,
            format!(
                "한 줄이 상한을 넘었다: {} > {MAX_LINE_BYTES} 바이트",
                s.len()
            ),
        ));
    }
    s.push(b'\n');
    Ok(s)
}

/// 상수시간 비교. 길이가 다르면 바로 끝난다(TS 와 같은 "받아들이는 누출"). 빈 토큰은 언제나 거절.
pub fn tokens_match(expected: &str, received: &Value) -> bool {
    let Some(b) = received.as_str() else {
        return false;
    };
    let (a, b) = (expected.as_bytes(), b.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `hello` 검사 — 버전을 토큰보다 먼저 본다(TS `checkHello`).
pub fn check_hello(msg: &Value, token: &str) -> Result<(), DaemonError> {
    if msg.get("type").and_then(Value::as_str) != Some("hello") {
        return Err(err(
            DaemonErrorCode::NotAuthenticated,
            "첫 메시지는 hello 여야 한다",
        ));
    }
    let version = msg.get("version");
    if version.and_then(Value::as_f64) != Some(f64::from(DAEMON_PROTOCOL_VERSION)) {
        let got = match version {
            None => "undefined".to_string(),
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
        };
        return Err(err(
            DaemonErrorCode::VersionMismatch,
            format!(
                "프로토콜 버전이 다르다: 이 daemon 은 v{DAEMON_PROTOCOL_VERSION}, 상대는 v{got}"
            ),
        ));
    }
    if msg.get("role").and_then(Value::as_str) != Some("app") {
        let got = match msg.get("role") {
            None => "undefined".to_string(),
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
        };
        return Err(err(
            DaemonErrorCode::BadPayload,
            format!("모르는 role 이다: {got}"),
        ));
    }
    if !tokens_match(token, msg.get("token").unwrap_or(&Value::Null)) {
        return Err(err(DaemonErrorCode::Unauthorized, "토큰이 다르다"));
    }
    Ok(())
}

/// 파싱된 요청. 성공이면 (id, type, payload).
pub fn parse_request(v: &Value) -> Result<(String, String, Option<Value>), DaemonError> {
    let Some(obj) = v.as_object() else {
        return Err(err(DaemonErrorCode::InvalidJson, "객체가 아니다"));
    };
    let id = match obj.get("id").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Err(err(DaemonErrorCode::BadPayload, "id 가 없다")),
    };
    let Some(ty) = obj.get("type").and_then(Value::as_str) else {
        return Err(err(DaemonErrorCode::BadPayload, "type 이 없다"));
    };
    if !REQUEST_TYPES.contains(&ty) {
        return Err(err(
            DaemonErrorCode::UnknownRequest,
            format!("모르는 요청이다: {ty}"),
        ));
    }
    Ok((id, ty.to_string(), obj.get("payload").cloned()))
}

/// 응답 id 를 값에서 최선으로 건진다(TS `readId`).
fn read_id(v: &Value) -> Option<String> {
    v.get("id").and_then(Value::as_str).map(str::to_string)
}

fn error_response(id: Option<String>, e: &DaemonError) -> Value {
    json!({ "id": id.unwrap_or_default(), "ok": false, "error": e })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

type Writer = Arc<Mutex<UnixStream>>;

/// 서버가 들고 있는 것. 토큰은 엔드포인트를 이긴 뒤에 생기므로 나중에 채운다(빈 값이면 누구도 통과 못 한다).
pub struct ServerState {
    pub identity: DaemonIdentity,
    token: Mutex<String>,
    /// 러너 표(A3b). `listRunners` 의 원천이다.
    pub runners: Arc<RunnerTable>,
    /// 인증된 접속의 쓰는 쪽 — 이벤트가 여기로 흐른다.
    authed: Mutex<HashMap<u64, Writer>>,
    next_conn: AtomicU64,
}

impl ServerState {
    /// `launch` 가 없으면 `spawnRunner` 는 거절된다(러너 프로그램은 기동 인자로만 정한다).
    pub fn new(identity: DaemonIdentity, launch: Option<RunnerLaunch>) -> Arc<Self> {
        Arc::new_cyclic(|me: &Weak<Self>| {
            let me = me.clone();
            let runners = RunnerTable::new(
                launch,
                Arc::new(move |exit| {
                    if let Some(st) = me.upgrade() {
                        eprintln!(
                            "러너 종료: agent={} code={:?} signal={:?}",
                            exit.agent_id, exit.code, exit.signal
                        );
                        st.broadcast_event("runnerExit", exit.to_json());
                    }
                }),
            );
            Self {
                identity,
                token: Mutex::new(String::new()),
                runners,
                authed: Mutex::new(HashMap::new()),
                next_conn: AtomicU64::new(1),
            }
        })
    }

    pub fn set_token(&self, token: String) {
        *self.token.lock().unwrap_or_else(|p| p.into_inner()) = token;
    }

    fn token(&self) -> String {
        self.token.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn authed(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Writer>> {
        self.authed.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 이벤트를 인증된 접속 전부에 흘린다. 인증 못 한 접속에는 아무것도 흘리지 않는다 — 이벤트도 정보다.
    pub fn broadcast_event(&self, name: &str, payload: Value) {
        debug_assert!(EVENT_NAMES.contains(&name));
        let Ok(line) = encode_line(&json!({ "type": "event", "event": name, "payload": payload }))
        else {
            return;
        };
        let writers: Vec<(u64, Writer)> = self
            .authed()
            .iter()
            .map(|(id, w)| (*id, Arc::clone(w)))
            .collect();
        for (id, w) in writers {
            let mut stream = w.lock().unwrap_or_else(|p| p.into_inner());
            if stream.write_all(&line).is_err() {
                // 시간 제한(`WRITE_TIMEOUT`)을 넘겼거나 끊긴 접속이다. 명단에서 빼고 양쪽을 닫는다 — 줄이 반쯤
                // 나갔을 수 있어 그 접속으로는 더 쓸 수 없고, 읽는 스레드도 0 을 읽고 끝난다.
                let _ = stream.shutdown(Shutdown::Both);
                drop(stream);
                self.authed().remove(&id);
                eprintln!("이벤트 쓰기 실패 — 접속을 끊는다: conn={id}");
            }
        }
    }

    /// 인증된 요청 하나에 대한 답(`DaemonServer.dispatch`).
    pub fn dispatch(&self, ty: &str, payload: Option<&Value>) -> Result<Value, DaemonError> {
        match ty {
            "ping" => Ok(json!({ "nowMs": now_ms() })),
            "listRunners" => Ok(json!({ "runners": self.runners.list_runners() })),
            "spawnRunner" => {
                let (agent_id, env) = read_spawn_params(payload)?;
                let outcome = self
                    .runners
                    .spawn_runner(&agent_id, &env)
                    .map_err(|m| err(DaemonErrorCode::Internal, m))?;
                let r = outcome.record();
                // env 를 로그에 적지 않는다 — PAT 가 실린다. 띄웠는지·이미 있었는지를 가른다(TS `#456` ②).
                match &outcome {
                    SpawnOutcome::Started(_) => {
                        eprintln!("러너 spawn: agent={} pid={}", r.agent_id, r.pid)
                    }
                    SpawnOutcome::Existing(_) => eprintln!(
                        "러너가 이미 있다 — 새로 안 띄운다: agent={} pid={}",
                        r.agent_id, r.pid
                    ),
                }
                Ok(
                    json!({ "agentId": r.agent_id, "pid": r.pid, "incarnationId": r.incarnation_id }),
                )
            }
            "killRunner" => {
                let (agent_id, incarnation_id) = read_kill_params(payload)?;
                let Some(r) = self
                    .runners
                    .kill_runner(&agent_id, incarnation_id.as_deref())
                else {
                    return Err(err(
                        DaemonErrorCode::NoSuchRunner,
                        format!("이 daemon 이 아는 러너가 아니다: {agent_id}"),
                    ));
                };
                eprintln!("SIGTERM 보냄: agent={} pid={}", r.agent_id, r.pid);
                Ok(
                    json!({ "agentId": r.agent_id, "pid": r.pid, "termSentAtMs": r.term_sent_at_ms }),
                )
            }
            other => Err(err(
                DaemonErrorCode::Internal,
                format!("이 오퍼레이터(Rust)에는 아직 없는 요청이다: {other}"),
            )),
        }
    }
}

/// TS `readSpawnParams` 와 같은 검사·문구.
pub fn read_spawn_params(
    payload: Option<&Value>,
) -> Result<(String, Vec<(String, String)>), DaemonError> {
    let Some(obj) = payload.and_then(Value::as_object) else {
        return Err(err(DaemonErrorCode::BadPayload, "payload 가 객체가 아니다"));
    };
    let agent_id = match obj.get("agentId").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Err(err(DaemonErrorCode::BadPayload, "agentId 가 없다")),
    };
    let Some(env) = obj.get("env").and_then(Value::as_object) else {
        return Err(err(DaemonErrorCode::BadPayload, "env 가 객체가 아니다"));
    };
    let mut out = Vec::with_capacity(env.len());
    for (k, v) in env {
        let Some(v) = v.as_str() else {
            return Err(err(
                DaemonErrorCode::BadPayload,
                format!("env.{k} 가 문자열이 아니다"),
            ));
        };
        out.push((k.clone(), v.to_string()));
    }
    Ok((agent_id, out))
}

/// TS `readKillParams` 와 같은 검사·문구.
pub fn read_kill_params(payload: Option<&Value>) -> Result<(String, Option<String>), DaemonError> {
    let Some(obj) = payload.and_then(Value::as_object) else {
        return Err(err(DaemonErrorCode::BadPayload, "payload 가 객체가 아니다"));
    };
    let agent_id = match obj.get("agentId").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Err(err(DaemonErrorCode::BadPayload, "agentId 가 없다")),
    };
    let incarnation_id = match obj.get("incarnationId") {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            return Err(err(
                DaemonErrorCode::BadPayload,
                "incarnationId 가 문자열이 아니다",
            ));
        }
    };
    Ok((agent_id, incarnation_id))
}

/// 접속 하나를 끝까지 서비스한다. `hello` 전에는 아무 요청도 받지 않고, 거절이면 사유 한 줄을 보내고 끊는다.
pub fn serve_connection(state: &ServerState, mut stream: UnixStream) {
    // 쓰기 시간 제한은 소켓 옵션(SO_SNDTIMEO)이라 복제한 fd 에도 같이 걸린다. 못 걸면 받지 않는다.
    if stream.set_write_timeout(Some(WRITE_TIMEOUT)).is_err() {
        return;
    }
    let writer: Writer = match stream.try_clone() {
        Ok(w) => Arc::new(Mutex::new(w)),
        Err(_) => return,
    };
    let conn_id = state.next_conn.fetch_add(1, Ordering::Relaxed);
    // 끝날 때 이벤트 명단에서 뺀다(패닉이어도 빠진다).
    struct Leave<'a>(&'a ServerState, u64);
    impl Drop for Leave<'_> {
        fn drop(&mut self) {
            self.0.authed().remove(&self.1);
        }
    }
    let _leave = Leave(state, conn_id);
    let mut decoder = NdjsonDecoder::default();
    let mut authenticated = false;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match stream.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        for line in decoder.push(&buf[..n]) {
            let reply = match line {
                Decoded::Err(e) => {
                    let drop = e.code == DaemonErrorCode::LineTooLong;
                    let _ = write_value(&writer, &error_response(None, &e));
                    if drop {
                        return;
                    }
                    continue;
                }
                Decoded::Ok(v) if !authenticated => match check_hello(&v, &state.token()) {
                    Ok(()) => {
                        authenticated = true;
                        let ok = json!({ "type": "hello", "ok": true, "daemon": state.identity });
                        // hello 응답을 먼저 쓰고 나서 명단에 올린다 — 이벤트가 hello 응답보다 앞서 가지 않게.
                        if write_value(&writer, &ok).is_err() {
                            return;
                        }
                        state.authed().insert(conn_id, Arc::clone(&writer));
                        continue;
                    }
                    Err(e) => {
                        let _ = write_value(
                            &writer,
                            &json!({ "type": "hello", "ok": false, "error": e }),
                        );
                        eprintln!("hello 거절: {}", e.message);
                        return;
                    }
                },
                Decoded::Ok(v) => match parse_request(&v) {
                    Err(e) => error_response(read_id(&v), &e),
                    Ok((id, ty, payload)) => match state.dispatch(&ty, payload.as_ref()) {
                        Ok(p) => json!({ "id": id, "ok": true, "payload": p }),
                        Err(e) => error_response(Some(id), &e),
                    },
                },
            };
            if write_value(&writer, &reply).is_err() {
                return;
            }
        }
    }
}

fn write_value(writer: &Writer, v: &Value) -> std::io::Result<()> {
    let bytes = encode_line(v).map_err(|e| std::io::Error::other(e.message))?;
    writer
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .write_all(&bytes)
}

/// 듣기 고리. 접속마다 스레드 하나.
/// 동시 연결 상한(security C3). 연결마다 스레드가 하나라, 상주 프로세스가 되면 스레드 수를 묶어 둔다.
pub const MAX_CONNECTIONS: usize = 64;

/// 연결 하나가 끝나면 자리를 돌려준다(스레드가 패닉해도 drop 으로 돌려준다).
struct Slot(Arc<AtomicUsize>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn take_slot(active: &Arc<AtomicUsize>, limit: usize) -> Option<Slot> {
    // `fetch_update` 는 새 Rust 에서 `try_update` 로 이름이 바뀌어(옛 이름은 deprecated) 판마다 갈린다 —
    // 어느 판에서나 같은 compare_exchange 반복으로 쓴다.
    let mut n = active.load(Ordering::Acquire);
    loop {
        if n >= limit {
            return None;
        }
        match active.compare_exchange_weak(n, n + 1, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return Some(Slot(Arc::clone(active))),
            Err(now) => n = now,
        }
    }
}

pub fn accept_loop(state: Arc<ServerState>, listener: UnixListener) {
    accept_loop_with_limit(state, listener, MAX_CONNECTIONS);
}

/// 상한을 넘은 연결은 사유 한 줄을 보내고 곧바로 닫는다 — 스레드를 띄우지 않는다.
pub fn accept_loop_with_limit(state: Arc<ServerState>, listener: UnixListener, limit: usize) {
    let active = Arc::new(AtomicUsize::new(0));
    for conn in listener.incoming() {
        let Ok(mut stream) = conn else { continue };
        let Some(slot) = take_slot(&active, limit) else {
            // 앱은 첫 줄로 hello 응답을 기다리므로 hello 거절 꼴로 답한다.
            let e = err(
                DaemonErrorCode::Internal,
                format!("동시 연결 상한({limit})을 넘었다"),
            );
            let msg = json!({ "type": "hello", "ok": false, "error": e });
            if let Ok(line) = encode_line(&msg) {
                let _ = stream.write_all(&line);
            }
            continue;
        };
        let st = Arc::clone(&state);
        std::thread::spawn(move || {
            let _slot = slot;
            serve_connection(&st, stream);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broadcast_drops_authed_peer_that_never_reads() {
        let state = ServerState::new(
            DaemonIdentity {
                pid: 1,
                started_at_ms: 0,
                launch_nonce: String::new(),
                entry_path: String::new(),
                app_version: String::new(),
            },
            None,
        );
        // 읽지 않는 상대. 시험은 짧은 제한으로 본다(실제 값은 `WRITE_TIMEOUT`).
        let (ours, _theirs) = UnixStream::pair().unwrap();
        ours.set_write_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        state.authed().insert(7, Arc::new(Mutex::new(ours)));
        let big = "x".repeat(256 * 1024);
        let started = std::time::Instant::now();
        // 소켓 버퍼가 찰 때까지 흘린다 — 막히지 않고 끝나야 하고, 그 접속은 명단에서 빠져야 한다.
        for _ in 0..64 {
            state.broadcast_event("runnerExit", json!({ "pad": big }));
            if state.authed().is_empty() {
                break;
            }
        }
        assert!(state.authed().is_empty(), "읽지 않는 접속이 명단에 남았다");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn connection_slots_cap_and_return() {
        let active = Arc::new(AtomicUsize::new(0));
        let a = take_slot(&active, 2).unwrap();
        let _b = take_slot(&active, 2).unwrap();
        assert!(take_slot(&active, 2).is_none());
        drop(a);
        assert!(take_slot(&active, 2).is_some());
    }

    #[test]
    fn decoder_split_and_joined_chunks() {
        let mut d = NdjsonDecoder::new(64);
        assert!(d.push(b"{\"a\":").is_empty());
        let out = d.push(b"1}\n{\"b\":2}\n\n{\"c\"");
        assert_eq!(
            out,
            vec![Decoded::Ok(json!({"a":1})), Decoded::Ok(json!({"b":2}))]
        );
        assert_eq!(d.pending_bytes(), 4);
    }

    #[test]
    fn decoder_drops_overlong_line_and_its_tail() {
        let mut d = NdjsonDecoder::new(8);
        let out = d.push(b"0123456789abc");
        assert!(matches!(&out[..], [Decoded::Err(e)] if e.code == DaemonErrorCode::LineTooLong));
        assert_eq!(d.pending_bytes(), 0);
        // 꼬리는 다음 줄로 읽히지 않는다.
        let out = d.push(b"tail\n{}\n");
        assert_eq!(out, vec![Decoded::Ok(json!({}))]);
    }

    #[test]
    fn hello_checks_version_before_token() {
        let e = check_hello(
            &json!({"type":"hello","version":2,"token":"x","role":"app"}),
            "t",
        )
        .unwrap_err();
        assert_eq!(e.code, DaemonErrorCode::VersionMismatch);
        assert_eq!(
            e.message,
            "프로토콜 버전이 다르다: 이 daemon 은 v1, 상대는 v2"
        );
        let e = check_hello(
            &json!({"type":"hello","version":1,"token":"x","role":"runner"}),
            "x",
        )
        .unwrap_err();
        assert_eq!(e.code, DaemonErrorCode::BadPayload);
        let e = check_hello(
            &json!({"type":"hello","version":1,"token":"y","role":"app"}),
            "x",
        )
        .unwrap_err();
        assert_eq!(e.code, DaemonErrorCode::Unauthorized);
        let e = check_hello(&json!({"type":"ping"}), "x").unwrap_err();
        assert_eq!(e.code, DaemonErrorCode::NotAuthenticated);
        assert!(
            check_hello(
                &json!({"type":"hello","version":1,"token":"x","role":"app"}),
                "x"
            )
            .is_ok()
        );
    }

    #[test]
    fn empty_token_never_matches() {
        assert!(!tokens_match("", &json!("")));
        assert!(!tokens_match("ab", &json!("abc")));
        assert!(!tokens_match("ab", &json!(1)));
    }

    #[test]
    fn parse_request_codes() {
        assert_eq!(
            parse_request(&json!([])).unwrap_err().code,
            DaemonErrorCode::InvalidJson
        );
        assert_eq!(
            parse_request(&json!({"type":"ping"})).unwrap_err().code,
            DaemonErrorCode::BadPayload
        );
        assert_eq!(
            parse_request(&json!({"id":"1","type":"nope"}))
                .unwrap_err()
                .code,
            DaemonErrorCode::UnknownRequest
        );
        assert_eq!(
            parse_request(&json!({"id":"1","type":"ping"})).unwrap().1,
            "ping"
        );
    }
}
