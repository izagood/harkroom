//! 정본 `mentionTurn.ts::runMentionTurn` 의 `callHuman`(사람 부르기)과 `attentionLedger.ts`(B4-2f-4b-2).
//!
//! 옮기는 것은 **순서와 갈림**이다:
//! 1. 이 턴은 이제 사람을 기다린다(`awaiting_human`) — 정지 시계를 재지 않는다.
//! 2. 턴 시작 관문이면 계정 표식을 세운다(다음 배정부터 맨 뒤).
//! 3. **스레드에 남기는 것은 원장보다 앞이다** — 관문 통지는 턴마다 한 번, 원장과 무관하게 남긴다.
//!    통지 본문은 [`gate_fail`] 이 만든다: 화면을 싣지 않고 풀·계정 **순번만** 싣는다(칩 ②).
//! 4. **원장은 `Startup` 만 묶는다** — 같은 계정에서 이미 다른 턴이 사람을 기다리면 이 PTY 는 접고
//!    (`Queued`) 표식이 지워진 뒤 다시 띄운다. 잡았으면 관문 감시 주기를 건다.
//! 5. 화면은 앱으로만 간다([`GateIo::needs_attention`]).
//!
//! 바깥 일(통지 발화·PTY 접기·주기 타이머·앱 신호)은 [`GateIo`] 뒤에 있다 — 실구현은 2f-4b-3.

use std::collections::HashMap;

use crate::pty::AttentionKind;
use crate::turn_end::EndState;
use crate::turn_notice::{GateFail, GateRanks, gate_fail};

/// 정본 `createAttentionLedger` — 어느 계정으로 이미 사람을 불렀는지(러너 프로세스 안에서만 산다).
///
/// 디스크에 남기지 않는다 — 남기면 "예전에 불렀다"가 "사람이 승인했다"로 잘못 굳는다.
/// 여러 턴이 함께 쓰므로 부르는 쪽이 잠금 뒤에 둔다.
///
/// `Debug` 는 손으로 짠다 — 계정 표지는 폴더 이름(사람 이름일 수 있다)이라 개수만 찍는다.
#[derive(Default)]
pub struct AttentionLedger {
    /// 계정 표지 → 기다리는 세션(운영 로그용; 판정은 계정만으로 한다).
    held: HashMap<String, String>,
}

impl AttentionLedger {
    /// 이 계정으로 **처음** 부르는가. `true` 면 부른다.
    pub fn claim(&mut self, account_label: &str, session_id: &str) -> bool {
        if self.held.contains_key(account_label) {
            return false;
        }
        self.held
            .insert(account_label.to_owned(), session_id.to_owned());
        true
    }

    /// 그 계정의 부름을 놓는다(세션 종료).
    pub fn release(&mut self, account_label: &str) {
        self.held.remove(account_label);
    }

    /// 그 계정을 기다리는 세션(운영 로그용).
    pub fn holder(&self, account_label: &str) -> Option<&str> {
        self.held.get(account_label).map(String::as_str)
    }
}

/// 정본 `end.gateRequeue` — 관문 때문에 PTY 를 접고 같은 멘션을 다시 띄우는 까닭.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateRequeueKind {
    /// 같은 계정의 관문에서 이미 다른 턴이 사람을 기다린다.
    Queued,
    /// 계정 관문 표식이 지워졌다(사람이 다른 터미널에서 지났다).
    Passed,
}

/// 정본 `end` 중 관문 몫(`gateNoticed`·`gateHeld`·`gateRequeue`·`cancelGateWatch`).
/// `Debug` 는 손으로 짠다 — `held` 는 계정 표지라 찍지 않는다.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct GateState {
    /// 관문 통지를 이미 남겼다 — 턴마다 한 번.
    pub noticed: bool,
    /// 이 턴이 원장에서 잡은 계정 표지. 턴 끝에 놓는다.
    pub held: Option<String>,
    pub requeue: Option<GateRequeueKind>,
    /// 관문 감시 주기를 걸었다(정본 `cancelGateWatch !== null`).
    pub watch_armed: bool,
}

/// 부르는 턴의 고정값. `Debug` 는 손으로 짠다 — 계정 표지를 찍지 않는다.
#[derive(Clone, PartialEq, Eq)]
pub struct CallHumanCtx {
    /// 원장 열쇠 — 기기 안에서만 쓴다(정본 `deps.accountLabel ?? '(기본)'`). **스레드에 싣지 않는다.**
    pub account_label: String,
    /// 스레드에 남는 글에 싣는 순번.
    pub ranks: GateRanks,
    pub mention_id: String,
    /// 원장에 적을 세션(정본 `sessionIdForProbe ?? key`).
    pub session_key: String,
}

impl std::fmt::Debug for AttentionLedger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AttentionLedger")
            .field("held", &self.held.len())
            .finish()
    }
}

impl std::fmt::Debug for GateState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GateState")
            .field("noticed", &self.noticed)
            .field("held", &self.held.as_ref().map(|_| "<가림>"))
            .field("requeue", &self.requeue)
            .field("watch_armed", &self.watch_armed)
            .finish()
    }
}

impl std::fmt::Debug for CallHumanCtx {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CallHumanCtx")
            .field("account_label", &"<가림>")
            .field("ranks", &self.ranks)
            .field("mention_id", &self.mention_id)
            .field("session_key", &self.session_key)
            .finish()
    }
}

/// 사람 부르기가 바깥에 시키는 일. 실패를 던지지 않는다 — 말하지 못한 것으로 턴을 죽이지 않는다.
pub trait GateIo {
    /// 턴 시작 관문 — 그 계정에 표식을 세운다(정본 `deps.markAccountGate?.()`).
    fn mark_account_gate(&mut self);
    /// 관문 통지를 스레드에 남긴다(정본 `harkroom.fail(...)`, 실패는 삼키고 적기만).
    fn post_gate_fail(&mut self, fail: GateFail);
    /// 원장에서 계정을 잡는다. 원장이 없으면(풀의 마지막 계정이 아니면) `None`.
    fn ledger_claim(&mut self, account_label: &str, session_key: &str) -> Option<bool>;
    /// PTY 를 접는다(정본 `reclaim()` — [`EndState::reclaim`] 이 참일 때만 SIGTERM).
    fn reclaim(&mut self, end: &mut EndState);
    /// 계정 관문 표식을 물을 수 있는가(정본 `deps.accountGateCleared` 가 있는가).
    fn can_watch_gate(&self) -> bool;
    /// 관문 감시 주기를 건다 — 주기마다 표식을 물어 [`gate_watch_tick`] 을 부른다.
    fn arm_gate_watch(&mut self);
    /// 앱에 이 세션의 터미널을 열라고 알린다 — **화면은 여기로만** 간다. 계정은 풀·계정 **순번**으로만 싣는다
    /// (칩 ③ — 계정 이름은 서버로 보내지 않는다, #1039). 실구현은 `relay_session::SessionHandle::needs_attention`.
    fn needs_attention(&mut self, screen: &str, ranks: GateRanks);
    /// 정본 `console.error` 몫.
    fn log(&mut self, line: &str);
}

/// 정본 `callHuman` — 사람 손을 부른다. 이 턴은 여기서 끝나지 않는다(PTY 는 살아 있다).
pub fn call_human(
    end: &mut EndState,
    gate: &mut GateState,
    ctx: &CallHumanCtx,
    screen: &str,
    kind: AttentionKind,
    io: &mut impl GateIo,
) {
    end.awaiting_human = true;
    let startup = kind == AttentionKind::Startup;
    if startup {
        io.mark_account_gate();
    }
    if !gate.noticed {
        gate.noticed = true;
        io.post_gate_fail(gate_fail(ctx.ranks, startup, &ctx.mention_id));
    }
    if startup && gate.held.is_none() {
        match io.ledger_claim(&ctx.account_label, &ctx.session_key) {
            None => {}
            Some(false) => {
                // 기다리는 PTY 는 계정당 하나다 — 접고, 표식이 지워지면 같은 멘션을 다시 띄운다.
                gate.requeue = Some(GateRequeueKind::Queued);
                io.reclaim(end);
                return;
            }
            Some(true) => {
                gate.held = Some(ctx.account_label.clone());
                if io.can_watch_gate() && !gate.watch_armed {
                    gate.watch_armed = true;
                    io.arm_gate_watch();
                }
            }
        }
    }
    io.needs_attention(screen, ctx.ranks);
    io.log(&format!(
        "사람 손이 필요하다({}, 계정={}) — 앱이 이 세션의 터미널을 연다",
        match kind {
            AttentionKind::Startup => "startup",
            AttentionKind::Gate => "gate",
        },
        ctx.account_label
    ));
}

/// 관문 감시가 표식을 물어야 하는가(정본 주기의 앞 가드) — 끝났거나 말했거나 이미 접기로 했으면 묻지 않는다.
pub fn gate_watch_due(end: &EndState, gate: &GateState) -> bool {
    !(end.exited || end.spoke || gate.requeue.is_some())
}

/// 관문 감시 한 주기의 답을 받는다. 표식이 지워졌으면 `Passed` 로 접는다 — `true` 면 접었다.
///
/// 묻는 사이 끝났을 수 있어 가드를 다시 본다(정본 `.then` 안의 두 번째 가드). 물음 실패는 `cleared=false` 로 준다.
pub fn gate_watch_tick(
    end: &mut EndState,
    gate: &mut GateState,
    cleared: bool,
    io: &mut impl GateIo,
) -> bool {
    if !cleared || !gate_watch_due(end, gate) {
        return false;
    }
    gate.requeue = Some(GateRequeueKind::Passed);
    io.log(&format!(
        "계정 관문 표식이 지워졌다 — PTY 를 접고 다시 띄운다(계정={})",
        gate.held.as_deref().unwrap_or("")
    ));
    io.reclaim(end);
    true
}

/// 턴 끝 정리(정본 settle 의 `cancelGateWatch?.()`·`attentionLedger?.release(gateHeld)`).
/// 감시를 내리고, 놓을 원장 계정을 돌려준다(한 번만).
pub fn settle_gate(gate: &mut GateState) -> Option<String> {
    gate.watch_armed = false;
    gate.held.take()
}

#[cfg(test)]
#[path = "turn_gate_tests.rs"]
mod tests;
