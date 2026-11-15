//! 릴레이 허브(S5.3 C6c-3, TS `ws/relay.ts`) — 러너 PTY ↔ 서버 ↔ 데스크톱 xterm 바이트를 잇는 인메모리 레지스트리.
//!
//! **서버는 불투명 우체국이다.** 프레임의 봉투만 열어 `sessionId` 를 읽고, 바이트(`data`, base64)는 문자열 그대로 옮긴다 —
//! 디코드하면 청크 경계에서 잘린 UTF-8·ANSI 가 깨진다. 바이트 수는 `base64_byte_len` 의 길이 산술로만 센다.
//!
//! **PTY 바이트·키를 DB·로그·tracing 에 남기지 않는다**(security C6c ②③). 이 파일에는 로그 호출이 없다. 감사는 라우트가
//! detach 때 입력 바이트 합 하나만 남긴다.
//!
//! **이벤트 버스를 타지 않는다.** 버스는 워크스페이스 전체 브로드캐스트라, 세션 바이트를 흘리면 모든 소켓이 PTY 출력을 받는다.
//!
//! 이 허브는 소켓도 DB 도 모른다 — 뷰어는 `mpsc` 송신기, 러너는 `RunnerSink`(보냈는가를 돌려주는 함수)로만 본다. 그래서
//! 프레임 순서·writer 승계·키 회수 순서를 소켓 없이 시험한다. 상태 판정은 TS 와 한 줄씩 대응한다(같은 이름을 쓴다).
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

/// 러너에게 보낼 릴레이 프레임(옛 `RelayServerFrame` 모양 — `runnerId` 감싸기는 라우트가 한다). 보냈으면 true.
pub type RunnerSink = Arc<dyn Fn(&Value) -> bool + Send + Sync>;
/// 뷰어 소켓으로 나갈 텍스트 프레임. 닫힌 소켓에 보내도 허브는 멈추지 않는다(close 가 곧 정리한다).
pub type ViewerTx = mpsc::UnboundedSender<String>;

/// TS `ATTENTION_ORPHAN_GRACE_MS`.
pub const ATTENTION_ORPHAN_GRACE: Duration = Duration::from_secs(60);
/// TS `INTERACTIVE_OPEN_TIMEOUT_MS`.
pub const INTERACTIVE_OPEN_TIMEOUT: Duration = Duration::from_secs(10);

/// TS `base64ByteLength` — 디코드 없이 길이 산술로만.
pub fn base64_byte_len(data: &str) -> u64 {
    let padding = if data.ends_with("==") {
        2
    } else if data.ends_with('=') {
        1
    } else {
        0
    };
    ((data.len() as u64 * 3) / 4).saturating_sub(padding)
}

/// TS `isPtySize` — 1..=1000 정수.
fn pty_size(v: Option<&Value>) -> Option<u64> {
    v.and_then(Value::as_u64).filter(|n| (1..=1000).contains(n))
}

/// TS `newLocalKey` — 192bit 난수(base64url 32자).
fn new_local_key() -> String {
    let mut b = [0u8; 24];
    getrandom::fill(&mut b).expect("os random");
    crate::inbox_today::b64url(&b)
}

fn random_request_id() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("os random");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// TS `isPoolRank`·`isAccountRank` — 0 이상 안전 정수.
fn rank(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991)
}

pub type Session = Map<String, Value>;

/// 허브 밖으로 나가는 관문 알림(TS `RelayHubHooks`). 화면 바이트는 넘기지 않는다.
#[derive(Debug, Clone, PartialEq)]
pub enum Attention {
    Raised {
        session_id: String,
        channel_id: String,
        thread_root_id: Option<String>,
        agent_account_id: String,
        claude_pool_rank: Option<u64>,
        /// None = 안 실림, Some(None) = null.
        claude_account_rank: Option<Option<u64>>,
    },
    Cleared {
        session_id: String,
        channel_id: String,
        thread_root_id: Option<String>,
        agent_account_id: String,
    },
}
pub type AttentionHook = Arc<dyn Fn(Attention) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CancelOutcome {
    Ok,
    NotFound,
    NoRunner,
    RunnerOutdated,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InteractiveOutcome {
    Opened { session_id: String, created: bool },
    NoRunner,
    RunnerOutdated,
    RunnerTimeout,
    RunnerRejected(Option<String>),
}

struct Viewer {
    id: u64,
    tx: ViewerTx,
    awaiting_replay: bool,
    queued: Vec<String>,
    input_bytes: u64,
    control: bool,
    view_key: Option<String>,
    writer_key: Option<String>,
    gen_: Option<u64>,
    gens: HashSet<u64>,
}

struct Runner {
    conn: u64,
    sink: RunnerSink,
    sessions: HashMap<String, Session>,
    caps: HashSet<String>,
}

struct Raised {
    agent: String,
    channel: String,
    thread: Option<String>,
}

struct Pending {
    agent: String,
    tx: oneshot::Sender<InteractiveOutcome>,
}

#[derive(Default)]
struct State {
    runners: HashMap<String, Runner>,
    owner_of: HashMap<String, String>,
    /// 삽입 순서 = attach 순서. writer 승계가 끝을 읽는다.
    viewers: HashMap<String, Vec<Viewer>>,
    writer_of: HashMap<String, u64>,
    pty_size_of: HashMap<String, (u64, u64)>,
    attention_raised: HashMap<String, Raised>,
    pending_viewer_counts: HashSet<String>,
    pending_opens: HashMap<String, Pending>,
    /// 러너가 끊긴 에이전트의 관문 정리 세대. 다시 붙으면 올라가 앞 타이머를 무효로 만든다.
    orphan_epoch: HashMap<String, u64>,
    next_gen: u64,
    next_id: u64,
}

/// 허브 — 프로세스에 하나. 복제는 같은 허브를 가리킨다.
#[derive(Clone)]
pub struct RelayHub {
    state: Arc<Mutex<State>>,
    hook: Option<AttentionHook>,
    grace: Duration,
}

/// 러너 등록 표. `detach` 로 지운다 — 이미 교체됐으면 아무 일도 없다(TS 의 `runners.get(id) !== runner`).
pub struct RunnerReg {
    agent: String,
    conn: u64,
}

/// 뷰어 하나의 손잡이(TS `ViewerHandle`).
pub struct ViewerHandle {
    hub: RelayHub,
    session_id: String,
    id: u64,
}

fn send_to(v: &Viewer, frame: Value) {
    let _ = v.tx.send(frame.to_string());
}

impl State {
    fn hook_out(&mut self, out: &mut Vec<Attention>, session_id: &str) {
        if let Some(r) = self.attention_raised.remove(session_id) {
            out.push(Attention::Cleared {
                session_id: session_id.to_owned(),
                channel_id: r.channel,
                thread_root_id: r.thread,
                agent_account_id: r.agent,
            });
        }
    }

    fn clear_attention_of(
        &mut self,
        out: &mut Vec<Attention>,
        agent: &str,
        keep: &HashSet<String>,
    ) {
        let ids: Vec<String> = self
            .attention_raised
            .iter()
            .filter(|(sid, r)| r.agent == agent && !keep.contains(*sid))
            .map(|(sid, _)| sid.clone())
            .collect();
        for sid in ids {
            self.hook_out(out, &sid);
        }
    }

    fn forget_size_if_unseen(&mut self, sid: &str) {
        if !self.viewers.contains_key(sid) {
            self.pty_size_of.remove(sid);
        }
    }

    fn broadcast_status(&self, sid: &str, state: &str) {
        for v in self.viewers.get(sid).into_iter().flatten() {
            send_to(v, json!({ "type": "status", "state": state }));
        }
    }

    fn runner_for(&self, sid: &str) -> Option<&Runner> {
        self.owner_of.get(sid).and_then(|a| self.runners.get(a))
    }

    fn send_runner_of(&self, sid: &str, frame: Value) -> bool {
        self.runner_for(sid).is_some_and(|r| (r.sink)(&frame))
    }

    /// TS `inputDenial`.
    fn input_denial(&self, sid: &str) -> Option<&'static str> {
        let Some(runner) = self.runner_for(sid).filter(|r| r.caps.contains("input")) else {
            return Some("runner-outdated");
        };
        match runner.sessions.get(sid).and_then(|s| s.get("acceptsInput")) {
            Some(Value::Bool(true)) => None,
            Some(Value::Bool(false)) => Some("observe-only"),
            _ => Some("runner-outdated"),
        }
    }

    fn local_capable(&self, sid: &str) -> bool {
        self.runner_for(sid)
            .is_some_and(|r| r.caps.contains("local-terminal"))
    }

    fn viewer_mut(&mut self, sid: &str, id: u64) -> Option<&mut Viewer> {
        self.viewers.get_mut(sid)?.iter_mut().find(|v| v.id == id)
    }

    fn viewer(&self, sid: &str, id: u64) -> Option<&Viewer> {
        self.viewers.get(sid)?.iter().find(|v| v.id == id)
    }

    /// TS `grantLocal` — 못 보냈으면 세대를 주지 않는다.
    fn grant_local(&mut self, sid: &str, id: u64) -> Option<String> {
        if !self.viewer(sid, id)?.control || !self.local_capable(sid) {
            return None;
        }
        self.next_gen += 1;
        let gen_ = self.next_gen;
        let key = new_local_key();
        let frame =
            json!({ "type": "local.writer", "sessionId": sid, "writerKey": key, "gen": gen_ });
        if !self.send_runner_of(sid, frame) {
            return None;
        }
        let v = self.viewer_mut(sid, id)?;
        v.writer_key = Some(key.clone());
        v.gen_ = Some(gen_);
        v.gens.insert(gen_);
        Some(key)
    }

    /// TS `revokeLocal`.
    fn revoke_local(&mut self, sid: &str, id: u64) {
        let Some(v) = self.viewer_mut(sid, id) else {
            return;
        };
        let (Some(_), Some(gen_)) = (v.writer_key.take(), v.gen_.take()) else {
            return;
        };
        if self.local_capable(sid) {
            self.send_runner_of(
                sid,
                json!({ "type": "local.writer", "sessionId": sid, "writerKey": null, "gen": gen_ }),
            );
        }
    }

    /// TS `revokeView`.
    fn revoke_view(&mut self, sid: &str, id: u64) {
        let Some(key) = self.viewer_mut(sid, id).and_then(|v| v.view_key.take()) else {
            return;
        };
        if self.local_capable(sid) {
            self.send_runner_of(
                sid,
                json!({ "type": "local.view", "sessionId": sid, "viewKey": key, "granted": false }),
            );
        }
    }

    /// TS `reconcileLocalWriter` — 입력이 닫혔으면 키를 거둔다(security F1). 열려 있으면 true.
    fn reconcile_local_writer(&mut self, sid: &str) -> bool {
        let Some(&w) = self.writer_of.get(sid) else {
            return false;
        };
        if self
            .viewer(sid, w)
            .and_then(|v| v.writer_key.as_ref())
            .is_none()
        {
            return false;
        }
        if self.input_denial(sid).is_none() {
            return true;
        }
        self.revoke_local(sid, w);
        false
    }

    /// TS `setWriter` — 옛 차례의 로컬 키를 **먼저** 거두고, 강등을 알린 뒤 새 차례를 준다.
    fn set_writer(&mut self, sid: &str, next: Option<u64>) {
        let prev = self.writer_of.get(sid).copied();
        if prev == next {
            return;
        }
        if let Some(p) = prev {
            self.revoke_local(sid, p);
            if let Some(v) = self.viewer(sid, p) {
                send_to(
                    v,
                    json!({ "type": "writer", "writer": false, "resize": false, "reason": "other-writer" }),
                );
            }
        }
        match next {
            Some(n) => {
                self.writer_of.insert(sid.to_owned(), n);
                let denial = self.input_denial(sid);
                let key = if denial.is_none() {
                    self.grant_local(sid, n)
                } else {
                    None
                };
                if let Some(v) = self.viewer(sid, n) {
                    let mut f = json!({ "type": "writer", "writer": denial.is_none(), "resize": true, "reason": denial });
                    if let Some(k) = key {
                        f["writerKey"] = json!(k);
                    }
                    send_to(v, f);
                }
            }
            None => {
                self.writer_of.remove(sid);
            }
        }
    }

    fn notify_viewer_count(&mut self, sid: &str) {
        let count = self.viewers.get(sid).map_or(0, Vec::len);
        if self.send_runner_of(
            sid,
            json!({ "type": "viewer.count", "sessionId": sid, "count": count }),
        ) {
            self.pending_viewer_counts.remove(sid);
        } else {
            self.pending_viewer_counts.insert(sid.to_owned());
        }
    }

    fn register_session(&mut self, agent: &str, mut session: Session) {
        let Some(runner) = self.runners.get_mut(agent) else {
            return;
        };
        let Some(sid) = session
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return;
        };
        // 계정·풀 **이름**은 받자마자 버린다(#1039) — 순번만 남긴다.
        session.remove("claudeAccount");
        session.remove("claudePool");
        runner.sessions.insert(sid.clone(), session);
        self.owner_of.insert(sid, agent.to_owned());
    }

    fn drop_session(&mut self, out: &mut Vec<Attention>, agent: &str, sid: &str) {
        if let Some(r) = self.runners.get_mut(agent) {
            r.sessions.remove(sid);
        }
        // 소유를 먼저 본다(security n2).
        if self
            .attention_raised
            .get(sid)
            .is_some_and(|r| r.agent == agent)
        {
            self.hook_out(out, sid);
        }
        self.broadcast_status(sid, "ended");
        self.owner_of.remove(sid);
        self.forget_size_if_unseen(sid);
        self.pending_viewer_counts.remove(sid);
    }

    fn fail_pending_opens(&mut self, agent: &str, outcome: InteractiveOutcome) {
        let ids: Vec<String> = self
            .pending_opens
            .iter()
            .filter(|(_, p)| p.agent == agent)
            .map(|(k, _)| k.clone())
            .collect();
        for id in ids {
            if let Some(p) = self.pending_opens.remove(&id) {
                let _ = p.tx.send(outcome.clone());
            }
        }
    }

    fn drop_runner_sessions(&mut self, agent: &str) {
        let sids: Vec<String> = self
            .runners
            .get(agent)
            .map(|r| r.sessions.keys().cloned().collect())
            .unwrap_or_default();
        for sid in sids {
            self.broadcast_status(&sid, "runner-offline");
            self.owner_of.remove(&sid);
            self.forget_size_if_unseen(&sid);
        }
    }
}

impl RelayHub {
    pub fn new(hook: Option<AttentionHook>) -> Self {
        Self::with_grace(hook, ATTENTION_ORPHAN_GRACE)
    }

    pub fn with_grace(hook: Option<AttentionHook>, grace: Duration) -> Self {
        Self {
            state: Arc::default(),
            hook,
            grace,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 관문 알림은 잠금 밖에서 낸다 — 훅이 DB 를 부르는 일을 띄워도 허브를 잡고 있지 않게.
    fn emit(&self, out: Vec<Attention>) {
        if let Some(h) = &self.hook {
            for a in out {
                h(a);
            }
        }
    }

    /// TS `addRunner` — 에이전트당 러너 하나. 새 것이 옛 것을 밀어낸다.
    pub fn add_runner(&self, agent: &str, sink: RunnerSink) -> RunnerReg {
        let mut s = self.lock();
        s.next_id += 1;
        let conn = s.next_id;
        if s.runners.contains_key(agent) {
            s.drop_runner_sessions(agent);
        }
        s.runners.insert(
            agent.to_owned(),
            Runner {
                conn,
                sink,
                sessions: HashMap::new(),
                caps: HashSet::new(),
            },
        );
        // 다시 붙었다 — 앞 정리 타이머를 무효로 한다.
        *s.orphan_epoch.entry(agent.to_owned()).or_default() += 1;
        RunnerReg {
            agent: agent.to_owned(),
            conn,
        }
    }

    /// TS `addRunner` 가 돌려주는 detach.
    pub fn detach_runner(&self, reg: &RunnerReg) {
        let epoch = {
            let mut s = self.lock();
            if s.runners.get(&reg.agent).is_none_or(|r| r.conn != reg.conn) {
                return;
            }
            s.drop_runner_sessions(&reg.agent);
            s.runners.remove(&reg.agent);
            s.fail_pending_opens(&reg.agent, InteractiveOutcome::NoRunner);
            let e = s.orphan_epoch.entry(reg.agent.clone()).or_default();
            *e += 1;
            *e
        };
        // 관문은 바로 내리지 않는다 — 유예 안에 아무 러너도 안 돌아오면 그때 전부 내린다(security n1).
        let hub = self.clone();
        let agent = reg.agent.clone();
        tokio::spawn(async move {
            tokio::time::sleep(hub.grace).await;
            let mut out = Vec::new();
            {
                let mut s = hub.lock();
                if s.orphan_epoch.get(&agent) == Some(&epoch) && !s.runners.contains_key(&agent) {
                    s.clear_attention_of(&mut out, &agent, &HashSet::new());
                }
            }
            hub.emit(out);
        });
    }

    /// TS `onRunnerFrame` — 옛 릴레이 모양(`announce`·`output`…)으로 풀린 프레임.
    pub fn on_runner_frame(&self, agent: &str, frame: &Map<String, Value>) {
        let mut out = Vec::new();
        {
            let mut s = self.lock();
            let s = &mut *s;
            let str_of = |k: &str| frame.get(k).and_then(Value::as_str).map(str::to_owned);
            match frame.get("type").and_then(Value::as_str).unwrap_or("") {
                "announce" => {
                    let Some(list) = frame.get("sessions").and_then(Value::as_array) else {
                        return;
                    };
                    let Some(runner) = s.runners.get_mut(agent) else {
                        return;
                    };
                    let old: Vec<String> = runner.sessions.drain().map(|(k, _)| k).collect();
                    for sid in old {
                        s.owner_of.remove(&sid);
                        s.forget_size_if_unseen(&sid);
                    }
                    for sess in list {
                        if let Value::Object(m) = sess {
                            s.register_session(agent, m.clone());
                        }
                    }
                    let keep: HashSet<String> = s.runners[agent].sessions.keys().cloned().collect();
                    s.clear_attention_of(&mut out, agent, &keep);
                    let caps: HashSet<String> = frame
                        .get("caps")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|c| c.as_str().map(str::to_owned))
                        .collect();
                    let local = caps.contains("local-terminal");
                    if let Some(r) = s.runners.get_mut(agent) {
                        r.caps = caps;
                    }
                    // 뷰어 수 화해(TS `resyncViewerCounts`).
                    let mut sids: Vec<String> = keep.into_iter().collect();
                    sids.sort();
                    for sid in &sids {
                        s.notify_viewer_count(sid);
                    }
                    // 로컬 키 재발송 — 열람 키 먼저, writer 키 나중(security ③). 입력이 닫혔으면 거둔다.
                    if local {
                        for sid in &sids {
                            let views: Vec<String> = s
                                .viewers
                                .get(sid)
                                .into_iter()
                                .flatten()
                                .filter_map(|v| v.view_key.clone())
                                .collect();
                            for k in views {
                                s.send_runner_of(sid, json!({ "type": "local.view", "sessionId": sid, "viewKey": k, "granted": true }));
                            }
                            if s.reconcile_local_writer(sid) {
                                let w = s.writer_of.get(sid).copied();
                                let wk = w
                                    .and_then(|w| s.viewer(sid, w))
                                    .and_then(|v| Some((v.writer_key.clone()?, v.gen_?)));
                                if let Some((k, g)) = wk {
                                    s.send_runner_of(sid, json!({ "type": "local.writer", "sessionId": sid, "writerKey": k, "gen": g }));
                                }
                            }
                        }
                    }
                }
                "session.started" => {
                    let Some(Value::Object(sess)) = frame.get("session") else {
                        return;
                    };
                    let Some(sid) = sess
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .filter(|x| !x.is_empty())
                        .map(str::to_owned)
                    else {
                        return;
                    };
                    s.register_session(agent, sess.clone());
                    s.broadcast_status(&sid, "running");
                    s.notify_viewer_count(&sid);
                    s.reconcile_local_writer(&sid);
                }
                "session.ended" => {
                    if let Some(sid) = str_of("sessionId") {
                        s.drop_session(&mut out, agent, &sid);
                    }
                }
                ty @ ("interactive.opened" | "interactive.error") => {
                    let Some(rid) = str_of("requestId") else {
                        return;
                    };
                    // 응답은 요청을 보냈던 그 러너에서만 받는다.
                    if s.pending_opens.get(&rid).is_none_or(|p| p.agent != agent) {
                        return;
                    }
                    let p = s.pending_opens.remove(&rid).expect("checked");
                    let outcome = if ty == "interactive.opened" {
                        let Some(sid) = str_of("sessionId") else {
                            return;
                        };
                        InteractiveOutcome::Opened {
                            session_id: sid,
                            created: frame.get("created") == Some(&Value::Bool(true)),
                        }
                    } else {
                        InteractiveOutcome::RunnerRejected(str_of("message"))
                    };
                    let _ = p.tx.send(outcome);
                }
                "attention.required" => {
                    let Some(sid) = str_of("sessionId") else {
                        return;
                    };
                    if s.owner_of.get(&sid).map(String::as_str) != Some(agent) {
                        return;
                    }
                    let Some(sess) = s.runners.get(agent).and_then(|r| r.sessions.get(&sid)) else {
                        return;
                    };
                    let channel = sess
                        .get("channelId")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    let thread = sess
                        .get("threadRootId")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    s.attention_raised.insert(
                        sid.clone(),
                        Raised {
                            agent: agent.to_owned(),
                            channel: channel.clone(),
                            thread: thread.clone(),
                        },
                    );
                    out.push(Attention::Raised {
                        session_id: sid,
                        channel_id: channel,
                        thread_root_id: thread,
                        agent_account_id: agent.to_owned(),
                        claude_pool_rank: frame
                            .get("claudePoolRank")
                            .filter(|v| rank(v))
                            .and_then(Value::as_u64),
                        claude_account_rank: match frame.get("claudeAccountRank") {
                            Some(Value::Null) => Some(None),
                            Some(v) if rank(v) => Some(v.as_u64()),
                            _ => None,
                        },
                    });
                }
                "output" => {
                    let (Some(sid), Some(data)) = (str_of("sessionId"), str_of("data")) else {
                        return;
                    };
                    if s.owner_of.get(&sid).map(String::as_str) != Some(agent) {
                        return;
                    }
                    for v in s.viewers.get_mut(&sid).into_iter().flatten() {
                        if v.control {
                            continue;
                        }
                        if v.awaiting_replay {
                            v.queued.push(data.clone());
                        } else {
                            send_to(v, json!({ "type": "output", "data": data }));
                        }
                    }
                }
                "replay" => {
                    let (Some(sid), Some(data)) = (str_of("sessionId"), str_of("data")) else {
                        return;
                    };
                    if s.owner_of.get(&sid).map(String::as_str) != Some(agent) {
                        return;
                    }
                    for v in s.viewers.get_mut(&sid).into_iter().flatten() {
                        if !v.awaiting_replay {
                            continue;
                        }
                        send_to(v, json!({ "type": "output", "data": data }));
                        v.awaiting_replay = false;
                        for q in std::mem::take(&mut v.queued) {
                            send_to(v, json!({ "type": "output", "data": q }));
                        }
                    }
                }
                "local.input" => {
                    let Some(sid) = str_of("sessionId") else {
                        return;
                    };
                    if s.owner_of.get(&sid).map(String::as_str) != Some(agent) {
                        return;
                    }
                    let safe = |v: Option<&Value>| {
                        v.and_then(Value::as_u64)
                            .filter(|n| *n <= 9_007_199_254_740_991)
                    };
                    let (Some(gen_), Some(bytes)) =
                        (safe(frame.get("gen")), safe(frame.get("bytes")))
                    else {
                        return;
                    };
                    if let Some(v) = s
                        .viewers
                        .get_mut(&sid)
                        .into_iter()
                        .flatten()
                        .find(|v| v.gens.contains(&gen_))
                    {
                        v.input_bytes += bytes;
                    }
                }
                _ => {}
            }
        }
        self.emit(out);
    }

    /// TS `listSessions` — `None` 이면 전체(admin).
    pub fn list_sessions(&self, agents: Option<&[String]>) -> Vec<Session> {
        let s = self.lock();
        let mut out: Vec<Session> = s
            .runners
            .iter()
            .filter(|(a, _)| agents.is_none_or(|l| l.contains(a)))
            .flat_map(|(_, r)| r.sessions.values().cloned())
            .collect();
        out.sort_by(|a, b| {
            let k = |m: &Session| {
                m.get("startedAt")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            };
            k(a).cmp(&k(b))
        });
        out
    }

    pub fn get_session(&self, sid: &str) -> Option<Session> {
        let s = self.lock();
        s.runner_for(sid)?.sessions.get(sid).cloned()
    }

    /// TS `addViewer`.
    pub fn add_viewer(&self, sid: &str, tx: ViewerTx, control: bool) -> ViewerHandle {
        let mut s = self.lock();
        s.next_id += 1;
        let id = s.next_id;
        let runner_caps = s.runner_for(sid).map(|r| r.caps.clone());
        let has_runner = runner_caps.is_some();
        let mut control = control
            && runner_caps
                .as_ref()
                .is_some_and(|c| c.contains("local-terminal"));
        let mut view_key = None;
        if control {
            let k = new_local_key();
            if s.send_runner_of(
                sid,
                json!({ "type": "local.view", "sessionId": sid, "viewKey": k, "granted": true }),
            ) {
                view_key = Some(k);
            } else {
                control = false;
            }
        }
        let viewer = Viewer {
            id,
            tx,
            awaiting_replay: has_runner && !control,
            queued: Vec::new(),
            input_bytes: 0,
            control,
            view_key: view_key.clone(),
            writer_key: None,
            gen_: None,
            gens: HashSet::new(),
        };
        if !has_runner {
            send_to(
                &viewer,
                json!({ "type": "status", "state": "runner-offline" }),
            );
        } else {
            send_to(&viewer, json!({ "type": "status", "state": "running" }));
            if let Some(k) = &view_key {
                send_to(&viewer, json!({ "type": "local", "viewKey": k }));
            }
        }
        s.viewers.entry(sid.to_owned()).or_default().push(viewer);
        if has_runner && !control {
            s.send_runner_of(sid, json!({ "type": "replay.request", "sessionId": sid }));
        }
        if runner_caps.as_ref().is_some_and(|c| c.contains("input")) {
            s.set_writer(sid, Some(id));
        } else if let Some(v) = s.viewer(sid, id) {
            send_to(
                v,
                json!({ "type": "writer", "writer": false, "resize": false, "reason": "runner-outdated" }),
            );
        }
        if let (Some(&(cols, rows)), Some(v)) = (s.pty_size_of.get(sid), s.viewer(sid, id)) {
            send_to(v, json!({ "type": "size", "cols": cols, "rows": rows }));
        }
        s.notify_viewer_count(sid);
        drop(s);
        ViewerHandle {
            hub: self.clone(),
            session_id: sid.to_owned(),
            id,
        }
    }

    /// TS `cancelSession`.
    pub fn cancel_session(&self, sid: &str, by_handle: &str) -> CancelOutcome {
        let s = self.lock();
        let Some(agent) = s.owner_of.get(sid) else {
            return CancelOutcome::NotFound;
        };
        let Some(runner) = s.runners.get(agent) else {
            return CancelOutcome::NoRunner;
        };
        if !runner.caps.contains("cancel") {
            return CancelOutcome::RunnerOutdated;
        }
        (runner.sink)(
            &json!({ "type": "session.cancel", "sessionId": sid, "byHandle": by_handle }),
        );
        CancelOutcome::Ok
    }

    /// TS `openInteractive`.
    pub async fn open_interactive(
        &self,
        agent: &str,
        channel_id: &str,
        thread_root_id: &str,
        opened_by_handle: &str,
        size: Option<(u64, u64)>,
        timeout: Duration,
    ) -> InteractiveOutcome {
        let (request_id, rx) = {
            let mut s = self.lock();
            let Some(runner) = s.runners.get(agent) else {
                return InteractiveOutcome::NoRunner;
            };
            if !runner.caps.contains("interactive") {
                return InteractiveOutcome::RunnerOutdated;
            }
            let sink = runner.sink.clone();
            let request_id = random_request_id();
            let (tx, rx) = oneshot::channel();
            s.pending_opens.insert(
                request_id.clone(),
                Pending {
                    agent: agent.to_owned(),
                    tx,
                },
            );
            let mut f = json!({
                "type": "interactive.open", "requestId": request_id, "channelId": channel_id,
                "threadRootId": thread_root_id, "openedByHandle": opened_by_handle,
            });
            if let Some((c, r)) = size {
                f["cols"] = json!(c);
                f["rows"] = json!(r);
            }
            sink(&f);
            (request_id, rx)
        };
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(o)) => o,
            Ok(Err(_)) => InteractiveOutcome::NoRunner,
            Err(_) => {
                self.lock().pending_opens.remove(&request_id);
                InteractiveOutcome::RunnerTimeout
            }
        }
    }
}

impl ViewerHandle {
    /// TS `ViewerHandle.close` — writer 키를 먼저, 그다음 열람 키를 거두고, 승계는 그 뒤.
    pub fn close(&self) {
        let mut s = self.hub.lock();
        let sid = self.session_id.as_str();
        if s.viewer(sid, self.id).is_none() {
            return;
        }
        s.revoke_local(sid, self.id);
        s.revoke_view(sid, self.id);
        let list = s.viewers.get_mut(sid).expect("viewer exists");
        list.retain(|v| v.id != self.id);
        let last = list.last().map(|v| v.id);
        if list.is_empty() {
            s.viewers.remove(sid);
            if !s.owner_of.contains_key(sid) {
                s.pty_size_of.remove(sid);
            }
        }
        if s.writer_of.get(sid) == Some(&self.id) {
            // 떠나는 창은 목록에서 빠졌다 — 강등 통지는 갈 곳이 없으니 차례만 지우고 승계한다.
            s.writer_of.remove(sid);
            s.set_writer(sid, last);
        }
        s.notify_viewer_count(sid);
    }

    /// TS `handleMessage` — 러너로 포워딩했으면 true.
    pub fn handle_message(&self, raw: &str) -> bool {
        let Ok(Value::Object(frame)) = serde_json::from_str::<Value>(raw) else {
            return false;
        };
        let ty = frame.get("type").and_then(Value::as_str).unwrap_or("");
        if ty != "input" && ty != "resize" {
            return false;
        }
        let mut s = self.hub.lock();
        let sid = self.session_id.as_str();
        if s.writer_of.get(sid) != Some(&self.id) {
            return false;
        }
        if !s.runner_for(sid).is_some_and(|r| r.caps.contains("input")) {
            return false;
        }
        if ty == "input" && s.input_denial(sid).is_some() {
            return false;
        }
        if ty == "resize" {
            let (Some(cols), Some(rows)) =
                (pty_size(frame.get("cols")), pty_size(frame.get("rows")))
            else {
                return false;
            };
            s.send_runner_of(
                sid,
                json!({ "type": "resize", "sessionId": sid, "cols": cols, "rows": rows }),
            );
            if s.pty_size_of.get(sid) != Some(&(cols, rows)) {
                s.pty_size_of.insert(sid.to_owned(), (cols, rows));
                for v in s.viewers.get(sid).into_iter().flatten() {
                    send_to(v, json!({ "type": "size", "cols": cols, "rows": rows }));
                }
            }
            return true;
        }
        let Some(data) = frame.get("data").and_then(Value::as_str) else {
            return false;
        };
        s.send_runner_of(
            sid,
            json!({ "type": "input", "sessionId": sid, "data": data }),
        );
        if let Some(v) = s.viewer_mut(sid, self.id) {
            v.input_bytes += base64_byte_len(data);
        }
        true
    }

    /// 이 뷰어가 러너로 흘린 입력 바이트 누계(내용 없음).
    pub fn input_bytes(&self) -> u64 {
        self.hub
            .lock()
            .viewer(&self.session_id, self.id)
            .map_or(0, |v| v.input_bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Sent = Arc<Mutex<Vec<Value>>>;

    fn runner(hub: &RelayHub, agent: &str) -> (RunnerReg, Sent) {
        let sent: Sent = Arc::default();
        let s2 = sent.clone();
        let reg = hub.add_runner(
            agent,
            Arc::new(move |f: &Value| {
                s2.lock().unwrap().push(f.clone());
                true
            }),
        );
        (reg, sent)
    }

    fn frame(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn drain(rx: &mut mpsc::UnboundedReceiver<String>) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(s) = rx.try_recv() {
            out.push(serde_json::from_str(&s).unwrap());
        }
        out
    }

    fn announce(hub: &RelayHub, agent: &str, caps: &[&str]) {
        hub.on_runner_frame(agent, &frame(json!({
            "type": "announce", "caps": caps,
            "sessions": [{ "sessionId": "s1", "agentAccountId": agent, "channelId": "c1", "threadRootId": "t1",
                           "harness": "claude", "startedAt": "2026-11-16T00:00:00Z", "acceptsInput": true,
                           "claudeAccount": "Some Person", "claudePool": "pool-name" }],
        })));
    }

    #[test]
    fn base64_len_matches_ts() {
        assert_eq!(base64_byte_len(""), 0);
        assert_eq!(base64_byte_len("YQ=="), 1);
        assert_eq!(base64_byte_len("YWI="), 2);
        assert_eq!(base64_byte_len("YWJj"), 3);
    }

    #[test]
    fn announce_strips_names_and_replay_precedes_live() {
        let hub = RelayHub::new(None);
        let (_reg, sent) = runner(&hub, "a1");
        announce(&hub, "a1", &["input"]);
        let sess = hub.get_session("s1").unwrap();
        assert!(!sess.contains_key("claudeAccount") && !sess.contains_key("claudePool"));

        let (tx, mut rx) = mpsc::unbounded_channel();
        let _v = hub.add_viewer("s1", tx, false);
        hub.on_runner_frame(
            "a1",
            &frame(json!({ "type": "output", "sessionId": "s1", "data": "TElWRQ==" })),
        );
        hub.on_runner_frame(
            "a1",
            &frame(json!({ "type": "replay", "sessionId": "s1", "data": "T0xE" })),
        );
        let outs: Vec<String> = drain(&mut rx)
            .into_iter()
            .filter(|f| f["type"] == "output")
            .map(|f| f["data"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(outs, ["T0xE", "TElWRQ=="]);
        assert!(
            sent.lock()
                .unwrap()
                .iter()
                .any(|f| f["type"] == "replay.request")
        );
    }

    #[test]
    fn foreign_runner_cannot_push_bytes() {
        let hub = RelayHub::new(None);
        let (_r1, _) = runner(&hub, "a1");
        let (_r2, _) = runner(&hub, "a2");
        announce(&hub, "a1", &["input"]);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _v = hub.add_viewer("s1", tx, false);
        hub.on_runner_frame(
            "a1",
            &frame(json!({ "type": "replay", "sessionId": "s1", "data": "" })),
        );
        drain(&mut rx);
        hub.on_runner_frame(
            "a2",
            &frame(json!({ "type": "output", "sessionId": "s1", "data": "eA==" })),
        );
        assert!(drain(&mut rx).is_empty());
    }

    #[test]
    fn last_attach_is_writer_and_input_counts_bytes() {
        let hub = RelayHub::new(None);
        let (_reg, sent) = runner(&hub, "a1");
        announce(&hub, "a1", &["input"]);
        let (t1, mut r1) = mpsc::unbounded_channel();
        let v1 = hub.add_viewer("s1", t1, false);
        let (t2, _r2) = mpsc::unbounded_channel();
        let v2 = hub.add_viewer("s1", t2, false);
        assert!(drain(&mut r1).iter().any(|f| f["type"] == "writer"
            && f["writer"] == false
            && f["reason"] == "other-writer"));
        assert!(!v1.handle_message(r#"{"type":"input","data":"YQ=="}"#));
        assert!(v2.handle_message(r#"{"type":"input","data":"YWJj"}"#));
        assert!(!v2.handle_message(r#"{"type":"resize","cols":0,"rows":10}"#));
        assert_eq!(v2.input_bytes(), 3);
        v2.close();
        assert!(v1.handle_message(r#"{"type":"input","data":"YQ=="}"#));
        let counts: Vec<u64> = sent
            .lock()
            .unwrap()
            .iter()
            .filter(|f| f["type"] == "viewer.count")
            .map(|f| f["count"].as_u64().unwrap())
            .collect();
        assert_eq!(counts.last(), Some(&1));
    }

    #[test]
    fn writer_key_revoked_before_demotion_and_view_before_writer_on_reannounce() {
        let hub = RelayHub::new(None);
        let (_reg, sent) = runner(&hub, "a1");
        announce(&hub, "a1", &["input", "local-terminal"]);
        let (t1, _r1) = mpsc::unbounded_channel();
        let _v1 = hub.add_viewer("s1", t1, true);
        sent.lock().unwrap().clear();
        let (t2, _r2) = mpsc::unbounded_channel();
        let _v2 = hub.add_viewer("s1", t2, true);
        let kinds: Vec<(String, bool)> = sent
            .lock()
            .unwrap()
            .iter()
            .filter(|f| f["type"] == "local.writer")
            .map(|f| {
                (
                    f["type"].as_str().unwrap().to_owned(),
                    f["writerKey"].is_null(),
                )
            })
            .collect();
        // 옛 키 회수(null) 가 새 키 발급보다 먼저.
        assert_eq!(
            kinds,
            [
                ("local.writer".into(), true),
                ("local.writer".into(), false)
            ]
        );

        sent.lock().unwrap().clear();
        announce(&hub, "a1", &["input", "local-terminal"]);
        let order: Vec<String> = sent
            .lock()
            .unwrap()
            .iter()
            .filter(|f| f["type"] == "local.view" || f["type"] == "local.writer")
            .map(|f| f["type"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(order, ["local.view", "local.view", "local.writer"]);
    }

    #[test]
    fn input_closed_revokes_writer_key() {
        let hub = RelayHub::new(None);
        let (_reg, sent) = runner(&hub, "a1");
        announce(&hub, "a1", &["input", "local-terminal"]);
        let (t1, _r1) = mpsc::unbounded_channel();
        let _v1 = hub.add_viewer("s1", t1, true);
        sent.lock().unwrap().clear();
        hub.on_runner_frame(
            "a1",
            &frame(json!({ "type": "session.started", "session": {
            "sessionId": "s1", "agentAccountId": "a1", "channelId": "c1", "threadRootId": "t1",
            "harness": "claude", "startedAt": "2026-11-16T00:00:00Z", "acceptsInput": false } })),
        );
        assert!(
            sent.lock()
                .unwrap()
                .iter()
                .any(|f| f["type"] == "local.writer" && f["writerKey"].is_null())
        );
    }

    #[test]
    fn cancel_outcomes() {
        let hub = RelayHub::new(None);
        assert_eq!(hub.cancel_session("s1", "h"), CancelOutcome::NotFound);
        let (_reg, sent) = runner(&hub, "a1");
        announce(&hub, "a1", &["input"]);
        assert_eq!(hub.cancel_session("s1", "h"), CancelOutcome::RunnerOutdated);
        announce(&hub, "a1", &["cancel"]);
        assert_eq!(hub.cancel_session("s1", "h"), CancelOutcome::Ok);
        assert!(
            sent.lock()
                .unwrap()
                .iter()
                .any(|f| f["type"] == "session.cancel" && f["byHandle"] == "h")
        );
    }

    #[test]
    fn attention_is_owner_checked_and_cleared_on_end() {
        let got: Arc<Mutex<Vec<Attention>>> = Arc::default();
        let g2 = got.clone();
        let hub = RelayHub::new(Some(Arc::new(move |a| g2.lock().unwrap().push(a))));
        let (_r1, _) = runner(&hub, "a1");
        let (_r2, _) = runner(&hub, "a2");
        announce(&hub, "a1", &[]);
        hub.on_runner_frame(
            "a2",
            &frame(json!({ "type": "attention.required", "sessionId": "s1" })),
        );
        assert!(got.lock().unwrap().is_empty());
        hub.on_runner_frame(
            "a1",
            &frame(json!({ "type": "attention.required", "sessionId": "s1", "claudePoolRank": 1 })),
        );
        hub.on_runner_frame(
            "a2",
            &frame(json!({ "type": "session.ended", "sessionId": "s1" })),
        );
        assert_eq!(got.lock().unwrap().len(), 1);
        hub.on_runner_frame(
            "a1",
            &frame(json!({ "type": "session.ended", "sessionId": "s1" })),
        );
        let g = got.lock().unwrap();
        assert!(matches!(&g[1], Attention::Cleared { session_id, .. } if session_id == "s1"));
    }

    #[tokio::test]
    async fn interactive_open_round_trip_and_spoof() {
        let hub = RelayHub::new(None);
        let (_r1, sent) = runner(&hub, "a1");
        let (_r2, _) = runner(&hub, "a2");
        hub.on_runner_frame(
            "a1",
            &frame(json!({ "type": "announce", "sessions": [], "caps": ["interactive"] })),
        );
        let h2 = hub.clone();
        let task = tokio::spawn(async move {
            h2.open_interactive("a1", "c1", "t1", "me", None, Duration::from_secs(5))
                .await
        });
        let rid = loop {
            if let Some(f) = sent
                .lock()
                .unwrap()
                .iter()
                .find(|f| f["type"] == "interactive.open")
            {
                break f["requestId"].as_str().unwrap().to_owned();
            }
            tokio::task::yield_now().await;
        };
        hub.on_runner_frame(
            "a2",
            &frame(json!({ "type": "interactive.opened", "requestId": rid, "sessionId": "evil" })),
        );
        hub.on_runner_frame("a1", &frame(json!({ "type": "interactive.opened", "requestId": rid, "sessionId": "s9", "created": true })));
        assert_eq!(
            task.await.unwrap(),
            InteractiveOutcome::Opened {
                session_id: "s9".into(),
                created: true
            }
        );
        assert_eq!(
            hub.open_interactive("a3", "c", "t", "me", None, Duration::from_millis(10))
                .await,
            InteractiveOutcome::NoRunner
        );
    }

    #[tokio::test]
    async fn orphan_attention_cleared_after_grace_unless_runner_returns() {
        let got: Arc<Mutex<Vec<Attention>>> = Arc::default();
        let g2 = got.clone();
        let hub = RelayHub::with_grace(
            Some(Arc::new(move |a| g2.lock().unwrap().push(a))),
            Duration::from_millis(80),
        );
        let (reg, _) = runner(&hub, "a1");
        announce(&hub, "a1", &[]);
        hub.on_runner_frame(
            "a1",
            &frame(json!({ "type": "attention.required", "sessionId": "s1" })),
        );
        hub.detach_runner(&reg);
        tokio::time::sleep(Duration::from_millis(20)).await;
        let (reg2, _) = runner(&hub, "a1");
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(
            got.lock().unwrap().len(),
            1,
            "runner came back — gate stays"
        );
        // 다시 떠나고 아무도 안 돌아오면 유예 뒤 내린다.
        hub.on_runner_frame("a1", &frame(json!({ "type": "announce", "caps": [], "sessions": [
            { "sessionId": "s1", "agentAccountId": "a1", "channelId": "c1", "threadRootId": "t1", "startedAt": "x" }] })));
        hub.detach_runner(&reg2);
        tokio::time::sleep(Duration::from_millis(160)).await;
        assert!(matches!(
            got.lock().unwrap().last(),
            Some(Attention::Cleared { .. })
        ));
    }
}
