//! `run_mention` 호출 자리(C1) — 멘션 하나를 실제로 돌리는 입구. 손님은 **에이전트 묶음([`AgentClients`])에서만** 꺼낸다.
//!
//! - deps(`MentionDeps` → [`LinkHooks`] → [`OnceRelease`])는 이 함수 한 번에 하나 짓고 이 함수 안에서 떨군다. 정상 길은
//!   `run_one` 이 슬롯·턴 끝·(결말이 놓는 갈래면) 임대 끝을 부르고, 패닉 길은 풀림 중 deps 가 떨어질 때 남은 것만 부른다(각 한 번).
//! - 턴 임대는 러너 수명의 [`LeaseBook`] 이 쥔다(정본 `secretLeases`). 재시도 갈래는 놓지 않으므로 다음 호출이 장부의 임대를
//!   그대로 쓴다(다시 발급 청하지 않음 — 서버는 멘션당 한 번만 준다).
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
use crate::mention_hooks::{LeaseBook, LinkHooks, SchedulerHooks};
use crate::mention_ledger::Ledger;
use crate::mention_parts::{AfterCtx, AfterFn, MentionParts, WatchLoopFn};
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
use serde_json::Value;

/// 턴 뒤 IO 재료(손님 없음) — 계획·입력·마지막 말 읽개. 손님은 이 함수가 묶음에서 붙인다.
pub struct AfterData {
    pub plan: AfterTurnPlan,
    pub inputs: OwnedAfterInputs,
    /// 통지에 인용할 마지막 말(판정·통지 함수가 가린다).
    pub last_said: Option<String>,
}

/// [`AfterInputs`] 의 소유본 — 보고처 약속은 아직 싣지 않는다(`promise: None`, C5).
#[derive(Clone, Debug)]
pub struct OwnedAfterInputs {
    pub key: String,
    pub me_id: String,
    pub channel_id: String,
    pub anchor: Option<String>,
    pub mention_id: String,
    pub caller: crate::turn_notice::NudgeCaller,
    pub proxy_head: String,
    pub record_proxy: bool,
    pub wake_reason: String,
    pub background_wait_ms: u64,
    pub turn_start_seq: i64,
    pub turn_id: String,
}

impl OwnedAfterInputs {
    pub fn view(&self) -> AfterInputs<'_> {
        AfterInputs {
            key: &self.key,
            me_id: &self.me_id,
            channel_id: &self.channel_id,
            anchor: self.anchor.as_deref(),
            mention_id: &self.mention_id,
            caller: self.caller,
            proxy_head: &self.proxy_head,
            record_proxy: self.record_proxy,
            wake_reason: &self.wake_reason,
            background_wait_ms: self.background_wait_ms,
            turn_start_seq: self.turn_start_seq,
            turn_id: &self.turn_id,
            promise: None,
        }
    }
}

/// 턴 뒤 재료를 짓는다 — 그 시도의 사실(`AfterCtx`)과 턴 뒤에 다시 읽은 앵커 스레드(시작 seq 뒤)를 받는다. 실물은
/// [`crate::turn_after_source::after_source`].
pub type AfterSource<'a> = Box<dyn FnMut(&AfterCtx, &[Value]) -> AfterData + 'a>;

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
    book: &'a LeaseBook,
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
        book,
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
            let (ch, root) = (target.channel_id.clone(), target.thread_root_id.clone());
            let after_fn: AfterFn<'a> = Box::new(move |s: &TurnSecrets, a: &AfterCtx| {
                // 정본 `readThread(channelId, anchor, turnStartSeq)` — 묶음 손님으로. 못 읽으면 턴 뒤 IO 를 접는다(best-effort,
                // 정본은 로그만 남기고 턴을 실패로 만들지 않는다).
                let rows = match clients.mcp().read_thread(
                    &ch,
                    Some(&root),
                    Some(a.ctx.turn_start_seq),
                    crate::turn_prepare_io::THREAD_PAGE,
                ) {
                    Ok(r) => r,
                    Err(e) => {
                        eprintln!("[mentionTurn] 턴 뒤 발화 확인 실패(통지 생략) — {e}");
                        return Ok(());
                    }
                };
                // 묻기는 이 스레드로 했지만, 섞여 와도 이 스레드 글만 센다(준비 쪽 #2061·#2062 와 짝).
                let rows: Vec<Value> = rows
                    .into_iter()
                    .filter(|m| crate::turn_prepare::in_thread(m, &ch, &root))
                    .collect();
                let d = after(a, &rows);
                let inputs = d.inputs.view();
                let said = d.last_said;
                let said2 = said.clone();
                clients.after_turn(
                    &d.plan,
                    s,
                    &inputs,
                    Box::new(move || said.clone()),
                    Box::new(move || SilentSaid {
                        last_said: said2.clone(),
                        ..SilentSaid::default()
                    }),
                )
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
