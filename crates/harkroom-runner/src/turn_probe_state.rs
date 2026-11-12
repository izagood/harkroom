//! 정본 `mentionTurn.ts` 의 `probeTurnState`·`probeOpencodeTurnState`(B4-2f-4b-3b-2c-1) — 기록 꼬리를 읽어
//! `end.finished`·`end.tail`·`end.pending` 을 갱신한다. **발화한 뒤에도 계속 본다** — 답을 올린 턴이 아직 도구를
//! 돌리는 중인지가 회수 여부를 정한다.
//!
//! 기록을 읽는 일은 [`TurnStateRecords`] 뒤에 있다(실구현 [`TranscriptTurnStateRecords`] 는 2f-1 의 `harness_errors`·
//! `harness_records` 읽개를 부른다). 여기는 갈림만 옮긴다. 원문은 읽지 않는다 — 상태·수·시각만 다룬다.
//!
//! 아직 아무 데서도 부르지 않는다 — [`crate::turn_probe::ProbeIo::probe_turn_state`] 실구현이 이것을 부른다(3b-2c-2).

use crate::adapter::{AgentHarness, uses_xdg_home};
use crate::harness_errors::{
    TranscriptDirs, TranscriptTurnState, read_transcript_pending_background,
    read_transcript_turn_state, session_transcript_mtime_ms,
};
use crate::harness_records::{OpencodeCall, RecordedTurnEnd, read_opencode_turn_state};
use crate::turn_end::{EndConfig, EndState, Tail};

/// 정본 `OPENCODE_QUIET_MS` — opencode 는 `opencode export` 를 띄우는 조회라 화면이 이만큼 조용할 때만, 이 간격으로만 묻는다.
pub const OPENCODE_QUIET_MS: i64 = 20_000;

/// 차례 상태 탐침의 턴 장부(정본 `end.opencodeAskedAtMs`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TurnStateProbe {
    /// opencode 에 끝을 마지막으로 물은 시각(ms). 0 은 아직 안 물었다.
    pub opencode_asked_at_ms: i64,
}

/// 이 턴의 기록을 읽는 자리. 못 읽으면 `None`(던지지 않는다 — 관측 실패로 턴을 죽이지 않는다).
pub trait TurnStateRecords {
    /// 정본 `readTranscriptTurnState`(`sinceMs` 이후).
    fn turn_state(&mut self, since_ms: i64) -> Option<Tail>;
    /// 정본 `readTranscriptPendingBackground`(`sinceMs` 이후). `None` 은 모른다.
    fn pending_background(&mut self, since_ms: i64) -> Option<u32>;
    /// 정본 `sessionTranscriptMtimeMs`.
    fn transcript_mtime_ms(&mut self) -> Option<i64>;
    /// 정본 `readOpencodeTurnState`(`sinceMs` 이후).
    fn opencode_turn_state(&mut self, since_ms: i64) -> Option<Tail>;
}

/// 탐침 한 번에 고정인 값.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TurnStateCtx {
    pub harness: AgentHarness,
    /// 턴 시작 시각(정본 `turnStartedAtMs`).
    pub turn_started_at_ms: i64,
    /// API 키 재촉을 보낸 시각(정본 `end.laneNudgedAtMs`). 0 은 안 보냈다 — 보냈으면 그 뒤 기록만 본다.
    pub lane_nudged_at_ms: i64,
    /// 정본 `deps.opencodeQuietMs ?? OPENCODE_QUIET_MS`.
    pub opencode_quiet_ms: i64,
}

/// 한 번의 결말 — 로그에 남길 일만 알린다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnStateNote {
    /// 바꾼 것이 없거나 로그에 남길 것이 없다.
    Quiet,
    /// opencode 를 물을 때가 아니다(화면이 흐르는 중·방금 물었다).
    OpencodeSkipped,
    /// opencode 가 차례를 끝냈다(정본 로그 「opencode 가 차례를 끝냈다」).
    OpencodeEnded,
    /// 발화 뒤 기록도 화면도 정지 한도만큼 그대로라 끝난 것으로 봤다 — `limit_ms` 를 로그에 남긴다.
    SpokeStallEnded { limit_ms: i64 },
}

fn since(ctx: &TurnStateCtx) -> i64 {
    if ctx.lane_nudged_at_ms != 0 {
        ctx.lane_nudged_at_ms
    } else {
        ctx.turn_started_at_ms
    }
}

/// 정본 `probeTurnState` 한 번. `exited` 는 PTY 가 죽었는가 — 정본처럼 읽은 **뒤** 다시 묻는다(다른 스레드가 세운다).
pub fn probe_turn_state(
    end: &mut EndState,
    probe: &mut TurnStateProbe,
    ctx: &TurnStateCtx,
    cfg: &EndConfig,
    now_ms: &mut dyn FnMut() -> i64,
    exited: &dyn Fn() -> bool,
    records: &mut impl TurnStateRecords,
) -> TurnStateNote {
    if uses_xdg_home(ctx.harness) {
        return probe_opencode(end, probe, ctx, now_ms(), exited, records);
    }
    let tail = records.turn_state(since(ctx));
    if exited() {
        end.exited = true;
        return TurnStateNote::Quiet;
    }
    end.tail = tail;
    end.finished = tail == Some(Tail::Ended);
    // 자식 작업 수는 끝난 턴에서만 뜻이 있다 — 일하는 중의 값은 다음 레코드가 바로 뒤집는다.
    // 정본은 재촉 뒤에도 턴 시작부터 센다(`sinceMs: turnStartedAtMs`).
    end.pending = if end.finished {
        records.pending_background(ctx.turn_started_at_ms)
    } else {
        None
    };
    // 발화 뒤 꼬리가 `working` 인 채 기록도 화면도 정지 한도만큼 그대로면 끝난 것으로 본다 — 실패가 아니다(답은
    // 이미 올라갔다). 꼬리 형식이 바뀌어 `end_turn` 을 못 알아볼 때 답한 턴이 영원히 살지 않게 하는 바닥이다.
    if !end.finished && end.spoke && tail == Some(Tail::Working) {
        if let Some(mtime) = records.transcript_mtime_ms()
            && mtime > end.last_life_ms
        {
            end.last_life_ms = mtime;
        }
        let life = end.last_life_ms.max(end.last_data_at_ms);
        if cfg.stall_ms > 0 && life > 0 && now_ms() - life >= cfg.stall_ms {
            end.finished = true;
            return TurnStateNote::SpokeStallEnded {
                limit_ms: cfg.stall_ms,
            };
        }
    }
    TurnStateNote::Quiet
}

/// 정본 `probeOpencodeTurnState` — opencode 는 기록을 우리가 읽지 않아 `opencode export` 로 끝을 묻는다(2026-10-25, e2e R1).
/// 명령을 띄우는 조회라 **화면이 조용할 때만**, 그 간격으로만 묻는다.
fn probe_opencode(
    end: &mut EndState,
    probe: &mut TurnStateProbe,
    ctx: &TurnStateCtx,
    now: i64,
    exited: &dyn Fn() -> bool,
    records: &mut impl TurnStateRecords,
) -> TurnStateNote {
    let quiet = ctx.opencode_quiet_ms;
    if end.last_data_at_ms == 0 || now - end.last_data_at_ms < quiet {
        return TurnStateNote::OpencodeSkipped;
    }
    if now - probe.opencode_asked_at_ms < quiet {
        return TurnStateNote::OpencodeSkipped;
    }
    probe.opencode_asked_at_ms = now;
    let state = records.opencode_turn_state(since(ctx));
    if exited() {
        end.exited = true;
        return TurnStateNote::Quiet;
    }
    end.tail = state;
    end.finished = state == Some(Tail::Ended);
    // opencode 의 `stop` 은 루프 전체의 끝이다 — 남은 자식 작업을 셀 표면이 없고, 모를 때는 유예한다.
    end.pending = None;
    if end.finished {
        TurnStateNote::OpencodeEnded
    } else {
        TurnStateNote::Quiet
    }
}

/// [`TurnStateRecords`] 실구현 — 2f-1 의 기록 읽개를 부른다.
pub struct TranscriptTurnStateRecords<'a> {
    pub harness: AgentHarness,
    pub session_id: Option<&'a str>,
    pub dirs: TranscriptDirs<'a>,
    /// opencode 조회(명령·env·워크스페이스). opencode 가 아니면 `None`.
    pub opencode: Option<OpencodeCall<'a>>,
}

fn tail_of_transcript(s: TranscriptTurnState) -> Tail {
    match s {
        TranscriptTurnState::Ended => Tail::Ended,
        TranscriptTurnState::Working => Tail::Working,
    }
}

fn tail_of_recorded(s: RecordedTurnEnd) -> Tail {
    match s {
        RecordedTurnEnd::Ended => Tail::Ended,
        RecordedTurnEnd::Working => Tail::Working,
    }
}

/// 남은 자식 작업 수(기록은 수를 JSON 숫자로 둔다) → `u32`. 음수·NaN·무한은 모른다(`None`) — 유예 쪽으로 간다.
pub fn pending_count(n: f64) -> Option<u32> {
    if !n.is_finite() || n < 0.0 {
        return None;
    }
    // 소수는 올린다 — 남은 작업을 적게 세면 일찍 거둔다.
    let c = n.ceil();
    if c > f64::from(u32::MAX) {
        return Some(u32::MAX);
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(c as u32)
}

impl TurnStateRecords for TranscriptTurnStateRecords<'_> {
    fn turn_state(&mut self, since_ms: i64) -> Option<Tail> {
        read_transcript_turn_state(self.harness, self.session_id, self.dirs, Some(since_ms))
            .map(tail_of_transcript)
    }
    fn pending_background(&mut self, since_ms: i64) -> Option<u32> {
        read_transcript_pending_background(self.harness, self.session_id, self.dirs, Some(since_ms))
            .and_then(pending_count)
    }
    fn transcript_mtime_ms(&mut self) -> Option<i64> {
        session_transcript_mtime_ms(self.harness, self.session_id, self.dirs)
    }
    fn opencode_turn_state(&mut self, since_ms: i64) -> Option<Tail> {
        read_opencode_turn_state(self.opencode?, self.session_id, since_ms).map(tail_of_recorded)
    }
}

#[cfg(test)]
#[path = "turn_probe_state_tests.rs"]
mod tests;
