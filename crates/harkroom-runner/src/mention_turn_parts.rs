//! 멘션 턴 본체(`mentionTurn.ts::runMentionTurn`)가 쓰는 작은 판정들(B4-2). 본체 조립은 다음 조각.
//!
//! 정본: `humanCancelOf`·`gateFailExtras`·`gateSignalOf`·`stallScreenOf`·`silentTurnCaller`·`wroteByTurn`.

use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::adapter::{AgentHarness, screen_gate_for};
use crate::mention_target::MentionTarget;
use crate::pty::AttentionKind;
use crate::turn_notice::GateRanks;

/// 정본 `humanCancelOf` — `operator`(고아 회수·물러나기)는 사람이 멈춘 일이 아니라 넘기지 않는다.
pub fn human_cancel_of(canceled_by: Option<&str>) -> Option<&str> {
    canceled_by.filter(|c| !c.is_empty() && *c != "operator")
}

/// 정본 `gateFailExtras` 의 결과 — 관문 실패 통지에 붙는 기계용 칸.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GateFailExtras {
    pub code: Option<&'static str>,
    pub mention_id: Option<String>,
    /// 풀·계정 **순번만**(칩 ② — 계정·풀 폴더 이름은 사람 이름일 수 있다, #1039).
    pub claude_pool_rank: Option<u32>,
    pub claude_account_rank: Option<u32>,
}

/// 턴 **시작** 관문에만 붙인다. 턴 도중 권한 확인은 명령 하나에 대한 물음이라 계정 관문이 아니다.
pub fn gate_fail_extras(kind: AttentionKind, mention_id: &str, ranks: GateRanks) -> GateFailExtras {
    if kind != AttentionKind::Startup {
        return GateFailExtras::default();
    }
    GateFailExtras {
        code: Some("account_gate"),
        mention_id: Some(mention_id.to_string()),
        claude_pool_rank: ranks.account.rank().and(ranks.pool),
        claude_account_rank: ranks.account.rank(),
    }
}

/// 정본 `gateSignalOf` — 신호 파일의 줄 수와 마지막 신호 시각(ms). 없거나 못 읽으면 0·`None`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GateSignal {
    pub count: usize,
    pub last_at_ms: Option<u64>,
}

/// JS `Number.isSafeInteger(n) && n > 0` 와 같은 상한.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

pub fn gate_signal_of(file: &Path) -> GateSignal {
    let Ok(text) = std::fs::read_to_string(file) else {
        return GateSignal::default();
    };
    let stamps: Vec<u64> = text
        .split('\n')
        .filter_map(|l| l.trim().parse::<u64>().ok())
        .filter(|n| *n > 0 && *n <= MAX_SAFE_INTEGER)
        .collect();
    GateSignal {
        count: stamps.len(),
        last_at_ms: stamps.last().copied(),
    }
}

/// 정지 갈래(정본 `StallScreen`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StallScreen {
    Gate,
    Idle,
    Stuck,
}

impl StallScreen {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gate => "gate",
            Self::Idle => "idle",
            Self::Stuck => "stuck",
        }
    }
}

/// 신호와 마지막 진행 시각(정본 `signal` 인자).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StallSignal {
    pub last_at_ms: Option<u64>,
    pub last_progress_at_ms: Option<u64>,
}

static CSI_LOOSE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").expect("csi"));

/// 정본 `stallScreenOf`. `watch_now` 는 화면 감시의 지금 갈래(`gate`·`idle`·그 밖) — 감시가 없으면 `None`.
/// 신호가 있는 턴은 **신호로만** gate 를 말한다(화면 정규식의 관문은 오탐으로 보고 stuck).
pub fn stall_screen_of(
    watch_now: Option<&str>,
    raw_tail: &str,
    harness: AgentHarness,
    signal: Option<StallSignal>,
) -> StallScreen {
    if let Some(s) = signal {
        if let Some(at) = s.last_at_ms
            && s.last_progress_at_ms.is_none_or(|p| at >= p)
        {
            return StallScreen::Gate;
        }
        return if watch_now == Some("idle") {
            StallScreen::Idle
        } else {
            StallScreen::Stuck
        };
    }
    if let Some(now) = watch_now {
        return match now {
            "gate" => StallScreen::Gate,
            "idle" => StallScreen::Idle,
            _ => StallScreen::Stuck,
        };
    }
    let flat = CSI_LOOSE.replace_all(raw_tail, " ");
    if screen_gate_for(harness).is_match(&flat) {
        StallScreen::Gate
    } else {
        StallScreen::Stuck
    }
}

/// 정본 `wroteByTurn` — 턴 id 가 없는 옛 글은 아니라고 본다.
pub fn wrote_by_turn(m: &Value, turn_id: Option<&str>) -> bool {
    match turn_id {
        Some(t) => m.pointer("/meta/turnId").and_then(Value::as_str) == Some(t),
        None => false,
    }
}

/// 침묵 통지를 받을 쪽(정본 `silentTurnCaller`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SilentCaller {
    Agent,
    Human,
    Delegated,
    Wake,
    DelegationOutcome,
}

/// 멘션 행을 못 찾거나 계정 종류를 모르면 사람(통지가 보이는 쪽으로 틀린다).
pub fn silent_turn_caller(
    agent_ids: Option<&HashSet<String>>,
    target: &MentionTarget,
    thread: &[Value],
) -> SilentCaller {
    if target.wake.is_some() && target.scheduled_wake() {
        return SilentCaller::Wake;
    }
    if target.delegation.is_some()
        || target.delegation_followup.is_some()
        || target.delegation_update.is_some()
    {
        return SilentCaller::DelegationOutcome;
    }
    if target.wake.is_some() {
        return SilentCaller::Human;
    }
    if target.delegated_by.is_some() {
        return SilentCaller::Delegated;
    }
    let Some(ids) = agent_ids else {
        return SilentCaller::Human;
    };
    let author = thread
        .iter()
        .find(|m| m.get("id").and_then(Value::as_str) == Some(target.mention_id.as_str()))
        .and_then(|m| m.get("authorId").and_then(Value::as_str));
    match author {
        Some(a) if ids.contains(a) => SilentCaller::Agent,
        _ => SilentCaller::Human,
    }
}

#[cfg(test)]
#[path = "mention_turn_parts_tests.rs"]
mod tests;
