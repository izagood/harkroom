//! [`NudgeIo`] 실물 — 말없이 끝난 API 키 연결 턴의 재촉(정본 `nudgeOrExpire`)이 바깥에 묻고 시키는 일.
//!
//! **PTY 에 넣는 것(재촉 붙여넣기·제출 Enter)은 [`write_on_watch`] 하나로만 간다**(security ②-3 조건 ②) — 그 시도의 감시
//! 자리가 쥔 손잡이로만, 자리가 PTY 종료를 적었으면 넣지 않는다. 제출 Enter 를 미루는 시계도 같은 길을 쓰고, 시계는 이 값이
//! 쥐고 있다가 값이 떨어질 때(시도 끝·패닉 풀림) 함께 꺼진다([`Timer`] 의 Drop).
//!
//! **잠금 차례**(조건 ③): 이 값이 잡는 잠금은 감시 자리 하나뿐이고, 쥔 채 다른 잠금(슬롯·`LiveTurn`)을 잡지 않는다. 기록
//! 읽기·앵커 밖 확인은 부르는 쪽이 넣은 닫개이고 감시 자리를 쥔 채 부르지 않는다.
//!
//! 마지막 말(`read_said`)은 **판정에만** 쓴다 — 올리지 않는다(재촉 문구는 서버가 정한 채널·앵커만 싣는다).

use std::time::Duration;

use crate::turn_io::Timer;
use crate::turn_notice::NudgeCaller;
use crate::turn_probe_rest::NudgeIo;
use crate::turn_watch::{Watch, write_on_watch};

/// 마지막 말을 읽는다(기록 → 하네스 자체 기록 순, 정본 `recordSaid ?? harnessSaid`). 못 읽으면 `None`.
pub type ReadSaid<'a> = Box<dyn FnMut() -> Option<String> + 'a>;
/// 앵커 밖에 답한 정황(정본 `offAnchorEvidence`). 없으면 `None`.
pub type OffAnchor<'a> = Box<dyn FnMut() -> Option<String> + 'a>;

/// [`NudgeIo`] 실물 — 그 시도의 감시 자리를 쥔다.
pub struct WatchNudgeIo<'a> {
    pub key: String,
    pub clock: fn() -> i64,
    /// API 키 연결 턴이고 TUI 하네스다(정본 `providerEnv !== null && usesTui`).
    pub lane_tui: bool,
    pub caller: NudgeCaller,
    pub watch: Watch,
    pub read_said: ReadSaid<'a>,
    pub off_anchor: OffAnchor<'a>,
    /// 서 있는 제출 시계 — 이 값이 떨어지면 꺼진다.
    pub submit_timers: Vec<Timer>,
}

impl<'a> WatchNudgeIo<'a> {
    pub fn new(
        key: String,
        clock: fn() -> i64,
        lane_tui: bool,
        caller: NudgeCaller,
        watch: Watch,
        read_said: ReadSaid<'a>,
        off_anchor: OffAnchor<'a>,
    ) -> Self {
        Self {
            key,
            clock,
            lane_tui,
            caller,
            watch,
            read_said,
            off_anchor,
            submit_timers: Vec::new(),
        }
    }
}

impl NudgeIo for WatchNudgeIo<'_> {
    fn now_ms(&self) -> i64 {
        (self.clock)()
    }
    fn lane_tui_turn(&self) -> bool {
        self.lane_tui
    }
    fn exited(&self) -> bool {
        self.watch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .end
            .exited
    }
    fn read_said(&mut self) -> Option<String> {
        (self.read_said)()
    }
    fn caller(&self) -> NudgeCaller {
        self.caller
    }
    fn answered_off_anchor(&mut self) -> bool {
        (self.off_anchor)().is_some()
    }
    fn write_pty(&mut self, bytes: &[u8]) -> bool {
        write_on_watch(&self.watch)(bytes)
    }
    fn submit_later(&mut self, delay: Duration) {
        let mut write = write_on_watch(&self.watch);
        self.submit_timers.push(Timer::after(delay, move || {
            let _ = write(b"\r");
        }));
    }
    fn rearm_screen_watch(&mut self) {
        // 화면 끝 감시는 아직 없다(`screen_idle_ended` 가 `None`) — 다시 걸 것이 없다.
    }
    fn log(&mut self, line: &str) {
        eprintln!("[mentionTurn] {}: {line}", self.key);
    }
}

#[cfg(test)]
#[path = "turn_nudge_io_tests.rs"]
mod tests;
