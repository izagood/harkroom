//! `AttemptParts` 실물의 계정 몫과 펜스·[중단] 듣기 자리.
//!
//! - [`AttemptAccount`]: 시도 하나가 쓸 계정(정본 `buildTurnDeps` 의 `claudeAccount`·`claudeConfigDir`·`callsForHuman`).
//!   **시도마다 그 시도의 계정으로 새로 만든다** — 계정 폴더(`config_dir`)는 이 값에서만 나와 명령 옵션
//!   ([`AttemptAccount::command`])과 기록 찾기 자리([`AttemptAccount::homes`])로 간다. 기본 명령 옵션에 무엇이 들어 있든
//!   덮는다 — 계정이 없는 시도는 `None`(정본 `account?.configDir ?? null`), 앞 시도의 폴더가 남지 않는다.
//! - [`LiveSlot`]: 펜스 잃음·[중단] 을 받는 쪽(스케줄러·오퍼레이터 신호)이 쥐는 손잡이. `bind_live` 가 지금 시도의
//!   [`LiveTurn`] 을 걸고 놓는다. 펜스 잃음은 걸린 시도에만, [중단] 은 멘션 단위로도 남아 다음 시도의 관문이 본다.

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
}

#[cfg(test)]
#[path = "turn_attempt_account_tests.rs"]
mod tests;
