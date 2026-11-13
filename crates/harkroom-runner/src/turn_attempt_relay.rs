//! 시도 하나와 멘션 중계 세션(#2046, 멘션 하나에 하나)을 잇는 몫 — `AttemptParts::spawn` 이 쓴다.
//!
//! - [`RelayAttempt`]: 시도 하나가 세션을 쥐는 동안의 가드. 시작에 이 시도의 계정 칩(순번만)을 고쳐 알리고, **어느 길로
//!   끝나든**(패닉 포함) 떨어질 때 그 시도의 PTY 입력 통로를 놓는다(`unbind_input`) — 앞 시도 PTY 손잡이가 세션에
//!   남아 다음 시도 사이에 온 입력이 그리로 가지 않게. `LiveBinding`(#2037)과 같은 꼴이다.
//! - [`RelaySink`]: 턴 sink 덧씌우개. 띄우는 순간 그 PTY 를 세션 입력 통로에 잇고(`bind_input`), 출력은 세션으로도
//!   흘린다(`push`). 나머지 갈래는 안쪽 sink 에 그대로 넘긴다.

use std::sync::Arc;

use crate::pty::AttentionKind;
use crate::pty_turn::{PromptHooks, PtyControls, PtyTurnSink};
use crate::relay_session::SessionHandle;

/// 시도 하나가 멘션 세션을 쥐는 동안 — 떨어지면 입력 통로를 놓는다.
pub struct RelayAttempt<'s> {
    session: &'s SessionHandle,
}

impl<'s> RelayAttempt<'s> {
    /// 이 시도의 계정 칩을 고쳐 알린다(`account_rank`: `None` 모른다·`Some(None)` 기본 로그인).
    pub fn begin(
        session: &'s SessionHandle,
        account_rank: Option<Option<u32>>,
        pool_rank: Option<u32>,
    ) -> Self {
        session.restate_account(account_rank, pool_rank);
        Self { session }
    }

    pub fn session(&self) -> &SessionHandle {
        self.session
    }
}

impl Drop for RelayAttempt<'_> {
    fn drop(&mut self) {
        // `unbind_input` 은 세션 맵 잠금 하나만 잡는다. 독 든 잠금이면 패닉하지 않고 건너뛴다.
        let _ =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.session.unbind_input()));
    }
}

/// 턴 sink 덧씌우개 — PTY 를 세션에 잇고 출력을 흘린다.
pub struct RelaySink<'a, S: PtyTurnSink> {
    pub inner: &'a mut S,
    pub relay: &'a RelayAttempt<'a>,
}

impl<S: PtyTurnSink> PromptHooks for RelaySink<'_, S> {
    fn wait_for_ready(&mut self) -> bool {
        self.inner.wait_for_ready()
    }
    fn wait_for_settled(&mut self, ready: bool, waited_ms: u64) {
        self.inner.wait_for_settled(ready, waited_ms)
    }
    fn gate_signal(&mut self) -> u64 {
        self.inner.gate_signal()
    }
    fn confirm_probe(&mut self) -> bool {
        self.inner.confirm_probe()
    }
}

impl<S: PtyTurnSink> PtyTurnSink for RelaySink<'_, S> {
    fn on_spawn(&mut self, controls: PtyControls) {
        self.relay.session.bind_input(Arc::new(controls.clone()));
        self.inner.on_spawn(controls)
    }
    fn on_output(&mut self, frame: &[u8]) {
        self.relay.session.push(frame);
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
#[path = "turn_attempt_relay_tests.rs"]
mod tests;
