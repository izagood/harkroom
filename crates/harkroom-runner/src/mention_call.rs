//! `run_mention` 호출 자리(C1) — 멘션 하나를 실제로 돌리는 입구. 손님은 **에이전트 묶음([`AgentClients`])에서만** 꺼낸다.
//!
//! - deps(`MentionDeps` → [`LinkHooks`] → [`OnceRelease`])는 이 함수 한 번에 하나 짓고 이 함수 안에서 떨군다. 정상 길은
//!   `run_one` 이 슬롯·턴 끝·임대 끝을 부르고, 패닉 길은 풀림 중 deps 가 떨어질 때 남은 것만 부른다(각 한 번).
//! - 턴(`PtyTurnAttempt`)의 서버 길: 턴 열쇠 REST·임대 끝 알림은 [`AgentClients::attempt_base`], 준비는
//!   [`AgentClients::prepare_io`], 감시 루프는 [`mention_watch_loop`](그 멘션 슬롯), 턴 뒤 IO 는 [`AgentClients::after_turn`].
//!   이 넷은 이 함수가 지어 [`BundleParts`] 로 넘긴다 — 부르는 쪽(`build_parts`)은 손님 없는 재료(지시문·명령·결과 접기·
//!   마운트)만 채운다.
//! - 중계 세션은 `open_relay` 가 그 멘션 슬롯으로 연다. 턴은 그 세션의 공유 복제를 쥔다(떨굼 차례 턴 → 세션 → 자리).
//!
//! 아직 부르는 곳이 없다(스케줄러 고리는 C5). B4-5 스위치는 꺼져 있다.

use std::sync::{Arc, Mutex};

use crate::mention_admit::Launch;
use crate::mention_clients::{AgentClients, AgentLink};
use crate::mention_deps::{LaneFn, MentionDeps};
use crate::mention_hooks::{LinkHooks, SchedulerHooks};
use crate::mention_ledger::Ledger;
use crate::mention_parts::{AfterFn, MentionParts, WatchLoopFn};
use crate::mention_run::run_mention;
use crate::mention_sched::OnceRelease;
use crate::mention_target::build_mention_target;
use crate::mention_watch::{MentionWatchInputs, mention_watch_loop};
use crate::pty_turn::PtyTurnSink;
use crate::relay_session::SessionHandle;
use crate::turn_after::SilentSaid;
use crate::turn_attempt::TurnSecrets;
use crate::turn_attempt_account::{LiveSlot, MentionSlots};
use crate::turn_attempt_fold::AfterInputs;
use crate::turn_attempt_run::{AttemptBase, PtyTurnAttempt};
use crate::turn_prepare_io::McpPrepareIo;
use crate::turn_success::AfterTurnPlan;

/// 턴 뒤 IO 재료(손님 없음) — 계획·입력·마지막 말 읽개. 손님은 이 함수가 묶음에서 붙인다.
pub struct AfterData<'a> {
    pub plan: AfterTurnPlan,
    pub inputs: AfterInputs<'a>,
    pub last_said: Box<dyn FnMut() -> Option<String> + 'a>,
    pub silent_said: Box<dyn FnMut() -> SilentSaid + 'a>,
}

/// 턴 뒤 재료를 짓는다(C2 가 실물을 채운다).
pub type AfterSource<'a> = Box<dyn FnMut(&TurnSecrets) -> Result<AfterData<'a>, String> + 'a>;

/// 이 함수가 묶음에서 지어 넘기는 몫.
pub struct BundleParts<'a, L: AgentLink> {
    pub io: McpPrepareIo<'a, L>,
    pub after: AfterFn<'a>,
    pub watch_loop: WatchLoopFn<'a>,
    pub slot: LiveSlot,
}

/// 부르는 쪽이 손님 없는 재료로 `MentionParts` 를 짓는다.
pub type BuildParts<'a, L, S> =
    Box<dyn FnOnce(BundleParts<'a, L>) -> MentionParts<'a, McpPrepareIo<'a, L>, S> + 'a>;

/// 멘션 하나의 러너 재료(손님 없음).
pub struct CallInputs<'a, L: AgentLink, S: PtyTurnSink> {
    pub key: String,
    pub lane: LaneFn<'a>,
    pub now: fn() -> u64,
    pub claim_holder: Option<&'a str>,
    pub log: &'a dyn Fn(&str),
    pub watch: MentionWatchInputs<'a>,
    pub after: AfterSource<'a>,
    pub build_parts: BuildParts<'a, L, S>,
    /// 턴 열쇠 등록 가능 여부·상태 폴더·MCP 설정·러너 env·PAT(`AttemptBase` 의 손님 아닌 칸).
    pub base: BaseInputs<'a>,
}

/// `AttemptBase` 의 손님 아닌 칸.
pub struct BaseInputs<'a> {
    pub harness: crate::adapter::AgentHarness,
    pub can_register_turn_keys: bool,
    pub state_dir: &'a std::path::Path,
    pub mcp_config_path: &'a std::path::Path,
    pub runner_env: &'a std::collections::BTreeMap<String, String>,
    pub pat: &'a str,
}

/// 멘션 하나를 돌린다.
#[allow(clippy::too_many_arguments)]
pub fn run_mention_call<'a, L, S, H>(
    ledger: &Mutex<Ledger>,
    slots: &MentionSlots,
    clients: &'a AgentClients<L>,
    launch: Launch,
    sched: H,
    i: CallInputs<'a, L, S>,
    open_relay: impl FnOnce(&LiveSlot) -> Option<Arc<SessionHandle>>,
) where
    L: AgentLink + 'a,
    S: PtyTurnSink + 'a,
    H: SchedulerHooks,
{
    let target = build_mention_target(
        &launch.lead_entry,
        &launch.lead_mention,
        &launch.anchor,
        &launch.bundled,
    );
    let hooks = LinkHooks::new(
        clients.operator(),
        OnceRelease::new(
            sched,
            &launch.thread_key,
            launch.slot_held,
            &target.mention_id,
        ),
        i.key.clone(),
        i.now,
    );
    // 이 멘션의 deps — 이 함수 안에서만 산다(정상·패닉 모두 여기서 떨어진다).
    let mut deps = MentionDeps::new(
        clients.link_io(i.claim_holder, i.log),
        hooks,
        target.channel_id.clone(),
        Some(target.thread_root_id.clone()),
        target.mention_id.clone(),
        i.lane,
    );
    let CallInputs {
        watch,
        mut after,
        build_parts,
        base,
        ..
    } = i;
    run_mention(
        ledger,
        &mut deps,
        slots,
        launch,
        open_relay,
        move |slot: LiveSlot, relay: &Option<Arc<SessionHandle>>| {
            let after_fn: AfterFn<'a> = Box::new(move |s: &TurnSecrets| {
                let d = after(s)?;
                clients.after_turn(&d.plan, s, &d.inputs, d.last_said, d.silent_said)
            });
            let parts = build_parts(BundleParts {
                io: clients.prepare_io(),
                after: after_fn,
                watch_loop: mention_watch_loop(clients, watch, slot.clone()),
                slot,
            });
            let ab: AttemptBase<'a, L, L::Operator> = clients.attempt_base(
                base.harness,
                base.can_register_turn_keys,
                base.state_dir,
                base.mcp_config_path,
                base.runner_env,
                base.pat,
            );
            let turn = PtyTurnAttempt::new(ab, parts);
            match relay {
                Some(r) => turn.with_relay(Arc::clone(r)),
                None => turn,
            }
        },
    );
}

#[cfg(test)]
#[path = "mention_call_tests.rs"]
mod tests;
