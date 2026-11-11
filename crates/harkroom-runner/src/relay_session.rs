//! 중계 세션 장부(S3 B3b-2c) — 정본 `packages/agent/src/relay.ts` 의 **세션 절반**(`openSession`·`onServerFrame` 의
//! `replay.request`/`input`/`resize`/`viewer.count`/`session.cancel`/`interactive.open`·`cancelSessions`·끊김 때 뷰어 0).
//! 연결·요청 절반은 `link`(B3a) 다. 이 장부는 `link` 의 고리 셋(`announce_sessions`·`on_frame`·`on_link_down`)에 꽂힌다
//! — `RelaySessions::wire`.
//!
//! 지키는 약속(정본 주석이 근거다):
//! - **스크롤백은 러너 메모리에만 산다**(세션당 `RING_CAP_BYTES`). 링크가 끊겨 있어도 ring 은 계속 채운다.
//! - 모르는 세션의 `replay.request` 에는 답하지 않는다(빈 재생은 "끝난 세션"과 "출력 없는 세션"을 같게 만든다).
//! - `input`·`resize` 의 인가(쓰기 차례·값 범위)는 서버 허브가 이미 했다 — 러너는 "내 세션인가"만 본다. spawn 전
//!   (통로 없음)에 온 입력·크기는 **버린다**(큐에 담으면 엉뚱한 프롬프트의 답이 된다).
//! - 죽이는 것은 장부가 아니라 **턴**이다(`on_cancel`). 장부의 콜백 예외(패닉)는 삼킨다 — 한 턴의 정리가 링크
//!   읽기 스레드와 다른 턴을 죽이면 안 된다.
//! - 닫힌 세션 손잡이의 호출은 무시한다(`session.ended` 두 번·끝난 세션 이름의 바이트 금지).
//!
//! **서버로 내보내는 화면 원문의 범위**(security B3b-2b 메모): ① `output` — 그 턴 PTY 바이트 전부(정본과 같다, 소유자
//! xterm 이 그린다) ② `replay` — 그 세션 ring(최대 256KB) ③ `attention.required.screen` — 화면 tail, 여기서
//! `ATTENTION_SCREEN_MAX_BYTES`(=`TAIL_CAP_BYTES` 2KB)로 한 번 더 자른다. 셋 다 base64 이고 서버는 열지 않는다.
//! 그 밖의 프레임(`session.*`·`interactive.*`)에는 화면 원문을 싣지 않는다.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::link::{LinkClient, LinkOptions, random_uuid};
use crate::pty::{RingBuffer, TAIL_CAP_BYTES};
use crate::pty_turn::PtyControls;

/// 세션당 스크롤백 용량(정본 `RING_CAP_BYTES`, 스펙 §5). 러너 메모리에만 산다.
pub const RING_CAP_BYTES: usize = 256 * 1024;
/// `attention.required` 에 싣는 화면의 상한 — 주입 기계의 tail 상한과 같다(그보다 길게 올 일이 없지만 장부가 한 번 더 막는다).
pub const ATTENTION_SCREEN_MAX_BYTES: usize = TAIL_CAP_BYTES;
/// 정본 `handleInteractiveOpen` 의 배선 없음 문구.
pub const INTERACTIVE_NOT_WIRED: &str =
    "이 러너에는 인터랙티브 열기가 배선되지 않았다 — 러너를 최신으로 올려 다시 시도해라";

/// 세션의 PTY 통로(정본 `PtyWriter`). 실물은 `PtyControls`, 시험은 가짜다.
pub trait PtyInput: Send + Sync {
    fn write(&self, chunk: &[u8]);
    fn resize(&self, cols: u16, rows: u16);
}

impl PtyInput for PtyControls {
    fn write(&self, chunk: &[u8]) {
        PtyControls::write(self, chunk);
    }
    fn resize(&self, cols: u16, rows: u16) {
        PtyControls::resize(self, cols, rows);
    }
}

type ViewerHook = Arc<dyn Fn(i64) + Send + Sync>;
type CancelHook = Arc<dyn Fn(&str) + Send + Sync>;

/// 정본 `OpenSessionInput`.
#[derive(Default)]
pub struct OpenSessionInput {
    pub agent_account_id: String,
    pub channel_id: String,
    pub thread_root_id: Option<String>,
    pub harness: String,
    /// `None` 은 멘션 턴(`'mention'`).
    pub mode: Option<String>,
    /// 필수 사실 — 호출부가 `accepts_pty_input(plan)` 으로 읽어 넘긴다(정본 #369).
    pub accepts_input: bool,
    /// 바깥 `None` = 모른다(필드 생략), `Some(None)` = 시스템 기본 로그인(null).
    pub claude_account: Option<Option<String>>,
    pub claude_pool: Option<Option<String>>,
    pub claude_pool_rank: Option<u32>,
    pub on_viewer_count: Option<ViewerHook>,
    pub on_cancel: Option<CancelHook>,
}

/// 정본 `InteractiveOpenHandler` 의 요청.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InteractiveOpenRequest {
    pub channel_id: String,
    pub thread_root_id: String,
    pub opened_by_handle: String,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

/// 성공은 `(sessionId, created)`. 실패 문구는 `interactive.error` 로 **사람 화면에 그대로** 간다 — 처리자는 로컬 경로·
/// 화면 원문을 싣지 말고 `Display` 수준 문구만 돌려준다.
pub type InteractiveOpenHandler =
    Arc<dyn Fn(InteractiveOpenRequest) -> Result<(String, bool), String> + Send + Sync>;

struct Live {
    info: Value,
    ring: RingBuffer,
    writer: Option<Arc<dyn PtyInput>>,
    viewer_count: i64,
    on_viewer_count: Option<ViewerHook>,
    on_cancel: Option<CancelHook>,
}

type Sink = Arc<dyn Fn(&Value) + Send + Sync>;

/// 세션 장부. 링크와는 `wire` 로 잇는다(서로를 알아야 하므로 보내기 길은 나중에 꽂는다).
pub struct RelaySessions {
    sessions: Mutex<HashMap<String, Live>>,
    sink: OnceLock<Sink>,
    on_interactive_open: Option<InteractiveOpenHandler>,
    log: Box<dyn Fn(&str) + Send + Sync>,
}

/// 콜백 패닉을 삼킨다 — 정본의 `try { … } catch {}` 자리.
fn guarded(f: impl FnOnce()) {
    let _ = catch_unwind(AssertUnwindSafe(f));
}

fn iso_now() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    crate::pty_record::iso_utc(ms)
}

/// 문자 경계를 지켜 끝에서 `max` 바이트 이하로 자른다.
fn tail_str(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

fn as_dim(v: Option<&Value>) -> Option<u16> {
    v.and_then(Value::as_u64)
        .and_then(|n| u16::try_from(n).ok())
        .filter(|n| *n > 0)
}

impl RelaySessions {
    pub fn new(
        on_interactive_open: Option<InteractiveOpenHandler>,
        log: Box<dyn Fn(&str) + Send + Sync>,
    ) -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            sink: OnceLock::new(),
            on_interactive_open,
            log,
        })
    }

    /// 보내기 길을 꽂는다(한 번만). 시험은 가짜 sink 를, 실물은 `wire` 가 링크를 꽂는다.
    pub fn set_sink(&self, sink: Sink) {
        let _ = self.sink.set(sink);
    }

    fn send(&self, frame: &Value) {
        if let Some(s) = self.sink.get() {
            s(frame);
        }
    }

    /// 링크 고리 셋을 이 장부로 채운다. 고아 판정(`on_rejected_give_up`)은 열린 세션을 중단 경로로 끝낸 **뒤** 원래
    /// 고리를 부른다(정본 `giveUpRejected` 순서). 돌려받은 `LinkOptions` 로 `LinkClient::new` 한 뒤 `attach_link` 를 부른다.
    pub fn wire(self: &Arc<Self>, mut opts: LinkOptions) -> LinkOptions {
        let me = self.clone();
        opts.announce_sessions = Box::new(move || me.announce());
        let me = self.clone();
        opts.on_frame = Box::new(move |f| me.on_frame(f));
        let me = self.clone();
        let prev_down = std::mem::replace(&mut opts.on_link_down, Box::new(|| {}));
        opts.on_link_down = Box::new(move || {
            me.on_link_down();
            prev_down();
        });
        let me = self.clone();
        let prev_give_up = std::mem::replace(&mut opts.on_rejected_give_up, Box::new(|| {}));
        opts.on_rejected_give_up = Box::new(move || {
            let n = me.sessions.lock().unwrap().len();
            (me.log)(&format!("[relay] 고아로 물러난다 — 열린 세션 {n}개 중단"));
            me.cancel_sessions();
            guarded(&prev_give_up);
        });
        opts
    }

    /// 링크를 보내기 길로 꽂는다. 링크가 끊겨 있으면 `send_frame` 이 버린다(정본 `send` 와 같다 — ring 이 재생을 맡는다).
    pub fn attach_link(&self, link: &Arc<LinkClient>) {
        let weak = Arc::downgrade(link);
        self.set_sink(Arc::new(move |f: &Value| {
            if let Some(l) = weak.upgrade() {
                l.send_frame(f);
            }
        }));
    }

    /// 재접속마다 `announce` 에 실을 세션들(`AgentSessionView`).
    pub fn announce(&self) -> Vec<Value> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .map(|l| l.info.clone())
            .collect()
    }

    pub fn len(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 끊겼다 — 뷰어 수를 0 으로 돌린다(정본: 재접속 화해가 참값을 돌려준다, 유예 60초 > 백오프).
    pub fn on_link_down(&self) {
        let hooks: Vec<ViewerHook> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter_map(|l| l.on_viewer_count.clone())
            .collect();
        for h in hooks {
            guarded(|| h(0));
        }
    }

    /// 열린 세션을 전부 중단 경로(`on_cancel("operator")`)로 끝낸다 — 링크 없이 물러날 때.
    pub fn cancel_sessions(&self) {
        let hooks: Vec<CancelHook> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter_map(|l| l.on_cancel.clone())
            .collect();
        for h in hooks {
            guarded(|| h("operator"));
        }
    }

    /// 링크가 넘긴 서버 프레임(응답·거절·이관 통지 뒤의 나머지).
    pub fn on_frame(self: &Arc<Self>, frame: Value) {
        let Some(t) = frame.get("type").and_then(Value::as_str) else {
            return;
        };
        let sid = frame.get("sessionId").and_then(Value::as_str);
        match t {
            "replay.request" => {
                let Some(sid) = sid else { return };
                let snap = match self.sessions.lock().unwrap().get(sid) {
                    Some(l) => l.ring.snapshot(),
                    None => return,
                };
                self.send(&json!({"type": "replay", "sessionId": sid, "data": B64.encode(snap)}));
            }
            "input" => {
                let (Some(sid), Some(data)) = (sid, frame.get("data").and_then(Value::as_str))
                else {
                    return;
                };
                let Some(w) = self.writer_of(sid) else { return };
                if let Ok(bytes) = B64.decode(data) {
                    w.write(&bytes);
                }
            }
            "resize" => {
                let Some(sid) = sid else { return };
                let (Some(cols), Some(rows)) =
                    (as_dim(frame.get("cols")), as_dim(frame.get("rows")))
                else {
                    return;
                };
                if let Some(w) = self.writer_of(sid) {
                    w.resize(cols, rows);
                }
            }
            "viewer.count" => {
                let (Some(sid), Some(count)) = (sid, frame.get("count").and_then(Value::as_i64))
                else {
                    return;
                };
                let hook = {
                    let mut map = self.sessions.lock().unwrap();
                    let Some(l) = map.get_mut(sid) else { return };
                    if l.viewer_count != count {
                        let mode = l.info.get("mode").and_then(Value::as_str).unwrap_or("?");
                        let thread = l
                            .info
                            .get("threadRootId")
                            .and_then(Value::as_str)
                            .unwrap_or("-");
                        (self.log)(&format!(
                            "[relay] 세션 {sid} ({mode}, 스레드 {thread}) 뷰어 {}→{count}",
                            l.viewer_count
                        ));
                        l.viewer_count = count;
                    }
                    l.on_viewer_count.clone()
                };
                if let Some(h) = hook {
                    guarded(|| h(count));
                }
            }
            "session.cancel" => {
                let (Some(sid), Some(by)) = (sid, frame.get("byHandle").and_then(Value::as_str))
                else {
                    return;
                };
                // 없는 세션은 조용히 버린다 — 누르는 사이에 턴이 스스로 끝났다.
                let hook = self
                    .sessions
                    .lock()
                    .unwrap()
                    .get(sid)
                    .and_then(|l| l.on_cancel.clone());
                if let Some(h) = hook {
                    guarded(|| h(by));
                }
            }
            "interactive.open" => {
                let Some(request_id) = frame.get("requestId").and_then(Value::as_str) else {
                    return;
                };
                let s = |k: &str| {
                    frame
                        .get(k)
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string()
                };
                let req = InteractiveOpenRequest {
                    channel_id: s("channelId"),
                    thread_root_id: s("threadRootId"),
                    opened_by_handle: s("openedByHandle"),
                    cols: as_dim(frame.get("cols")),
                    rows: as_dim(frame.get("rows")),
                };
                let request_id = request_id.to_string();
                let Some(handler) = self.on_interactive_open.clone() else {
                    self.send(&json!({"type": "interactive.error", "requestId": request_id, "message": INTERACTIVE_NOT_WIRED}));
                    return;
                };
                // 처리자는 턴을 띄우느라 오래 걸린다 — 링크 읽기 스레드를 막지 않게 따로 돈다(정본 `void handleInteractiveOpen`).
                let me = self.clone();
                std::thread::spawn(move || {
                    let res = catch_unwind(AssertUnwindSafe(|| handler(req)))
                        .unwrap_or_else(|_| Err("인터랙티브 열기가 실패했다".to_string()));
                    let frame = match res {
                        Ok((session_id, created)) => {
                            json!({"type": "interactive.opened", "requestId": request_id, "sessionId": session_id, "created": created})
                        }
                        Err(message) => {
                            json!({"type": "interactive.error", "requestId": request_id, "message": message})
                        }
                    };
                    me.send(&frame);
                });
            }
            _ => {}
        }
    }

    fn writer_of(&self, sid: &str) -> Option<Arc<dyn PtyInput>> {
        self.sessions.lock().unwrap().get(sid)?.writer.clone()
    }

    /// 턴 하나를 세션으로 연다(정본 `openSession`). 링크가 끊겨 있어도 성공한다(ring 은 계속 쌓인다).
    pub fn open_session(self: &Arc<Self>, input: OpenSessionInput) -> SessionHandle {
        let session_id = random_uuid();
        let mut info = Map::new();
        info.insert("sessionId".into(), json!(session_id));
        info.insert("agentAccountId".into(), json!(input.agent_account_id));
        info.insert("channelId".into(), json!(input.channel_id));
        info.insert("threadRootId".into(), json!(input.thread_root_id));
        info.insert("harness".into(), json!(input.harness));
        // 러너 시계다 — 세션이 언제 열렸는지는 러너만 안다(재접속 announce 에서 값이 바뀌지 않게).
        info.insert("startedAt".into(), json!(iso_now()));
        info.insert(
            "mode".into(),
            json!(input.mode.unwrap_or_else(|| "mention".into())),
        );
        info.insert("acceptsInput".into(), json!(input.accepts_input));
        if let Some(a) = input.claude_account {
            info.insert("claudeAccount".into(), json!(a));
        }
        if let Some(p) = input.claude_pool {
            info.insert("claudePool".into(), json!(p));
        }
        if let Some(r) = input.claude_pool_rank {
            info.insert("claudePoolRank".into(), json!(r));
        }
        let info = Value::Object(info);
        self.sessions.lock().unwrap().insert(
            session_id.clone(),
            Live {
                info: info.clone(),
                ring: RingBuffer::new(RING_CAP_BYTES),
                writer: None,
                viewer_count: 0,
                on_viewer_count: input.on_viewer_count,
                on_cancel: input.on_cancel,
            },
        );
        self.send(&json!({"type": "session.started", "session": info}));
        SessionHandle {
            session_id,
            ledger: self.clone(),
            closed: AtomicBool::new(false),
        }
    }
}

/// 열린 세션의 호출자 쪽 손잡이(정본 `OpenSession`). 턴을 도는 코드는 이것만 안다. 버리면(`Drop`) 닫힌다.
pub struct SessionHandle {
    session_id: String,
    ledger: Arc<RelaySessions>,
    closed: AtomicBool,
}

impl SessionHandle {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// PTY 가 뱉은 바이트 — ring 에 담고 서버로도 흘린다.
    pub fn push(&self, chunk: &[u8]) {
        if self.is_closed() {
            return;
        }
        if let Some(l) = self
            .ledger
            .sessions
            .lock()
            .unwrap()
            .get_mut(&self.session_id)
        {
            l.ring.push(chunk);
        }
        self.ledger.send(
            &json!({"type": "output", "sessionId": self.session_id, "data": B64.encode(chunk)}),
        );
    }

    /// PTY stdin 을 잇는다(spawn 순간 `on_spawn` 이 부른다). 그 전 입력은 버려졌다.
    pub fn bind_input(&self, writer: Arc<dyn PtyInput>) {
        if self.is_closed() {
            return;
        }
        if let Some(l) = self
            .ledger
            .sessions
            .lock()
            .unwrap()
            .get_mut(&self.session_id)
        {
            l.writer = Some(writer);
        }
    }

    /// 사람 손을 기다린다. 화면은 끝에서 `ATTENTION_SCREEN_MAX_BYTES` 까지만 싣는다.
    pub fn needs_attention(&self, screen: &str, account_label: &str) {
        if self.is_closed() {
            return;
        }
        let screen = tail_str(screen, ATTENTION_SCREEN_MAX_BYTES);
        self.ledger.send(&json!({
            "type": "attention.required",
            "sessionId": self.session_id,
            "accountLabel": account_label,
            "screen": B64.encode(screen.as_bytes()),
        }));
    }

    /// 턴이 끝났다. 두 번째 호출은 아무 일도 하지 않는다.
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        // 맵에서 빼면 뒤늦은 입력은 `writer_of` 에서 걸리고, 통로(PTY)도 같이 놓는다.
        self.ledger
            .sessions
            .lock()
            .unwrap()
            .remove(&self.session_id);
        self.ledger
            .send(&json!({"type": "session.ended", "sessionId": self.session_id}));
    }
}

impl Drop for SessionHandle {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests;
