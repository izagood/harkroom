//! 감시 루프 → [`EndState`] — PTY 출력을 받는 턴 sink([`WatchSink`])와 탐침 주기를 도는 루프([`run_watch`]).
//!
//! - [`WatchSink`]: 띄운 순간 `has_controls`, 출력마다 `last_data_at_ms` 를 [`EndState`] 에 적는다. 화면 원문(꼬리)은
//!   [`WatchState`] 안에만 쥔다 — `Debug` 는 길이만, 밖으로 내는 길은 [`WatchState::screen_line_for_post`] 하나이고
//!   그것은 [`screen_said_for_post`](`NoticeSecrets` 의 `quoted_line`)를 거친 한 줄만 낸다.
//! - [`run_watch`]: `probe_ms` 마다 끝 상태를 잠깐 잠가 꺼내 [`probe_cycle`] 을 **잠금 밖에서** 한 번 돌고 돌려놓는다. `Stop`·멈춤 신호·PTY 종료면 끝낸다. 탐침이 글로
//!   내는 것은 이미 가린 통지 함수만 지난다(`turn_probe_records`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use crate::pty::{AttentionKind, decode_tail_text, strip_ansi};
use crate::pty_turn::{PromptHooks, PtyControls, PtyTurnSink};
use crate::turn_end::{EndConfig, EndState};
use crate::turn_probe::{CycleOutcome, ProbeIo, ProbeState, probe_cycle};
use crate::turn_probe_records::{NoticeSecrets, screen_said_for_post};

/// 화면 꼬리 상한(바이트) — 마지막 줄을 거두는 데만 쓴다.
const SCREEN_TAIL_MAX: usize = 4096;

/// 감시가 쥐는 것 — 끝 상태와 화면 꼬리(원문).
#[derive(Default)]
pub struct WatchState {
    pub end: EndState,
    screen: Vec<u8>,
}

impl std::fmt::Debug for WatchState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WatchState")
            .field("end", &self.end)
            .field("screen_len", &self.screen.len())
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
        lock(&self.watch).end.has_controls = true;
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

/// 탐침 주기를 돈다 — `probe_ms` 마다 한 번, `Stop`·`stop` 신호·PTY 종료까지. 돈 주기 수를 돌려준다.
pub fn run_watch(
    watch: &Watch,
    probe: &mut ProbeState,
    cfg: &EndConfig,
    io: &mut impl ProbeIo,
    probe_ms: Duration,
    stop: &AtomicBool,
) -> u32 {
    let mut cycles = 0;
    loop {
        std::thread::sleep(probe_ms);
        if stop.load(Ordering::SeqCst) {
            return cycles;
        }
        // 잠금 안에서는 상태만 꺼낸다 — 탐침 IO(스레드 읽기·통지 글·화면 줄 꺼내기)는 잠금 밖에서 돈다. 그래서 통지가 느려도
        // PTY 출력(`on_output`)이 막히지 않고, 탐침이 같은 자리를 다시 잠가도 교착이 없다.
        let mut snap = lock(watch).end.clone();
        let out = probe_cycle(&mut snap, probe, cfg, io);
        {
            // 돌려놓을 때 sink 가 그사이 적은 값(출력 시각·손잡이)은 지킨다.
            let mut w = lock(watch);
            let last_data = w.end.last_data_at_ms.max(snap.last_data_at_ms);
            let controls = w.end.has_controls || snap.has_controls;
            w.end = snap;
            w.end.last_data_at_ms = last_data;
            w.end.has_controls = controls;
        }
        cycles += 1;
        if out == CycleOutcome::Stop {
            return cycles;
        }
    }
}

#[cfg(test)]
#[path = "turn_watch_tests.rs"]
mod tests;
