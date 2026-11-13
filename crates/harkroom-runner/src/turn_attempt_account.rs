//! `AttemptParts` 실물의 계정 몫과 펜스·[중단] 듣기 자리.
//!
//! - [`AttemptAccount`]: 시도 하나가 쓸 계정(정본 `buildTurnDeps` 의 `claudeAccount`·`claudeConfigDir`·`callsForHuman`).
//!   **시도마다 그 시도의 계정으로 새로 만든다** — 계정 폴더(`config_dir`)는 이 값에서만 나와 명령 옵션
//!   ([`AttemptAccount::command`])과 기록 찾기 자리([`AttemptAccount::homes`])로 간다. 기본 명령 옵션에 무엇이 들어 있든
//!   덮는다 — 계정이 없는 시도는 `None`(정본 `account?.configDir ?? null`), 앞 시도의 폴더가 남지 않는다.
//! - [`LiveSlot`]: 펜스 잃음·[중단] 을 받는 쪽(스케줄러·오퍼레이터 신호)이 쥐는 손잡이. `bind_live` 가 지금 시도의
//!   [`LiveTurn`] 을 걸고 놓는다 — 놓인 뒤 온 신호는 아무 시도에도 닿지 않는다(다음 시도의 `LiveTurn` 은 새것이다).

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

/// 지금 시도의 [`LiveTurn`] 을 가리키는 손잡이 — 신호를 받는 쪽이 복제해 쥔다.
#[derive(Clone, Default)]
pub struct LiveSlot(Arc<Mutex<Option<Arc<LiveTurn>>>>);

impl LiveSlot {
    fn lock(&self) -> MutexGuard<'_, Option<Arc<LiveTurn>>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `AttemptParts::bind_live` 의 몸통.
    pub fn bind(&self, live: Option<Arc<LiveTurn>>) {
        *self.lock() = live;
    }

    /// 턴 임대를 잃었다 — 지금 걸린 시도에만. 걸린 것이 없으면 `false`.
    pub fn fence_lost(&self) -> bool {
        self.lock().as_ref().map(|l| l.fence_lost()).is_some()
    }

    /// 사람이 [중단] 했다 — 지금 걸린 시도에만. 걸린 것이 없으면 `false`.
    pub fn cancel(&self, by: &str) -> bool {
        self.lock().as_ref().map(|l| l.cancel(by)).is_some()
    }

    pub fn is_bound(&self) -> bool {
        self.lock().is_some()
    }
}

#[cfg(test)]
#[path = "turn_attempt_account_tests.rs"]
mod tests;
