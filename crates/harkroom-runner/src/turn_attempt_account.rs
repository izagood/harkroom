//! `AttemptParts` 실물의 계정 몫과 펜스·[중단] 듣기 자리.
//!
//! - [`AttemptAccount`]: 시도 하나가 쓸 계정(정본 `buildTurnDeps` 의 `claudeAccount`·`claudeConfigDir`·`callsForHuman`).
//!   **시도마다 그 시도의 계정으로 새로 만든다** — 계정 폴더(`config_dir`)는 이 값에서만 나와 명령 옵션
//!   ([`AttemptAccount::command`])과 기록 찾기 자리([`AttemptAccount::homes`])로 간다. 기본 명령 옵션에 무엇이 들어 있든
//!   덮는다 — 계정이 없는 시도는 `None`(정본 `account?.configDir ?? null`), 앞 시도의 폴더가 남지 않는다.
//! - [`LiveSlot`]: 펜스 잃음·[중단] 을 받는 쪽(스케줄러·오퍼레이터 신호)이 쥐는 손잡이. `bind_live` 가 지금 시도의
//!   [`LiveTurn`] 을 걸고 놓는다. 펜스 잃음은 걸린 시도에만, [중단] 은 멘션 단위로도 남아 다음 시도의 관문이 본다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::account_assign::{ClaudeAccount, ClaudePoolLane};
use crate::turn_attempt_live::LiveTurn;
use crate::turn_attempt_run::OwnedHomes;
use crate::turn_command::TurnCommandOptions;

/// 시도 하나의 계정(소유본).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AttemptAccount {
    pub name: Option<String>,
    /// 이 계정의 `CLAUDE_CONFIG_DIR`. 계정이 없으면 `None`(하네스 기본).
    pub config_dir: Option<PathBuf>,
    pub pool: Option<String>,
    /// 사람 부르기는 축의 마지막 계정에서만 연다(정본 `callsForHuman: isLastAccount`).
    pub calls_for_human: bool,
}

impl AttemptAccount {
    pub fn of(account: Option<&ClaudeAccount>, is_last_account: bool) -> Self {
        Self {
            name: account.map(|a| a.name.clone()),
            config_dir: account.map(|a| a.config_dir.clone()),
            pool: account.and_then(|a| a.pool.clone()),
            calls_for_human: is_last_account,
        }
    }

    /// 기본 명령 옵션 위에 이 시도의 계정 폴더를 얹는다 — 기본에 든 값은 **언제나** 덮는다.
    pub fn command<'a>(&'a self, base: &TurnCommandOptions<'a>) -> TurnCommandOptions<'a> {
        let mut o = base.clone();
        o.claude_config_dir = self.config_dir.as_deref();
        o
    }

    /// 기록 찾기 자리 — claude 기록은 이 시도의 계정 폴더에서만 찾는다.
    pub fn homes(
        &self,
        home: Option<&Path>,
        omp_home: Option<&Path>,
        codex_home: Option<&Path>,
    ) -> OwnedHomes {
        OwnedHomes {
            claude_config_dir: self.config_dir.clone(),
            home: home.map(Path::to_path_buf),
            omp_home: omp_home.map(Path::to_path_buf),
            codex_home: codex_home.map(Path::to_path_buf),
        }
    }
}

/// 계정 축의 지금 모습(정본 `LiveLaneValue` 중 칩이 보는 몫).
#[derive(Clone, Debug, Default)]
pub struct LaneSnapshot {
    /// 기동 때 정한 lane 의 풀(계정이 풀을 모를 때 쓴다).
    pub pool: Option<String>,
    /// 이 러너의 풀 순서.
    pub chain: Vec<ClaudePoolLane>,
    /// 지금 계정 축.
    pub lane: Vec<Option<ClaudeAccount>>,
}

/// 칩 순번(정본 `accountRanks`) — **이름은 내지 않는다**(칩 ②, #1039). `(계정 순번, 풀 순번)`:
/// 계정 순번은 `Some(None)` = 기본 로그인(계정 없음), `Some(Some(n))` = 그 풀(풀 순서에 없으면 지금 축) 안 n 번째,
/// `None` = 모른다. 풀 순번은 풀 순서에 있을 때만 `Some(n)`.
pub fn account_ranks(
    snap: &LaneSnapshot,
    account: Option<&ClaudeAccount>,
) -> (Option<Option<u32>>, Option<u32>) {
    let Some(a) = account else {
        return (Some(None), None);
    };
    let pool = a.pool.as_ref().or(snap.pool.as_ref());
    let idx = pool.and_then(|p| snap.chain.iter().position(|c| &c.pool == p));
    let at = match idx {
        Some(i) => snap.chain[i].accounts.iter().position(|x| x.name == a.name),
        None => snap.lane.iter().flatten().position(|x| x.name == a.name),
    };
    let to_rank = |i: usize| u32::try_from(i + 1).ok();
    (at.and_then(to_rank).map(Some), idx.and_then(to_rank))
}

/// 지금 시도의 [`LiveTurn`] 을 가리키는 손잡이 — 신호를 받는 쪽이 복제해 쥔다. **멘션 하나에 하나**(`run_one` 한 번)다.
///
/// [중단] 은 멘션 단위로도 남는다: 시도 **사이**(앞 시도 놓기 ~ 다음 시도 걸기)에 온 [중단] 도 버리지 않고 적어 두었다가,
/// 다음 시도를 걸 때 그 시도의 `LiveTurn` 에 먼저 싣는다 → 그 시도의 띄우기 관문(`spawn_gate`)이 막는다.
/// 펜스 잃음은 시도 단위다(멘션 단위 펜스는 장부의 임대 판정이 따로 본다).
#[derive(Clone, Default)]
pub struct LiveSlot(Arc<Mutex<SlotState>>);

#[derive(Default)]
struct SlotState {
    live: Option<Arc<LiveTurn>>,
    /// 이 멘션에서 처음 [중단] 한 사람.
    canceled_by: Option<String>,
    /// 이 멘션의 **스레드** 임대(러너 사이 잠금, `thread_claims`)를 잃었다 — 한 번 서면 내려가지 않는다. 턴 임대 잃음
    /// ([`LiveSlot::fence_lost`])은 그 시도만의 것이라 다음 시도가 새 임대로 돌지만, 스레드 임대는 멘션 전체의 것이다.
    claim_lost: bool,
}

impl LiveSlot {
    fn lock(&self) -> MutexGuard<'_, SlotState> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `AttemptParts::bind_live` 의 몸통. 걸 때 멘션 단위 [중단] 이 있으면 그 시도에 먼저 싣는다(같은 잠금 안 — 틈 없음).
    pub fn bind(&self, live: Option<Arc<LiveTurn>>) {
        let mut st = self.lock();
        if let (Some(l), Some(by)) = (&live, &st.canceled_by) {
            l.cancel(by);
        }
        if let (Some(l), true) = (&live, st.claim_lost) {
            l.fence_lost();
        }
        st.live = live;
    }

    /// 턴 임대를 잃었다 — 지금 걸린 시도에만. 걸린 것이 없으면 `false`.
    pub fn fence_lost(&self) -> bool {
        self.lock().live.as_ref().map(|l| l.fence_lost()).is_some()
    }

    /// 이 멘션의 스레드 임대를 잃었다 — 멘션 단위로 남기고(다음 시도도 걸리는 순간 펜스), 지금 걸린 시도가 있으면 그 시도에도.
    pub fn claim_lost(&self) {
        let mut st = self.lock();
        st.claim_lost = true;
        if let Some(l) = &st.live {
            l.fence_lost();
        }
    }

    /// 사람이 [중단] 했다 — 멘션 단위로 남기고(처음 사람이 남는다), 지금 걸린 시도가 있으면 그 시도에도. 돌던 시도에
    /// 닿았으면 `true`, 시도 사이였으면 `false`(그래도 다음 시도는 막힌다).
    pub fn cancel(&self, by: &str) -> bool {
        let mut st = self.lock();
        if st.canceled_by.is_none() {
            st.canceled_by = Some(by.to_string());
        }
        st.live.as_ref().map(|l| l.cancel(by)).is_some()
    }

    /// 이 멘션에서 [중단] 한 사람.
    pub fn canceled_by(&self) -> Option<String> {
        self.lock().canceled_by.clone()
    }

    /// 지금 시도를 접어야 하는가 — 걸린 시도가 임대를 잃었거나, 이 멘션·그 시도에 [중단] 이 있다(띄운 순간 접기에 쓴다).
    pub fn stop_requested(&self) -> bool {
        let st = self.lock();
        st.canceled_by.is_some()
            || st.claim_lost
            || st
                .live
                .as_ref()
                .is_some_and(|l| l.fenced_out() || l.canceled_by().is_some())
    }

    /// 걸린 시도가 턴 임대를 잃었다(감시 루프의 펜스 확인). 걸린 시도가 없으면 `false`.
    pub fn fenced_out(&self) -> bool {
        self.lock().live.as_ref().is_some_and(|l| l.fenced_out())
    }

    pub fn is_bound(&self) -> bool {
        self.lock().live.is_some()
    }

    fn same(&self, other: &LiveSlot) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

/// 러너 전체의 [중단]·펜스 신호 길 — 멘션 id 마다 **새** [`LiveSlot`] 을 연다([`MentionSlots::open`]). 러너 전역 슬롯
/// 하나를 쓰면 앞 멘션의 [중단] 이 다음 멘션을 영원히 막는다 — 그래서 슬롯은 멘션 하나(`run_one` 한 번)의 수명이고,
/// [`MentionSlot`] 이 떨어지면 지도에서 빠진다. 열리지 않은 멘션에 온 신호는 버린다(`false`).
#[derive(Clone, Default)]
pub struct MentionSlots {
    map: Arc<Mutex<HashMap<String, LiveSlot>>>,
    /// 슬롯이 열리기 **전에** 임대를 잃은 멘션 — 열 때 펜스 표지를 함께 세운다(틈 없음).
    pending_fence: Arc<Mutex<std::collections::HashSet<String>>>,
}

impl MentionSlots {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, LiveSlot>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn pending(&self) -> MutexGuard<'_, std::collections::HashSet<String>> {
        self.pending_fence.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 그 멘션의 스레드 임대를 잃었다 — 열린 슬롯이면 거기 세우고, 아직 안 열렸으면 기억했다가 열 때 세운다.
    ///
    /// **틈 없음**: [`Self::open`] 과 같은 차례(대기 표 → 지도)로 대기 표를 쥔 채 지도를 본다 — 「지도에 없음」을 본 뒤 기억하기
    /// 전에 슬롯이 열려 표지를 놓치는 길이 없다. 슬롯 표지는 두 잠금을 놓은 뒤 세운다(슬롯 잠금을 겹쳐 쥐지 않는다).
    pub fn fence_lost_or_hold(&self, mention_id: &str) {
        let open = {
            let mut pending = self.pending();
            let open = self.get(mention_id);
            if open.is_none() {
                pending.insert(mention_id.to_string());
            }
            open
        };
        if let Some(s) = open {
            s.claim_lost();
        }
    }

    /// 그 멘션에 열기를 기다리는 펜스 표지가 있는가(진단·시험용).
    pub fn has_pending_fence(&self, mention_id: &str) -> bool {
        self.pending().contains(mention_id)
    }

    /// 그 멘션에 남은 대기 표지를 지운다 — 슬롯을 열지 못하고 끝난 멘션의 표지가 다음 시도(새 임대)에 남지 않게.
    pub fn forget_pending_fence(&self, mention_id: &str) {
        self.pending().remove(mention_id);
    }

    /// 이 멘션의 슬롯을 **새로** 연다(같은 id 의 옛 슬롯이 남아 있어도 바꾼다). 같은 멘션은 동시에 두 번 돌지 않는다 —
    /// 멘션의 스레드 열쇠(채널·앵커)가 정해져 있고 장부가 그 열쇠로 한 번에 하나만 띄운다(`Ledger::thread_in_flight`).
    /// 그래도 열린 id 를 다시 열면 로그를 남긴다(겹치면 앞 실행의 [중단] 이 뒤 슬롯으로 간다).
    ///
    /// 열기 전에 임대를 잃었으면([`Self::fence_lost_or_hold`]) 지도에 넣기 **전에** 표지를 세운다.
    pub fn open(&self, mention_id: &str) -> MentionSlot {
        let slot = LiveSlot::default();
        {
            let mut pending = self.pending();
            if pending.remove(mention_id) {
                slot.claim_lost();
            }
            if self
                .lock()
                .insert(mention_id.to_string(), slot.clone())
                .is_some()
            {
                eprintln!(
                    "[mentionTurn] {mention_id}: 이미 열린 멘션 자리를 다시 열었다(겹친 실행)"
                );
            }
        }
        MentionSlot {
            slots: self.clone(),
            mention_id: mention_id.to_string(),
            slot,
        }
    }

    fn get(&self, mention_id: &str) -> Option<LiveSlot> {
        self.lock().get(mention_id).cloned()
    }

    /// 사람이 그 멘션을 [중단] 했다. 열린 멘션이 아니면 `false`.
    pub fn cancel(&self, mention_id: &str, by: &str) -> bool {
        // 지도 잠금을 놓은 뒤 슬롯을 잠근다 — 잠금을 겹쳐 쥐지 않는다.
        self.get(mention_id).map(|s| s.cancel(by)).is_some()
    }

    /// 그 멘션의 턴 임대를 잃었다. 열린 멘션이 아니면 `false`.
    pub fn fence_lost(&self, mention_id: &str) -> bool {
        self.get(mention_id).is_some_and(|s| s.fence_lost())
    }

    pub fn is_open(&self, mention_id: &str) -> bool {
        self.lock().contains_key(mention_id)
    }
}

/// relay 세션의 [중단] 갈고리(`OpenSessionInput::on_cancel`)로 넘길 닫개 — 슬롯을 **직접** 쥔다. 멘션 id 로 다시 찾지
/// 않으므로 id 가 어긋나 [중단] 이 조용히 버려질 길이 없다.
pub fn cancel_hook(slot: &LiveSlot) -> Arc<dyn Fn(&str) + Send + Sync> {
    let slot = slot.clone();
    Arc::new(move |by: &str| {
        slot.cancel(by);
    })
}

/// 열린 멘션 하나의 슬롯 — `run_one` 한 번 동안 쥔다. 떨어지면 지도에서 뺀다(그사이 같은 id 로 새로 열렸으면 그것은 둔다).
pub struct MentionSlot {
    slots: MentionSlots,
    mention_id: String,
    slot: LiveSlot,
}

impl MentionSlot {
    /// 이 멘션의 `AttemptParts` 가 `bind_live` 에 쓸 슬롯.
    pub fn slot(&self) -> LiveSlot {
        self.slot.clone()
    }
}

impl Drop for MentionSlot {
    fn drop(&mut self) {
        let mut map = self.slots.lock();
        if map
            .get(&self.mention_id)
            .is_some_and(|s| s.same(&self.slot))
        {
            map.remove(&self.mention_id);
        }
    }
}

#[cfg(test)]
#[path = "turn_attempt_account_tests.rs"]
mod tests;
