//! 같은 머신의 터미널 직결 허브(s21c-4a) — TS `localTerminal.ts` 의 이식. 앱이 오퍼레이터 소켓으로 러너의 PTY 바이트를
//! **서버를 거치지 않고** 받고 보낸다.
//!
//! ## 소켓 토큰은 허가가 아니다
//! 오퍼레이터 소켓 토큰은 같은 uid 의 에이전트 셸도 읽는다. 그래서 이 허브는 **서버가 내린 키 두 가지**로만 문을 연다:
//! - 열람 키(viewKey) — 서버가 소유자의 attach 를 인가할 때 준다. 세션 하나에 여럿. 회수되면 그 키로 붙은 구독을 끊는다.
//! - writer 키(writerKey) — writer 차례마다 새로 만든다. 세션당 하나. 옛 키로 보낸 바이트는 거절된다.
//! - 둘 다 `MIN_KEY_LENGTH` 보다 짧으면 허가로 받지 않고, 대조는 상수 시간으로 한다.
//!
//! ## 감사
//! 이 경로로 들어간 입력은 **바이트 수**만 센다(내용은 보지 않는다). writer 키 번호(gen)별로 `INPUT_REPORT_MS` 동안 모아
//! `report_input` 으로 올리고, 키를 갈거나 세션이 끝나기 전에 턴다.
//!
//! ## 재생
//! 구독할 때 러너에 `replay.request` 를 보낸다. 재생을 기다리는 동안 온 라이브 바이트는 쌓아 두고(상한
//! `MAX_AWAITING_CHUNKS`), 재생이 오면 재생 → 쌓인 라이브 순으로 흘린다.
//!
//! ## TS 와 다른 점
//! - 구독자에게 보내는 일·러너에 내리는 일은 **잠금을 놓은 뒤** 한다(TS 는 한 스레드라 잠금이 없다). 같은 러너의 프레임은
//!   그 러너 링크 스레드 하나에서 차례로 오므로 순서는 TS 와 같다.
//! - 구독자 식별은 객체 동일성 대신 `id()`(소켓 접속 번호)다.
//!
//! 이 판은 허브만 넣는다 — 소켓 `terminal*` 요청·서버 `local.view`/`local.writer`·announce 의 `local-terminal` 능력 배선은 다음 판.
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

/// 허가로 받는 키의 최소 길이. base64url 22자 ≈ 128bit.
pub const MIN_KEY_LENGTH: usize = 22;
/// 재생을 기다리는 동안 쌓아 둘 라이브 청크 수. 넘으면 재생을 포기하고 쌓인 것부터 흘린다.
pub const MAX_AWAITING_CHUNKS: usize = 1024;
/// 입력 바이트 보고를 모으는 창(ms).
pub const INPUT_REPORT_MS: u64 = 200;
/// 서버 허브(`isPtySize`)와 같은 범위.
const MAX_DIM: i64 = 1000;

/// 구독자 하나(앱 소켓 접속 하나).
pub trait LocalTerminalSubscriber: Send + Sync {
    /// 접속마다 다른 번호. 같은 접속의 구독을 가리는 데 쓴다.
    fn id(&self) -> u64;
    /// `terminalOutput`·`terminalEnded` 이벤트를 흘린다. 끊긴 접속이면 조용히 버린다.
    fn send(&self, event: &str, payload: Value);
}

/// 허브가 쓰는 바깥. 시험은 가짜를 준다.
pub trait LocalTerminalDeps: Send + Sync {
    /// 러너에 프레임을 내린다. 링크가 없으면 false.
    fn send_to_runner(&self, runner_id: &str, frame: &Value) -> bool;
    /// 이 경로로 들어간 입력의 바이트 수를 서버 감사에 올린다(`local.input`).
    fn report_input(&self, runner_id: &str, session_id: &str, r#gen: i64, bytes: i64);
    /// 보고를 잠깐 모았다가 보낸다. 기본은 잠자는 스레드 하나.
    fn schedule(&self, f: Box<dyn FnOnce() + Send>, ms: u64) {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(ms));
            f();
        });
    }
    fn log(&self, line: &str);
}

/// 거절 사유 — 앱은 `not-viewer`·`not-writer` 면 서버 경유로, `no-such-session` 이면 이 머신 것이 아니라고 읽는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    NoSuchSession,
    NotViewer,
    NotWriter,
    RunnerGone,
    BadSize,
}

impl Refusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Refusal::NoSuchSession => "no-such-session",
            Refusal::NotViewer => "not-viewer",
            Refusal::NotWriter => "not-writer",
            Refusal::RunnerGone => "runner-gone",
            Refusal::BadSize => "bad-size",
        }
    }
}

type Sub = Arc<dyn LocalTerminalSubscriber>;

struct Unreported {
    runner_id: String,
    r#gen: i64,
    bytes: i64,
}

#[derive(Default)]
struct State {
    /// sessionId → 그 세션을 가진 러너.
    owner: HashMap<String, String>,
    /// sessionId → (구독자 id → (구독자, 그 구독을 연 열람 키)). 붙은 순서를 지킨다.
    subs: HashMap<String, Vec<(Sub, String)>>,
    /// sessionId → (구독자 id → 재생 전에 쌓인 라이브).
    awaiting: HashMap<String, Vec<(Sub, Vec<String>)>>,
    view_keys: HashMap<String, HashSet<String>>,
    writer_key: HashMap<String, String>,
    writer_gen: HashMap<String, i64>,
    input_bytes: HashMap<String, i64>,
    unreported: HashMap<String, Unreported>,
    pending_flush: HashSet<String>,
}

/// 잠금 밖에서 할 일.
enum Out {
    Send(Sub, &'static str, Value),
    Report(Unreported, String),
}

pub struct LocalTerminalHub {
    deps: Box<dyn LocalTerminalDeps>,
    state: Mutex<State>,
    me: Weak<LocalTerminalHub>,
}

/// 상수 시간 대조. 길이는 비밀이 아니다(서버가 같은 길이로 만든다).
fn key_equals(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn usable_key(k: &str) -> bool {
    k.chars().count() >= MIN_KEY_LENGTH
}

/// base64 문자열이 담은 바이트 수. 디코드하지 않는다(TS `base64ByteLength` — JS length 는 UTF-16 단위지만 base64 는 ASCII 라 같다).
fn base64_byte_length(data: &str) -> i64 {
    let pad = if data.ends_with("==") {
        2
    } else if data.ends_with('=') {
        1
    } else {
        0
    };
    let n = data.encode_utf16().count() as i64;
    ((n * 3) / 4 - pad).max(0)
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

fn lock(m: &Mutex<State>) -> MutexGuard<'_, State> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl State {
    fn take_flush(&mut self, session_id: &str) -> Option<Out> {
        self.pending_flush.remove(session_id);
        let u = self.unreported.remove(session_id)?;
        (u.bytes > 0).then(|| Out::Report(u, session_id.to_string()))
    }

    fn end_session(&mut self, session_id: &str, out: &mut Vec<Out>) {
        // 잊기 전에 턴다 — 세션이 끝난 뒤의 보고는 번호를 잊어 갈 곳이 없다.
        out.extend(self.take_flush(session_id));
        self.writer_gen.remove(session_id);
        for (sub, _) in self.subs.remove(session_id).unwrap_or_default() {
            out.push(Out::Send(
                sub,
                "terminalEnded",
                json!({ "sessionId": session_id }),
            ));
        }
        self.awaiting.remove(session_id);
        self.owner.remove(session_id);
        self.view_keys.remove(session_id);
        self.writer_key.remove(session_id);
        // input_bytes 는 남긴다 — 감사가 털어 가기 전에 사라지면 그 바이트가 빠진다.
    }

    fn writer_gate(&self, session_id: &str, key: &str) -> Result<String, Refusal> {
        let runner = self.owner.get(session_id).ok_or(Refusal::NoSuchSession)?;
        match self.writer_key.get(session_id) {
            Some(granted) if key_equals(granted, key) => Ok(runner.clone()),
            _ => Err(Refusal::NotWriter),
        }
    }
}

impl LocalTerminalHub {
    pub fn new(deps: Box<dyn LocalTerminalDeps>) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            deps,
            state: Mutex::new(State::default()),
            me: me.clone(),
        })
    }

    fn still_subscribed(&self, sub: &dyn LocalTerminalSubscriber, payload: &Value) -> bool {
        let Some(id) = payload.get("sessionId").and_then(Value::as_str) else {
            return false;
        };
        lock(&self.state)
            .subs
            .get(id)
            .is_some_and(|l| l.iter().any(|(x, _)| x.id() == sub.id()))
    }

    fn run(&self, out: Vec<Out>) {
        for o in out {
            match o {
                Out::Send(sub, event, payload) => {
                    // 출력은 보내기 직전 그 구독이 아직 있는지 다시 본다(security c4-1 낮음) — 잠금을 놓은 사이
                    // 거둬졌거나 풀린 구독에 `terminalEnded` 뒤 출력이 새지 않게. 끝 알림은 구독을 뺀 뒤 내므로 보지 않는다.
                    if event == "terminalOutput" && !self.still_subscribed(sub.as_ref(), &payload) {
                        continue;
                    }
                    sub.send(event, payload)
                }
                Out::Report(u, session_id) => {
                    self.deps
                        .report_input(&u.runner_id, &session_id, u.r#gen, u.bytes)
                }
            }
        }
    }

    /// 다른 러너가 이미 가진 sessionId 를 덮어쓰지 않는다 — 러너 링크 비밀도 같은 uid 가 읽는다.
    fn claim(&self, st: &mut State, runner_id: &str, session: &Value) {
        let Some(id) = s(session, "sessionId") else {
            return;
        };
        if let Some(cur) = st.owner.get(&id)
            && cur != runner_id
        {
            self.deps.log(&format!(
                "localTerminal: {runner_id} 가 {cur} 의 세션 {id} 를 자기 것이라 했다 — 무시"
            ));
            return;
        }
        st.owner.insert(id, runner_id.to_string());
    }

    /// 러너가 올린 프레임을 본다(서버로 가는 것과 별개로).
    pub fn on_runner_frame(&self, runner_id: &str, frame: &Value) {
        let mut out = Vec::new();
        {
            let mut st = lock(&self.state);
            match frame.get("type").and_then(Value::as_str) {
                Some("announce") => {
                    let sessions: Vec<Value> = frame
                        .get("sessions")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let listed: HashSet<String> =
                        sessions.iter().filter_map(|v| s(v, "sessionId")).collect();
                    let gone: Vec<String> = st
                        .owner
                        .iter()
                        .filter(|(id, r)| *r == runner_id && !listed.contains(*id))
                        .map(|(id, _)| id.clone())
                        .collect();
                    for id in gone {
                        st.end_session(&id, &mut out);
                    }
                    for v in &sessions {
                        self.claim(&mut st, runner_id, v);
                    }
                }
                Some("session.started") => {
                    if let Some(v) = frame.get("session") {
                        self.claim(&mut st, runner_id, v);
                    }
                }
                Some("session.ended") => {
                    if let Some(id) = s(frame, "sessionId")
                        && st.owner.get(&id).is_some_and(|r| r == runner_id)
                    {
                        st.end_session(&id, &mut out);
                    }
                }
                Some("output") => {
                    let (Some(id), Some(data)) = (s(frame, "sessionId"), s(frame, "data")) else {
                        return;
                    };
                    if st.owner.get(&id).is_none_or(|r| r != runner_id) {
                        return;
                    }
                    let st = &mut *st;
                    let subs = st.subs.get(&id).cloned().unwrap_or_default();
                    let mut waiting = st.awaiting.get_mut(&id);
                    for (sub, _) in subs {
                        let slot = waiting
                            .as_deref_mut()
                            .and_then(|w| w.iter().position(|(x, _)| x.id() == sub.id()));
                        let Some(pos) = slot else {
                            out.push(Out::Send(
                                sub,
                                "terminalOutput",
                                json!({ "sessionId": id, "data": data }),
                            ));
                            continue;
                        };
                        let w = waiting.as_deref_mut().expect("slot 은 waiting 에서 나왔다");
                        w[pos].1.push(data.clone());
                        if w[pos].1.len() > MAX_AWAITING_CHUNKS {
                            // 재생에 답하지 않는 러너다 — 쌓인 라이브부터 흘리고 기다리기를 그만둔다.
                            self.deps.log(&format!(
                                "localTerminal: {id} 재생이 오지 않아 기다리기를 그만둔다"
                            ));
                            let (sub, queue) = w.remove(pos);
                            for d in queue {
                                out.push(Out::Send(
                                    sub.clone(),
                                    "terminalOutput",
                                    json!({ "sessionId": id, "data": d }),
                                ));
                            }
                        }
                    }
                }
                Some("replay") => {
                    let (Some(id), Some(data)) = (s(frame, "sessionId"), s(frame, "data")) else {
                        return;
                    };
                    if st.owner.get(&id).is_none_or(|r| r != runner_id) {
                        return;
                    }
                    let Some(waiting) = st.awaiting.remove(&id) else {
                        return;
                    };
                    for (sub, queue) in waiting {
                        // 재생이 먼저, 그동안 쌓인 라이브가 그다음 — 서버 허브와 같은 순서 규율.
                        out.push(Out::Send(
                            sub.clone(),
                            "terminalOutput",
                            json!({ "sessionId": id, "data": data, "replay": true }),
                        ));
                        for d in queue {
                            out.push(Out::Send(
                                sub.clone(),
                                "terminalOutput",
                                json!({ "sessionId": id, "data": d }),
                            ));
                        }
                    }
                }
                _ => {}
            }
        }
        self.run(out);
    }

    /// 러너가 죽었다 — 그 세션의 구독자에게 끝을 알리고 잊는다.
    pub fn forget_runner(&self, runner_id: &str) {
        let mut out = Vec::new();
        {
            let mut st = lock(&self.state);
            let ids: Vec<String> = st
                .owner
                .iter()
                .filter(|(_, r)| *r == runner_id)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                st.end_session(&id, &mut out);
            }
        }
        self.run(out);
    }

    /// 이 sessionId 를 이 머신의 러너가 가졌는가. 다른 세션 목록은 내주지 않는다.
    pub fn is_local(&self, session_id: &str) -> bool {
        lock(&self.state).owner.contains_key(session_id)
    }

    /// 이 세션을 가진 러너(서버 프레임이 맞는 러너에서 왔는지 대조하는 데 쓴다).
    pub fn owner_of(&self, session_id: &str) -> Option<String> {
        lock(&self.state).owner.get(session_id).cloned()
    }

    pub fn subscribe(&self, sub: Sub, session_id: &str, view_key: &str) -> Result<(), Refusal> {
        let runner_id = {
            let mut st = lock(&self.state);
            let runner_id = st
                .owner
                .get(session_id)
                .cloned()
                .ok_or(Refusal::NoSuchSession)?;
            let ok = usable_key(view_key)
                && st
                    .view_keys
                    .get(session_id)
                    .is_some_and(|keys| keys.iter().any(|k| key_equals(k, view_key)));
            if !ok {
                return Err(Refusal::NotViewer);
            }
            let list = st.subs.entry(session_id.to_string()).or_default();
            if let Some(slot) = list.iter_mut().find(|(x, _)| x.id() == sub.id()) {
                slot.1 = view_key.to_string();
                return Ok(());
            }
            // 재생 요청보다 **먼저** 기다림에 넣는다 — 잠금을 놓은 사이 재생이 오면 받을 자리가 있어야 한다.
            list.push((sub.clone(), view_key.to_string()));
            st.awaiting
                .entry(session_id.to_string())
                .or_default()
                .push((sub.clone(), Vec::new()));
            runner_id
        };
        let frame = json!({ "type": "replay.request", "sessionId": session_id });
        if self.deps.send_to_runner(&runner_id, &frame) {
            return Ok(());
        }
        self.unsubscribe(sub.as_ref(), session_id);
        Err(Refusal::RunnerGone)
    }

    pub fn unsubscribe(&self, sub: &dyn LocalTerminalSubscriber, session_id: &str) {
        let mut st = lock(&self.state);
        let id = sub.id();
        if let Some(list) = st.subs.get_mut(session_id) {
            list.retain(|(x, _)| x.id() != id);
        }
        if let Some(w) = st.awaiting.get_mut(session_id) {
            w.retain(|(x, _)| x.id() != id);
        }
    }

    /// 접속이 끊겼다 — 그 구독을 전부 뗀다.
    pub fn drop_subscriber(&self, sub_id: u64) {
        let mut st = lock(&self.state);
        for list in st.subs.values_mut() {
            list.retain(|(x, _)| x.id() != sub_id);
        }
        for w in st.awaiting.values_mut() {
            w.retain(|(x, _)| x.id() != sub_id);
        }
    }

    /// 서버가 열람 키를 준다.
    pub fn grant_view(&self, session_id: &str, view_key: &str) {
        if !usable_key(view_key) {
            self.deps.log(&format!(
                "localTerminal: {session_id} 열람 키가 너무 짧아 받지 않는다"
            ));
            return;
        }
        lock(&self.state)
            .view_keys
            .entry(session_id.to_string())
            .or_default()
            .insert(view_key.to_string());
    }

    /// 서버가 열람 키를 거둔다 — 그 키로 붙은 구독은 끝난다.
    pub fn revoke_view(&self, session_id: &str, view_key: &str) {
        let mut out = Vec::new();
        {
            let mut st = lock(&self.state);
            if let Some(keys) = st.view_keys.get_mut(session_id) {
                keys.remove(view_key);
            }
            let Some(list) = st.subs.get_mut(session_id) else {
                return;
            };
            let (gone, keep): (Vec<_>, Vec<_>) =
                list.drain(..).partition(|(_, k)| key_equals(k, view_key));
            *list = keep;
            let gone_ids: HashSet<u64> = gone.iter().map(|(x, _)| x.id()).collect();
            if let Some(w) = st.awaiting.get_mut(session_id) {
                w.retain(|(x, _)| !gone_ids.contains(&x.id()));
            }
            for (sub, _) in gone {
                out.push(Out::Send(
                    sub,
                    "terminalEnded",
                    json!({ "sessionId": session_id, "reason": "revoked" }),
                ));
            }
        }
        self.run(out);
    }

    /// 서버가 writer 키를 갈아 끼운다(None 이면 거둔다). 갈기 **전에** 옛 번호로 센 바이트를 턴다.
    pub fn grant_writer(&self, session_id: &str, writer_key: Option<&str>, r#gen: Option<i64>) {
        let mut out = Vec::new();
        {
            let mut st = lock(&self.state);
            out.extend(st.take_flush(session_id));
            st.writer_gen.remove(session_id);
            match writer_key {
                None => {
                    st.writer_key.remove(session_id);
                }
                Some(k) if !usable_key(k) => {
                    self.deps.log(&format!(
                        "localTerminal: {session_id} writer 키가 너무 짧아 받지 않는다"
                    ));
                    st.writer_key.remove(session_id);
                }
                Some(k) => {
                    if let Some(g) = r#gen {
                        st.writer_gen.insert(session_id.to_string(), g);
                    }
                    st.writer_key.insert(session_id.to_string(), k.to_string());
                }
            }
        }
        self.run(out);
    }

    pub fn input(&self, session_id: &str, writer_key: &str, data: &str) -> Result<(), Refusal> {
        // 문을 지날 때의 writer 번호를 같이 잡는다 — 보내는 사이 키가 갈리면 이 바이트는 옛 번호의 몫이다(security c4-1 낮음).
        let (runner_id, gate_gen) = {
            let st = lock(&self.state);
            let r = st.writer_gate(session_id, writer_key)?;
            (r, st.writer_gen.get(session_id).copied())
        };
        let frame = json!({ "type": "input", "sessionId": session_id, "data": data });
        if !self.deps.send_to_runner(&runner_id, &frame) {
            return Err(Refusal::RunnerGone);
        }
        let bytes = base64_byte_length(data);
        let mut out = Vec::new();
        let mut arm = false;
        {
            let mut st = lock(&self.state);
            *st.input_bytes.entry(session_id.to_string()).or_insert(0) += bytes;
            if st.writer_gen.get(session_id).copied() != gate_gen {
                // 그사이 키가 갈렸다 — 새 writer 의 창에 섞지 않고 옛 번호로 바로 보고한다.
                if let Some(g) = gate_gen {
                    out.push(Out::Report(
                        Unreported {
                            runner_id: runner_id.clone(),
                            r#gen: g,
                            bytes,
                        },
                        session_id.to_string(),
                    ));
                }
            } else if let Some(g) = gate_gen {
                match st.unreported.get_mut(session_id) {
                    Some(u) if u.r#gen == g => u.bytes += bytes,
                    _ => {
                        out.extend(st.take_flush(session_id));
                        st.unreported.insert(
                            session_id.to_string(),
                            Unreported {
                                runner_id: runner_id.clone(),
                                r#gen: g,
                                bytes,
                            },
                        );
                    }
                }
                arm = st.pending_flush.insert(session_id.to_string());
            }
        }
        self.run(out);
        if arm {
            let me = self.me.clone();
            let id = session_id.to_string();
            self.deps.schedule(
                Box::new(move || {
                    if let Some(hub) = me.upgrade() {
                        hub.flush(&id);
                    }
                }),
                INPUT_REPORT_MS,
            );
        }
        Ok(())
    }

    /// 모아 둔 바이트를 지금 보고한다.
    pub fn flush(&self, session_id: &str) {
        let out: Vec<Out> = lock(&self.state)
            .take_flush(session_id)
            .into_iter()
            .collect();
        self.run(out);
    }

    pub fn resize(
        &self,
        session_id: &str,
        writer_key: &str,
        cols: &Value,
        rows: &Value,
    ) -> Result<(), Refusal> {
        // TS `Number.isInteger` — 2.0 같은 정수 꼴 실수도 받는다.
        let dim = |v: &Value| -> Option<i64> {
            let f = v.as_f64()?;
            (f.fract() == 0.0 && (1.0..=MAX_DIM as f64).contains(&f)).then_some(f as i64)
        };
        let (Some(cols), Some(rows)) = (dim(cols), dim(rows)) else {
            return Err(Refusal::BadSize);
        };
        let runner_id = lock(&self.state).writer_gate(session_id, writer_key)?;
        let frame =
            json!({ "type": "resize", "sessionId": session_id, "cols": cols, "rows": rows });
        if self.deps.send_to_runner(&runner_id, &frame) {
            Ok(())
        } else {
            Err(Refusal::RunnerGone)
        }
    }

    /// 지난 호출 뒤로 이 경로에 들어간 입력 바이트 수. 읽으면 0 으로 돌아간다.
    pub fn take_input_bytes(&self, session_id: &str) -> i64 {
        lock(&self.state)
            .input_bytes
            .remove(session_id)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests;
