//! 정본 `mentionTurn.ts::runMentionTurn` 의 「턴의 끝」 상태와 판정(B4-2c) — `end` 객체·`reclaim`·`turnIsDone`·
//! `reconsiderEnd`·`probeStall` 의 판정 몫.
//!
//! TUI 는 답하고도 죽지 않으므로 러너가 끝을 정한다. 끝의 정의는 **"발화했고 아무도 안 본다"** 다.
//! 여기에는 판정만 있다 — 시계(회수 유예)를 세우고 끊는 일, SIGTERM·Enter 를 실제로 보내는 일, 기록 mtime 을
//! 읽는 일은 부르는 쪽(턴 루프)이 돌려받은 [`EndAction`]·[`StallVerdict`] 대로 한다.
//! 정본은 `await` 뒤에 끝 조건을 다시 보지만, 여기서는 읽은 값을 받아 한 번에 판정하므로 그 재확인이 같은 자리에 있다.

use crate::turn_notice::quoted_line;

/// 가린 뒤 남는 것이 없는 API 오류 줄 자리(정본 `'(오류 줄은 가려졌다)'`).
pub const MASKED_API_ERROR: &str = "(오류 줄은 가려졌다)";

/// 기록 꼬리(정본 `end.tail`). `None` 은 판정할 수 없다는 뜻이다(읽지 못하는 하네스·파일 없음).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tail {
    Ended,
    Working,
}

/// 끝 판정의 설정(정본 `deps.orphanMs`·`finishedReclaimMs`·`backgroundWaitMs`·`turnTimeoutMs`·`harnessStallMs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EndConfig {
    /// 끝났지만 자식 작업을 모를 때의 회수 유예. 정본 기본 60초.
    pub orphan_ms: u64,
    /// 끝났고 자식이 0으로 확인됐을 때의 유예. 정본 기본 0(곧바로 거둔다).
    pub finished_reclaim_ms: u64,
    /// 하위 에이전트 대기 상한. 정본은 없으면 `turnTimeoutMs`.
    pub background_wait_ms: u64,
    /// 기록도 화면도 그대로인 시간 상한. 0 이하면 정지 판정을 끈다. 정본 기본 10분.
    pub stall_ms: i64,
}

impl EndConfig {
    pub fn new(turn_timeout_ms: u64) -> Self {
        Self {
            orphan_ms: 60_000,
            finished_reclaim_ms: 0,
            background_wait_ms: turn_timeout_ms,
            stall_ms: 10 * 60_000,
        }
    }
}

/// 정본 `end` 객체 중 판정이 보는 몫. 통지 중복 표(deniedSeen 등)·관문 몫은 그것을 쓰는 조각이 따로 갖는다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EndState {
    /// PTY 손잡이가 있다(정본 `end.controls !== null`).
    pub has_controls: bool,
    pub exited: bool,
    pub spoke: bool,
    pub viewers: u32,
    pub silenced: bool,
    /// 러너가 이 턴을 죽였다 — 종료 코드(143)로는 회수·무발화·스스로 죽음을 못 가른다.
    pub reclaimed: bool,
    /// 하네스가 낸 API 오류 줄 원문(정본 `end.apiError`). **판정(한도·자격증명)용이고 글에 그대로 싣지 않는다** —
    /// 통지는 [`EndState::api_error_notice`] 를 거친다.
    pub api_error: Option<String>,
    /// 하네스가 자기 기록에 남긴 API 오류 — 이미 [`quoted_line`] 을 거친 값(정본 `end.recordedApiError`). 실패 글로만 쓴다.
    pub recorded_api_error: Option<String>,
    pub stalled: bool,
    pub stalled_idle_ms: i64,
    pub awaiting_human: bool,
    pub finished: bool,
    /// 기록이 말한 남은 하위 에이전트 수. `None` 은 모른다.
    pub pending: Option<u32>,
    pub background_since_ms: Option<i64>,
    /// 하위 에이전트 대기 상한이 차서 거뒀다 — 그때 남아 있던 수. 스레드에 끊겼다고 알린다.
    pub background_cut: Option<u32>,
    /// 하네스 기록이 마지막으로 자란 것을 본 시각(ms).
    pub last_life_ms: i64,
    /// 화면 바이트가 마지막으로 온 시각(ms). 0 은 아직 못 봤다.
    pub last_data_at_ms: i64,
    pub tail: Option<Tail>,
    /// 정지 직전 Enter 를 이미 한 번 쳤다 — 한 턴에 한 번만.
    pub unsent_nudged: bool,
    /// 회수 시계가 서 있다(정본 `end.cancelReclaim !== null`).
    pub reclaim_armed: bool,
    /// 지금 선 회수 시계의 유예(ms).
    pub reclaim_grace_ms: u64,
}

/// [`reconsider_end`] 가 부르는 쪽에 시키는 시계 일.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndAction {
    /// 아무것도 바꾸지 않는다(이미 더 짧거나 같은 유예가 서 있다·이미 죽었다).
    Keep,
    /// 서 있던 회수 시계를 끊는다(있으면).
    Disarm,
    /// 서 있던 시계를 끊고 `grace` ms 뒤 회수 시계를 새로 세운다. 시계가 울리면 [`EndState::on_reclaim_timer`].
    Arm { grace_ms: u64 },
    /// 서 있던 시계를 끊고 지금 거둔다 — `kill` 이 참이면 SIGTERM 을 보낸다([`EndState::reclaim`] 의 결과).
    ReclaimNow { kill: bool },
}

impl EndState {
    /// 정본 `reclaim()` — 죽일 것이 있으면 `reclaimed` 를 세우고 `true`(부르는 쪽이 SIGTERM).
    /// PTY 가 아직 없으면 할 일이 없다 — 그 창의 중단은 스폰 앞 가드가 받는다.
    pub fn reclaim(&mut self) -> bool {
        if self.exited || !self.has_controls {
            return false;
        }
        self.reclaimed = true;
        true
    }

    /// 정본 `turnIsDone` — 차례가 끝났거나, 말했는데 기록 꼬리를 판정할 수 없다.
    pub fn turn_is_done(&self) -> bool {
        self.finished || (self.spoke && self.tail.is_none())
    }

    /// 회수 시계가 울렸다(정본 `schedule(() => { end.cancelReclaim = null; reclaim(); })`). `true` 면 SIGTERM.
    pub fn on_reclaim_timer(&mut self) -> bool {
        self.reclaim_armed = false;
        self.reclaim()
    }

    /// 정본 `probeApiError` 의 기록 갈래 — 하네스가 자기 기록에 API 오류를 남겼다. 이미 끝났거나 말했으면 무시(`None`).
    /// 받으면 가린 한 줄로 적고 회수한다 — `Some(true)` 면 SIGTERM. 가린 뒤 남는 것이 없으면 자리표시 문구를 싣는다.
    pub fn on_recorded_api_error(
        &mut self,
        recorded: &str,
        pat: &str,
        secrets: &[String],
    ) -> Option<bool> {
        if self.exited || self.spoke {
            return None;
        }
        let line = quoted_line(Some(recorded), pat, secrets);
        self.recorded_api_error = Some(if line.is_empty() {
            MASKED_API_ERROR.to_owned()
        } else {
            line
        });
        Some(self.reclaim())
    }

    /// 정본 `probeApiError` 의 오류 줄 갈래 — 원문은 판정용으로만 쥐고 회수한다. `Some(true)` 면 SIGTERM.
    pub fn on_api_error(&mut self, text: &str) -> Option<bool> {
        if self.exited || self.spoke {
            return None;
        }
        self.api_error = Some(text.to_owned());
        Some(self.reclaim())
    }

    /// 실패 통지에 싣는 API 오류 한 줄 — 기록 갈래(이미 가림)가 먼저, 아니면 오류 줄 원문을 [`quoted_line`] 으로 가린다
    /// (security #1971 낮음: 정본은 `apiError` 원문을 그대로 실었다). 가린 뒤 남는 것이 없으면 자리표시 문구.
    pub fn api_error_notice(&self, pat: &str, secrets: &[String]) -> Option<String> {
        if let Some(r) = &self.recorded_api_error {
            return Some(r.clone());
        }
        let raw = self.api_error.as_deref()?;
        let line = quoted_line(Some(raw), pat, secrets);
        Some(if line.is_empty() {
            MASKED_API_ERROR.to_owned()
        } else {
            line
        })
    }

    fn disarm(&mut self) {
        self.reclaim_armed = false;
    }
}

/// 정본 `reconsiderEnd` — 발화·기록 꼬리·뷰어 어느 쪽이 바뀌어도 여기로 모인다.
pub fn reconsider_end(end: &mut EndState, now_ms: i64, cfg: &EndConfig) -> EndAction {
    if end.exited {
        return EndAction::Keep;
    }
    if !end.turn_is_done() || end.viewers > 0 {
        end.disarm();
        return EndAction::Disarm;
    }
    // 끝났는데 하위 에이전트가 남았으면 거두지 않고 기다린다 — 상한이 차면 거두고 그 수를 남긴다.
    if let (true, Some(pending)) = (end.finished, end.pending)
        && pending > 0
    {
        let since = *end.background_since_ms.get_or_insert(now_ms);
        if now_ms.saturating_sub(since) < cfg.background_wait_ms as i64 {
            end.disarm();
            return EndAction::Disarm;
        }
        end.background_cut = Some(pending);
        end.disarm();
        return EndAction::ReclaimNow {
            kill: end.reclaim(),
        };
    }
    let grace = if end.finished && end.pending == Some(0) {
        cfg.finished_reclaim_ms
    } else {
        cfg.orphan_ms
    };
    if end.reclaim_armed {
        // 다시 세우면 유예가 늘어난다 — 더 짧은 유예가 가능해졌을 때만 바꿔 세운다.
        if grace >= end.reclaim_grace_ms {
            return EndAction::Keep;
        }
        end.disarm();
    }
    end.reclaim_grace_ms = grace;
    if grace == 0 {
        return EndAction::ReclaimNow {
            kill: end.reclaim(),
        };
    }
    end.reclaim_armed = true;
    EndAction::Arm { grace_ms: grace }
}

/// [`probe_stall`] 의 판정.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StallVerdict {
    /// 아직 접지 않는다(살아 있음·판정 불가·관찰자 있음).
    Alive,
    /// 화면이 제출 대기다 — 접지 않고 Enter(`\r`) 를 한 번 친다. 한 턴에 한 번만 온다.
    PressEnter,
    /// 멈췄다 — `stalled` 를 세웠다. `kill` 이 참이면 SIGTERM.
    Stalled { idle_ms: i64, kill: bool },
}

/// [`probe_stall`] 에 넘기는 이번 주기의 관측.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StallProbe {
    /// 이 하네스는 세션 기록을 읽을 줄 안다(정본 `readsSessionTranscript`).
    pub reads_transcript: bool,
    /// 읽은 기록 mtime(ms). 못 읽었으면 `None` — 그것을 정지로 읽지 않는다.
    pub transcript_mtime_ms: Option<i64>,
    /// 화면 꼬리가 「입력줄에 붙여넣기가 남은 제출 대기」로 보인다(정본 `unsentHint && looksReadyForPrompt`).
    /// 하네스에 그 힌트가 없으면 `false`.
    pub looks_unsent: bool,
    pub now_ms: i64,
}

/// 정본 `probeStall` 의 판정 — **살아 있음의 증거는 둘이다(기록이 자라거나, 화면이 흐르거나)**, 둘 다 멈춰야 정지다.
/// 긴 셸 명령(CI 기다리기)은 기록을 멈추지만 화면은 계속 그린다(2026-09-16 실측: 하루 6건이 그렇게 접혔다).
pub fn probe_stall(end: &mut EndState, probe: StallProbe, cfg: &EndConfig) -> StallVerdict {
    if cfg.stall_ms <= 0 || end.awaiting_human || end.exited || end.spoke || end.finished {
        return StallVerdict::Alive;
    }
    if probe.reads_transcript
        && let Some(mtime) = probe.transcript_mtime_ms
        && mtime > end.last_life_ms
    {
        end.last_life_ms = mtime;
    }
    // 관찰자가 있으면 재지 않는다 — 사람이 그 터미널에서 직접 치고 있을 수 있다.
    if end.viewers > 0 {
        return StallVerdict::Alive;
    }
    // 기록을 못 읽는 하네스는 화면을 한 번이라도 봐야 잰다 — 턴 시작 시각은 생존 증거가 아니다.
    if !probe.reads_transcript && end.last_data_at_ms == 0 {
        return StallVerdict::Alive;
    }
    let life = end.last_life_ms.max(end.last_data_at_ms);
    if life == 0 {
        return StallVerdict::Alive;
    }
    let idle_ms = probe.now_ms - life;
    if idle_ms < cfg.stall_ms {
        return StallVerdict::Alive;
    }
    // 프롬프트가 입력줄에 칩으로 남은 채 10분이 지나면 Enter 한 번이면 풀린다(2026-10-07). 두 번째면 그대로 접는다.
    if probe.looks_unsent && !end.unsent_nudged && end.has_controls {
        end.unsent_nudged = true;
        end.last_life_ms = probe.now_ms;
        return StallVerdict::PressEnter;
    }
    end.stalled = true;
    end.stalled_idle_ms = idle_ms;
    StallVerdict::Stalled {
        idle_ms,
        kill: end.reclaim(),
    }
}

#[cfg(test)]
#[path = "turn_end_tests.rs"]
mod tests;
