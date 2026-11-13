//! 멘션 몸통(L2b-2) — [`crate::mention_admit_deps::ThreadLauncher`] 가 멘션마다 띄운 스레드 **안에서** 부르는 것(정본 `runOne`
//! 에서 `runMentionTurn` 까지).
//!
//! 차례: `build_mention_target` → [`read_mention`](묶음 손님으로 정의·가이드·승인·규칙·모델) → [`system_inputs`] →
//! [`CallMaker::call_inputs`] 로 그 멘션의 `CallInputs` 를 **새로** → [`run_mention_guarded`] 만 부른다. deps(`MentionDeps`·
//! `LinkHooks`)는 `run_mention_call` 이 그 안에서 새로 짓는다. 몸통은 멘션 사이에 나누는 값이 러너 수명 것(장부·슬롯 지도·
//! 임대 장부·묶음 손님·스케줄러 고리·짓개)뿐이고, 멘션의 재료(읽은 것·지시문 입력·`CallInputs`)는 이 함수의 지역 값이다
//! (security L2 ④).
//!
//! **정의를 못 읽으면 띄우지 않는다**: 장부에서 그 멘션을 놓고(`Ledger::release` — 시도 기록은 남아 재시도 상한이 그대로
//! 센다, 읽음 처리는 하지 않아 다음 폴이 다시 받는다), 임대·자리·턴 끝을 `Launch::release_holds` 로 한 번 놓는다(자리 놓기·
//! 턴 끝은 스케줄러 고리로 — 정상 길의 `OnceRelease` 와 같은 길). 턴 임대는 아직 받지 않았다.
//!
//! 실제 짓개(하네스·명령 옵션·세션 저장소·채널 이름·기억 — 폴 상태에서 나오는 값)는 L3(`main.rs`) 몫이다.

use std::sync::{Arc, Mutex};

use crate::mention_admit::Launch;
use crate::mention_call::{CallInputs, run_mention_guarded};
use crate::mention_clients::{AgentClients, AgentLink};
use crate::mention_hooks::{LeaseBook, SchedulerHooks};
use crate::mention_inputs::{MentionReads, SystemContext, read_mention, system_inputs};
use crate::mention_ledger::Ledger;
use crate::mention_parts::SystemInputs;
use crate::mention_sched::ChannelScheduler;
use crate::mention_target::{MentionTarget, build_mention_target};
use crate::pty_turn::PtyTurnSink;
use crate::relay_session::SessionHandle;
use crate::turn_attempt_account::{LiveSlot, MentionSlots};

/// 멘션 하나의 러너 쪽 재료를 짓는다(실물은 L3). 부를 때마다 **새** 값을 돌려준다 — 짓개는 멘션 사이 상태를 쥐지 않는다.
pub trait CallMaker<L: AgentLink, S: PtyTurnSink>: Send + Sync {
    /// 지시문 입력의 러너 쪽 값(채널 이름·기억·하네스 …).
    fn system_context(&self, target: &MentionTarget, reads: &MentionReads) -> SystemContext<'_>;
    /// 그 멘션의 `CallInputs`. `reads`·`system` 은 이 멘션 것이다.
    fn call_inputs<'a>(
        &'a self,
        clients: &'a AgentClients<L>,
        book: &'a LeaseBook,
        target: &MentionTarget,
        reads: MentionReads,
        system: SystemInputs,
    ) -> CallInputs<'a, L, S>;
    /// 인터랙티브 중계 세션 — Rust 러너에는 아직 없다.
    fn open_relay(&self, _slot: &LiveSlot) -> Option<Arc<SessionHandle>> {
        None
    }
}

/// 짓개를 러너가 다른 자리(배치 이름 표 갱신)와 나눠 쥘 수 있게 — `Arc` 로 감싼 짓개도 짓개다.
impl<L: AgentLink, S: PtyTurnSink, M: CallMaker<L, S>> CallMaker<L, S> for Arc<M> {
    fn system_context(&self, target: &MentionTarget, reads: &MentionReads) -> SystemContext<'_> {
        (**self).system_context(target, reads)
    }
    #[allow(clippy::result_large_err)]
    fn call_inputs<'a>(
        &'a self,
        clients: &'a AgentClients<L>,
        book: &'a LeaseBook,
        target: &MentionTarget,
        reads: MentionReads,
        system: SystemInputs,
    ) -> CallInputs<'a, L, S> {
        (**self).call_inputs(clients, book, target, reads, system)
    }
    fn open_relay(&self, slot: &LiveSlot) -> Option<Arc<SessionHandle>> {
        (**self).open_relay(slot)
    }
}

/// 몸통이 러너 수명 동안 나눠 쥐는 것.
pub struct BodyShared<L: AgentLink, M> {
    pub ledger: Arc<Mutex<Ledger>>,
    pub slots: MentionSlots,
    pub book: Arc<LeaseBook>,
    pub clients: Arc<AgentClients<L>>,
    pub sched: ChannelScheduler,
    pub maker: M,
}

/// 몸통이 어떻게 끝났나.
#[derive(Debug, PartialEq, Eq)]
pub enum BodyEnd {
    /// 돌렸다(`true` 면 패닉했고 `run_mention_guarded` 가 정리했다).
    Ran { panicked: bool },
    /// 정의를 못 읽어 띄우지 않았다 — 장부·임대·자리를 놓았다.
    DefinitionUnreadable,
    /// 띄우기 전 준비(읽기·지시문 입력·짓개)가 패닉했다 — 정의 못 읽음과 같이 놓았다.
    PreparePanicked,
}

/// 띄우지 않고 끝낼 때의 정리(정의 못 읽음·준비 패닉): 장부에서 그 멘션을 놓고(시도 기록은 남는다, 읽음 처리 없음 — 다음
/// 폴이 다시 받는다), 임대·자리·턴 끝을 `Launch::release_holds` 로 한 번 놓는다(자리·턴 끝은 스케줄러 고리). 패닉하지 않는다.
fn give_back<L: AgentLink, M>(sh: &BodyShared<L, M>, mut launch: Launch) {
    let (lead, key) = (launch.lead_id(), launch.thread_key.clone());
    sh.ledger
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .release(lead, &key);
    let (mut a, mut b) = (sh.sched.clone(), sh.sched.clone());
    launch.release_holds(&mut |k| a.release_slot(k), &mut |k, m| b.turn_ended(k, m));
}

/// 멘션 하나의 몸통. `ThreadLauncher` 의 스레드 안에서 부른다.
///
/// **몸통 전체가 지킴 안이다**(security L3 ①): 띄우기 전 준비(`read_mention`·`system_inputs`·`CallMaker`)는 이 함수의
/// `catch_unwind` 안에서, 띄운 뒤는 [`run_mention_guarded`] 안에서 돈다. 준비가 패닉하면 `Launch` 는 아직 이 함수가 쥐고
/// 있으므로 정의 못 읽음과 같은 정리([`give_back`])를 한다 — 멘션 장부 「도는 중」·턴 자리·턴 끝·임대가 남아 그 스레드가
/// 러너 재시작까지 멈추는 길이 없다.
pub fn run_body<L, S, M>(sh: &BodyShared<L, M>, launch: Launch) -> BodyEnd
where
    L: AgentLink + 'static,
    S: PtyTurnSink,
    M: CallMaker<L, S>,
{
    let clients: &AgentClients<L> = &sh.clients;
    let prepared = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let target = build_mention_target(
            &launch.lead_entry,
            &launch.lead_mention,
            &launch.anchor,
            &launch.bundled,
        );
        let reads = read_mention(clients, &target).ok()?;
        let system = system_inputs(&reads, &target, sh.maker.system_context(&target, &reads));
        Some(
            sh.maker
                .call_inputs(clients, &sh.book, &target, reads, system),
        )
    }));
    match prepared {
        Ok(Some(inputs)) => {
            let panicked = run_mention_guarded(
                &sh.ledger,
                &sh.slots,
                &sh.book,
                clients,
                launch,
                sh.sched.clone(),
                inputs,
                |slot| sh.maker.open_relay(slot),
            );
            BodyEnd::Ran { panicked }
        }
        Ok(None) => {
            eprintln!(
                "[mentionScheduler] {}: 정의를 못 읽어 띄우지 않는다 — 장부·임대·자리를 놓고 다음 폴에 다시 받는다",
                launch.thread_key
            );
            give_back(sh, launch);
            BodyEnd::DefinitionUnreadable
        }
        Err(_) => {
            eprintln!(
                "[mentionScheduler] {}: 띄우기 전 준비가 패닉했다 — 장부·임대·자리를 놓고 다음 폴에 다시 받는다",
                launch.thread_key
            );
            give_back(sh, launch);
            BodyEnd::PreparePanicked
        }
    }
}

/// `ThreadLauncher` 에 넘길 몸통 닫개.
pub fn body_fn<L, S, M>(sh: Arc<BodyShared<L, M>>) -> impl Fn(Launch, &str) + Send + Sync + 'static
where
    L: AgentLink + Send + Sync + 'static,
    S: PtyTurnSink + 'static,
    M: CallMaker<L, S> + 'static,
{
    move |launch: Launch, _mention_id: &str| {
        let _ = run_body::<L, S, M>(&sh, launch);
    }
}

#[cfg(test)]
#[path = "mention_body_tests.rs"]
mod tests;
