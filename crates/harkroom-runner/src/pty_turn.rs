//! PTY 턴의 **프롬프트 주입 상태 기계**(S3 B3b-2b). 정본은 `packages/agent/src/pty.ts` 의 `runPtyTurn` 안
//! `if (opts.injectPrompt) { … }` 절이다 — 준비 신호·정적 대기·`waitFor`·관문 미루기·bracketed paste 와 Enter·
//! 미제출 그물(`unsentHint`)·턴 도중 관문·전달 확인(`confirmDelivery`)·선택 대기(`waitingQuietMs`).
//! 판정 문구·이유는 정본 주석이 정본이다 — 여기엔 이식에서 달라진 것만 적는다.
//!
//! **이식에서 달라진 모양.** 정본은 타이머 일곱 개(setTimeout·setInterval)와 `onData` 리스너 셋이 클로저 변수를
//! 나눠 쥔다. 이 crate 는 std::thread 구조라(tokio 없음) 그것을 **시계를 바깥에서 받는 상태 기계 하나**로 접었다:
//! 타이머는 전부 「언제 깨어날지」(`Option<u64>` 마감)이고, 호출자(PTY 루프)는 `next_deadline` 까지 기다렸다가
//! `on_tick` 을 부른다. 바이트가 오면 `on_data`. 기계는 **할 일**(`Action`)을 돌려줄 뿐 PTY 를 직접 만지지 않는다 —
//! 그래서 시험은 가짜 시계로 정본의 시각 순서를 그대로 밟는다.
//!
//! 정본에서 한 콜백 안에 겹쳐 있던 순서(데이터 리스너 등록 순서: tail → readyProbe → pasteData)는 `on_data` 안의
//! 순서로 옮겼다. 같은 시각에 마감이 여럿이면 정본의 타이머 등록 순서와 무관하게 **아래 `on_tick` 의 순서**로 돈다 —
//! 정본도 같은 ms 의 두 타이머 순서를 계약으로 삼지 않는다.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::Value;

use crate::pty::{
    AttentionKind, NotDeliveredKind, OUTPUT_COALESCE_MS, OutputCoalescer, PromptNotDelivered, Push,
    RingBuffer, SIGKILL_GRACE_MS, TAIL_CAP_BYTES, compose_spawn, decode_tail_text, looks_like_gate,
    looks_ready_for_prompt, sanitize_paste_text, strip_ansi,
};
use crate::pty_proc::{
    ExecutableNotFound, PtyExit, PtyHandle, PtyProcess, SpawnError, SpawnSpec, read_until_closed,
    spawn_pty,
};
use crate::pty_record::PtyRecorder;

/// bracketed paste 시작·끝 표식.
const PASTE_START: &str = "\u{1b}[200~";
const PASTE_END: &str = "\u{1b}[201~";
/// 붙여넣기 뒤 가라앉음을 재는 주기(정본 `settleProbe` 25ms).
const SETTLE_PROBE_MS: u64 = 25;
/// `afterPaste` 꼬리 상한(정본 2,048 글자 — 여기선 바이트, 끝 판정만 하므로 충분하다).
const AFTER_PASTE_CAP: usize = 2_048;

/// 정본 `injectPrompt.waitFor` — 넣기 전에 따로 설 것(예: 훅 소켓)을 기다린다. `ready` 는 `PromptHooks` 가 답한다.
#[derive(Clone, Debug)]
pub struct WaitFor {
    pub max_ms: u64,
    pub poll_ms: u64,
}

/// 정본 `injectPrompt.confirmDelivery` — 증거(`PromptHooks::confirm_probe`)가 없으면 개행 한 번 더, 그래도 없으면 부른다.
#[derive(Clone, Debug)]
pub struct ConfirmDelivery {
    pub within_ms: u64,
    /// 생략하면 `max(50, round(within_ms / 3))`(정본 기본값).
    pub resend_grace_ms: Option<u64>,
}

/// 정본 `injectPrompt` 의 값 절반. 콜백 절반은 `PromptHooks` 다. 기본값은 정본과 같다(`Default`).
#[derive(Clone, Debug)]
pub struct InjectPrompt {
    pub text: String,
    pub ready_pattern: Option<Regex>,
    pub gate_pattern: Option<Regex>,
    pub ready_timeout_ms: u64,
    pub ready_quiet_ms: u64,
    pub ready_quiet_max_ms: u64,
    pub ready_min_ms: u64,
    pub unsent_hint: Option<Regex>,
    pub unsent_probe_ms: u64,
    pub unsent_retries: u32,
    pub submit_min_ms: u64,
    pub submit_quiet_ms: u64,
    pub submit_max_ms: u64,
    pub submit_pasting_max_ms: u64,
    pub waiting_quiet_ms: u64,
    /// 정본 `onAttention` 이 있는가. 있으면 준비 상한은 사람을 부르고(접지 않는다), 선택 대기 판정은 돌지 않는다.
    pub attention: bool,
    /// 정본 `onTurnGate` 가 따로 있는가. 없고 `attention` 이 있으면 `Attention(.., Gate)` 로 부른다(정본 기본).
    pub turn_gate: bool,
    pub gate_probe_ms: u64,
    /// 정본 `gateSignal` 이 있는가(있으면 화면 대신 `PromptHooks::gate_signal` 의 증가로 잰다).
    pub gate_signal: bool,
    pub wait_for: Option<WaitFor>,
    pub confirm: Option<ConfirmDelivery>,
}

impl Default for InjectPrompt {
    fn default() -> Self {
        Self {
            text: String::new(),
            ready_pattern: None,
            gate_pattern: None,
            ready_timeout_ms: 60_000,
            ready_quiet_ms: 300,
            ready_quiet_max_ms: 2_000,
            ready_min_ms: 0,
            unsent_hint: None,
            unsent_probe_ms: 1_500,
            unsent_retries: 3,
            submit_min_ms: 300,
            submit_quiet_ms: 150,
            submit_max_ms: 1_200,
            submit_pasting_max_ms: 5_000,
            waiting_quiet_ms: 3_000,
            attention: false,
            turn_gate: false,
            gate_probe_ms: 3_000,
            gate_signal: false,
            wait_for: None,
            confirm: None,
        }
    }
}

/// 상태 기계가 밖에 물어야 하는 것(정본의 콜백 중 **값을 돌려주는** 것). 던지는 쪽은 정본처럼 「없음」으로 읽도록
/// 구현이 알아서 `false`·옛 값을 돌려준다.
pub trait PromptHooks {
    /// 정본 `waitFor.ready()`.
    fn wait_for_ready(&mut self) -> bool {
        true
    }
    /// 정본 `waitFor.onSettled`.
    fn wait_for_settled(&mut self, _ready: bool, _waited_ms: u64) {}
    /// 정본 `gateSignal()` — 지금까지 본 관문 신호 수.
    fn gate_signal(&mut self) -> u64 {
        0
    }
    /// 정본 `confirmDelivery.probe()` — 세션 기록에 사람 입력 줄이 생겼나.
    fn confirm_probe(&mut self) -> bool {
        true
    }
}

/// 기계가 낸 할 일. 호출자가 **낸 순서대로** 처리한다.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    /// PTY 에 쓴다.
    Write(Vec<u8>),
    /// 주입했다(정본 `onInjected`).
    Injected,
    /// 사람을 부른다(정본 `onAttention`).
    Attention(String, AttentionKind),
    /// 턴 도중 관문(정본 `onTurnGate` — 따로 없으면 호출자가 이미 `Attention(.., Gate)` 로 받는다, 아래 `turn_gate_action`).
    TurnGate(String),
    /// 프롬프트를 못 넣은 채로 접는다 — 호출자는 SIGKILL 을 쏘고 이 오류로 끝낸다(정본 `failUndelivered`).
    Fail(PromptNotDelivered),
}

/// 붙여넣은 뒤의 상태(정본 `inject` 안의 지역 변수들).
struct Pasted {
    at: u64,
    last_data: u64,
    after: Vec<u8>,
    /// 다음 가라앉음 검사 시각. `None` = 이미 Enter 를 쳤다.
    settle_next: Option<u64>,
    nudge_next: Option<u64>,
    nudge_left: u32,
    gate_next: Option<u64>,
    gate_seen_once: bool,
    gate_called: bool,
    signals_seen: u64,
    confirm_at: Option<u64>,
    grace_at: Option<u64>,
}

/// 정본 `runPtyTurn` 의 주입 절. 시각은 스폰 기준 ms(`now`)다.
pub struct PromptInjector {
    opts: InjectPrompt,
    tail: RingBuffer,
    settled: bool,
    injected: bool,
    wait_for_done: bool,
    submitted: bool,
    gate_blocked: bool,
    gate_called: bool,
    ready_seen_at: Option<u64>,
    last_data_at: u64,
    gate_since: Option<u64>,
    ready_deadline: Option<u64>,
    quiet_at: Option<u64>,
    waiting_next: Option<u64>,
    waiting_period: u64,
    pasted: Option<Pasted>,
}

impl PromptInjector {
    /// 스폰 직후(`now` = 0 기준) 세운다. 준비 상한과 선택 대기 주기는 여기서 걸린다(정본과 같은 자리).
    pub fn new(opts: InjectPrompt) -> Self {
        let waiting_period = (opts.waiting_quiet_ms / 4).clamp(50, 250);
        Self {
            ready_deadline: Some(opts.ready_timeout_ms),
            waiting_next: (!opts.attention).then_some(waiting_period),
            wait_for_done: opts.wait_for.is_none(),
            opts,
            tail: RingBuffer::new(TAIL_CAP_BYTES),
            settled: false,
            injected: false,
            submitted: false,
            gate_blocked: false,
            gate_called: false,
            ready_seen_at: None,
            last_data_at: 0,
            gate_since: None,
            quiet_at: None,
            waiting_period,
            pasted: None,
        }
    }

    pub fn injected(&self) -> bool {
        self.injected
    }

    pub fn submitted(&self) -> bool {
        self.submitted
    }

    /// 정본 `tail` — 끝난 턴의 `TurnResult.tail` 과 자격증명 실패 판정이 이것을 읽는다.
    pub fn tail_text(&self) -> String {
        decode_tail_text(&self.tail.snapshot())
    }

    /// PTY 가 끝났다(정본 exit 리스너의 `settled = true`). 그 뒤로는 아무것도 내지 않는다.
    pub fn settle(&mut self) {
        self.settled = true;
    }

    /// 다음에 `on_tick` 을 불러야 할 가장 이른 시각. `None` 이면 바이트가 올 때까지 기다리면 된다.
    pub fn next_deadline(&self) -> Option<u64> {
        if self.settled {
            return None;
        }
        let mut all = vec![self.ready_deadline, self.quiet_at, self.waiting_next];
        if let Some(p) = &self.pasted {
            all.extend([
                p.settle_next,
                p.nudge_next,
                p.gate_next,
                p.confirm_at,
                p.grace_at,
            ]);
        }
        all.into_iter().flatten().min()
    }

    /// 바이트가 왔다. 정본의 리스너 등록 순서대로 — tail → readyProbe → pasteData.
    pub fn on_data(&mut self, now: u64, chunk: &[u8], hooks: &mut dyn PromptHooks) -> Vec<Action> {
        self.tail.push(chunk);
        let mut out = Vec::new();
        if self.settled {
            return out;
        }
        if !self.injected {
            self.last_data_at = now;
            let screen = self.tail_text();
            if looks_ready_for_prompt(&screen, self.opts.ready_pattern.as_ref()) {
                let seen = *self.ready_seen_at.get_or_insert(now);
                if now.saturating_sub(seen) >= self.opts.ready_quiet_max_ms {
                    self.inject(now, hooks, &mut out);
                } else {
                    // 바이트가 또 왔다 = 아직 그리는 중이다. 시계를 다시 세운다.
                    self.quiet_at = Some(now + self.opts.ready_quiet_ms);
                }
            }
        } else if let Some(p) = self.pasted.as_mut()
            && p.settle_next.is_some()
        {
            // 정본 `pasteData` 는 Enter 를 친 뒤 dispose 된다 — 그 전까지만 잰다.
            p.last_data = now;
            p.after.extend_from_slice(chunk);
            if p.after.len() > AFTER_PASTE_CAP {
                p.after.drain(..p.after.len() - AFTER_PASTE_CAP);
            }
        }
        out
    }

    /// 마감에 닿았다. 닿은 것만 돈다 — 일찍 불러도 해가 없다.
    pub fn on_tick(&mut self, now: u64, hooks: &mut dyn PromptHooks) -> Vec<Action> {
        let mut out = Vec::new();
        if self.settled {
            return out;
        }
        if self.ready_deadline.is_some_and(|d| now >= d) {
            self.ready_deadline = None;
            self.ready_timer(now, &mut out);
        }
        if self.waiting_next.is_some_and(|d| now >= d) {
            self.waiting_next = Some(now + self.waiting_period);
            self.waiting_probe(now, &mut out);
        }
        if self.quiet_at.is_some_and(|d| now >= d) {
            self.quiet_at = None;
            self.inject(now, hooks, &mut out);
        }
        if self.settled || self.pasted.is_none() {
            return out;
        }
        self.settle_probe(now, &mut out);
        self.nudge(now, &mut out);
        self.turn_gate_probe(now, hooks, &mut out);
        self.confirm(now, hooks, &mut out);
        out
    }

    fn ready_timer(&mut self, now: u64, out: &mut Vec<Action>) {
        // 준비를 본 뒤라면 이 상한은 남의 일이다 — 단 관문에 막혀 있으면 제 일을 한다(정본 주석).
        if self.injected || (self.ready_seen_at.is_some() && !self.gate_blocked) {
            return;
        }
        let screen = self.tail_text();
        if self.opts.attention {
            // 아무것도 정착시키지 않는다 — 사람이 관문을 지나면 주입이 이어진다.
            out.push(Action::Attention(screen, AttentionKind::Startup));
            return;
        }
        self.fail(now, screen, NotDeliveredKind::Timeout, out);
    }

    fn waiting_probe(&mut self, now: u64, out: &mut Vec<Action>) {
        if self.injected {
            self.waiting_next = None;
            return;
        }
        let screen = self.tail_text();
        if looks_like_gate(
            &screen,
            self.opts.gate_pattern.as_ref(),
            self.opts.ready_pattern.as_ref(),
        ) {
            let since = *self.gate_since.get_or_insert(now);
            if now.saturating_sub(since) >= self.opts.waiting_quiet_ms {
                self.fail(now, screen, NotDeliveredKind::Waiting, out);
                return;
            }
        } else {
            self.gate_since = None;
        }
        if self.ready_seen_at.is_none()
            && self.last_data_at > 0
            && now.saturating_sub(self.last_data_at) >= self.opts.waiting_quiet_ms
        {
            self.fail(now, screen, NotDeliveredKind::Waiting, out);
        }
    }

    fn fail(&mut self, now: u64, screen: String, kind: NotDeliveredKind, out: &mut Vec<Action>) {
        if self.injected || self.settled {
            return;
        }
        self.settled = true;
        out.push(Action::Fail(PromptNotDelivered {
            waited_ms: now,
            tail: screen,
            kind,
        }));
    }

    /// 정본 `inject` — 준비를 본 뒤 정적이 오거나 정적 상한에 닿으면 온다. 하한·`waitFor`·관문을 차례로 본다.
    fn inject(&mut self, now: u64, hooks: &mut dyn PromptHooks, out: &mut Vec<Action>) {
        if self.injected || self.settled {
            return;
        }
        // 입력창이 보인다 ≠ 입력을 받는다 — 스폰 기준 하한(관문 검사보다 앞, 정본 주석).
        if self.opts.ready_min_ms > 0 && now < self.opts.ready_min_ms {
            self.quiet_at = Some(self.opts.ready_min_ms);
            return;
        }
        if !self.wait_for_done
            && let Some(w) = &self.opts.wait_for
        {
            let (max_ms, poll_ms) = (w.max_ms, w.poll_ms);
            let ready = hooks.wait_for_ready();
            if !ready && now < max_ms {
                self.quiet_at = Some(now + poll_ms.min(max_ms - now));
                return;
            }
            self.wait_for_done = true;
            hooks.wait_for_settled(ready, now);
        }
        // 관문 위에는 쓰지 않는다(2026-09-11 실측 — Enter 가 업데이트 선택지를 눌렀다).
        let before = self.tail_text();
        if looks_like_gate(
            &before,
            self.opts.gate_pattern.as_ref(),
            self.opts.ready_pattern.as_ref(),
        ) {
            self.gate_blocked = true;
            if self.opts.attention && !self.gate_called {
                self.gate_called = true;
                out.push(Action::Attention(before, AttentionKind::Startup));
            }
            // 화면이 멈춰 있으면 데이터가 안 와 다시 안 깨운다 — 직접 다시 볼 시각을 잡는다. 상한은 준비 상한이 쥔다.
            self.quiet_at = Some(now + self.opts.ready_quiet_ms);
            return;
        }
        self.gate_blocked = false;

        self.injected = true;
        out.push(Action::Injected);
        self.ready_deadline = None;
        self.quiet_at = None;
        self.waiting_next = None;
        // 감싼 본문과 전송을 나눠 쓴다 — 붙여 쓰면 일부 TUI 가 끝 표식과 개행을 한 덩어리로 읽는다.
        out.push(Action::Write(
            format!(
                "{PASTE_START}{}{PASTE_END}",
                sanitize_paste_text(&self.opts.text)
            )
            .into_bytes(),
        ));
        let turn_gate = self.opts.turn_gate || self.opts.attention;
        self.pasted = Some(Pasted {
            at: now,
            last_data: now,
            after: Vec::new(),
            settle_next: Some(now + SETTLE_PROBE_MS),
            nudge_next: self
                .opts
                .unsent_hint
                .as_ref()
                .map(|_| now + self.opts.unsent_probe_ms),
            nudge_left: self.opts.unsent_retries,
            gate_next: turn_gate.then_some(now + self.opts.gate_probe_ms),
            gate_seen_once: false,
            gate_called: false,
            signals_seen: 0,
            confirm_at: self.opts.confirm.as_ref().map(|c| now + c.within_ms),
            grace_at: None,
        });
    }

    /// 정본 `settleProbe` — Enter 는 붙여넣기가 가라앉은 뒤에 친다(2026-10-09 실측).
    fn settle_probe(&mut self, now: u64, out: &mut Vec<Action>) {
        let opts = &self.opts;
        let Some(p) = self.pasted.as_mut() else {
            return;
        };
        let Some(due) = p.settle_next else { return };
        if now < due {
            return;
        }
        p.settle_next = Some(now + SETTLE_PROBE_MS);
        let since = now.saturating_sub(p.at);
        if since < opts.submit_min_ms {
            return;
        }
        // 받아 들이는 중 표시가 **마지막으로 그린 것**이면 아직이다(정본 `/Pasting…?\s*$/`).
        let after = strip_ansi(&String::from_utf8_lossy(&p.after));
        let pasting = is_pasting(&after);
        let cap = if pasting {
            opts.submit_pasting_max_ms
        } else {
            opts.submit_max_ms
        };
        if since < cap && (pasting || now.saturating_sub(p.last_data) < opts.submit_quiet_ms) {
            return;
        }
        p.settle_next = None;
        p.after.clear();
        self.submitted = true;
        out.push(Action::Write(b"\r".to_vec()));
    }

    /// 정본 `nudge` — 삼켜진 Enter 를 화면(`unsentHint`)으로 보고 개행만 다시 친다. 본문은 다시 보내지 않는다.
    fn nudge(&mut self, now: u64, out: &mut Vec<Action>) {
        let screen = strip_ansi(&self.tail_text());
        let submitted = self.submitted;
        let hint = self.opts.unsent_hint.as_ref();
        let probe_ms = self.opts.unsent_probe_ms;
        let Some(p) = self.pasted.as_mut() else {
            return;
        };
        let Some(due) = p.nudge_next else { return };
        if now < due {
            return;
        }
        p.nudge_next = Some(now + probe_ms);
        if p.nudge_left == 0 {
            p.nudge_next = None;
            return;
        }
        if !submitted {
            return; // 첫 Enter 가 아직이다 — 받아 들이는 중에 치면 버려진다.
        }
        if !hint.is_some_and(|h| h.is_match(&screen)) {
            p.nudge_next = None; // 갔다 — 남은 시도를 태우지 않는다.
            return;
        }
        p.nudge_left -= 1;
        out.push(Action::Write(b"\r".to_vec()));
    }

    /// 정본 `gateProbe` — 턴 **도중** 관문. 한 관문에 한 번만 부르고, 내려가면 다음 관문은 다시 센다.
    fn turn_gate_probe(&mut self, now: u64, hooks: &mut dyn PromptHooks, out: &mut Vec<Action>) {
        let screen = self.tail_text();
        let signal = self.opts.gate_signal;
        let period = self.opts.gate_probe_ms;
        let own = self.opts.turn_gate;
        let action = move |s: String| turn_gate_action(s, own);
        let Some(p) = self.pasted.as_mut() else {
            return;
        };
        let Some(due) = p.gate_next else { return };
        if now < due {
            return;
        }
        p.gate_next = Some(now + period);
        if signal {
            let n = hooks.gate_signal();
            if n > p.signals_seen {
                p.signals_seen = n;
                out.push(action(screen));
            }
            return;
        }
        // 정본은 여기서 기본 패턴으로 잰다(`looksLikeGate(screen)` — 하네스 패턴을 넘기지 않는다).
        if !looks_like_gate(&screen, None, None) {
            p.gate_seen_once = false;
            p.gate_called = false;
            return;
        }
        if !p.gate_seen_once {
            p.gate_seen_once = true;
            return;
        }
        if p.gate_called {
            return;
        }
        p.gate_called = true;
        out.push(action(screen));
    }

    /// 정본 `confirmTimer`·`graceTimer` — 증거가 없으면 개행 한 번 더, 유예 뒤에도 없으면 부른다(부를 곳이 있을 때만).
    fn confirm(&mut self, now: u64, hooks: &mut dyn PromptHooks, out: &mut Vec<Action>) {
        let Some(c) = self.opts.confirm.clone() else {
            return;
        };
        let attention = self.opts.attention;
        let screen = self.tail_text();
        let Some(p) = self.pasted.as_mut() else {
            return;
        };
        if p.confirm_at.is_some_and(|d| now >= d) {
            p.confirm_at = None;
            if !hooks.confirm_probe() {
                eprintln!(
                    "[pty] 주입 {}ms 뒤에도 세션 기록에 사람 입력 줄이 없다 — 개행을 한 번 더 친다",
                    c.within_ms
                );
                out.push(Action::Write(b"\r".to_vec()));
                let grace = c
                    .resend_grace_ms
                    .unwrap_or_else(|| (c.within_ms as f64 / 3.0).round().max(50.0) as u64);
                p.grace_at = Some(now + grace);
            }
        }
        if p.grace_at.is_some_and(|d| now >= d) {
            p.grace_at = None;
            if !hooks.confirm_probe() && attention {
                out.push(Action::Attention(screen, AttentionKind::Startup));
            }
        }
    }
}

/// 턴 도중 관문을 누구에게 알리나 — 정본: `onTurnGate` 가 있으면 그것, 없으면 `onAttention(screen, 'gate')`.
fn turn_gate_action(screen: String, own_turn_gate: bool) -> Action {
    if own_turn_gate {
        Action::TurnGate(screen)
    } else {
        Action::Attention(screen, AttentionKind::Gate)
    }
}

/// 정본 `/Pasting…?\s*$/` — `Pasting` 뒤에 `…` 가 있거나 없고, 그 뒤는 공백뿐.
fn is_pasting(after: &str) -> bool {
    let t = after.trim_end();
    t.ends_with("Pasting…") || t.ends_with("Pasting")
}

// ── PTY 루프(B3b-2b-2): spawn·읽기·회수 스레드와 위 상태 기계·출력 합치기·시간 한도를 한 스레드에서 돈다. ──

/// 띄울 계획(정본 `TurnPlan` 중 PTY 가 쓰는 것).
pub struct PtyPlan {
    pub command: String,
    pub args: Vec<String>,
    /// 자식 env 전체 — 러너 env 를 물려주지 않는다.
    pub env: Vec<(String, String)>,
    pub stdin_file: Option<String>,
}

/// 정본 `RunPtyTurnOptions` 의 값 절반. 콜백 절반은 `PtyTurnSink` 다.
pub struct PtyTurnOptions {
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    /// 0 = 무기한(인터랙티브·TUI 멘션 턴) — 정본처럼 타이머를 아예 걸지 않는다.
    pub timeout_ms: u64,
    pub kill_grace_ms: u64,
    pub coalesce_ms: u64,
    pub record_dir: Option<PathBuf>,
    pub inject: Option<InjectPrompt>,
}

impl Default for PtyTurnOptions {
    fn default() -> Self {
        Self {
            cwd: PathBuf::from("/"),
            cols: 120,
            rows: 40,
            timeout_ms: 0,
            kill_grace_ms: SIGKILL_GRACE_MS,
            coalesce_ms: OUTPUT_COALESCE_MS,
            record_dir: None,
            inject: None,
        }
    }
}

/// 정본 `TurnResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnResult {
    pub exit_code: i32,
    pub timed_out: bool,
    pub tail: String,
}

/// 정본이 reject 하는 둘(실행 파일 부재·프롬프트 미전달)과 spawn 의 그 밖의 I/O 오류.
#[derive(Debug)]
pub enum PtyTurnError {
    NotFound(ExecutableNotFound),
    Spawn(std::io::Error),
    NotDelivered(PromptNotDelivered),
}

impl std::fmt::Display for PtyTurnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(e) => e.fmt(f),
            Self::Spawn(e) => write!(f, "PTY 를 띄우지 못했다: {e}"),
            Self::NotDelivered(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for PtyTurnError {}

/// 사람·중계가 쥐는 손잡이(정본 `PtyControls`). `PtyHandle` 에 녹화로 가는 길만 더했다 — 녹화기는 루프 스레드가 쥔다.
#[derive(Clone)]
pub struct PtyControls {
    handle: PtyHandle,
    tx: mpsc::Sender<Event>,
}

impl PtyControls {
    pub fn pid(&self) -> u32 {
        self.handle.pid()
    }
    pub fn write(&self, chunk: &[u8]) {
        self.handle.write(chunk);
    }
    pub fn resize(&self, cols: u16, rows: u16) {
        self.handle.resize(cols, rows);
        let _ = self.tx.send(Event::Resize(cols, rows));
    }
    /// SIGTERM 은 유예 뒤 SIGKILL 로 승격한다(`PtyHandle::kill`).
    pub fn kill(&self, sigkill: bool) {
        self.handle.kill(sigkill);
    }
    pub fn mark(&self, data: Value) {
        let _ = self.tx.send(Event::Mark(data));
    }
}

/// 정본 `RunPtyTurnOptions` 의 콜백들. 전부 루프 스레드에서 불린다.
pub trait PtyTurnSink: PromptHooks {
    /// 정본 `onSpawn` — 시간 한도는 이것이 돌아온 **뒤에** 흐르기 시작한다(정본 #391 주석).
    fn on_spawn(&mut self, _controls: PtyControls) {}
    /// 합친 출력(정본 `ring.push` + `onData`).
    fn on_output(&mut self, _frame: &[u8]) {}
    fn on_injected(&mut self) {}
    fn on_attention(&mut self, _screen: &str, _kind: AttentionKind) {}
    fn on_turn_gate(&mut self, _screen: &str) {}
}

enum Event {
    Data(Vec<u8>),
    ReaderDone,
    Exit(std::io::Result<PtyExit>),
    Resize(u16, u16),
    Mark(Value),
}

/// 자식이 끝난 뒤 남은 화면 바이트를 기다리는 상한. 정본(node-pty)은 exit 뒤 데이터를 버리지만, 마지막 프레임에
/// 결과가 적혀 있으므로(정본 `relay.stop` 주석) 읽기 끝이 닫힐 때까지 잠깐 더 받는다 — 손자가 slave 를 쥐고 있으면
/// 끝이 안 오므로 상한을 둔다. 이식에서 달라진 점.
const DRAIN_AFTER_EXIT_MS: u64 = 200;

/// 정본 `runPtyTurn`. 실행 파일 부재·프롬프트 미전달만 `Err` 이고, 끝남·시간 한도는 `TurnResult` 로 돌려준다.
pub fn run_pty_turn<S: PtyTurnSink>(
    plan: &PtyPlan,
    opts: PtyTurnOptions,
    sink: &mut S,
) -> Result<TurnResult, PtyTurnError> {
    let (command, args) = compose_spawn(&plan.command, &plan.args, plan.stdin_file.as_deref());
    let spec = SpawnSpec {
        harness: &plan.command,
        command: &command,
        args: &args,
        env: &plan.env,
        cwd: &opts.cwd,
        cols: opts.cols,
        rows: opts.rows,
    };
    let proc =
        spawn_pty(&spec, Duration::from_millis(opts.kill_grace_ms)).map_err(|e| match e {
            SpawnError::NotFound(n) => PtyTurnError::NotFound(n),
            SpawnError::Io(e) => PtyTurnError::Spawn(e),
        })?;
    let started = Instant::now();
    let now_ms = || started.elapsed().as_millis() as u64;
    let (tx, rx) = mpsc::channel();
    let handle = proc.handle.clone();
    // 읽기·회수 스레드를 다른 무엇보다 먼저 세운다 — 그 사이에 무언가 실패하면 자식이 아무도 안 지켜보는 채로 남는다
    // (정본 exit 리스너 주석). 회수 스레드는 루프가 먼저 끝나도(미전달 실패) 끝까지 회수한다.
    {
        let PtyProcess { reader, .. } = &proc;
        let reader = reader.try_clone().map_err(PtyTurnError::Spawn)?;
        let tx = tx.clone();
        std::thread::spawn(move || {
            read_until_closed(reader, |c| {
                let _ = tx.send(Event::Data(c.to_vec()));
            });
            let _ = tx.send(Event::ReaderDone);
        });
    }
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Event::Exit(proc.wait()));
        });
    }
    let label = Path::new(&plan.command)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut recorder = PtyRecorder::open(opts.record_dir.as_deref(), &label, opts.cols, opts.rows);
    sink.on_spawn(PtyControls {
        handle: handle.clone(),
        tx: tx.clone(),
    });
    drop(tx);

    let base = now_ms();
    let mut tail = RingBuffer::new(TAIL_CAP_BYTES);
    let mut relay = OutputCoalescer::new();
    let mut relay_at: Option<u64> = None;
    let mut injector = opts.inject.map(|o| (PromptInjector::new(o), base));
    let timeout_at = (opts.timeout_ms > 0).then(|| base + opts.timeout_ms);
    let mut timed_out = false;
    let mut exited: Option<(PtyExit, u64)> = None;

    let finish = |relay: &mut OutputCoalescer, sink: &mut S, recorder: &mut Option<PtyRecorder>| {
        if let Some(rest) = relay.stop() {
            sink.on_output(&rest);
        }
        if let Some(r) = recorder.as_mut() {
            r.close();
        }
    };

    loop {
        let now = now_ms();
        let mut next = [relay_at, timeout_at.filter(|_| !timed_out)]
            .into_iter()
            .flatten()
            .chain(
                injector
                    .as_ref()
                    .and_then(|(m, b)| m.next_deadline().map(|d| d + b)),
            )
            .min();
        if let Some((_, at)) = exited {
            next = Some(next.map_or(at + DRAIN_AFTER_EXIT_MS, |n| {
                n.min(at + DRAIN_AFTER_EXIT_MS)
            }));
        }
        let ev = match next {
            Some(d) if d <= now => None,
            Some(d) => match rx.recv_timeout(Duration::from_millis(d - now)) {
                Ok(e) => Some(e),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => Some(Event::ReaderDone),
            },
            None => match rx.recv() {
                Ok(e) => Some(e),
                Err(_) => Some(Event::ReaderDone),
            },
        };
        let now = now_ms();
        let mut actions = Vec::new();
        match ev {
            Some(Event::Data(chunk)) => {
                if let Some(r) = recorder.as_mut() {
                    r.output(&chunk);
                }
                tail.push(&chunk);
                match relay.push(&chunk) {
                    Push::EmitAndArm(b) => {
                        sink.on_output(&b);
                        relay_at = Some(now + opts.coalesce_ms);
                    }
                    Push::Buffered | Push::Ignored => {}
                }
                if exited.is_none()
                    && let Some((m, b)) = injector.as_mut()
                {
                    actions = m.on_data(now - *b, &chunk, sink);
                }
            }
            Some(Event::Resize(c, r)) => {
                if let Some(rec) = recorder.as_mut() {
                    rec.resize(c, r);
                }
            }
            Some(Event::Mark(v)) => {
                if exited.is_none()
                    && let Some(rec) = recorder.as_mut()
                {
                    rec.mark(&v);
                }
            }
            Some(Event::Exit(r)) => {
                if let Some((m, _)) = injector.as_mut() {
                    m.settle();
                }
                let exit = r.unwrap_or(PtyExit {
                    code: None,
                    signal: None,
                });
                exited = Some((exit, now));
            }
            Some(Event::ReaderDone) => {
                if let Some((exit, _)) = exited {
                    finish(&mut relay, sink, &mut recorder);
                    return Ok(TurnResult {
                        exit_code: exit.node_exit_code(),
                        timed_out,
                        tail: decode_tail_text(&tail.snapshot()),
                    });
                }
            }
            None => {}
        }
        if relay_at.is_some_and(|d| now >= d) {
            let (frame, again) = relay.window_end();
            if let Some(f) = frame {
                sink.on_output(&f);
            }
            relay_at = again.then_some(now + opts.coalesce_ms);
        }
        if let Some((exit, at)) = exited
            && now >= at + DRAIN_AFTER_EXIT_MS
        {
            finish(&mut relay, sink, &mut recorder);
            return Ok(TurnResult {
                exit_code: exit.node_exit_code(),
                timed_out,
                tail: decode_tail_text(&tail.snapshot()),
            });
        }
        if !timed_out && timeout_at.is_some_and(|d| now >= d) {
            timed_out = true;
            // 승격까지 `PtyHandle::kill` 이 갖는다 — 끝내는 길을 하나로(정본 `terminate` 주석).
            handle.kill(false);
        }
        if exited.is_none()
            && let Some((m, b)) = injector.as_mut()
        {
            actions.extend(m.on_tick(now - *b, sink));
        }
        for a in actions {
            match a {
                Action::Write(b) => handle.write(&b),
                Action::Injected => sink.on_injected(),
                Action::Attention(screen, kind) => sink.on_attention(&screen, kind),
                Action::TurnGate(screen) => sink.on_turn_gate(&screen),
                Action::Fail(e) => {
                    handle.kill(true);
                    // 정본은 여기서 녹화를 닫지 않았다(누락) — 닫는다. 회수는 회수 스레드가 끝까지 한다.
                    finish(&mut relay, sink, &mut recorder);
                    return Err(PtyTurnError::NotDelivered(e));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
