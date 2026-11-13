//! 정본 `mentionScheduler.ts::runOne` 의 조립(B4-1b-2b-2b) — 대상 만들기 → 턴 임대 판정 → 계정 축을 돌며 턴 →
//! 오류를 [`TurnEnd`] 로 접기 → 결말([`settle`]) → 장부 `finally`([`Ledger::release`]) → 임대·자리 놓기
//! ([`Launch::release_holds`]).
//!
//! 하네스 턴 자체(정본 `runMentionTurn`)는 [`TurnAttempt`] 뒤에 있다 — 본체는 B4-2 몫이고 여기서는 가짜로 시험한다.
//! 오류 분류(한도·세션 충돌·API 키 연결·모델 거절·정지·관문)는 그 오류 꼴이 [`TurnError::into_turn_end`] 로 접는다.
//!
//! 장부는 `Mutex` 로 받고 **턴이 도는 동안에는 잠그지 않는다** — 임대 판정·결말·`finally` 의 짧은 구간만 잡는다.
//! 정본은 단일 스레드라 같은 장부를 그대로 만지지만, 여기서는 턴이 작업 스레드에서 돌고 스케줄러가 그 사이 폴한다.
//! 결말 구간은 잠근 채 `SettleDeps`(통지·읽음)를 부른다 — 그 구현이 장부를 다시 잠그면 교착이다(`Mutex` 는 재진입하지 않는다).

use std::cell::RefCell;
use std::sync::{Mutex, MutexGuard};

use crate::account_assign::ClaudeAccount;
use crate::account_failover::{
    AccountFailure, AccountFailureClass, AttemptEnd, Mark, marks_after, switch_log_line,
    with_account_failover,
};
use crate::mention_admit::Launch;
use crate::mention_ledger::Ledger;
use crate::mention_settle::{LeaseGate, LeaseState, SettleDeps, TurnEnd, lease_gate, settle};
use crate::mention_target::{MentionTarget, build_mention_target};
use crate::turn_attempt_account::{LiveSlot, MentionSlots};

/// 턴이 답을 냈다(정본 `runMentionTurn` 의 반환 중 runOne 이 보는 몫).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TurnOk {
    pub stop_requested_at: Option<String>,
}

/// 턴 오류 하나(정본 `catch` 가 받는 `err`). 계정 전환 방아쇠인지는 [`AccountFailureClass`] 가 말한다.
pub trait TurnError: AccountFailureClass {
    /// 표식 판정용 끝 모양 — `Waiting`·`Credential`·`OtherErr` 중 하나(정본 `PromptNotDeliveredError.kind == 'waiting'`·
    /// `accountFailureOf(err).kind == 'credential'`).
    fn attempt_end(&self) -> AttemptEnd;
    /// 하네스 API 오류 줄이 실렸는가(정본 `turnOutcome(false)` 조건).
    fn harness_api_error(&self) -> bool;
    /// 계정 관문 때문에 접었다(정본 `AccountGateRequeueError`) — 실패가 아니라 다시 띄우기다.
    fn is_gate_requeue(&self) -> bool;
    /// 결말 갈래로 접는다. 준비 실패면 `err_text` 에 종류만 싣는다(화면 원문 금지).
    fn into_turn_end(self) -> TurnEnd;
}

/// 계정 하나로 턴 한 번(정본 `deps.runMentionTurn(deps.buildTurnDeps(...), target)`).
pub trait TurnAttempt {
    type Err: TurnError;
    /// `delivered` 는 프롬프트가 입력창까지 간 순간 `true` 로 세운다(정본 `onPromptDelivered`).
    fn run(
        &mut self,
        target: &MentionTarget,
        account: Option<&ClaudeAccount>,
        is_last_account: bool,
        delivered: &mut bool,
    ) -> Result<TurnOk, Self::Err>;
}

/// runOne 이 결말 밖에서 하는 일.
pub trait RunDeps<E>: SettleDeps {
    /// 이 스레드의 계정 축(정본 `laneFor`·`accountLane`). 풀이 없는 러너는 `[None]`.
    fn lane(&mut self, thread_key: &str, anchor: &str) -> Vec<Option<ClaudeAccount>>;
    /// 정본 `secretLeases.acquire(mention.id)`. 턴 임대를 안 쓰면 `Ready`.
    fn acquire_lease(&mut self, mention_id: &str) -> LeaseState;
    /// 「사람 손 필요」 표식(`Set`·`Clear` 만 온다, 실패는 삼킨다).
    fn attention(&mut self, account: &ClaudeAccount, mark: Mark);
    /// 「로그인 풀림」 표식(`Set`·`Clear` 만 온다, 실패는 삼킨다).
    fn auth(&mut self, account: &ClaudeAccount, mark: Mark);
    /// 계정 축 흔적 — 이어지는 실패 통지(`fail`)에 붙일 몫(정본 `withAccountTrail`·`accountTrailReason`). 축을 넘긴 적 없으면 빈 것.
    fn account_trail(&mut self, trail: &[AccountFailure]);
    /// 계정 축 소진 뒤, 통지보다 먼저(정본 `noticeHarnessLogin` → `exitIfUnrecoverable` — 물러날 수 있다).
    fn before_fail(&mut self, err: &E, mention_id: &str);
    /// 정본 `.finally` 의 자리 놓기와 감시 끝.
    fn release_slot(&mut self, thread_key: &str);
    fn turn_ended(&mut self, thread_key: &str, mention_id: &str);
}

fn lock(ledger: &Mutex<Ledger>) -> MutexGuard<'_, Ledger> {
    // 장부는 판정 도중 패닉하지 않는다 — 독이 들어도 장부 값은 쓸 만하다(정리를 멈추면 멘션이 묶인다).
    ledger.lock().unwrap_or_else(|p| p.into_inner())
}

/// 정본 `runOne`. 어느 길로 끝나든 장부 `finally` 와 [`Launch::release_holds`] 를 지난다.
pub fn run_one<T, D>(ledger: &Mutex<Ledger>, deps: &mut D, turn: &mut T, mut launch: Launch)
where
    T: TurnAttempt,
    D: RunDeps<T::Err>,
{
    let lead = launch.lead_id();
    let tried = launch.tried;
    run_body(ledger, deps, turn, &launch, lead, tried);
    lock(ledger).release(lead, &launch.thread_key);
    let mut release_slot = |key: &str| deps.release_slot(key);
    // 두 클로저가 같은 deps 를 빌리지 않게 감시 끝은 따로 모은다.
    let mut ended: Option<(String, String)> = None;
    launch.release_holds(&mut release_slot, &mut |k, m| {
        ended = Some((k.to_string(), m.to_string()));
    });
    if let Some((k, m)) = ended {
        deps.turn_ended(&k, &m);
    }
}

/// 실물 입구 — 멘션의 [중단]·펜스 신호 자리를 **첫 시도 전에** 열고([`MentionSlots::open`]), 그 자리에 [중단] 이 닿는
/// 중계 세션(`open_relay`, 멘션 하나에 하나 — 시도 사이에 온 [중단] 도 받는다)을 연 뒤, [`run_one`] 이 끝날 때까지
/// (장부 `finally`·임대·자리 놓기까지) 쥔다. 턴(`make_turn`)은 그 자리와 세션을 받아 시도마다 `bind_live`·입력 통로에
/// 쓴다. 떨구는 차례: 턴 → 중계 세션 → 자리.
pub fn run_mention<T, D, R>(
    ledger: &Mutex<Ledger>,
    deps: &mut D,
    slots: &MentionSlots,
    launch: Launch,
    open_relay: impl FnOnce(&LiveSlot) -> R,
    make_turn: impl FnOnce(LiveSlot, &R) -> T,
) where
    T: TurnAttempt,
    D: RunDeps<T::Err>,
{
    let mention_id = build_mention_target(
        &launch.lead_entry,
        &launch.lead_mention,
        &launch.anchor,
        &launch.bundled,
    )
    .mention_id;
    let held = slots.open(&mention_id);
    let relay = open_relay(&held.slot());
    {
        let mut turn = make_turn(held.slot(), &relay);
        run_one(ledger, deps, &mut turn, launch);
    }
    drop(relay);
    drop(held);
}

fn run_body<T, D>(
    ledger: &Mutex<Ledger>,
    deps: &mut D,
    turn: &mut T,
    launch: &Launch,
    lead: i64,
    tried: u32,
) where
    T: TurnAttempt,
    D: RunDeps<T::Err>,
{
    let target = build_mention_target(
        &launch.lead_entry,
        &launch.lead_mention,
        &launch.anchor,
        &launch.bundled,
    );
    let mention_id = target.mention_id.clone();
    let lane = deps.lane(&launch.thread_key, &launch.anchor);
    let state = deps.acquire_lease(&mention_id);
    match lease_gate(&mut lock(ledger), deps, lead, tried, state) {
        LeaseGate::Run => {}
        LeaseGate::Deferred | LeaseGate::GaveUp => return,
    }

    let cell = RefCell::new(&mut *deps);
    let result = with_account_failover(
        &lane,
        |account, is_last| {
            let mut delivered = false;
            let out = turn.run(&target, account, is_last, &mut delivered);
            if let Some(acc) = account {
                let end = match &out {
                    Ok(_) => AttemptEnd::Ok,
                    Err(e) => e.attempt_end(),
                };
                let marks = marks_after(end, delivered);
                let mut d = cell.borrow_mut();
                if marks.attention != Mark::Keep {
                    d.attention(acc, marks.attention);
                }
                if marks.auth != Mark::Keep {
                    d.auth(acc, marks.auth);
                }
            }
            out
        },
        |from, to, why| {
            cell.borrow_mut()
                .log(&switch_log_line(&mention_id, from, to, why));
        },
    );
    let fenced = launch.claim.as_ref().is_some_and(|c| c.fenced());

    let (end, api_error) = match result {
        Err(_empty) => {
            // 호출자 결함(축이 비었다) — 정본은 던져 `catch` 의 그 밖 갈래로 간다.
            (
                TurnEnd::Other {
                    err_text: "계정 축이 비었다".into(),
                },
                false,
            )
        }
        Ok(Ok(ok)) => (
            TurnEnd::Done {
                stop_requested_at: ok.stop_requested_at,
            },
            false,
        ),
        Ok(Err(fe)) => {
            let api = fe.error.harness_api_error();
            (
                fold_after_exhaust(deps, fe.error, &fe.trail, &mention_id, fenced),
                api,
            )
        }
    };
    settle(&mut lock(ledger), deps, lead, tried, end, fenced, api_error);
}

/// 계정 축 소진 뒤 오류를 접는다. 정본 순서: 펜싱 → 관문 → `noticeHarnessLogin`·`exitIfUnrecoverable` → 흔적 로그 → 갈래.
/// 펜싱·관문은 실패가 아니므로 물러남 판정과 흔적을 건너뛴다([`settle`] 이 그 둘을 먼저 가른다).
fn fold_after_exhaust<E, D>(
    deps: &mut D,
    err: E,
    trail: &[AccountFailure],
    mention_id: &str,
    fenced: bool,
) -> TurnEnd
where
    E: TurnError,
    D: RunDeps<E>,
{
    if fenced || err.is_gate_requeue() {
        return err.into_turn_end();
    }
    deps.before_fail(&err, mention_id);
    if !trail.is_empty() {
        let line = trail
            .iter()
            .map(|f| {
                format!(
                    "{}={}{}",
                    f.account.as_deref().unwrap_or("(기본)"),
                    f.kind.as_str(),
                    f.resets_at
                        .as_deref()
                        .map(|r| format!("({r})"))
                        .unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        deps.log(&format!("  {mention_id} 계정 축 소진: {line}"));
    }
    deps.account_trail(trail);
    err.into_turn_end()
}

#[cfg(test)]
#[path = "mention_run_tests.rs"]
mod tests;
