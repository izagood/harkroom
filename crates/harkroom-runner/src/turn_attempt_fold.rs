//! `AttemptParts` 실물의 `outcome`·`after` 몸통 — 둘 다 `run_attempt` 가 넘기는 **그 시도의 [`TurnSecrets`]**(마운트 뒤에
//! 지은 목록)로만 가린다.
//!
//! - [`fold_outcome`]: 그 시도의 끝 상태(`EndState`, 턴 sink·감시가 채운 것)를 잠근 채 [`attempt_outcome`] 으로 접는다.
//! - [`run_after_turn`]: 턴 뒤 IO(`apply_after_turn`)를 [`McpAfterIo`] 로 돈다. 가림 목록이 든 것(`AfterFacts`·보고처
//!   약속 `ReportPromise`)은 **여기서** `secrets` 로 짓는다 — 턴 전에 지어 두면 마운트한 비밀이 목록에 없다(#2032 와 같은 꼴).

use std::sync::Mutex;

use crate::mcp::HarkroomMcpClient;
use crate::mention_run::TurnOk;
use crate::mention_scheduler::WakeReportTo;
use crate::rest::RunnerLink;
use crate::thread_model::TurnModel;
use crate::turn_after::{AfterFacts, McpAfterIo, SilentSaid, apply_after_turn};
use crate::turn_attempt::{Attempted, TurnSecrets};
use crate::turn_attempt_live::{LiveTurn, OffAnchorArgs, off_anchor_reader, report_promise_runner};
use crate::turn_end::EndState;
use crate::turn_failure::StallInputs;
use crate::turn_notice::NudgeCaller;
use crate::turn_outcome::{OutcomeFacts, attempt_outcome};
use crate::turn_policy::AttemptError;
use crate::turn_report::ReportPromise;
use crate::turn_run::PtyOut;
use crate::turn_success::AfterTurnPlan;

/// 결과 접기의 이 턴 고정값(가림 목록은 빼고 — 그것은 `secrets` 에서 온다).
pub struct OutcomeInputs<'a> {
    pub thread_unreadable: bool,
    pub turn_timeout_ms: u64,
    pub harness_stall_ms: u64,
    pub stall: StallInputs<'a>,
    /// 종료 뒤 하네스 기록에서 읽은 API 오류.
    pub recorded_after: Option<&'a str>,
    pub turn_model: Option<&'a TurnModel>,
    pub stop_requested_at: Option<String>,
}

/// `AttemptParts::outcome` 의 몸통.
#[allow(clippy::result_large_err)]
pub fn fold_outcome(
    attempted: Attempted<PtyOut>,
    secrets: &TurnSecrets,
    live: &LiveTurn,
    end: &Mutex<EndState>,
    i: OutcomeInputs<'_>,
) -> Result<TurnOk, AttemptError> {
    let end = end.lock().unwrap_or_else(|e| e.into_inner());
    attempt_outcome(
        attempted,
        &OutcomeFacts {
            end: &end,
            live,
            thread_unreadable: i.thread_unreadable,
            turn_timeout_ms: i.turn_timeout_ms,
            harness_stall_ms: i.harness_stall_ms,
            stall: i.stall,
            recorded_after: i.recorded_after,
            turn_model: i.turn_model,
            pat: secrets.pat(),
            secrets: secrets.needles(),
            stop_requested_at: i.stop_requested_at,
        },
    )
}

/// 보고처 약속(깨움 턴만) — 가림 목록을 뺀 몫.
pub struct PromiseInputs<'a> {
    pub report_to: &'a WakeReportTo,
    pub base_seq: i64,
    pub scheduled_turn_id: Option<&'a str>,
    pub reason: &'a str,
}

/// 턴 뒤 IO 의 이 턴 고정값(가림 목록은 빼고).
pub struct AfterInputs<'a> {
    pub key: &'a str,
    pub me_id: &'a str,
    pub channel_id: &'a str,
    pub anchor: Option<&'a str>,
    pub mention_id: &'a str,
    pub caller: NudgeCaller,
    pub proxy_head: &'a str,
    pub record_proxy: bool,
    pub wake_reason: &'a str,
    pub background_wait_ms: u64,
    pub turn_start_seq: i64,
    pub turn_id: &'a str,
    pub promise: Option<PromiseInputs<'a>>,
}

/// `AttemptParts::after` 의 몸통 — 가림 목록이 드는 것은 모두 이 자리에서 `secrets` 로 짓는다.
pub fn run_after_turn<'a, L: RunnerLink>(
    client: &'a HarkroomMcpClient<L>,
    plan: &AfterTurnPlan,
    secrets: &'a TurnSecrets,
    i: &'a AfterInputs<'a>,
    last_said: Box<dyn FnMut() -> Option<String> + 'a>,
    silent_said: Box<dyn FnMut() -> SilentSaid + 'a>,
) -> Result<(), String> {
    let facts = AfterFacts {
        key: i.key,
        channel_id: i.channel_id,
        anchor: i.anchor,
        mention_id: i.mention_id,
        caller: i.caller,
        proxy_head: i.proxy_head,
        record_proxy: i.record_proxy,
        wake_reason: i.wake_reason,
        background_wait_ms: i.background_wait_ms,
        pat: secrets.pat(),
        secrets: secrets.needles(),
    };
    let report_promise: Box<dyn FnMut() -> Result<(), String> + 'a> = match (&i.promise, i.anchor) {
        (Some(p), Some(anchor)) => report_promise_runner(
            client,
            ReportPromise {
                me_id: i.me_id,
                report_to: p.report_to,
                base_seq: p.base_seq,
                scheduled_turn_id: p.scheduled_turn_id,
                reason: p.reason,
                anchor,
                anchor_channel_id: i.channel_id,
                pat: secrets.pat(),
                secrets: secrets.needles(),
            },
        ),
        _ => Box::new(|| Ok(())),
    };
    let mut io = McpAfterIo {
        client,
        last_said,
        silent_said,
        off_anchor: off_anchor_reader(
            client,
            OffAnchorArgs {
                key: i.key,
                me_id: i.me_id,
                channel_id: i.channel_id,
                anchor: i.anchor,
                turn_start_seq: i.turn_start_seq,
                turn_id: i.turn_id,
            },
        ),
        report_promise,
    };
    apply_after_turn(plan, &facts, &mut io)
}

#[cfg(test)]
#[path = "turn_attempt_fold_tests.rs"]
mod tests;
