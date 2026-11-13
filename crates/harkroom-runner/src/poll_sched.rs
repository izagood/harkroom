//! 폴 루프의 스케줄러 쪽(L3b) — [`crate::poll_loop::Scheduler`] 실물과 스케줄러 고리를 **받는 쪽**.
//!
//! - 받아들이기: 장부를 잠근 채 `admit` 를 부르되, 띄우기는 [`LaunchQueue`] 에 모아 두었다가 **잠금을 놓은 뒤** 띄운다.
//!   띄우개가 스레드를 못 띄워 그 자리에서 몸통을 돌리면(`ThreadLauncher` 의 대체 길) 몸통이 같은 장부를 다시 잠그기 때문이다
//!   — 잠근 채 띄우면 그 길에서 스스로 막힌다.
//! - 받는 쪽: 멘션 스레드가 [`crate::mention_sched::ChannelScheduler`] 로 보낸 사건을 러너 수명 스레드 하나가 받는다.
//!   자리 놓기는 롱폴을 기다리지 않고 바로 서버에 돌려준다(머신의 다른 러너가 그 자리를 기다린다).
//!   사건 처리 하나가 패닉해도 고리는 산다.
//! - 물러나기(`drain`): 띄운 멘션마다 `TurnEnded` 가 꼭 한 번 온다(`OnceRelease`·몸통 지킴) — 그 수가 0 이 될 때까지 기다린다.
//!
//! 실제 `admit` 닫개(`LinkAdmitDeps` + `CallMaker` 실물)는 L3c, 기동 배선은 L3d 다.

use std::sync::mpsc::Receiver;
use std::sync::{Arc, Condvar, Mutex};

use serde_json::Value;

use crate::mention_admit::Launch;
use crate::mention_admit_deps::MentionLauncher;
use crate::mention_ledger::Ledger;
use crate::mention_sched::SchedEvent;
use crate::poll_loop::{AdmitOutcome, BatchContext, Scheduler};
use crate::rest::HarkroomError;

/// 띄우기로 정한 멘션을 잠금 밖으로 옮기는 상자.
#[derive(Default)]
pub struct LaunchQueue(pub Vec<(Launch, String)>);

impl MentionLauncher for &mut LaunchQueue {
    fn launch(&mut self, launch: Launch, mention_id: String) {
        self.0.push((launch, mention_id));
    }
}

/// 도는 멘션 수. 띄우기 **전에** 올리고 `TurnEnded` 에 내린다 — 끝 사건이 먼저 와서 음수가 되는 일이 없다.
#[derive(Default)]
pub struct Running {
    n: Mutex<usize>,
    cv: Condvar,
}

impl Running {
    fn lock(&self) -> std::sync::MutexGuard<'_, usize> {
        self.n.lock().unwrap_or_else(|p| p.into_inner())
    }
    pub fn started(&self) {
        *self.lock() += 1;
    }
    pub fn ended(&self) {
        let mut n = self.lock();
        *n = n.saturating_sub(1);
        self.cv.notify_all();
    }
    pub fn count(&self) -> usize {
        *self.lock()
    }
    /// 0 이 될 때까지 기다린다.
    pub fn wait_idle(&self) {
        let n = self.lock();
        let _n = self
            .cv
            .wait_while(n, |n| *n > 0)
            .unwrap_or_else(|p| p.into_inner());
    }
}

/// 사건을 밖으로 내보내는 곳(실물은 L3d: 서버 자리 놓기·표지 발화·제공자 줄·러너 종료 판정).
pub trait EventSink: Send + Sync {
    /// 머신 자리를 서버에 돌려준다(`rest.release_turn_slot`).
    fn release_turn_slot(&self, thread_key: &str);
    /// 임대를 잃어 접힌 턴의 표지(정본 `sendNotice({key:'fenced'})`). 실패는 삼킨다.
    fn notice_fenced(&self, channel_id: &str, anchor: &str);
    fn turn_outcome(&self, ok: bool);
    /// 턴 안에서 본 종료 요청 — 루프가 「나를 향한 것인가」를 본다(`PollLoop::consider_stop_request`).
    fn stop_requested(&self, at: &str);
    /// 하네스 실행 파일이 없다 — 재시도로 낫지 않는다.
    fn executable_missing(&self);
}

/// 스레드 열쇠(`채널/앵커`) → (채널, 앵커). 앵커가 없거나 `_root` 면 `None` — 표지를 채널 최상위에 달지 않는다.
pub fn split_thread_key(key: &str) -> Option<(&str, &str)> {
    let (channel, anchor) = key.split_once('/')?;
    if channel.is_empty() || anchor.is_empty() || anchor == "_root" {
        return None;
    }
    Some((channel, anchor))
}

/// 사건 하나를 처리한다.
pub fn handle_event(e: SchedEvent, sink: &dyn EventSink, running: &Running) {
    match e {
        SchedEvent::SlotReleased(key) => sink.release_turn_slot(&key),
        SchedEvent::TurnEnded { .. } => running.ended(),
        SchedEvent::Fenced(key) => match split_thread_key(&key) {
            Some((channel, anchor)) => sink.notice_fenced(channel, anchor),
            None => eprintln!(
                "[mentionScheduler] 임대 잃음 표지: 스레드 열쇠를 못 읽었다 — 표지를 건너뛴다"
            ),
        },
        SchedEvent::Outcome(ok) => sink.turn_outcome(ok),
        SchedEvent::StopRequested(at) => sink.stop_requested(&at),
        SchedEvent::ExecutableMissing => sink.executable_missing(),
    }
}

/// 받는 쪽 고리를 돈다 — 보내는 쪽이 모두 떨어지면 끝난다. 사건 하나의 패닉은 그 사건만 버린다. 다만 `TurnEnded` 는
/// 수를 내리는 것뿐이라 패닉하지 않는다(물러나기가 끝없이 기다리지 않는다).
pub fn pump_events(rx: Receiver<SchedEvent>, sink: &dyn EventSink, running: &Running) {
    for e in rx {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            handle_event(e, sink, running)
        }));
        if r.is_err() {
            eprintln!(
                "[mentionScheduler] 스케줄러 사건 처리가 패닉했다 — 그 사건만 버리고 계속 받는다"
            );
        }
    }
}

/// 받는 쪽 고리를 스레드 하나로 띄운다.
pub fn spawn_event_pump(
    rx: Receiver<SchedEvent>,
    sink: Arc<dyn EventSink>,
    running: Arc<Running>,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("sched-events".into())
        .spawn(move || pump_events(rx, sink.as_ref(), &running))
}

/// 배치 하나를 받아들이는 닫개 — 장부·배치·맥락·띄우기 상자를 받는다(실물 L3c: `LinkAdmitDeps` + `mention_admit::admit`).
pub type AdmitFn = dyn Fn(&mut Ledger, &Value, &BatchContext, &mut LaunchQueue) -> Result<AdmitOutcome, String>
    + Send
    + Sync;

/// [`Scheduler`] 실물.
pub struct RunnerScheduler {
    ledger: Arc<Mutex<Ledger>>,
    admit: Box<AdmitFn>,
    launcher: Mutex<Box<dyn MentionLauncher + Send>>,
    running: Arc<Running>,
}

impl RunnerScheduler {
    pub fn new(
        ledger: Arc<Mutex<Ledger>>,
        admit: Box<AdmitFn>,
        launcher: Box<dyn MentionLauncher + Send>,
        running: Arc<Running>,
    ) -> Self {
        Self {
            ledger,
            admit,
            launcher: Mutex::new(launcher),
            running,
        }
    }

    fn ledger(&self) -> std::sync::MutexGuard<'_, Ledger> {
        self.ledger.lock().unwrap_or_else(|p| p.into_inner())
    }
}

impl Scheduler for RunnerScheduler {
    fn admit(&self, batch: &Value, ctx: &BatchContext) -> Result<AdmitOutcome, HarkroomError> {
        let mut queue = LaunchQueue::default();
        let r = {
            let mut ledger = self.ledger();
            (self.admit)(&mut ledger, batch, ctx, &mut queue)
        };
        // 실패해도 이미 정한 띄우기는 띄운다 — 장부에 「도는 중」으로 올라 있다(정본도 던지기 전에 띄운 뒤다).
        let mut launcher = self.launcher.lock().unwrap_or_else(|p| p.into_inner());
        for (launch, mention_id) in queue.0 {
            self.running.started();
            launcher.launch(launch, mention_id);
        }
        r.map_err(|m| HarkroomError::new(format!("admit: {m}"), None))
    }
    fn holding_entries(&self) -> Vec<i64> {
        self.ledger().holding_entries()
    }
    fn done_entries(&self) -> Vec<i64> {
        self.ledger().done_entries()
    }
    fn drain(&self) {
        self.running.wait_idle();
    }
}

#[cfg(test)]
#[path = "poll_sched_tests.rs"]
mod tests;
