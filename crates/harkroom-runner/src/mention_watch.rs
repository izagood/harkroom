//! 멘션 하나의 감시 루프 — `run_mention` 의 `make_turn` 안에서 **그 멘션의 슬롯**(#2042 `MentionSlots::open` 이 연 것)으로
//! [`ProbeLoopConfig`] 를 **한 번** 지어 [`watch_loop_fn`] 에 넘긴다(security ③ 조건 ①).
//!
//! - 슬롯은 인자로만 받는다 — 러너 전역 슬롯이나 다른 멘션의 슬롯을 쥘 길이 없다. 펜스·[중단] 은 그 멘션 슬롯에 지금 걸린
//!   시도만 본다.
//! - MCP 손님(`client`)은 **이 에이전트 자기 자격**의 것 하나다 — 탐침 sink·스레드 읽기·앵커 밖 확인이 모두 이것을 쓴다
//!   (조건 ②). 준비(`McpPrepareIo`)와 멘션 deps(`LinkIo.mcp`)도 같은 손님을 넘긴다.
//! - 시도마다 바뀌는 값(세션·턴 id·시작 시각·계정 폴더·끝 신호)은 여기 없다 — `MentionParts::spawn` 이 `LoopCtx` 로 넘긴다.

use std::path::PathBuf;
use std::time::Duration;

use crate::adapter::AgentHarness;
use crate::mcp::HarkroomMcpClient;
use crate::mention_parts::WatchLoopFn;
use crate::rest::RunnerLink;
use crate::turn_attempt_account::LiveSlot;
use crate::turn_end::EndConfig;
use crate::turn_notice::NudgeCaller;
use crate::turn_probe_make::{ProbeLoopConfig, probe_make};
use crate::turn_watch_loop::watch_loop_fn;

/// 정본 `probeMs` 기본(3초).
pub const PROBE_MS: Duration = Duration::from_millis(3_000);

/// 멘션 단위 감시 재료(슬롯 빼고).
pub struct MentionWatchInputs<'a, L: RunnerLink> {
    /// 이 에이전트 자기 MCP 자격의 손님.
    pub client: &'a HarkroomMcpClient<L>,
    pub key: String,
    pub me_id: String,
    pub channel_id: String,
    pub anchor: Option<String>,
    pub harness: AgentHarness,
    pub home: Option<PathBuf>,
    pub omp_home: Option<PathBuf>,
    pub end_cfg: EndConfig,
    pub lane_tui: bool,
    pub caller: NudgeCaller,
    pub report_auth: &'a (dyn Fn(&[String], i64) + Send + Sync),
    pub clock: fn() -> i64,
    pub probe_ms: Duration,
}

/// 그 멘션 슬롯으로 감시 루프를 짓는다 — `run_mention` 한 번에 한 번(`make_turn` 안, `held.slot()` 으로).
pub fn mention_watch_loop<'a, L: RunnerLink + 'a>(
    i: MentionWatchInputs<'a, L>,
    slot: LiveSlot,
) -> WatchLoopFn<'a> {
    let (end_cfg, probe_ms) = (i.end_cfg, i.probe_ms);
    let cfg = ProbeLoopConfig {
        client: i.client,
        key: i.key,
        me_id: i.me_id,
        channel_id: i.channel_id,
        anchor: i.anchor,
        harness: i.harness,
        home: i.home,
        omp_home: i.omp_home,
        end_cfg,
        lane_tui: i.lane_tui,
        caller: i.caller,
        report_auth: i.report_auth,
        slot,
        clock: i.clock,
    };
    watch_loop_fn(probe_make(cfg), end_cfg, probe_ms)
}

#[cfg(test)]
#[path = "mention_watch_tests.rs"]
mod tests;
