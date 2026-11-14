//! 시도마다 심는 두 표식 파일(T4c) — 정본 `mentionTurn.ts` 의 `mcpReadyFile`·`gateFile`.
//!
//! - **MCP 준비 표식**(`HARKROOM_MCP_READY_FILE`): 브릿지가 첫 `tools/list` 답을 쓴 뒤 만든다. 러너는 프롬프트를 넣기 전에 그 파일을
//!   [`MCP_READY_MAX_MS`] 까지 기다리고, 넘기면 그냥 넣는다(턴을 막지 않는다). 이어 받은 턴의 프롬프트 캐시가 깨지지 않게 하는 장치다.
//! - **「확인을 기다려 멈춤」 신호**(`HARKROOM_GATE_FILE`): 물음 hook 이 한 줄씩 덧붙인다. 심은 턴은 턴 도중 관문을 화면 정규식이
//!   아니라 이 파일의 줄 수 증가로 잰다(`InjectPrompt::gate_signal`).
//!
//! 자리는 러너 상태 폴더 아래 0700 폴더([`turn_marker_file`]). 폴더를 못 만들면 그 표식 없이 돈다(정본과 같음 — 기다리지 않고, 관문은
//! 화면으로 잰다). 파일은 러너가 만들지 않는다 — 브릿지·hook 이 만든다. 시도가 끝나면(정상·패닉 풀림 모두) [`TurnMarkers`] 가
//! 떨어지며 지운다.
//!
//! 정본과 다른 점: 정지 화면 판정의 신호(`stallScreenOf(.., gateSignalOf(gateFile))`)를 정본은 파일을 **지운 뒤에** 읽어 늘
//! 0 이 된다. 여기서는 PTY 턴이 끝난 직후, 지우기 **전에** 읽어 둔다([`TurnMarkers::gate_snapshot`]).

use std::path::{Path, PathBuf};

use crate::adapter::{AgentHarness, MentionPermission};
use crate::mention_turn_parts::{GateSignal, gate_signal_of};
use crate::pty::AttentionKind;
use crate::pty_turn::{InjectPrompt, PromptHooks, PtyControls, PtyTurnSink, WaitFor};
use crate::turn_env_plan::{TurnMarker, turn_marker_file};

/// 브릿지의 `tools/list` 표식을 기다리는 상한(ms, 스폰 기준) — 정본 `MCP_READY_MAX_MS`.
pub const MCP_READY_MAX_MS: u64 = 8_000;
/// 표식을 다시 보는 간격(정본 `waitFor.pollMs ?? 100`).
pub const MCP_READY_POLL_MS: u64 = 100;

/// 이 시도의 표식 파일 자리. 떨어질 때 둘 다 지운다.
#[derive(Debug, Default)]
pub struct TurnMarkers {
    pub mcp_ready: Option<PathBuf>,
    pub gate: Option<PathBuf>,
}

impl TurnMarkers {
    /// 이 시도에 심을 표식을 정하고 자리를 잡는다(정본 `usesTui && waitsForMcpBeforePrompt` · `usesTui && attachesGateHook`).
    pub fn plan(
        state_dir: &Path,
        key: &str,
        harness: AgentHarness,
        uses_tui: bool,
        permission: MentionPermission,
        provider_lane: bool,
        new_id: &mut dyn FnMut() -> String,
    ) -> Self {
        let mut at = |m: TurnMarker| {
            m.wanted(harness, uses_tui, permission, provider_lane)
                .then(|| turn_marker_file(state_dir, m, key, new_id))
                .flatten()
        };
        Self {
            mcp_ready: at(TurnMarker::McpReady),
            gate: at(TurnMarker::GateSignal),
        }
    }

    /// 주입 옵션에 「기다릴 것」·「신호로 잰다」를 싣는다. 주입이 없는(TUI 아닌) 턴은 그대로.
    pub fn apply(&self, inject: Option<&mut InjectPrompt>) {
        let Some(i) = inject else { return };
        if self.mcp_ready.is_some() {
            i.wait_for = Some(WaitFor {
                max_ms: MCP_READY_MAX_MS,
                poll_ms: MCP_READY_POLL_MS,
            });
        }
        if self.gate.is_some() {
            i.gate_signal = true;
        }
    }

    /// 신호 파일의 지금 값 — 신호를 심지 않은 턴은 `None`(정본 `gateFile === null ? null : ..`).
    pub fn gate_snapshot(&self) -> Option<GateSignal> {
        self.gate.as_deref().map(gate_signal_of)
    }
}

impl Drop for TurnMarkers {
    /// 정본 `finally` 의 `rm(mcpReadyFile)`·`rm(gateFile)` — 없으면 조용히 넘긴다.
    fn drop(&mut self) {
        for p in [self.mcp_ready.take(), self.gate.take()]
            .into_iter()
            .flatten()
        {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// 표식을 답하는 sink 덧씌우개 — `wait_for_ready`·`wait_for_settled`·`gate_signal` 만 여기서 답하고 나머지는 안쪽으로 넘긴다.
pub struct MarkerSink<'s, S: PtyTurnSink> {
    pub inner: &'s mut S,
    pub markers: &'s TurnMarkers,
    /// 로그 머리(스레드 키). 경로는 로그에 싣지 않는다.
    pub key: &'s str,
    /// 주입이 먹혔는지의 증거(정본 `confirmDelivery.probe` = 턴 시작 뒤 세션 기록에 사람 입력 줄이 생겼나). 없으면 안쪽으로.
    pub confirm: Option<&'s dyn Fn() -> bool>,
}

impl<S: PtyTurnSink> PromptHooks for MarkerSink<'_, S> {
    fn wait_for_ready(&mut self) -> bool {
        match &self.markers.mcp_ready {
            // 못 읽으면 아직 안 선 것으로 본다(정본 `try { ready = waitFor.ready() } catch {}`).
            Some(p) => p.try_exists().unwrap_or(false),
            None => self.inner.wait_for_ready(),
        }
    }
    fn wait_for_settled(&mut self, ready: bool, waited_ms: u64) {
        if self.markers.mcp_ready.is_some() {
            if ready {
                eprintln!(
                    "[mentionTurn] {}: MCP 준비 신호를 보고 넣는다(스폰 뒤 {waited_ms}ms)",
                    self.key
                );
            } else {
                eprintln!(
                    "[mentionTurn] {}: MCP 준비 신호 없이 시한({MCP_READY_MAX_MS}ms)을 넘겨 그냥 넣는다",
                    self.key
                );
            }
        }
        self.inner.wait_for_settled(ready, waited_ms)
    }
    fn gate_signal(&mut self) -> u64 {
        match &self.markers.gate {
            Some(p) => gate_signal_of(p).count as u64,
            None => self.inner.gate_signal(),
        }
    }
    fn confirm_probe(&mut self) -> bool {
        match self.confirm {
            Some(f) => f(),
            None => self.inner.confirm_probe(),
        }
    }
}

impl<S: PtyTurnSink> PtyTurnSink for MarkerSink<'_, S> {
    fn on_spawn(&mut self, controls: PtyControls) {
        self.inner.on_spawn(controls)
    }
    fn on_output(&mut self, frame: &[u8]) {
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

#[cfg(test)]
#[path = "turn_markers_tests.rs"]
mod tests;
