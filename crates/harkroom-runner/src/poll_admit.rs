//! 받아들이기 닫개 실물(L3c-1) — [`crate::poll_sched::AdmitFn`] 를 [`LinkAdmitDeps`] + [`admit`] 로 짓는다.
//!
//! - **손님은 묶음에서만**(security L3c): 닫개가 쥐는 서버 길은 그 에이전트의 [`AgentClients`] 하나와, 같은 묶음을 쥔
//!   [`ThreadClaims`] 뿐이다. 배치마다 `LinkAdmitDeps` 를 새로 지어(임대 칸 지도도 배치마다 새로) 띄우기는 받은
//!   [`LaunchQueue`] 에만 넣는다 — 실제 띄우기는 `RunnerScheduler` 가 장부 잠금을 놓은 뒤 한다.
//! - **장부 잠금 안의 서버 호출**(security nit #2091, 다시 봄): `admit` 는 `&mut Ledger` 를 처음부터 끝까지 쓰고(유예·시도·
//!   묶음 판정이 서버 응답 사이사이에 장부를 고친다), 정본도 한 줄로 돈다. 그동안 기다리는 쪽은 멘션 스레드의 장부 놓기
//!   (`run_one` 끝·패닉 정리)뿐이고, 그 스레드가 쥔 채 장부를 기다리는 잠금은 없다(임대 `wire`·슬롯 잠금은 장부 전에 놓인다)
//!   → 교착이 아니라 지연이다. 지연의 상한은 배치 하나의 서버 호출 시간(각 호출은 링크 시한을 가진다)이다. 그래서 유지한다.

use std::sync::Arc;

use serde_json::Value;

use crate::mention_admit::admit;
use crate::mention_admit_deps::LinkAdmitDeps;
use crate::mention_clients::AgentClients;
use crate::mention_ledger::Ledger;
use crate::poll_loop::{AdmitOutcome, BatchContext};
use crate::poll_sched::{AdmitFn, LaunchQueue};
use crate::rest::RunnerLink;
use crate::thread_claims::ThreadClaims;
use crate::turn_attempt_account::MentionSlots;

/// 실물 받아들이기 닫개.
pub fn link_admit_fn<L: RunnerLink + 'static>(
    clients: Arc<AgentClients<L>>,
    claims: Arc<ThreadClaims<AgentClients<L>>>,
    slots: MentionSlots,
    now: fn() -> u64,
) -> Box<AdmitFn> {
    Box::new(
        move |ledger: &mut Ledger,
              batch: &Value,
              ctx: &BatchContext,
              queue: &mut LaunchQueue|
              -> Result<AdmitOutcome, String> {
            let mut deps = LinkAdmitDeps::new(&clients, &claims, slots.clone(), now, queue);
            admit(ledger, &mut deps, batch, ctx)
        },
    )
}

#[cfg(test)]
#[path = "poll_admit_tests.rs"]
mod tests;
