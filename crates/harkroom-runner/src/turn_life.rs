//! 정본 `mentionTurn.ts::runMentionTurn` 의 턴 수명 접착(B4-2f-4b-3a) — 등록·펜스·뒷정리(`settle`)의 **순서**.
//!
//! - 등록([`register_turn`]): 세션을 연 **뒤**에 이 스레드에 멘션 턴이 돈다고 적는다. 거절되면(같은 스레드에 이미
//!   턴이 있다) 연 세션을 정리하고 그 오류를 돌려준다 — 정리가 `try` 의 `finally` 에만 있으면 그 사이에서 던진
//!   경로가 「running」 유령 줄을 남긴다(10-07).
//! - 펜스([`watch_fence`]·[`on_fence_lost`]): 턴 임대를 잃으면 사람의 [중단] 과 같은 길(`reclaim`)로 접는다.
//! - 뒷정리([`settle_turn`]): **타이머를 먼저 끈다** — 남기면 끝난 턴의 타이머가 다음 턴의 PTY 를 죽인다. 그다음
//!   관문 원장을 놓고, **내 등록만** 풀고, 세션을 닫고, 💬 를 지운다(추가가 끝난 뒤에).
//!
//! 바깥 일은 [`LifeIo`] 뒤에 있다 — 실구현은 2f-4b-3b.

use crate::turn_end::EndState;
use crate::turn_gate::{GateState, settle_gate};

/// 정본 `registered`·`end.fencedOut` 와 펜스 구독 여부.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TurnLife {
    /// 이 턴이 레지스트리에 **스스로** 등록했다 — 남의 등록(인터랙티브)을 지우지 않으려고 센다.
    pub registered: bool,
    /// 펜스 잃음을 듣고 있다(정본 `addEventListener('abort', onFenceLost)`).
    pub fence_listening: bool,
    /// 턴 임대를 잃었다(정본 `end.fencedOut`). 표지는 스케줄러가 남긴다.
    pub fenced_out: bool,
    /// 뒷정리를 이미 했다 — 두 번째 부름은 아무것도 하지 않는다.
    pub settled: bool,
}

/// 수명 접착이 바깥에 시키는 일. 실패를 던지지 않는다(💬 지우기만 사유를 돌려 적는다).
pub trait LifeIo {
    /// 레지스트리에 이 스레드의 멘션 턴을 적는다(정본 `deps.registry?.register`). 거절이면 `Err(사유)`.
    fn registry_register(&mut self) -> Result<(), String>;
    /// 내 등록을 푼다(정본 `deps.registry?.release(key)`).
    fn registry_release(&mut self);
    /// 펜스 잃음을 듣기 시작한다.
    fn listen_fence(&mut self);
    /// 펜스 잃음 듣기를 내린다.
    fn unlisten_fence(&mut self);
    /// PTY 를 접는다(정본 `reclaim()`).
    fn reclaim(&mut self, end: &mut EndState);
    /// 탐침 주기를 내린다(정본 `end.cancelProbe`).
    fn cancel_probe(&mut self);
    /// 회수 시계를 내린다(정본 `end.cancelReclaim`).
    fn cancel_reclaim(&mut self);
    /// 무발화 시계를 내린다(정본 `end.cancelSilence`).
    fn cancel_silence(&mut self);
    /// 관문 감시 주기를 내린다(정본 `end.cancelGateWatch`).
    fn cancel_gate_watch(&mut self);
    /// 관문 원장의 그 계정을 놓는다(정본 `deps.attentionLedger?.release`).
    fn ledger_release(&mut self, account_label: &str);
    /// 공급자 환경을 돌려준다(정본 `deps.providerEnvDone`, 실패는 삼킨다).
    fn provider_env_done(&mut self);
    /// 릴레이 세션을 닫는다(정본 `session?.close()`) — 두 번 불러도 무해해야 한다.
    fn close_session(&mut self);
    /// 💬 추가가 끝나기를 기다린다(정본 `await workingInFlight`).
    fn await_working(&mut self);
    /// 💬 를 지운다. 실패면 `Err(사유)`.
    fn remove_working_reaction(&mut self) -> Result<(), String>;
    fn log(&mut self, line: &str);
}

/// 정본 `settle` — 턴이 어떻게 끝나든(정상·타임아웃·예외·등록 거절) 한 번 부른다.
pub fn settle_turn(
    life: &mut TurnLife,
    end: &mut EndState,
    gate: &mut GateState,
    io: &mut impl LifeIo,
) {
    if life.settled {
        return;
    }
    life.settled = true;
    // 끝 상태의 타이머를 먼저 끈다 — 남기면 끝난 턴의 타이머가 다음 턴의 PTY 를 죽인다.
    end.exited = true;
    if life.fence_listening {
        life.fence_listening = false;
        io.unlisten_fence();
    }
    io.cancel_probe();
    io.cancel_reclaim();
    end.reclaim_armed = false;
    io.cancel_silence();
    if gate.watch_armed {
        io.cancel_gate_watch();
    }
    // 원장은 턴과 같은 수명이다 — 놓지 않으면 그 계정의 다음 관문은 영영 사람을 부르지 못한다.
    if let Some(account) = settle_gate(gate) {
        io.ledger_release(&account);
    }
    // 등록이 던졌다면 그 자리는 먼저 온 인터랙티브 턴의 것이다 — 내 등록만 푼다.
    if life.registered {
        life.registered = false;
        io.registry_release();
    }
    io.provider_env_done();
    io.close_session();
    // 추가가 끝난 뒤에 지운다(순서가 뒤집히면 💬 가 남는다).
    io.await_working();
    if let Err(e) = io.remove_working_reaction() {
        io.log(&format!("리액션(진행 중) 제거 실패 — {e}"));
    }
}

/// 정본 등록 `try` — 세션을 연 **뒤** 부른다. 거절이면 뒷정리를 하고 그 사유를 돌려준다(턴은 여기서 끝).
pub fn register_turn(
    life: &mut TurnLife,
    end: &mut EndState,
    gate: &mut GateState,
    io: &mut impl LifeIo,
) -> Result<(), String> {
    match io.registry_register() {
        Ok(()) => {
            life.registered = true;
            Ok(())
        }
        Err(e) => {
            settle_turn(life, end, gate, io);
            Err(e)
        }
    }
}

/// 등록 뒤 펜스를 건다. 이미 잃었으면 듣지 않고 표지만 세운다(정본 `if (fence.aborted) end.fencedOut = true`).
pub fn watch_fence(life: &mut TurnLife, fence_aborted: bool, io: &mut impl LifeIo) {
    if fence_aborted {
        life.fenced_out = true;
    } else if !life.fence_listening {
        life.fence_listening = true;
        io.listen_fence();
    }
}

/// 정본 `onFenceLost` — 임대를 잃으면 사람의 [중단] 과 같은 길로 접는다. 끝난 턴이면 아무것도 하지 않는다.
pub fn on_fence_lost(life: &mut TurnLife, end: &mut EndState, io: &mut impl LifeIo) {
    if life.settled {
        return;
    }
    life.fenced_out = true;
    io.reclaim(end);
}

#[cfg(test)]
#[path = "turn_life_tests.rs"]
mod tests;
