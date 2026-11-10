//! 앱(Tauri) ↔ 오퍼레이터 소켓 서버(경계 P3, S2 A2). 정본은 `packages/operator/src/server.ts`(`DaemonServer`)와
//! `packages/shared/src/daemonProtocol.ts`(`NdjsonDecoder`·`checkHello`·`tokensMatch`·`parseRequest`)다.
//!
//! A2 는 **문지기와 읽기 요청 둘**만 옮긴다: `hello`(버전 → role → 토큰 순, 상수시간 비교) · `ping` · `listRunners`.
//! 러너 표는 아직 비어 있다(러너를 띄우는 `spawnRunner` 는 A3). 프로토콜이 아는 나머지 요청에는 `unknown-request` 가
//! 아니라 `internal`("이 오퍼레이터에는 아직 없다")로 답한다 — 모른다고 하면 앱이 프로토콜 판이 갈렸다고 읽는다(TS 주석).
//!
//! 접속마다 스레드 하나다. 앱 하나가 붙는 로컬 소켓이라 async 런타임을 들이지 않는다(의존이 늘지 않는다).
use harkroom_proto::p3::{
    DAEMON_PROTOCOL_VERSION, DaemonError, DaemonErrorCode, DaemonIdentity, MAX_LINE_BYTES,
    REQUEST_TYPES,
};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

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

/// 서버가 들고 있는 것. 토큰은 엔드포인트를 이긴 뒤에 생기므로 나중에 채운다(빈 값이면 누구도 통과 못 한다).
pub struct ServerState {
    pub identity: DaemonIdentity,
    token: Mutex<String>,
    /// `listRunners` 의 원천. A2 에서는 늘 비어 있다(A3 에서 러너 표가 채운다).
    pub runners: Mutex<Vec<Value>>,
}

impl ServerState {
    pub fn new(identity: DaemonIdentity) -> Arc<Self> {
        Arc::new(Self {
            identity,
            token: Mutex::new(String::new()),
            runners: Mutex::new(Vec::new()),
        })
    }

    pub fn set_token(&self, token: String) {
        *self.token.lock().unwrap_or_else(|p| p.into_inner()) = token;
    }

    fn token(&self) -> String {
        self.token.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// 인증된 요청 하나에 대한 답(`DaemonServer.dispatch`).
    pub fn dispatch(&self, ty: &str, _payload: Option<&Value>) -> Result<Value, DaemonError> {
        match ty {
            "ping" => Ok(json!({ "nowMs": now_ms() })),
            "listRunners" => {
                let runners = self
                    .runners
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();
                Ok(json!({ "runners": runners }))
            }
            other => Err(err(
                DaemonErrorCode::Internal,
                format!("이 오퍼레이터(Rust)에는 아직 없는 요청이다: {other}"),
            )),
        }
    }
}

/// 접속 하나를 끝까지 서비스한다. `hello` 전에는 아무 요청도 받지 않고, 거절이면 사유 한 줄을 보내고 끊는다.
pub fn serve_connection(state: &ServerState, mut stream: UnixStream) {
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
                    let _ = write_value(&mut stream, &error_response(None, &e));
                    if drop {
                        return;
                    }
                    continue;
                }
                Decoded::Ok(v) if !authenticated => match check_hello(&v, &state.token()) {
                    Ok(()) => {
                        authenticated = true;
                        json!({ "type": "hello", "ok": true, "daemon": state.identity })
                    }
                    Err(e) => {
                        let _ = write_value(
                            &mut stream,
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
            if write_value(&mut stream, &reply).is_err() {
                return;
            }
        }
    }
}

fn write_value(stream: &mut UnixStream, v: &Value) -> std::io::Result<()> {
    let bytes = encode_line(v).map_err(|e| std::io::Error::other(e.message))?;
    stream.write_all(&bytes)
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
    active
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < limit).then_some(n + 1)
        })
        .ok()
        .map(|_| Slot(Arc::clone(active)))
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
