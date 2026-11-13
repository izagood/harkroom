//! 턴 뒤 재료 실물(C2) — [`after_source`] 가 [`AfterSource`] 를 돌려준다. 정본 `runMentionTurn` 정상 종료 갈래의 재료다:
//! 턴 뒤에 다시 읽은 앵커 스레드(시작 seq 뒤)로 [`after_turn_plan`] 을 고르고, 통지 입력([`AfterInputs`])과 마지막 말 읽개를 짓는다.
//!
//! **시도마다 바뀌는 값은 인자로만 온다**(mem/runner/per-attempt-state): 턴 id·시작 seq·세션 id·시작 시각·계정 폴더는
//! [`AfterCtx`](그 시도의 `LoopCtx`), 거둔 하위 에이전트 수는 그 시도의 끝 상태. 설정([`AfterConfig`])은 멘션 단위 값만 쥔다.
//! 손님은 없다 — 스레드 다시 읽기와 통지는 호출 자리가 묶음 손님으로 한다.
//!
//! 보고처 약속(`promise`)은 설정에 실려 온다 — 그 멘션의 깨움 줄에서만 짓는다(`mention_inputs::report_promise`).

use std::path::PathBuf;

use serde_json::Value;

use crate::adapter::AgentHarness;
use crate::harness_errors::{TranscriptDirs, read_last_assistant_text};
use crate::mention_call::{AfterData, AfterSource, OwnedAfterInputs};
use crate::mention_parts::AfterCtx;
use crate::turn_notice::NudgeCaller;
use crate::turn_success::{SuccessTarget, after_turn_plan};

/// 멘션 단위 재료(시도마다 바뀌지 않는 것).
pub struct AfterConfig {
    pub key: String,
    pub me_id: String,
    pub channel_id: String,
    pub anchor: Option<String>,
    pub mention_id: String,
    pub caller: NudgeCaller,
    pub proxy_head: String,
    pub record_proxy: bool,
    pub wake_reason: String,
    pub background_wait_ms: u64,
    pub target: SuccessTarget,
    pub harness: AgentHarness,
    /// 기본 로그인일 때 기록을 찾을 홈(계정 폴더는 시도 문맥에서 온다).
    pub home: Option<PathBuf>,
    /// 보고처 약속 — 그 멘션의 깨움에서만(`mention_inputs::report_promise`).
    pub promise: Option<crate::mention_call::OwnedPromise>,
}

fn last_said(c: &AfterConfig, a: &AfterCtx) -> Option<String> {
    read_last_assistant_text(
        c.harness,
        a.ctx.session_id.as_deref(),
        TranscriptDirs {
            config_dir: a.ctx.claude_config_dir.as_deref(),
            home: c.home.as_deref(),
        },
        Some(a.ctx.turn_started_at_ms),
    )
}

/// 턴 뒤 재료 실물 — 설정은 빌려 쥐고, 돌려주는 재료는 소유본이다.
pub fn after_source<'a>(c: &'a AfterConfig) -> AfterSource<'a> {
    Box::new(move |a: &AfterCtx, rows: &[Value]| AfterData {
        plan: after_turn_plan(
            rows,
            &c.me_id,
            a.ctx.turn_start_seq,
            Some(&a.ctx.turn_id),
            a.background_cut,
            c.target,
        ),
        inputs: OwnedAfterInputs {
            key: c.key.clone(),
            me_id: c.me_id.clone(),
            channel_id: c.channel_id.clone(),
            anchor: c.anchor.clone(),
            mention_id: c.mention_id.clone(),
            caller: c.caller,
            proxy_head: c.proxy_head.clone(),
            record_proxy: c.record_proxy,
            wake_reason: c.wake_reason.clone(),
            background_wait_ms: c.background_wait_ms,
            turn_start_seq: a.ctx.turn_start_seq,
            turn_id: a.ctx.turn_id.clone(),
            promise: c.promise.clone(),
        },
        // 마지막 말은 시도 문맥(세션·계정 폴더·시작 시각)으로 읽는다.
        last_said: last_said(c, a),
    })
}

#[cfg(test)]
#[path = "turn_after_source_tests.rs"]
mod tests;
