//! 감시 루프 → [`EndState`] — PTY 출력을 받는 턴 sink([`WatchSink`])와 탐침 주기를 도는 루프([`run_watch`]).
//!
//! - [`WatchSink`]: 띄운 순간 `has_controls`, 출력마다 `last_data_at_ms` 를 [`EndState`] 에 적는다. 화면 원문(꼬리)은
//!   [`WatchState`] 안에만 쥔다 — `Debug` 는 길이만, 밖으로 내는 길은 [`WatchState::screen_line_for_post`] 하나이고
//!   그것은 [`screen_said_for_post`](`NoticeSecrets` 의 `quoted_line`)를 거친 한 줄만 낸다.
//! - [`run_watch`]: `probe_ms` 마다 끝 상태를 잠깐 잠가 꺼내 [`probe_cycle`] 을 **잠금 밖에서** 한 번 돌고 돌려놓는다. `Stop`·멈춤 신호·PTY 종료면 끝낸다. 탐침이 글로
//!   내는 것은 이미 가린 통지 함수만 지난다(`turn_probe_records`). 돌려놓을 때 그사이 남이 적은 값과 한 번 서면 안 내려가는
//!   표지(`reclaimed`·`stalled`·`exited`)를 지키고, 거둔 턴이면 멈춘다.
//! - [`reclaim_on_watch`]: 회수 시계가 사본이 아니라 이 자리에 직접 적게 하는 닫개.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use crate::pty::{AttentionKind, decode_tail_text, strip_ansi};
use crate::pty_turn::{PromptHooks, PtyControls, PtyTurnSink};
use crate::turn_end::{EndConfig, EndState};
use crate::turn_probe::{CycleOutcome, ProbeIo, ProbeState, probe_cycle};
use crate::turn_probe_records::{NoticeSecrets, screen_said_for_post};
use crate::turn_probe_rest::{FenceCheck, ReclaimEnd, WritePty};

/// 화면 꼬리 상한(바이트) — 마지막 줄을 거두는 데만 쓴다.
const SCREEN_TAIL_MAX: usize = 4096;

/// 감시가 쥐는 것 — 끝 상태와 화면 꼬리(원문).
#[derive(Default)]
pub struct WatchState {
    pub end: EndState,
    screen: Vec<u8>,
    /// 이 시도의 PTY 손잡이 — 띄운 순간 sink 가 적는다. SIGTERM·Enter 는 이것으로만([`terminate_on_watch`]·[`write_on_watch`]).
    controls: Option<PtyControls>,
}

impl std::fmt::Debug for WatchState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WatchState")
            .field("end", &self.end)
            .field("screen_len", &self.screen.len())
            .field("controls", &self.controls.is_some())
            .finish()
    }
}

impl WatchState {
    /// 스레드에 올릴 화면 마지막 줄 — `NoticeSecrets` 의 `quoted_line` 만 거친다(비밀·토큰 가림, 다 가려지면 `None`).
    pub fn screen_line_for_post(&self, secrets: &NoticeSecrets) -> Option<String> {
        let text = strip_ansi(&decode_tail_text(&self.screen));
        let last = text.lines().rev().find(|l| !l.trim().is_empty())?;
        screen_said_for_post(Some(last.trim()), secrets)
    }
}

/// 공유 감시 자리.
pub type Watch = Arc<Mutex<WatchState>>;

fn lock(w: &Watch) -> MutexGuard<'_, WatchState> {
    w.lock().unwrap_or_else(|e| e.into_inner())
}

/// 회수 시계가 감시 자리에 직접 적는 닫개([`crate::turn_probe_rest::TurnProbeRest::on_reclaim`]).
pub fn reclaim_on_watch(watch: &Watch) -> ReclaimEnd {
    let w = Arc::clone(watch);
    Arc::new(move || lock(&w).end.on_reclaim_timer())
}

/// 탐침이 잠금 밖에 있는 사이 다른 쪽(sink·회수 시계·PTY 종료)이 자리에 적은 값을 지키며 사본을 돌려놓는다.
///
/// - 출력 시각은 큰 쪽, 손잡이는 OR.
/// - **한 번 서면 안 내려가는 표지**(`reclaimed`·`stalled`·`exited`)는 OR — 시계가 거둔 것을 사본이 덮으면 임대를 잃은
///   턴이 계속 돈다(#2040·#2042 펜스 경계와 같은 몫).
/// - 그사이 시계가 울렸고(`reclaimed` 가 새로 섰다) 탐침이 시계를 새로 세우지 않았으면 `reclaim_armed` 를 내린다.
fn write_back(slot: &mut EndState, before: &EndState, snap: EndState) {
    let clock_fired = slot.reclaimed && !before.reclaimed;
    let rearmed = snap.reclaim_armed
        && (!before.reclaim_armed || snap.reclaim_grace_ms != before.reclaim_grace_ms);
    let last_data = slot.last_data_at_ms.max(snap.last_data_at_ms);
    let controls = slot.has_controls || snap.has_controls;
    let reclaimed = slot.reclaimed || snap.reclaimed;
    let stalled = slot.stalled || snap.stalled;
    let exited = slot.exited || snap.exited;
    *slot = snap;
    slot.last_data_at_ms = last_data;
    slot.has_controls = controls;
    slot.reclaimed = reclaimed;
    slot.stalled = stalled;
    slot.exited = exited;
    if clock_fired && !rearmed {
        slot.reclaim_armed = false;
    }
}

/// PTY 출력을 감시 자리에 적는 sink. 나머지 갈래는 안쪽 sink 로 그대로 넘긴다.
pub struct WatchSink<'a, S: PtyTurnSink> {
    pub inner: &'a mut S,
    pub watch: Watch,
    pub now_ms: &'a dyn Fn() -> i64,
}

impl<S: PtyTurnSink> PromptHooks for WatchSink<'_, S> {
    fn wait_for_ready(&mut self) -> bool {
        self.inner.wait_for_ready()
    }
    fn wait_for_settled(&mut self, ready: bool, waited_ms: u64) {
        self.inner.wait_for_settled(ready, waited_ms)
    }
    fn gate_signal(&mut self) -> u64 {
        self.inner.gate_signal()
    }
    fn confirm_probe(&mut self) -> bool {
        self.inner.confirm_probe()
    }
}

impl<S: PtyTurnSink> PtyTurnSink for WatchSink<'_, S> {
    fn on_spawn(&mut self, controls: PtyControls) {
        {
            let mut w = lock(&self.watch);
            w.end.has_controls = true;
            w.controls = Some(controls.clone());
        }
        self.inner.on_spawn(controls)
    }
    fn on_output(&mut self, frame: &[u8]) {
        {
            let mut w = lock(&self.watch);
            w.end.last_data_at_ms = (self.now_ms)();
            w.screen.extend_from_slice(frame);
            let over = w.screen.len().saturating_sub(SCREEN_TAIL_MAX);
            if over > 0 {
                w.screen.drain(..over);
            }
        }
        self.inner.on_output(frame)
    }
    fn on_injected(&mut self) {
        self.inner.on_injected()
    }
    fn on_attention(&mut self, screen: &str, kind: AttentionKind) {
        self.inner.on_attention(screen, kind)
    }
    fn on_turn_gate(&mut self, screen: &str) {
        self.inner.on_turn_gate(screen)
    }
}

/// 감시 루프를 멈추는 것들. `stop` 은 시도 범위(`run_beside` 의 가드)가, `ended` 는 턴 끝이, `fence` 는 임대 잃음이 세운다.
pub struct WatchStops<'s> {
    pub stop: &'s AtomicBool,
    /// 턴이 끝났다([`crate::turn_io::TurnIo::ended`]). 없으면 보지 않는다.
    pub ended: Option<&'s AtomicBool>,
    /// 펜스 — 듣고 있고 임대를 잃었으면 **자리 값**에 접고 멈춘다. 없으면 보지 않는다. `on_lost` 는 잠금 안에서 불리므로
    /// 감시 자리를 다시 잠그지 않는 것만 해야 한다(실물 [`fence_reclaim`] 은 표지만 적는다).
    pub fence: Option<&'s mut FenceCheck>,
    /// 펜스로 거뒀을 때 보낼 SIGTERM(실물 [`terminate_on_watch`]) — 잠금을 놓은 **뒤에** 부른다.
    pub terminate: Option<Arc<dyn Fn() + Send + Sync>>,
}

/// 탐침 주기를 돈다 — `probe_ms` 마다 한 번, `Stop`·`stop` 신호·PTY 종료까지. 돈 주기 수를 돌려준다.
pub fn run_watch(
    watch: &Watch,
    probe: &mut ProbeState,
    cfg: &EndConfig,
    io: &mut impl ProbeIo,
    probe_ms: Duration,
    stop: &AtomicBool,
) -> u32 {
    run_watch_guarded(
        watch,
        probe,
        cfg,
        io,
        probe_ms,
        WatchStops {
            stop,
            ended: None,
            fence: None,
            terminate: None,
        },
    )
}

/// [`run_watch`] 에 턴 끝·펜스 확인을 더한 것. 주기마다 차례: 멈춤 신호 → 턴 끝 → **펜스**(감시 자리를 잠근 채 자리 값에 접는다 —
/// 잠금 밖 사본이 아니다) → 탐침(잠금 밖) → 되쓰기 → 거뒀으면 멈춤. 펜스에 걸린 주기에는 탐침(발화 읽기·통지 글)이 돌지 않는다.
pub fn run_watch_guarded(
    watch: &Watch,
    probe: &mut ProbeState,
    cfg: &EndConfig,
    io: &mut impl ProbeIo,
    probe_ms: Duration,
    mut stops: WatchStops<'_>,
) -> u32 {
    let mut cycles = 0;
    loop {
        std::thread::sleep(probe_ms);
        if stops.stop.load(Ordering::SeqCst) {
            return cycles;
        }
        if stops.ended.is_some_and(|e| e.load(Ordering::SeqCst)) {
            return cycles;
        }
        if let Some(fence) = stops.fence.as_deref_mut()
            && fence.listening.load(Ordering::SeqCst)
            && (fence.lost)()
        {
            let kill = {
                let mut w = lock(watch);
                (fence.on_lost)(&mut w.end);
                w.end.reclaimed
            };
            // SIGTERM 은 잠금을 놓은 뒤 — 손잡이를 꺼내려 같은 자리를 다시 잠근다.
            if kill
                && !stops.ended.is_some_and(|e| e.load(Ordering::SeqCst))
                && let Some(t) = &stops.terminate
            {
                t();
            }
            return cycles;
        }
        // 잠금 안에서는 상태만 꺼낸다 — 탐침 IO(스레드 읽기·통지 글·화면 줄 꺼내기)는 잠금 밖에서 돈다. 그래서 통지가 느려도
        // PTY 출력(`on_output`)이 막히지 않고, 탐침이 같은 자리를 다시 잠가도 교착이 없다.
        let before = lock(watch).end.clone();
        let mut snap = before.clone();
        let out = probe_cycle(&mut snap, probe, cfg, io);
        let reclaimed = {
            let mut w = lock(watch);
            write_back(&mut w.end, &before, snap);
            w.end.reclaimed
        };
        cycles += 1;
        // 거둔 턴은 더 탐침하지 않는다 — SIGTERM 은 시계가 보냈고, 남은 일은 PTY 종료를 받은 settle 몫이다.
        if out == CycleOutcome::Stop || reclaimed {
            return cycles;
        }
    }
}

/// 이 자리의 PTY 에 SIGTERM(`PtyControls::kill(false)` — 회수한 자식에는 쏘지 않는다). 아직 띄우지 않았으면 아무것도 하지 않는다.
/// 잠금은 손잡이를 꺼내는 동안만 쥔다.
pub fn terminate_on_watch(watch: &Watch) -> Arc<dyn Fn() + Send + Sync> {
    let w = Arc::clone(watch);
    Arc::new(move || {
        let c = lock(&w).controls.clone();
        if let Some(c) = c {
            c.kill(false);
        }
    })
}

/// 이 자리의 PTY 에 바이트를 넣는다(재촉·Enter). 띄우지 않았거나 PTY 가 죽었으면 `false`.
pub fn write_on_watch(watch: &Watch) -> WritePty {
    let w = Arc::clone(watch);
    Box::new(move |bytes: &[u8]| {
        let c = {
            let g = lock(&w);
            if g.end.exited {
                return false;
            }
            g.controls.clone()
        };
        match c {
            Some(c) => {
                c.write(bytes);
                true
            }
            None => false,
        }
    })
}

/// 임대를 잃었을 때 접는 일 — 자리 값에 「거뒀다」만 적는다(SIGTERM 은 [`run_watch_guarded`] 가 잠금 밖에서).
pub fn fence_reclaim() -> Box<dyn FnMut(&mut EndState) + Send> {
    Box::new(|end: &mut EndState| {
        end.reclaim();
    })
}

#[cfg(test)]
#[path = "turn_watch_tests.rs"]
mod tests;
