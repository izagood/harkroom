//! 탐침 한 주기의 나머지 실구현(B4-2f-4b-3b-2c-2b) — 정본 `mentionTurn.ts` 의 `nudgeOrExpire`(API 키 연결 턴 재촉),
//! 회수 시계(`EndAction`), 정지 처리(`probeStall` 의 결과), 그리고 탐침 주기 한 번([`probe_tick`]).
//!
//! **탐침 주기의 순서**(security 확인 거리): ① 턴이 끝났으면(`ended`) 멈춘다 → ② 펜스를 듣고 있고 임대를 잃었으면
//! 그 자리에서 접고(사람의 [중단] 과 같은 길) 멈춘다 — **이번 주기의 탐침(발화 읽기·통지 올리기)은 돌지 않는다** →
//! ③ 그다음에야 [`probe_cycle`]. 임대를 잃은 턴이 스레드에 글을 더 남기지 않게 한다.
//!
//! **화면 원문**: 재촉 판정에 쓰는 `probe.screen_said` 는 판정(`lane_nudge_wanted`)에만 넣고 **올리지 않는다**. 화면 답을 스레드에
//! 올리는 길은 [`crate::turn_probe_records::screen_said_for_post`] 하나다(security 22:35 조건 ①) — 이 파일은 올리지 않는다.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::pty::sanitize_paste_text;
use crate::turn_end::{EndAction, EndConfig, EndState, StallProbe, StallVerdict};
use crate::turn_io::Timer;
use crate::turn_notice::{NudgeCaller, lane_nudge_text, lane_nudge_wanted};
use crate::turn_probe::{CycleOutcome, ProbeIo, ProbeState, probe_cycle};
use crate::turn_probe_io::ProbeRest;

/// 정본 `LANE_NUDGE_WAIT_MS` — 재촉한 뒤 이만큼 말이 없으면 끝난 것으로 본다.
pub const LANE_NUDGE_WAIT_MS: i64 = 120_000;
/// 정본 `LANE_NUDGE_SUBMIT_DELAY_MS` — 붙여넣은 재촉을 제출(`\r`)하기까지의 틈.
pub const LANE_NUDGE_SUBMIT_DELAY_MS: u64 = 1_000;

/// 재촉이 바깥에 묻고 시키는 일. 실패를 던지지 않는다.
pub trait NudgeIo {
    fn now_ms(&self) -> i64;
    /// API 키 연결(provider lane) 턴이고 TUI 하네스다 — 재촉은 이 턴에만 한다.
    fn lane_tui_turn(&self) -> bool;
    fn exited(&self) -> bool;
    /// 하네스 기록의 마지막 말(원문 — 판정에만 쓴다). 기록 → 하네스 자체 기록 순. 없으면 `None`.
    fn read_said(&mut self) -> Option<String>;
    /// 이 턴을 부른 쪽(재촉할지 고르는 재료).
    fn caller(&self) -> NudgeCaller;
    /// 다른 스레드에 답하고 끝낸 증거가 있다(정본 `offAnchorEvidence !== null`) — 그러면 재촉하지 않는다.
    fn answered_off_anchor(&mut self) -> bool;
    /// PTY 에 바이트를 넣는다. 죽었으면 `false`.
    fn write_pty(&mut self, bytes: &[u8]) -> bool;
    /// `delay` 뒤 PTY 가 살아 있으면 `\r` 을 넣는다(제출).
    fn submit_later(&mut self, delay: Duration);
    /// 화면 끝 감시를 다시 건다(정본 `idleWatch?.rearm()`). 화면 감시가 없으면 아무것도 하지 않는다.
    fn rearm_screen_watch(&mut self);
    fn log(&mut self, line: &str);
}

/// 정본 `nudgeOrExpire` — 말없이 끝난 API 키 연결 턴을 **한 번** 재촉한다. 재촉한 뒤 `wait_ms` 동안 말이 없으면 끝으로 본다.
pub fn nudge_or_expire(
    end: &mut EndState,
    probe: &mut ProbeState,
    io: &mut impl NudgeIo,
    target: &NudgeTarget,
    wait_ms: i64,
) {
    let now = io.now_ms();
    if probe.lane_nudged_at_ms != 0 {
        if !end.finished && now - probe.lane_nudged_at_ms >= wait_ms {
            io.log("재촉 뒤에도 발화가 없다 — 끝난 것으로 본다");
            end.finished = true;
            end.pending = Some(0);
        }
        return;
    }
    if !io.lane_tui_turn()
        || !end.finished
        || end.pending.unwrap_or(0) > 0
        || !end.has_controls
        || end.viewers > 0
    {
        return;
    }
    // 판정 재료 — 원문은 판정에만 쓰고 올리지 않는다.
    let said = io.read_said().or_else(|| probe.screen_said.clone());
    if end.exited || io.exited() || !end.has_controls {
        return;
    }
    if !lane_nudge_wanted(io.caller(), said.as_deref()) {
        return;
    }
    if io.answered_off_anchor() {
        return;
    }
    if end.exited || io.exited() || !end.has_controls {
        return;
    }
    probe.lane_nudged_at_ms = now;
    end.finished = false;
    end.tail = None;
    end.last_life_ms = now;
    io.rearm_screen_watch();
    io.log("API 키 연결 턴이 말없이 끝났다 — 한 번 재촉한다");
    let text = sanitize_paste_text(&lane_nudge_text(
        &target.channel_id,
        target.thread_root_id.as_deref(),
    ));
    let mut pasted = Vec::with_capacity(text.len() + 12);
    pasted.extend_from_slice(b"\x1b[200~");
    pasted.extend_from_slice(text.as_bytes());
    pasted.extend_from_slice(b"\x1b[201~");
    if io.write_pty(&pasted) {
        io.submit_later(Duration::from_millis(LANE_NUDGE_SUBMIT_DELAY_MS));
    }
}

/// 재촉 문구에 싣는 자리(채널 id·앵커 — 서버가 정한 값).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NudgeTarget {
    pub channel_id: String,
    pub thread_root_id: Option<String>,
}

/// 회수 시계가 울렸을 때 끝 상태에 「거뒀다」를 적고 SIGTERM 을 보낼지 돌려준다(`EndState::on_reclaim_timer`).
/// 실구현은 감시 자리(`turn_watch::Watch`)를 **직접** 잠가 적는다 — 사본에 적으면 감시 루프의 되쓰기에 덮인다.
pub type ReclaimEnd = Arc<dyn Fn() -> bool + Send + Sync>;

/// PTY 에 바이트를 넣는 일. 죽었으면 `false`.
pub type WritePty = Box<dyn FnMut(&[u8]) -> bool + Send>;

/// [`ProbeRest`] 실구현 — 회수 시계·정지 처리는 여기서, 재촉은 [`NudgeIo`] 로.
pub struct TurnProbeRest<N: NudgeIo> {
    pub nudge: N,
    pub nudge_target: NudgeTarget,
    pub nudge_wait_ms: i64,
    /// 회수 시계가 울렸을 때 끝 상태(감시 자리)에 적는 닫개.
    pub on_reclaim: ReclaimEnd,
    /// 턴이 끝났다([`crate::turn_io::TurnIo::ended`]) — 서 있으면 SIGTERM·Enter 를 보내지 않는다.
    pub ended: Arc<AtomicBool>,
    /// PTY 에 SIGTERM(실구현 `PtyControls::kill(false)` — 회수한 자식에는 쏘지 않는다).
    pub terminate: Arc<dyn Fn() + Send + Sync>,
    /// PTY 에 바이트를 넣는다(Enter). 죽었으면 `false`.
    pub write_pty: WritePty,
    /// 이 하네스가 세션 기록을 읽을 줄 알고, 그 기록 mtime(ms). 못 읽으면 `None`.
    pub reads_transcript: bool,
    pub transcript_mtime_ms: Box<dyn FnMut() -> Option<i64> + Send>,
    /// 서 있는 회수 시계. [`Timer`] 는 떨어지면 꺼진다 — 이 값이 떨어지면(시도 끝·패닉 풀림) 시계도 멈춘다.
    pub reclaim_timer: Option<Timer>,
}

impl<N: NudgeIo> TurnProbeRest<N> {
    fn live(&self) -> bool {
        !self.ended.load(Ordering::SeqCst)
    }
    fn disarm(&mut self) {
        if let Some(t) = self.reclaim_timer.take() {
            t.cancel();
        }
    }
}

impl<N: NudgeIo> ProbeRest for TurnProbeRest<N> {
    fn nudge_or_expire(&mut self, end: &mut EndState, probe: &mut ProbeState) {
        nudge_or_expire(
            end,
            probe,
            &mut self.nudge,
            &self.nudge_target,
            self.nudge_wait_ms,
        );
    }

    fn apply_end_action(&mut self, action: EndAction) {
        match action {
            EndAction::Keep => {}
            EndAction::Disarm => self.disarm(),
            EndAction::Arm { grace_ms } => {
                self.disarm();
                if !self.live() {
                    return;
                }
                let on_reclaim = self.on_reclaim.clone();
                let ended = self.ended.clone();
                let terminate = self.terminate.clone();
                self.reclaim_timer =
                    Some(Timer::after(Duration::from_millis(grace_ms), move || {
                        // 끈 직후 깨어났을 수 있다 — 끝난 턴이면 아무것도 하지 않는다(#2000).
                        if ended.load(Ordering::SeqCst) {
                            return;
                        }
                        let kill = on_reclaim();
                        if kill && !ended.load(Ordering::SeqCst) {
                            terminate();
                        }
                    }));
            }
            EndAction::ReclaimNow { kill } => {
                self.disarm();
                if kill && self.live() {
                    (self.terminate)();
                }
            }
        }
    }

    fn stall_probe(&mut self, _end: &EndState, now_ms: i64) -> StallProbe {
        StallProbe {
            reads_transcript: self.reads_transcript,
            transcript_mtime_ms: if self.reads_transcript {
                (self.transcript_mtime_ms)()
            } else {
                None
            },
            // 화면 감시가 아직 없다 — 「제출 대기」를 화면으로 말할 수 없으니 거짓(Enter 를 치지 않는 쪽).
            looks_unsent: false,
            now_ms,
        }
    }

    fn apply_stall(&mut self, verdict: StallVerdict) {
        match verdict {
            StallVerdict::Alive => {}
            StallVerdict::PressEnter => {
                if self.live() {
                    let _ = (self.write_pty)(b"\r");
                }
            }
            StallVerdict::Stalled { kill, .. } => {
                if kill && self.live() {
                    (self.terminate)();
                }
            }
        }
    }
}

/// 탐침 주기 한 번의 결과.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TickOutcome {
    /// 다음 주기에 다시 돈다.
    Again,
    /// 턴이 끝났다 — 주기를 멈춘다.
    Ended,
    /// 임대를 잃어 접었다 — 주기를 멈춘다(이번 주기의 탐침은 돌지 않았다).
    Fenced,
    /// 탐침이 멈추라고 했다(PTY 가 죽었거나 거뒀다).
    Stopped,
}

/// 펜스 확인 — 듣고 있는지와 임대를 잃었는지(실구현 `ThreadClaimHandle::fenced()`), 잃었을 때 접는 일(`on_fence_lost`).
pub struct FenceCheck {
    pub listening: Arc<AtomicBool>,
    pub lost: Box<dyn FnMut() -> bool + Send>,
    pub on_lost: Box<dyn FnMut(&mut EndState) + Send>,
}

/// 탐침 주기 한 번(정본 `probeUtterance` 의 바깥 고리). 순서: 끝 확인 → **펜스** → 탐침.
pub fn probe_tick(
    end: &Mutex<EndState>,
    ended: &AtomicBool,
    fence: &mut FenceCheck,
    probe: &mut ProbeState,
    cfg: &EndConfig,
    io: &mut impl ProbeIo,
) -> TickOutcome {
    if ended.load(Ordering::SeqCst) {
        return TickOutcome::Ended;
    }
    let mut end = end.lock().unwrap_or_else(|p| p.into_inner());
    if fence.listening.load(Ordering::SeqCst) && (fence.lost)() {
        (fence.on_lost)(&mut end);
        return TickOutcome::Fenced;
    }
    match probe_cycle(&mut end, probe, cfg, io) {
        CycleOutcome::Stop => TickOutcome::Stopped,
        _ => TickOutcome::Again,
    }
}

/// 탐침 주기를 건다(정본 `setTimeout(probeUtterance, probeMs)` 되풀이) — 멈춤([`TickOutcome::Again`] 이 아닌 결과)이 오면 스스로 멈춘다.
/// 돌려준 [`Timer`] 는 settle 이 끈다(`cancel_probe`).
pub fn start_probe_loop<I: ProbeIo + Send + 'static>(
    period: Duration,
    end: Arc<Mutex<EndState>>,
    ended: Arc<AtomicBool>,
    mut fence: FenceCheck,
    mut probe: ProbeState,
    cfg: EndConfig,
    mut io: I,
) -> Timer {
    Timer::every(period, move || {
        probe_tick(&end, &ended, &mut fence, &mut probe, &cfg, &mut io) == TickOutcome::Again
    })
}

#[cfg(test)]
#[path = "turn_probe_rest_tests.rs"]
mod tests;
