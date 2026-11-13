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

use crate::account_assign::ClaudeAccount;
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
        st.live = live;
    }

    /// 턴 임대를 잃었다 — 지금 걸린 시도에만. 걸린 것이 없으면 `false`.
    pub fn fence_lost(&self) -> bool {
        self.lock().live.as_ref().map(|l| l.fence_lost()).is_some()
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
pub struct MentionSlots(Arc<Mutex<HashMap<String, LiveSlot>>>);

impl MentionSlots {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, LiveSlot>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 이 멘션의 슬롯을 **새로** 연다(같은 id 의 옛 슬롯이 남아 있어도 바꾼다). 같은 멘션은 동시에 두 번 돌지 않는다 —
    /// 멘션의 스레드 열쇠(채널·앵커)가 정해져 있고 장부가 그 열쇠로 한 번에 하나만 띄운다(`Ledger::thread_in_flight`).
    /// 그래도 열린 id 를 다시 열면 로그를 남긴다(겹치면 앞 실행의 [중단] 이 뒤 슬롯으로 간다).
    pub fn open(&self, mention_id: &str) -> MentionSlot {
        let slot = LiveSlot::default();
        if self
            .lock()
            .insert(mention_id.to_string(), slot.clone())
            .is_some()
        {
            eprintln!("[mentionTurn] {mention_id}: 이미 열린 멘션 자리를 다시 열었다(겹친 실행)");
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
