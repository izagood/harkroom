//! [`ProbeIo`] 실구현 1/2(B4-2f-4b-3b-2c-2a) — 탐침 한 주기가 묻는 것 중 **이미 있는 읽개·판정에 넘기면 되는 몫**을 잇는다.
//!
//! | ProbeIo | 넘기는 곳 |
//! |---|---|
//! | `read_spoke` | 스레드 읽기 + [`count_own_posts_since`] |
//! | `probe_denials`·`probe_mac_permission`·`probe_mcp_auth`·`probe_api_error` | [`crate::turn_probe_records`] |
//! | `probe_turn_state` | [`crate::turn_probe_state::probe_turn_state`] |
//! | `read_recorded_end` | 부르는 쪽이 넣은 기록 읽개(실구현은 `harness_records::read_harness_turn_end`) |
//! | `screen_idle_ended`·`screen_answer` | 화면 감시가 아직 없다 — `None`(정본 `idleWatch === null` 과 같은 길) |
//! | 재촉·시계·정지(`nudge_or_expire`·`apply_end_action`·`stall_probe`·`apply_stall`) | [`ProbeRest`] — 실구현은 3b-2c-2b |
//!
//! SIGTERM 은 부르는 쪽이 넣은 `terminate` 로만 보낸다. 실구현은 `PtyControls::kill(false)` 이고, 그 아래
//! `PtyHandle::signal` 은 회수(wait)를 끝낸 자식에는 신호를 보내지 않는다(#1947 규칙 — pid 재사용 방지).
//! 여기서는 턴이 끝났으면(`ended`) 아예 부르지 않는다.
//!
//! 아직 아무 데서도 부르지 않는다 — 탐침 주기(`Timer::every` → `probe_cycle`)에 붙이는 것은 3b-2c-2b 다.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;

use crate::adapter::AgentHarness;
use crate::harness_records::RecordedTurnEnd;
use crate::turn_end::{EndAction, EndConfig, EndState, StallProbe, StallVerdict};
use crate::turn_posts::count_own_posts_since;
use crate::turn_probe::{ProbeIo, ProbeState};
use crate::turn_probe_records::{
    NoticeSecrets, ProbeRecords, ProbeSink, RecordProbeState, probe_api_error, probe_denials,
    probe_mac_permission, probe_mcp_auth,
};
use crate::turn_probe_state::{
    TurnStateCtx, TurnStateNote, TurnStateProbe, TurnStateRecords, probe_turn_state,
};

/// 재촉·시계·정지 — [`ProbeIo`] 중 이 조각이 아직 잇지 않은 몫(3b-2c-2b).
pub trait ProbeRest {
    fn nudge_or_expire(&mut self, end: &mut EndState, probe: &mut ProbeState);
    fn apply_end_action(&mut self, action: EndAction);
    fn stall_probe(&mut self, end: &EndState, now_ms: i64) -> StallProbe;
    fn apply_stall(&mut self, verdict: StallVerdict);
}

/// 「내 발화가 있는가」를 셀 기준(정본 `countOwnPostsSince(me.id, startSeq, turnId)`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpokeKey {
    pub me_id: String,
    /// 턴 시작 seq — 그 뒤 글만 센다.
    pub since_seq: i64,
    pub turn_id: Option<String>,
}

/// 스레드를 읽는다(정본 `readThread`). 못 읽으면 `Err(사유)`.
pub type ReadThread<'a> = Box<dyn FnMut() -> Result<Vec<Value>, String> + Send + 'a>;
/// 하네스 기록이 말하는 차례 끝(`sinceMs` 이후). 못 읽으면 `None`.
pub type ReadRecordedEnd<'a> = Box<dyn FnMut(i64) -> Option<RecordedTurnEnd> + Send + 'a>;

/// 탐침 한 주기의 바깥 일 실구현.
pub struct TurnProbeIo<'a, R: ProbeRecords, S: ProbeSink, T: TurnStateRecords, X: ProbeRest> {
    pub clock: fn() -> i64,
    /// PTY 가 죽었다 — PTY 루프 스레드가 세운다.
    pub exited: Arc<AtomicBool>,
    /// 턴이 끝났다([`crate::turn_io::TurnIo::ended`]) — 서 있으면 SIGTERM 을 보내지 않는다.
    pub ended: Arc<AtomicBool>,
    pub read_thread: ReadThread<'a>,
    pub spoke_key: SpokeKey,
    pub records: R,
    pub record_state: RecordProbeState,
    pub sink: S,
    pub secrets: NoticeSecrets,
    pub turn_state_records: T,
    pub turn_state_probe: TurnStateProbe,
    pub harness: AgentHarness,
    pub turn_started_at_ms: i64,
    pub opencode_quiet_ms: i64,
    /// [`ProbeState::lane_nudged_at_ms`] 의 사본 — `probe_turn_state` 는 `ProbeState` 를 받지 않아 재촉 뒤 여기 옮겨 둔다.
    pub lane_nudged_at_ms: i64,
    pub cfg: EndConfig,
    pub read_recorded_end: ReadRecordedEnd<'a>,
    /// PTY 에 SIGTERM(실구현 `PtyControls::kill(false)`).
    pub terminate: Arc<dyn Fn() + Send + Sync>,
    pub rest: X,
}

impl<R: ProbeRecords, S: ProbeSink, T: TurnStateRecords, X: ProbeRest> TurnProbeIo<'_, R, S, T, X> {
    fn kill(&self) {
        if !self.ended.load(Ordering::SeqCst) {
            (self.terminate)();
        }
    }
}

impl<R: ProbeRecords, S: ProbeSink, T: TurnStateRecords, X: ProbeRest> ProbeIo
    for TurnProbeIo<'_, R, S, T, X>
{
    fn now_ms(&self) -> i64 {
        (self.clock)()
    }
    fn exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }
    fn read_spoke(&mut self) -> Result<bool, String> {
        let messages = (self.read_thread)()?;
        let k = &self.spoke_key;
        Ok(count_own_posts_since(&messages, &k.me_id, k.since_seq, k.turn_id.as_deref()) > 0)
    }
    fn log_unreadable(&mut self, reason: &str) {
        self.sink.log(&format!("발화 확인 실패 — {reason}"));
    }
    fn probe_denials(&mut self, _end: &mut EndState) {
        probe_denials(
            &mut self.record_state,
            &mut self.records,
            &mut self.sink,
            &self.secrets,
        );
    }
    fn probe_mac_permission(&mut self, _end: &mut EndState) {
        probe_mac_permission(
            &mut self.record_state,
            &mut self.records,
            &mut self.sink,
            &self.secrets,
        );
    }
    fn probe_mcp_auth(&mut self, _end: &mut EndState) {
        probe_mcp_auth(&mut self.record_state, &mut self.records, &mut self.sink);
    }
    fn probe_api_error(&mut self, end: &mut EndState) -> bool {
        match probe_api_error(end, &mut self.records, &mut self.sink, &self.secrets) {
            None => false,
            Some(kill) => {
                if kill {
                    self.kill();
                }
                true
            }
        }
    }
    fn probe_turn_state(&mut self, end: &mut EndState) {
        let ctx = TurnStateCtx {
            harness: self.harness,
            turn_started_at_ms: self.turn_started_at_ms,
            lane_nudged_at_ms: self.lane_nudged_at_ms,
            opencode_quiet_ms: self.opencode_quiet_ms,
        };
        let clock = self.clock;
        let exited = self.exited.clone();
        let note = probe_turn_state(
            end,
            &mut self.turn_state_probe,
            &ctx,
            &self.cfg,
            &mut || clock(),
            &|| exited.load(Ordering::SeqCst),
            &mut self.turn_state_records,
        );
        match note {
            TurnStateNote::Quiet | TurnStateNote::OpencodeSkipped => {}
            TurnStateNote::OpencodeEnded => self.sink.log("opencode 가 차례를 끝냈다"),
            TurnStateNote::SpokeStallEnded { limit_ms } => self.sink.log(&format!(
                "발화 뒤 기록·화면이 {}초 그대로 — 끝난 것으로 본다",
                limit_ms / 1000
            )),
        }
    }
    fn screen_idle_ended(&mut self, _now_ms: i64) -> Option<bool> {
        None
    }
    fn read_recorded_end(&mut self, since_ms: i64) -> Option<RecordedTurnEnd> {
        (self.read_recorded_end)(since_ms)
    }
    fn screen_answer(&mut self) -> Option<String> {
        None
    }
    fn log_screen_ended(&mut self) {
        self.sink.log("화면이 차례 끝을 말했다");
    }
    fn nudge_or_expire(&mut self, end: &mut EndState, probe: &mut ProbeState) {
        self.rest.nudge_or_expire(end, probe);
        self.lane_nudged_at_ms = probe.lane_nudged_at_ms;
    }
    fn apply_end_action(&mut self, action: EndAction) {
        self.rest.apply_end_action(action);
    }
    fn stall_probe(&mut self, end: &EndState, now_ms: i64) -> StallProbe {
        self.rest.stall_probe(end, now_ms)
    }
    fn apply_stall(&mut self, verdict: StallVerdict) {
        self.rest.apply_stall(verdict);
    }
}

#[cfg(test)]
#[path = "turn_probe_io_tests.rs"]
mod tests;
