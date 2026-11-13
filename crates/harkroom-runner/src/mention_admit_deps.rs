//! [`AdmitDeps`] 실물(L2b) — 정본 `main.ts` 가 `createMentionScheduler` 에 넘기는 deps 중 받아들이기 몫.
//!
//! - **서버 손님은 묶음([`AgentClients`])에서만** 꺼낸다(security L2 ③): 대기 통지·조종 상한 경고·읽음은 `clients.mcp()`,
//!   동시 턴 자리는 `clients.rest()`, 스레드 임대는 같은 묶음을 쥔 [`ThreadClaims`]. 다른 링크를 지을 길이 없다.
//! - **임대 잃음 → 그 멘션 슬롯**(security L2 ①): 잡기(`hold_claim`)는 묶기보다 앞서 대표 멘션을 모른다. 그래서 임대마다
//!   칸([`FenceCell`])을 두고 `on_lost` 는 칸에 「잃음」을 적고, `launch` 가 칸에 대표 멘션 id 를 적는다. 둘 다 칸 잠금 안에서
//!   서로를 보므로 어느 쪽이 먼저든 [`MentionSlots::fence_lost_or_hold`] 가 한 번은 불린다 — 슬롯이 아직 안 열렸으면 열 때
//!   표지가 함께 선다(틈 없음).
//! - **`on_lost` 는 표지만 세운다**(security L2 ②): 박동 시계 스레드에서 불리므로 손잡이의 `release` 를 부르지 않는다(시계를
//!   떨구며 제 스레드를 기다리는 교착). 놓기는 턴이 끝난 뒤 `Launch::release_holds`·Drop 몫이다.
//! - **읽음은 받은 id 만**(⑤): `mark_read` 는 받아들이기가 넘긴 그 id 들만 `inbox.read` 로 보낸다.
//! - **멘션마다 새로**(④): 띄우기는 [`MentionLauncher`] 에 넘긴다 — 실물 띄우개는 멘션 하나마다 deps·`CallInputs` 를 새로 짓는다.
//!
//! 아직 없는 것(정본에는 있다): 조종(인터랙티브 턴)·레지스트리·이관(앞 세대가 쥔 entry)이 Rust 러너에 없다. 그래서
//! `control_of`=없음, `registry_busy`=아님, `held_entry_ids`=빈 집합, `defer`·`mark_warned`·`reserve_mention`=아무것도 안 함이다.
//! 조종·이관은 node 러너만 하고, Rust 러너로 바꾼 에이전트에는 그 길이 열리지 않는다(B4-5 스위치 조건).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::json;

use crate::account_assign::shared::{is_attention_active, read_account_attention};
use crate::mcp::FailOpts;
use crate::mention_admit::{AdmitDeps, AdmitNotice, ClaimHold, Launch};
use crate::mention_clients::AgentClients;
use crate::mention_target::build_mention_target;
use crate::rest::{RunnerLink, SlotOutcome};
use crate::thread_claims::{ClaimClient, OnLost, ThreadClaims};
use crate::turn_attempt_account::MentionSlots;
use crate::turn_registry::{DeferResult, ThreadControl};

impl<L: RunnerLink> ClaimClient for AgentClients<L> {
    fn claim(
        &self,
        channel_id: &str,
        root: &str,
        holder: &str,
        ttl_sec: u64,
    ) -> Result<crate::rest::ClaimOutcome, String> {
        ClaimClient::claim(self.rest(), channel_id, root, holder, ttl_sec)
    }
    fn release(&self, channel_id: &str, root: &str, holder: &str) -> Result<(), String> {
        ClaimClient::release(self.rest(), channel_id, root, holder)
    }
}

/// 띄우기 몸통 — 멘션 하나마다 deps·`CallInputs` 를 새로 지어 돌린다(실물은 스레드 하나, 끝나면 `Launch::release_holds`).
pub trait MentionLauncher {
    /// `mention_id` 는 그 멘션 슬롯의 열쇠(`build_mention_target(..).mention_id`).
    fn launch(&mut self, launch: Launch, mention_id: String);
}

/// 실물 띄우개 — 멘션 하나마다 스레드 하나를 띄워 `body` 를 부른다(정본 `runOne` 을 `await` 없이 띄우는 자리). `body` 는 그
/// 멘션의 deps·`CallInputs` 를 **그 안에서 새로** 짓는다(④) — 이 값은 멘션 사이에 나눌 상태를 쥐지 않는다(`body` 는 `Fn`).
///
/// `body` 가 돌아오거나 패닉으로 풀린 뒤 그 멘션의 대기 펜스 표지를 지운다 — 슬롯을 열지 못하고 끝난 멘션의 표지가 다음
/// 시도(새 임대)에 남지 않게. 그때 임대 손잡이는 이미 놓였다(`Launch` 가 `body` 안에서 떨어지며 박동이 멈춘다) — 지운 뒤
/// 늦게 오는 잃음 알림이 없다.
pub struct ThreadLauncher<F> {
    slots: MentionSlots,
    body: Arc<F>,
}

impl<F> ThreadLauncher<F>
where
    F: Fn(Launch, &str) + Send + Sync + 'static,
{
    pub fn new(slots: MentionSlots, body: F) -> Self {
        Self {
            slots,
            body: Arc::new(body),
        }
    }
}

impl<F> MentionLauncher for ThreadLauncher<F>
where
    F: Fn(Launch, &str) + Send + Sync + 'static,
{
    fn launch(&mut self, launch: Launch, mention_id: String) {
        // 띄우지 못하면(스레드 자원 고갈) 이 자리에서 돌린다 — 몸통이 끝나야 장부·자리·임대가 놓인다.
        let job = Arc::new(Mutex::new(Some((launch, mention_id.clone()))));
        let run = {
            let (slots, body) = (self.slots.clone(), Arc::clone(&self.body));
            move |job: &Mutex<Option<(Launch, String)>>| {
                let Some((launch, mention_id)) =
                    job.lock().unwrap_or_else(|e| e.into_inner()).take()
                else {
                    return;
                };
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    body(launch, &mention_id)
                }));
                slots.forget_pending_fence(&mention_id);
                if r.is_err() {
                    eprintln!("[mentionTurn] {mention_id}: 멘션 스레드가 패닉으로 끝났다");
                }
            }
        };
        let (j, r) = (Arc::clone(&job), run.clone());
        let spawned = std::thread::Builder::new()
            .name(format!("mention-{mention_id}"))
            .spawn(move || r(&j));
        if let Err(e) = spawned {
            eprintln!(
                "[mentionTurn] {mention_id}: 멘션 스레드를 띄우지 못했다 — 이 자리에서 돌린다({e})"
            );
            run(&job);
        }
    }
}

#[derive(Default)]
struct CellState {
    mention: Option<String>,
    lost: bool,
}

/// 임대 하나의 「잃음 → 멘션 슬롯」 칸.
#[derive(Clone)]
pub struct FenceCell {
    state: Arc<Mutex<CellState>>,
    slots: MentionSlots,
}

impl FenceCell {
    pub fn new(slots: MentionSlots) -> Self {
        Self {
            state: Arc::default(),
            slots,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CellState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 박동 시계가 부를 알림 — 표지만 세운다(놓기 없음).
    pub fn on_lost(&self) -> OnLost {
        let cell = self.clone();
        Arc::new(move || cell.lost())
    }

    fn lost(&self) {
        let target = {
            let mut st = self.lock();
            st.lost = true;
            st.mention.clone()
        };
        if let Some(m) = target {
            self.slots.fence_lost_or_hold(&m);
        }
    }

    /// 대표 멘션을 적는다. 이미 잃었으면 지금 그 멘션에 표지를 세운다(슬롯이 안 열렸으면 열 때).
    pub fn bind(&self, mention_id: &str) {
        let lost = {
            let mut st = self.lock();
            st.mention = Some(mention_id.to_string());
            st.lost
        };
        if lost {
            self.slots.fence_lost_or_hold(mention_id);
        }
    }
}

/// 받아들이기 실물.
pub struct LinkAdmitDeps<'a, L: RunnerLink + 'static, M: MentionLauncher> {
    clients: &'a AgentClients<L>,
    claims: &'a ThreadClaims<AgentClients<L>>,
    slots: MentionSlots,
    now: fn() -> u64,
    launcher: M,
    /// 이번 폴에 잡은 임대의 칸(채널·앵커 열쇠). `launch` 가 꺼내 대표 멘션을 적는다.
    cells: HashMap<(String, String), FenceCell>,
}

impl<'a, L: RunnerLink + 'static, M: MentionLauncher> LinkAdmitDeps<'a, L, M> {
    pub fn new(
        clients: &'a AgentClients<L>,
        claims: &'a ThreadClaims<AgentClients<L>>,
        slots: MentionSlots,
        now: fn() -> u64,
        launcher: M,
    ) -> Self {
        Self {
            clients,
            claims,
            slots,
            now,
            launcher,
            cells: HashMap::new(),
        }
    }
}

fn notice_value(n: &AdmitNotice) -> (serde_json::Value, String) {
    match n {
        AdmitNotice::BlockedByTurn => (
            json!({"key": "blocked_by_turn"}),
            "(이 스레드에서 앞 턴이 아직 돌고 있습니다 — 이 글은 그 턴이 끝나면 읽습니다. \
             바로 멈추려면 도는 턴 목록이나 그 턴의 터미널 창에서 「멈추기」를 누르세요)"
                .to_string(),
        ),
        AdmitNotice::Controlled { handle, pending } => (
            json!({"key": "controlled", "handle": handle, "pending": pending}),
            format!(
                "(지금 {handle} 이(가) 직접 조종 중입니다 — 이 멘션은 대기 {pending}건째입니다. \
                 조종이 끝나면 처리합니다: 터미널에서 하네스를 종료하거나, Agents 탭에서 「조종 끝내기」)"
            ),
        ),
    }
}

impl<L: RunnerLink + 'static, M: MentionLauncher> AdmitDeps for LinkAdmitDeps<'_, L, M> {
    fn now(&self) -> u64 {
        (self.now)()
    }
    fn held_entry_ids(&self) -> HashSet<i64> {
        HashSet::new() // 이관 없음 — 모듈 머리 주석.
    }
    fn attention_active(&mut self, config_dir: &str) -> bool {
        let a = read_account_attention(std::path::Path::new(config_dir));
        is_attention_active(a.as_ref(), (self.now)() as f64)
    }
    fn control_of(&self, _key: &str) -> Option<ThreadControl> {
        None // 조종 없음.
    }
    fn defer(&mut self, _key: &str, _entry_id: i64, _seq: i64, _now: u64) -> DeferResult {
        // `control_of` 가 늘 `None` 이라 불리지 않는다.
        DeferResult {
            should_notify: false,
            pending: 0,
            held_ms: 0,
            warned: true,
        }
    }
    fn mark_warned(&mut self, _key: &str) {}
    fn registry_busy(&self, _key: &str) -> bool {
        false // 레지스트리 없음 — 스레드당 하나는 장부(`thread_in_flight`)와 임대가 지킨다.
    }
    fn reserve_mention(&mut self, _key: &str) {}
    fn notice(
        &mut self,
        channel_id: &str,
        anchor: &str,
        notice: &AdmitNotice,
    ) -> Result<(), String> {
        let (v, fallback) = notice_value(notice);
        self.clients
            .mcp()
            .notice(channel_id, Some(anchor), &v, &fallback)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    fn fail(
        &mut self,
        channel_id: &str,
        anchor: &str,
        body: &str,
        what: &str,
        reason: &str,
    ) -> Result<(), String> {
        let opts = FailOpts {
            retryable: false,
            what: Some(what.to_string()),
            reason: Some(reason.to_string()),
            ..FailOpts::default()
        };
        self.clients
            .mcp()
            .fail(channel_id, body, Some(anchor), &opts)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    fn hold_claim(&mut self, channel_id: &str, anchor: &str) -> ClaimHold {
        let cell = FenceCell::new(self.slots.clone());
        let hold = self.claims.hold(channel_id, anchor, Some(cell.on_lost()));
        if matches!(hold, ClaimHold::Held(_)) {
            self.cells
                .insert((channel_id.to_string(), anchor.to_string()), cell);
        }
        hold
    }
    fn acquire_slot(&mut self, key: &str) -> Option<SlotOutcome> {
        Some(self.clients.rest().acquire_turn_slot(key, None))
    }
    fn release_slot(&mut self, key: &str) {
        self.clients.rest().release_turn_slot(key);
    }
    fn turn_started(&mut self, _key: &str, _message_id: &str) {
        // 정본 `turnWatch.started` — 화면 끝 감시가 아직 없다.
    }
    fn mark_read(&mut self, ids: &[i64]) -> Result<(), String> {
        self.clients
            .mcp()
            .mark_read(ids)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    fn launch(&mut self, launch: Launch) {
        let mention_id = build_mention_target(
            &launch.lead_entry,
            &launch.lead_mention,
            &launch.anchor,
            &launch.bundled,
        )
        .mention_id;
        let channel = crate::mention_admit::str_of(&launch.lead_mention, "channelId").to_string();
        if let Some(cell) = self.cells.remove(&(channel, launch.anchor.clone())) {
            cell.bind(&mention_id);
        }
        // 손잡이가 이미 잃음을 알고 있으면(칸이 없던 길 포함) 같은 표지를 세운다 — 두 번 세워도 같다.
        if launch.claim.as_ref().is_some_and(|c| c.fenced()) {
            self.slots.fence_lost_or_hold(&mention_id);
        }
        self.launcher.launch(launch, mention_id);
    }
}

#[cfg(test)]
#[path = "mention_admit_deps_tests.rs"]
mod tests;
