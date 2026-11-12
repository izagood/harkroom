//! 정본 `mentionTurn.ts::runMentionTurn` 의 `probeUtterance` 한 주기(B4-2f-4b-1) — 탐침들의 **순서와 갈림**만 옮긴다.
//!
//! 각 탐침(발화 읽기·권한 거부·macOS 권한·MCP 인증·API 오류·턴 상태·화면·기록 끝·재촉·정지 처리)이 실제로 무엇을
//! 읽고 무엇을 보내는지는 [`ProbeIo`] 뒤에 있다 — 판정은 이미 [`crate::turn_end`] 에 있고, 여기는 접착이다.
//! 정본은 `await` 마다 `end.exited` 를 다시 본다. 여기서는 [`ProbeIo::exited`] 를 같은 자리에서 본다
//! (PTY 종료는 다른 스레드가 세우므로 `EndState::exited` 만 보면 놓친다).
//!
//! 주기를 다시 세우는 일(정본 `again()`·`schedule(probeUtterance, probeMs)`)은 부르는 쪽 몫이다 —
//! [`probe_cycle`] 이 [`CycleOutcome::Again`] 을 돌려주면 `probeMs` 뒤 다시 부른다.

use crate::harness_records::RecordedTurnEnd;
use crate::turn_end::{
    EndAction, EndConfig, EndState, StallProbe, StallVerdict, probe_stall, reconsider_end,
};

/// 정본 `end` 객체 중 탐침 주기만 쓰는 몫과 턴의 고정값.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProbeState {
    /// 지난 주기에 서버 스레드를 못 읽었다(정본 `end.threadUnreadable`) — 같은 실패를 주기마다 적지 않는다.
    pub thread_unreadable: bool,
    /// 처음 발화를 본 시각(정본 `firstSpokeAt`).
    pub first_spoke_at_ms: Option<i64>,
    /// 화면이 차례 끝을 말했다(정본 `end.screenEnded`).
    pub screen_ended: bool,
    /// 화면에서 거둔 답(정본 `end.screenSaid`). 재촉 뒤에는 덮지 않는다.
    pub screen_said: Option<String>,
    /// API 키 재촉을 보낸 시각(정본 `end.laneNudgedAtMs`). 0 은 안 보냈다.
    pub lane_nudged_at_ms: i64,
    /// 턴 시작 시각(정본 `turnStartedAtMs`) — 기록 끝을 읽을 기준.
    pub turn_started_at_ms: i64,
}

/// 한 주기의 결말.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CycleOutcome {
    /// `probeMs` 뒤 다시 부른다(정본 `again()`).
    Again,
    /// 다시 부르지 않는다 — PTY 가 죽었거나, API 오류·정지로 거뒀다.
    Stop,
}

/// 탐침 한 주기가 바깥에 묻고 시키는 일. 시험은 가짜로 갈아 끼운다.
///
/// 실패를 던지지 않는다 — 정본의 `.catch(() => null)`·`.catch(again)` 처럼 **관측 실패로 턴을 죽이지 않는다**.
pub trait ProbeIo {
    /// 지금 시각(ms).
    fn now_ms(&self) -> i64;
    /// PTY 가 죽었다 — 다른 스레드가 세운 값을 본다.
    fn exited(&self) -> bool;
    /// 턴 시작 뒤 내 발화가 있는가(정본 `readThread` + `countOwnPostsSince > 0`). 서버를 못 읽으면 `Err(사유)`.
    fn read_spoke(&mut self) -> Result<bool, String>;
    /// 발화 확인 실패를 한 번 적는다(정본 `console.error`).
    fn log_unreadable(&mut self, reason: &str);
    /// 정본 `probeDenials`.
    fn probe_denials(&mut self, end: &mut EndState);
    /// 정본 `probeMacPermission`.
    fn probe_mac_permission(&mut self, end: &mut EndState);
    /// 정본 `probeMcpAuth`.
    fn probe_mcp_auth(&mut self, end: &mut EndState);
    /// 정본 `probeApiError` — `true` 면 거뒀다(이 주기를 끝낸다).
    fn probe_api_error(&mut self, end: &mut EndState) -> bool;
    /// 정본 `probeTurnState` — 기록 꼬리·남은 하위 에이전트를 `end` 에 적는다.
    fn probe_turn_state(&mut self, end: &mut EndState);
    /// 화면 감시가 「입력창 + 일하는 중 표지 없음」을 끝 시간만큼 이어 말한다. 화면 감시가 없으면 `None`
    /// (정본 `idleWatch === null`).
    fn screen_idle_ended(&mut self, now_ms: i64) -> Option<bool>;
    /// 하네스 기록이 말하는 차례 끝(정본 `readHarnessTurnEnd`, `sinceMs` 이후). 못 읽으면 `None`.
    fn read_recorded_end(&mut self, since_ms: i64) -> Option<RecordedTurnEnd>;
    /// 화면에서 거둔 답 줄(정본 `screenAnswerLines(...).join('\n') || null`).
    fn screen_answer(&mut self) -> Option<String>;
    /// 화면이 끝을 말했다고 적는다(정본 `console.log`).
    fn log_screen_ended(&mut self);
    /// 정본 `nudgeOrExpire` — 재촉을 보냈으면 `probe.lane_nudged_at_ms` 를 세운다.
    fn nudge_or_expire(&mut self, end: &mut EndState, probe: &mut ProbeState);
    /// [`reconsider_end`] 가 시킨 시계 일을 한다.
    fn apply_end_action(&mut self, action: EndAction);
    /// 정지 판정에 넘길 이번 주기의 관측(기록 mtime·제출 대기 화면).
    fn stall_probe(&mut self, end: &EndState, now_ms: i64) -> StallProbe;
    /// [`probe_stall`] 의 판정을 실행한다 — Enter 치기·SIGTERM·정지 통지.
    fn apply_stall(&mut self, verdict: StallVerdict);
}

fn gone(end: &mut EndState, io: &impl ProbeIo) -> bool {
    if io.exited() {
        end.exited = true;
    }
    end.exited
}

/// 정본 `probeUtterance` 한 주기.
pub fn probe_cycle(
    end: &mut EndState,
    probe: &mut ProbeState,
    cfg: &EndConfig,
    io: &mut impl ProbeIo,
) -> CycleOutcome {
    if gone(end, io) {
        return CycleOutcome::Stop;
    }
    // 발화는 한 번 보면 다시 묻지 않는다. **확인이 실패해도 기록 꼬리는 본다**(2026-09-30) — 실패는 `None`(모른다).
    let spoke: Option<bool> = if end.spoke {
        Some(true)
    } else {
        match io.read_spoke() {
            Ok(v) => Some(v),
            Err(reason) => {
                if !probe.thread_unreadable {
                    io.log_unreadable(&reason);
                }
                None
            }
        }
    };
    if gone(end, io) {
        return CycleOutcome::Stop;
    }
    probe.thread_unreadable = spoke.is_none();
    if spoke == Some(true) {
        end.spoke = true;
        if probe.first_spoke_at_ms.is_none() {
            probe.first_spoke_at_ms = Some(io.now_ms());
        }
    }
    io.probe_denials(end);
    io.probe_mac_permission(end);
    io.probe_mcp_auth(end);
    if gone(end, io) {
        return CycleOutcome::Stop;
    }
    // 발화가 없을 때만 API 오류를 끝 판정보다 **먼저** 본다 — 한도에 걸린 턴을 "말없이 끝났다"로 읽으면 계정을
    // 안 넘긴다. 모를 때(`None`)는 보지 않는다 — 말한 뒤의 한도를 실패로 읽으면 재시도가 두 번 답한다.
    if spoke == Some(false) && io.probe_api_error(end) {
        return CycleOutcome::Stop;
    }
    io.probe_turn_state(end);
    // 화면은 언제 물을지만 정한다 — 기록이 일하는 중이라고 하면 끝이 아니다. 못 읽으면 화면을 따른다.
    let now = io.now_ms();
    let has_watch;
    let screen_says_ended = if end.finished || end.awaiting_human {
        has_watch = false;
        false
    } else {
        let s = io.screen_idle_ended(now);
        has_watch = s.is_some();
        s == Some(true)
    };
    let recorded_end = if screen_says_ended {
        let since = if probe.lane_nudged_at_ms != 0 {
            probe.lane_nudged_at_ms
        } else {
            probe.turn_started_at_ms
        };
        io.read_recorded_end(since)
    } else {
        None
    };
    if gone(end, io) {
        return CycleOutcome::Stop;
    }
    if has_watch && screen_says_ended && recorded_end != Some(RecordedTurnEnd::Working) {
        end.finished = true;
        // 표지가 꺼졌다는 것은 하네스가 더 기다리는 일이 없다는 뜻이라 0 으로 둔다.
        end.pending = Some(0);
        // 재촉 뒤의 화면은 군말일 수 있다 — 재촉 전에 본 답을 지킨다.
        if probe.lane_nudged_at_ms == 0 {
            probe.screen_said = io.screen_answer().filter(|s| !s.is_empty());
        }
        probe.screen_ended = true;
        io.log_screen_ended();
    }
    if spoke == Some(false) {
        io.nudge_or_expire(end, probe);
    }
    if gone(end, io) {
        return CycleOutcome::Stop;
    }
    let action = reconsider_end(end, io.now_ms(), cfg);
    io.apply_end_action(action);
    // 끝나지 않았고 말도 없다 — 일하는 중인가, 서 있는가. 발화를 모를 때는 접지 않는다.
    if spoke == Some(false) && !end.spoke && !end.finished {
        let now = io.now_ms();
        let obs = io.stall_probe(end, now);
        let verdict = probe_stall(end, obs, cfg);
        let stalled = matches!(verdict, StallVerdict::Stalled { .. });
        if verdict != StallVerdict::Alive {
            io.apply_stall(verdict);
        }
        if stalled {
            return CycleOutcome::Stop;
        }
    }
    if gone(end, io) {
        return CycleOutcome::Stop;
    }
    CycleOutcome::Again
}

#[cfg(test)]
#[path = "turn_probe_tests.rs"]
mod tests;
