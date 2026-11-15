//! 오퍼레이터 채널 → 릴레이 허브 배선(S5.3 C6c-3, TS `agentRelayRoutes.ts` 의 `register`·`unregister`·`onFrame` 부분).
//!
//! 러너 프레임은 오퍼레이터 소켓에 `runnerId` 로 다중화돼 온다. 이 파일이 그것을 풀어(`unwrap_operator_frame`, shared
//! `runnerLink.ts` 와 한 줄씩 대응) 릴레이 허브의 옛 릴레이 모양으로 넣고, 서버 → 러너 프레임은 다시 감싸(`wrap_server_frame`)
//! 그 오퍼레이터에게 보낸다.
//!
//! **배정이 곧 인가다.** (오퍼레이터, 에이전트) 쌍이 `agent_assignment` 에 있을 때만 러너를 허브에 등록한다 — 배정되지 않은
//! 에이전트를 주장하는 오퍼레이터는 남의 에이전트 세션을 위조해 그 소유자 화면에 띄울 수 있다. 확인은 DB 왕복이고
//! `runner.started` 바로 뒤에 `runner.announce` 가 붙어 오므로, 키(오퍼레이터, 러너)마다 **일꾼 하나**가 확인을 끝낸 뒤
//! 쌓인 프레임을 도착 순서대로 넣는다(TS 의 키별 약속 사슬과 같은 순서 보장). 한 러너의 확인이 다른 러너를 막지 않는다.
//!
//! **프레임을 잃지 않는다.** 입력은 broadcast 가 아니라 operator 허브의 전용 피드(`LinkEvent`, mpsc)다 — `operator_hub.rs`
//! 의 `LinkEvent` 주석. 이 루프는 기다리지 않고 나눠 주기만 한다.
//!
//! 바이트·키는 여기서도 로그에 남기지 않는다. 로그는 오퍼레이터·러너·에이전트 id 뿐이다.
use super::operator_hub::{Frame, LinkEvent, OperatorHub};
use super::relay::{RelayHub, RunnerSink};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, watch};

/// 배정 확인 실패의 두 갈래. `Unreachable` 은 잠깐 다시 하고(TS `retryWhileDbUnreachable`), `Other` 는 곧바로 이 러너를 잊는다
/// (다음 `hello`·`runner.started` 가 다시 등록한다).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckErr {
    Unreachable,
    Other,
}

pub type CheckFuture = Pin<Box<dyn Future<Output = Result<bool, CheckErr>> + Send>>;
/// (operatorId, agentId) → 배정돼 있는가.
pub type AssignCheck = Arc<dyn Fn(String, String) -> CheckFuture + Send + Sync>;

/// 배정을 확인한 러너의 프레임마다(presence·세션 사본이 여기 붙는다). 주인 agent 는 프레임 본문이 아니라 링크의 것이다
/// (security C6c ①′).
pub type FrameHook = Arc<dyn Fn(&str, &str, &Map<String, Value>) + Send + Sync>;
/// 러너가 물러났다(operatorId, agentId).
pub type GoneHook = Arc<dyn Fn(&str, &str) + Send + Sync>;

#[derive(Clone, Default)]
pub struct LinkHooks {
    pub on_frame: Option<FrameHook>,
    pub on_gone: Option<GoneHook>,
}

/// 확인이 DB 에 닿지 못할 때 다시 해 보는 한도(TS `deadlineMs: 60_000`).
pub const CHECK_DEADLINE: Duration = Duration::from_secs(60);

/// 기본 배정 확인 — 읽기 풀로 `agent_assignment` 를 본다. uuid 모양이 아니면 조회하지 않고 「배정 아님」.
pub fn db_assign_check(pool: sqlx::PgPool) -> AssignCheck {
    Arc::new(move |op: String, agent: String| {
        let pool = pool.clone();
        Box::pin(async move {
            if !is_uuid(&op) || !is_uuid(&agent) {
                return Ok(false);
            }
            sqlx::query_scalar::<_, i32>(
                "select 1 from agent_assignment where operator_id = $1::uuid and agent_id = $2::uuid",
            )
            .bind(&op)
            .bind(&agent)
            .fetch_optional(&pool)
            .await
            .map(|r| r.is_some())
            .map_err(|e| match e {
                sqlx::Error::Io(_)
                | sqlx::Error::PoolTimedOut
                | sqlx::Error::PoolClosed
                | sqlx::Error::Tls(_)
                | sqlx::Error::WorkerCrashed => CheckErr::Unreachable,
                _ => CheckErr::Other,
            })
        })
    })
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

fn s<'a>(f: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    f.get(k).and_then(Value::as_str)
}

/// shared `unwrapOperatorFrame` — (runnerId, 옛 릴레이 모양 프레임). 러너 프레임이 아니면 None.
pub fn unwrap_operator_frame(f: &Map<String, Value>) -> Option<(String, Map<String, Value>)> {
    let rid = s(f, "runnerId")?.to_owned();
    let g = |k: &str| f.get(k).cloned().unwrap_or(Value::Null);
    let mut out = match s(f, "type")? {
        "runner.announce" => {
            let mut o = json!({ "type": "announce", "sessions": g("sessions") });
            if let Some(c) = f.get("caps").filter(|c| !c.is_null()) {
                o["caps"] = c.clone();
            }
            o
        }
        "session.started" => json!({ "type": "session.started", "session": g("session") }),
        "session.ended" => json!({ "type": "session.ended", "sessionId": g("sessionId") }),
        "pty.output" => {
            json!({ "type": "output", "sessionId": g("sessionId"), "data": g("bytes") })
        }
        "pty.replay" => {
            json!({ "type": "replay", "sessionId": g("sessionId"), "data": g("bytes") })
        }
        "interactive.opened" => json!({
            "type": "interactive.opened", "requestId": g("requestId"),
            "sessionId": g("sessionId"), "created": g("created"),
        }),
        "interactive.error" => json!({
            "type": "interactive.error", "requestId": g("requestId"), "message": g("message"),
        }),
        "attention.required" => {
            let mut o = json!({ "type": "attention.required", "sessionId": g("sessionId"), "screen": g("screen") });
            for k in ["claudePoolRank", "claudeAccountRank"] {
                if let Some(v) = f.get(k) {
                    o[k] = v.clone();
                }
            }
            o
        }
        "local.input" => json!({
            "type": "local.input", "sessionId": g("sessionId"), "gen": g("gen"), "bytes": g("bytes"),
        }),
        _ => return None,
    };
    let Value::Object(m) = out.take() else {
        return None;
    };
    Some((rid, m))
}

/// shared `wrapServerFrame` — 허브가 러너에게 보내는 프레임에 `runnerId` 를 붙인다. 모르는 프레임은 None(보내지 않는다).
pub fn wrap_server_frame(runner_id: &str, f: &Value) -> Option<Value> {
    let g = |k: &str| f.get(k).cloned().unwrap_or(Value::Null);
    Some(match f.get("type")?.as_str()? {
        "replay.request" => {
            json!({ "type": "pty.replay.request", "runnerId": runner_id, "sessionId": g("sessionId") })
        }
        "input" => {
            json!({ "type": "pty.input", "runnerId": runner_id, "sessionId": g("sessionId"), "bytes": g("data") })
        }
        "resize" => json!({
            "type": "pty.resize", "runnerId": runner_id, "sessionId": g("sessionId"),
            "cols": g("cols"), "rows": g("rows"),
        }),
        "viewer.count" => json!({
            "type": "viewer.count", "runnerId": runner_id, "sessionId": g("sessionId"), "count": g("count"),
        }),
        "session.cancel" => json!({
            "type": "session.cancel", "runnerId": runner_id, "sessionId": g("sessionId"), "byHandle": g("byHandle"),
        }),
        "interactive.open" => {
            let mut o = json!({
                "type": "interactive.open", "runnerId": runner_id, "requestId": g("requestId"),
                "channelId": g("channelId"), "threadRootId": g("threadRootId"), "openedByHandle": g("openedByHandle"),
            });
            for k in ["cols", "rows"] {
                if let Some(v) = f.get(k) {
                    o[k] = v.clone();
                }
            }
            o
        }
        "local.writer" => json!({
            "type": "local.writer", "runnerId": runner_id, "sessionId": g("sessionId"),
            "writerKey": g("writerKey"), "gen": g("gen"),
        }),
        "local.view" => json!({
            "type": "local.view", "runnerId": runner_id, "sessionId": g("sessionId"),
            "viewKey": g("viewKey"), "granted": g("granted"),
        }),
        _ => return None,
    })
}

enum Work {
    Frame(Map<String, Value>),
    Gone,
}

type Key = (String, String);

struct Worker {
    epoch: u64,
    tx: mpsc::UnboundedSender<Work>,
}

#[derive(Default)]
struct LinkState {
    next_epoch: u64,
    workers: HashMap<Key, Worker>,
    /// 에이전트별 가장 최근 등록의 「확인 끝남」(TS `settling`).
    settling: HashMap<String, watch::Receiver<bool>>,
}

/// 배선 손잡이. 라우트가 `settled`·`all_settled` 로 등록이 끝나기를 기다린다.
#[derive(Clone)]
pub struct RelayLink {
    state: Arc<Mutex<LinkState>>,
    relay: RelayHub,
    ops: OperatorHub,
    check: AssignCheck,
    hooks: LinkHooks,
}

impl RelayLink {
    /// 피드를 열고 배선 루프를 띄운다. 프로세스에 하나.
    pub fn spawn(relay: RelayHub, ops: OperatorHub, check: AssignCheck, hooks: LinkHooks) -> Self {
        let mut feed = ops.link_feed();
        let link = Self {
            state: Arc::default(),
            relay,
            ops,
            check,
            hooks,
        };
        let l = link.clone();
        tokio::spawn(async move {
            while let Some(ev) = feed.recv().await {
                l.on_event(ev);
            }
        });
        link
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LinkState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn on_event(&self, ev: LinkEvent) {
        match ev {
            LinkEvent::Close(op) => {
                let keys: Vec<Key> = self
                    .lock()
                    .workers
                    .keys()
                    .filter(|(o, _)| *o == op)
                    .cloned()
                    .collect();
                for (o, r) in keys {
                    self.unregister(&o, &r);
                }
            }
            LinkEvent::Frame(op, f) => self.on_frame(&op, &f),
        }
    }

    fn on_frame(&self, op: &str, f: &Frame) {
        match s(f, "type").unwrap_or("") {
            "hello" => {
                for r in f
                    .get("runners")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let (Some(rid), Some(aid)) = (
                        r.get("runnerId").and_then(Value::as_str),
                        r.get("agentId").and_then(Value::as_str),
                    ) {
                        self.register(op, rid, aid);
                    }
                }
            }
            "runner.started" => {
                if let (Some(rid), Some(aid)) = (s(f, "runnerId"), s(f, "agentId")) {
                    self.register(op, rid, aid);
                }
            }
            "runner.exited" => {
                if let Some(rid) = s(f, "runnerId") {
                    self.unregister(op, rid);
                }
            }
            _ => {
                let Some((rid, inner)) = unwrap_operator_frame(f) else {
                    return;
                };
                // 모르는 러너의 프레임은 버린다 — `runner.started` 없이 온 것이거나 이미 물러난 러너다.
                if let Some(w) = self.lock().workers.get(&(op.to_owned(), rid)) {
                    let _ = w.tx.send(Work::Frame(inner));
                }
            }
        }
    }

    fn register(&self, op: &str, runner: &str, agent: &str) {
        let key: Key = (op.to_owned(), runner.to_owned());
        let (tx, rx) = mpsc::unbounded_channel();
        let (done_tx, done_rx) = watch::channel(false);
        let epoch = {
            let mut st = self.lock();
            if st.workers.contains_key(&key) {
                return;
            }
            st.next_epoch += 1;
            let epoch = st.next_epoch;
            st.workers.insert(key.clone(), Worker { epoch, tx });
            st.settling.insert(agent.to_owned(), done_rx);
            epoch
        };
        let link = self.clone();
        let agent = agent.to_owned();
        tokio::spawn(async move { link.run_worker(key, epoch, agent, rx, done_tx).await });
    }

    fn unregister(&self, op: &str, runner: &str) {
        if let Some(w) = self
            .lock()
            .workers
            .remove(&(op.to_owned(), runner.to_owned()))
        {
            let _ = w.tx.send(Work::Gone);
        }
    }

    async fn check_assigned(&self, op: &str, agent: &str) -> Result<bool, CheckErr> {
        let deadline = tokio::time::Instant::now() + CHECK_DEADLINE;
        let mut wait = Duration::from_millis(250);
        loop {
            match (self.check)(op.to_owned(), agent.to_owned()).await {
                Err(CheckErr::Unreachable) if tokio::time::Instant::now() + wait < deadline => {
                    eprintln!(
                        "core: relay runner assignment check unreachable — retrying (operator {op}, agent {agent})"
                    );
                    tokio::time::sleep(wait).await;
                    wait = (wait * 2).min(Duration::from_secs(5));
                }
                r => return r,
            }
        }
    }

    async fn run_worker(
        self,
        key: Key,
        epoch: u64,
        agent: String,
        mut rx: mpsc::UnboundedReceiver<Work>,
        done: watch::Sender<bool>,
    ) {
        let (op, runner) = key.clone();
        let reg = match self.check_assigned(&op, &agent).await {
            Ok(true) => {
                let ops = self.ops.clone();
                let (o, r) = (op.clone(), runner.clone());
                let sink: RunnerSink = Arc::new(move |f: &Value| {
                    wrap_server_frame(&r, f).is_some_and(|w| ops.send(&o, &w))
                });
                Some(self.relay.add_runner(&agent, sink))
            }
            Ok(false) => {
                eprintln!(
                    "core: relay runner of unassigned agent — dropping its frames (operator {op}, runner {runner}, agent {agent})"
                );
                None
            }
            Err(_) => {
                eprintln!(
                    "core: relay runner assignment check failed — forgetting runner (operator {op}, runner {runner}, agent {agent})"
                );
                let mut st = self.lock();
                if st.workers.get(&key).is_some_and(|w| w.epoch == epoch) {
                    st.workers.remove(&key);
                }
                drop(st);
                let _ = done.send(true);
                return;
            }
        };
        let _ = done.send(true);
        while let Some(w) = rx.recv().await {
            match w {
                Work::Frame(f) => {
                    if reg.is_none() {
                        continue;
                    }
                    if let Some(h) = &self.hooks.on_frame {
                        h(&op, &agent, &f);
                    }
                    self.relay.on_runner_frame(&agent, &f);
                }
                Work::Gone => break,
            }
        }
        if let Some(reg) = reg {
            self.relay.detach_runner(&reg);
            if let Some(h) = &self.hooks.on_gone {
                h(&op, &agent);
            }
        }
    }

    /// 이 에이전트의 가장 최근 등록이 확인을 마칠 때까지(TS `settled`). `interactive.open` 앞에 부른다.
    pub async fn settled(&self, agent: &str) {
        let rx = self.lock().settling.get(agent).cloned();
        if let Some(mut rx) = rx {
            let _ = rx.wait_for(|d| *d).await;
        }
    }

    /// 진행 중인 등록 전부(TS `allSettled`) — 세션 id 로만 오는 attach·cancel 앞에 부른다.
    pub async fn all_settled(&self) {
        let rxs: Vec<_> = self.lock().settling.values().cloned().collect();
        for mut rx in rxs {
            let _ = rx.wait_for(|d| *d).await;
        }
    }

    pub fn relay(&self) -> &RelayHub {
        &self.relay
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::operator_hub::{OpOut, Registration};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const OP: &str = "00000000-0000-0000-0000-0000000000a1";
    const AG: &str = "00000000-0000-0000-0000-0000000000b1";

    fn check_with(delay_ms: u64, assigned: bool) -> AssignCheck {
        Arc::new(move |_o, _a| {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                Ok(assigned)
            })
        })
    }

    struct Rig {
        ops: OperatorHub,
        reg: Registration,
        out: mpsc::UnboundedReceiver<OpOut>,
        link: RelayLink,
        gone: Arc<AtomicUsize>,
        seen: Arc<AtomicUsize>,
    }

    fn rig(check: AssignCheck) -> Rig {
        let ops = OperatorHub::new();
        let (tx, out) = mpsc::unbounded_channel();
        let reg = ops.add_operator(OP, tx);
        let gone = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(AtomicUsize::new(0));
        let (g, sn) = (gone.clone(), seen.clone());
        let hooks = LinkHooks {
            on_frame: Some(Arc::new(move |_, _, _| {
                sn.fetch_add(1, Ordering::SeqCst);
            })),
            on_gone: Some(Arc::new(move |_, _| {
                g.fetch_add(1, Ordering::SeqCst);
            })),
        };
        let link = RelayLink::spawn(RelayHub::new(None), ops.clone(), check, hooks);
        Rig {
            ops,
            reg,
            out,
            link,
            gone,
            seen,
        }
    }

    fn send(r: &Rig, v: Value) {
        r.ops.on_operator_message(&r.reg, &v.to_string());
    }

    fn started(r: &Rig, rid: &str) {
        send(
            r,
            json!({ "type": "runner.started", "runnerId": rid, "agentId": AG, "pid": 1 }),
        );
    }

    fn announce(r: &Rig, rid: &str) {
        send(
            r,
            json!({ "type": "runner.announce", "runnerId": rid, "caps": ["input", "interactive", "cancel"],
            "sessions": [{ "sessionId": "s1", "agentAccountId": AG, "channelId": "c1", "threadRootId": "t1",
                           "harness": "claude", "startedAt": "2026-11-16T00:00:00Z", "acceptsInput": true }] }),
        );
    }

    /// 배정 확인의 sleep(0) 도 실제 타이머를 한 번 거친다 — 짧게 실제로 잔다.
    async fn settle() {
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    #[tokio::test]
    async fn announce_right_after_started_waits_for_assignment() {
        let r = rig(check_with(30, true));
        started(&r, "r1");
        announce(&r, "r1");
        settle().await;
        assert!(
            r.link.relay().get_session("s1").is_none(),
            "확인 전에는 허브에 없다"
        );
        r.link.settled(AG).await;
        settle().await;
        assert!(r.link.relay().get_session("s1").is_some());
        assert_eq!(r.seen.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn unassigned_runner_frames_are_dropped() {
        let r = rig(check_with(0, false));
        started(&r, "r1");
        announce(&r, "r1");
        r.link.settled(AG).await;
        settle().await;
        assert!(r.link.relay().get_session("s1").is_none());
        assert_eq!(r.seen.load(Ordering::SeqCst), 0);
        // 모르는 러너의 프레임도 버린다.
        announce(&r, "r9");
        settle().await;
        assert!(r.link.relay().get_session("s1").is_none());
    }

    #[tokio::test]
    async fn server_frames_are_wrapped_with_runner_id() {
        let mut r = rig(check_with(0, true));
        started(&r, "r1");
        announce(&r, "r1");
        r.link.settled(AG).await;
        settle().await;
        assert!(matches!(
            r.link.relay().cancel_session("s1", "jb"),
            crate::core::relay::CancelOutcome::Ok
        ));
        let mut got = None;
        while let Ok(OpOut::Text(t)) = r.out.try_recv() {
            let v: Value = serde_json::from_str(&t).unwrap();
            if v["type"] == "session.cancel" {
                got = Some(v);
            }
        }
        let v = got.expect("session.cancel 이 오퍼레이터로 갔다");
        assert_eq!(v["runnerId"], "r1");
        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["byHandle"], "jb");
    }

    #[tokio::test]
    async fn exit_and_close_detach_the_runner() {
        let r = rig(check_with(0, true));
        started(&r, "r1");
        announce(&r, "r1");
        r.link.settled(AG).await;
        settle().await;
        send(
            &r,
            json!({ "type": "runner.exited", "runnerId": "r1", "code": 0 }),
        );
        settle().await;
        assert!(r.link.relay().get_session("s1").is_none());
        assert_eq!(r.gone.load(Ordering::SeqCst), 1);

        started(&r, "r2");
        announce(&r, "r2");
        r.link.settled(AG).await;
        settle().await;
        assert!(r.link.relay().get_session("s1").is_some());
        r.ops.detach(&r.reg);
        settle().await;
        assert!(r.link.relay().get_session("s1").is_none());
        assert_eq!(r.gone.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn unreachable_check_retries_and_other_error_forgets() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let check: AssignCheck = Arc::new(move |_o, _a| {
            let n = c.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                match n {
                    0 => Err(CheckErr::Unreachable),
                    1 => Err(CheckErr::Other),
                    _ => Ok(true),
                }
            })
        });
        let r = rig(check);
        started(&r, "r1");
        announce(&r, "r1");
        tokio::time::sleep(Duration::from_millis(400)).await;
        // 1차 닿지 못함 → 다시 함 → 2차 다른 오류 → 잊는다.
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(r.link.relay().get_session("s1").is_none());
        // 잊었으니 다음 runner.started 가 다시 등록한다.
        started(&r, "r1");
        announce(&r, "r1");
        r.link.settled(AG).await;
        settle().await;
        assert!(r.link.relay().get_session("s1").is_some());
    }

    /// task_manager 게이트: broadcast(4096) 를 넘는 폭주에도 PTY 프레임이 하나도 빠지지 않는다.
    #[tokio::test]
    async fn burst_beyond_broadcast_capacity_loses_no_bytes() {
        let r = rig(check_with(0, true));
        started(&r, "r1");
        announce(&r, "r1");
        r.link.settled(AG).await;
        settle().await;
        let (tx, mut vrx) = mpsc::unbounded_channel();
        let _v = r.link.relay().add_viewer("s1", tx, false);
        send(
            &r,
            json!({ "type": "pty.replay", "runnerId": "r1", "sessionId": "s1", "bytes": "" }),
        );
        // 소비 루프가 돌기 전에 한꺼번에 민다(이 시험은 단일 스레드 런타임이라 그 사이 루프가 돌지 않는다).
        const N: usize = 10_000;
        for i in 0..N {
            send(
                &r,
                json!({ "type": "pty.output", "runnerId": "r1", "sessionId": "s1", "bytes": format!("{i}") }),
            );
        }
        // 같은 프레임을 broadcast 로 받았다면 앞 프레임이 Lagged 로 빠진다 — 대조.
        let mut b = r.ops.subscribe_frames();
        for _ in 0..5000 {
            send(
                &r,
                json!({ "type": "status", "status": { "turns": { "running": 0 } } }),
            );
        }
        assert!(matches!(
            b.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_))
        ));
        for _ in 0..200 {
            tokio::task::yield_now().await;
        }
        let datas: Vec<String> = std::iter::from_fn(|| vrx.try_recv().ok())
            .map(|s| serde_json::from_str::<Value>(&s).unwrap())
            .filter(|f| f["type"] == "output")
            .map(|f| f["data"].as_str().unwrap().to_owned())
            .filter(|d| !d.is_empty())
            .collect();
        assert_eq!(datas.len(), N);
        assert!(datas.iter().enumerate().all(|(i, d)| *d == i.to_string()));
    }

    #[test]
    fn wrap_unwrap_match_shared_runner_link() {
        let f = serde_json::from_value::<Map<String, Value>>(json!({
            "type": "pty.output", "runnerId": "r1", "sessionId": "s1", "bytes": "QQ==",
        }))
        .unwrap();
        let (rid, inner) = unwrap_operator_frame(&f).unwrap();
        assert_eq!(rid, "r1");
        assert_eq!(
            Value::Object(inner),
            json!({ "type": "output", "sessionId": "s1", "data": "QQ==" })
        );
        assert!(
            unwrap_operator_frame(
                &serde_json::from_value(json!({ "type": "status", "runnerId": "r1" })).unwrap()
            )
            .is_none()
        );
        assert_eq!(
            wrap_server_frame(
                "r1",
                &json!({ "type": "input", "sessionId": "s1", "data": "QQ==" })
            ),
            Some(
                json!({ "type": "pty.input", "runnerId": "r1", "sessionId": "s1", "bytes": "QQ==" })
            )
        );
        assert_eq!(
            wrap_server_frame(
                "r1",
                &json!({ "type": "interactive.open", "requestId": "q", "channelId": "c", "threadRootId": "t", "openedByHandle": "h" })
            )
            .unwrap()
            .get("cols"),
            None
        );
        assert!(wrap_server_frame("r1", &json!({ "type": "assign" })).is_none());
        assert!(is_uuid(OP) && !is_uuid("x"));
    }
}
