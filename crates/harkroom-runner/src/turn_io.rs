//! 턴 수명·관문 접착의 실구현(B4-2f-4b-3b-2a) — [`LifeIo`]·[`GateIo`] 를 진짜 레지스트리·릴레이 세션·관문 원장·
//! 서버 글쓰기·타이머에 잇는다. 정본은 `mentionTurn.ts::runMentionTurn` 의 `settle`·등록·`callHuman` 둘레다.
//!
//! - 타이머는 [`Timer`] — 끄면(`cancel`) 다음 깨어남에서 돈 일을 하지 않는다. 끄는 쪽이 콜백 안이어도 막히지 않게
//!   기다리지(join) 않는다.
//! - 서버에 쓰는 일은 [`TurnPoster`] 뒤에 있다 — 실구현 [`McpTurnPoster`] 는 MCP 클라이언트의 `message.fail`·
//!   `message.unreact` 를 부른다.
//! - 앱으로 가는 관문 알림은 **순번만** 싣는다([`attention_ranks`], 칩 ③).
//!
//! 아직 아무 데서도 부르지 않는다 — 턴 흐름에 붙이는 것은 TurnAttempt 조각이다.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use crate::mcp::{FailOpts, HarkroomMcpClient};
use crate::relay_session::SessionHandle;
use crate::rest::RunnerLink;
use crate::turn_end::EndState;
use crate::turn_gate::{AttentionLedger, GateIo};
use crate::turn_life::LifeIo;
use crate::turn_notice::{GateAccountRank, GateFail, GateRanks};
use crate::turn_registry::{TurnRecord, TurnRegistry};

/// 끌 수 있는 타이머 한 개(정본 `setTimeout`/`setInterval` 과 그 `clear*`).
pub struct Timer {
    stop: Arc<(Mutex<bool>, Condvar)>,
}

impl Timer {
    /// `delay` 뒤에 한 번 돈다. 그 전에 끄면 돌지 않는다.
    pub fn after(delay: Duration, f: impl FnOnce() + Send + 'static) -> Self {
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let s = stop.clone();
        std::thread::spawn(move || {
            if !wait_or_stop(&s, delay) {
                f();
            }
        });
        Self { stop }
    }

    /// `period` 마다 돈다. 콜백이 `false` 를 내거나 끄면 멈춘다.
    pub fn every(period: Duration, mut f: impl FnMut() -> bool + Send + 'static) -> Self {
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let s = stop.clone();
        std::thread::spawn(move || {
            while !wait_or_stop(&s, period) {
                if !f() {
                    break;
                }
            }
        });
        Self { stop }
    }

    /// 끈다. 기다리지 않는다 — 콜백 안에서 불러도 막히지 않는다.
    pub fn cancel(&self) {
        let (m, cv) = &*self.stop;
        *m.lock().unwrap_or_else(|p| p.into_inner()) = true;
        cv.notify_all();
    }
}

impl Drop for Timer {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// `dur` 만큼 기다린다. 그 사이 꺼졌으면 `true`.
fn wait_or_stop(stop: &(Mutex<bool>, Condvar), dur: Duration) -> bool {
    let (m, cv) = stop;
    let g = m.lock().unwrap_or_else(|p| p.into_inner());
    if *g {
        return true;
    }
    let (g, _) = cv
        .wait_timeout_while(g, dur, |stopped| !*stopped)
        .unwrap_or_else(|p| p.into_inner());
    *g
}

/// 턴이 서버에 쓰는 일. 실패는 사유를 돌려주고 던지지 않는다.
pub trait TurnPoster {
    /// 실패 카드(정본 `harkroom.fail`).
    fn fail(&mut self, body: &str, opts: &FailOpts) -> Result<(), String>;
    /// 멘션에 단 💬(진행 중) 리액션을 지운다.
    fn remove_working_reaction(&mut self) -> Result<(), String>;
}

/// [`TurnPoster`] 실구현 — MCP 클라이언트로 이 턴의 채널·앵커에 쓴다.
pub struct McpTurnPoster<'a, L: RunnerLink> {
    pub client: &'a HarkroomMcpClient<L>,
    pub channel_id: String,
    pub anchor: Option<String>,
    /// 💬 를 단 멘션 글.
    pub mention_id: String,
}

/// 정본 `WORKING_REACTION`.
pub const WORKING_REACTION: &str = "💬";

impl<L: RunnerLink> TurnPoster for McpTurnPoster<'_, L> {
    fn fail(&mut self, body: &str, opts: &FailOpts) -> Result<(), String> {
        self.client
            .fail(&self.channel_id, body, self.anchor.as_deref(), opts)
            .map(|_| ())
            .map_err(|e| e.message)
    }
    fn remove_working_reaction(&mut self) -> Result<(), String> {
        self.client
            .remove_reaction(&self.channel_id, &self.mention_id, WORKING_REACTION)
            .map_err(|e| e.message)
    }
}

/// 관문 알림의 순번 두 칸(`claudePoolRank`·`claudeAccountRank`) — 계정 이름은 싣지 않는다(칩 ③).
/// 계정 칸은 `None` = 모른다(생략), `Some(None)` = 기본 로그인(null).
pub fn attention_ranks(ranks: GateRanks) -> (Option<u32>, Option<Option<u32>>) {
    let account = match ranks.account {
        GateAccountRank::Unknown => None,
        GateAccountRank::DefaultLogin => Some(None),
        GateAccountRank::Rank(n) => Some(Some(n)),
    };
    (ranks.pool, account)
}

/// 관문 실패 글 → `message.fail` 의 칸.
pub fn gate_fail_opts(fail: &GateFail) -> FailOpts {
    FailOpts {
        retryable: fail.retryable,
        what: Some(fail.what.to_owned()),
        reason: Some(fail.reason.to_owned()),
        code: fail.code.map(str::to_owned),
        mention_id: fail.mention_id.clone(),
        claude_pool_rank: fail.claude_pool_rank,
        claude_account_rank: fail.claude_account_rank,
        ..FailOpts::default()
    }
}

/// 턴 하나의 바깥 일 실구현. 콜백(PTY 회수·관문 표식·lane env 정리)은 부르는 쪽이 넣는다.
pub struct TurnIo<P: TurnPoster> {
    pub thread_key: String,
    pub registry: Arc<Mutex<TurnRegistry>>,
    pub record: TurnRecord,
    pub session: Option<SessionHandle>,
    /// 관문 원장. 풀의 마지막 계정이 아니면 `None`(사람을 부르지 않는다).
    pub ledger: Option<Arc<Mutex<AttentionLedger>>>,
    pub poster: P,
    /// PTY 에 SIGTERM(정본 `controls.terminate`).
    pub terminate: Box<dyn FnMut() + Send>,
    /// 턴 시작 관문 표식(정본 `deps.markAccountGate`). 계정 풀이 없으면 `None`.
    pub mark_gate: Option<Box<dyn FnMut() + Send>>,
    /// 관문 감시 주기를 거는 일(정본 `deps.accountGateCleared` 가 있을 때). 없으면 감시하지 않는다.
    pub arm_gate: Option<Box<dyn FnMut() -> Timer + Send>>,
    /// lane env 를 놓는다(정본 `providerEnvDone`). 한 번만 돈다.
    pub provider_done: Option<Box<dyn FnOnce() + Send>>,
    pub probe: Option<Timer>,
    pub reclaim_timer: Option<Timer>,
    pub silence: Option<Timer>,
    pub gate_watch: Option<Timer>,
    /// 펜스 잃음을 듣고 있다 — 탐침 주기가 이것을 보고 임대를 묻는다.
    pub fence_listening: Arc<AtomicBool>,
    pub log_prefix: String,
    pub log: Box<dyn FnMut(&str) + Send>,
}

impl<P: TurnPoster> TurnIo<P> {
    fn line(&mut self, s: &str) {
        let msg = format!("{}{s}", self.log_prefix);
        (self.log)(&msg);
    }
}

impl<P: TurnPoster> LifeIo for TurnIo<P> {
    fn registry_register(&mut self) -> Result<(), String> {
        self.registry
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .register(&self.thread_key, self.record.clone())
            .map_err(|e| e.to_string())
    }
    fn registry_release(&mut self) {
        self.registry
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .release(&self.thread_key);
    }
    fn listen_fence(&mut self) {
        self.fence_listening.store(true, Ordering::SeqCst);
    }
    fn unlisten_fence(&mut self) {
        self.fence_listening.store(false, Ordering::SeqCst);
    }
    fn reclaim(&mut self, end: &mut EndState) {
        if end.reclaim() {
            (self.terminate)();
        }
    }
    fn cancel_probe(&mut self) {
        if let Some(t) = self.probe.take() {
            t.cancel();
        }
    }
    fn cancel_reclaim(&mut self) {
        if let Some(t) = self.reclaim_timer.take() {
            t.cancel();
        }
    }
    fn cancel_silence(&mut self) {
        if let Some(t) = self.silence.take() {
            t.cancel();
        }
    }
    fn cancel_gate_watch(&mut self) {
        if let Some(t) = self.gate_watch.take() {
            t.cancel();
        }
    }
    fn ledger_release(&mut self, account_label: &str) {
        if let Some(l) = &self.ledger {
            l.lock()
                .unwrap_or_else(|p| p.into_inner())
                .release(account_label);
        }
    }
    fn provider_env_done(&mut self) {
        if let Some(f) = self.provider_done.take() {
            f();
        }
    }
    fn close_session(&mut self) {
        if let Some(s) = self.session.take() {
            s.close();
        }
    }
    fn await_working(&mut self) {
        // 💬 달기는 이 러너에서 동기로 끝난다 — 기다릴 것이 없다.
    }
    fn remove_working_reaction(&mut self) -> Result<(), String> {
        self.poster.remove_working_reaction()
    }
    fn log(&mut self, line: &str) {
        self.line(line);
    }
}

impl<P: TurnPoster> GateIo for TurnIo<P> {
    fn mark_account_gate(&mut self) {
        if let Some(f) = self.mark_gate.as_mut() {
            f();
        }
    }
    fn post_gate_fail(&mut self, fail: GateFail) {
        let opts = gate_fail_opts(&fail);
        if let Err(e) = self.poster.fail(&fail.body, &opts) {
            self.line(&format!("관문 통지 실패 — {e}"));
        }
    }
    fn ledger_claim(&mut self, account_label: &str, session_key: &str) -> Option<bool> {
        let l = self.ledger.as_ref()?;
        Some(
            l.lock()
                .unwrap_or_else(|p| p.into_inner())
                .claim(account_label, session_key),
        )
    }
    fn reclaim(&mut self, end: &mut EndState) {
        LifeIo::reclaim(self, end);
    }
    fn can_watch_gate(&self) -> bool {
        self.arm_gate.is_some()
    }
    fn arm_gate_watch(&mut self) {
        if self.gate_watch.is_some() {
            return;
        }
        if let Some(arm) = self.arm_gate.as_mut() {
            self.gate_watch = Some(arm());
        }
    }
    fn needs_attention(&mut self, screen: &str, ranks: GateRanks) {
        let (pool, account) = attention_ranks(ranks);
        if let Some(s) = &self.session {
            s.needs_attention(screen, pool, account);
        }
    }
    fn log(&mut self, line: &str) {
        self.line(line);
    }
}

#[cfg(test)]
#[path = "turn_io_tests.rs"]
mod tests;
