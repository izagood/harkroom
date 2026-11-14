//! 이 러너의 claude 계정 축(L3c-3b) — 정본 `main.ts` 의 `loadLane`·`createLiveAccountLane`·`presentAccounts`·`laneFor` 몫.
//!
//! - 풀 해석은 `harkroom-accounts`(L3c-3a, TS 실행 골든과 대조한 함수)를 그대로 부른다 — 오퍼레이터의 러너 고르기와 **같은 함수**다.
//! - 축은 **턴마다 다시 읽는다**(5초 안의 재요청은 앞 값). 지운 계정은 빠지고 새 계정은 들어온다. 다시 읽기가 실패하면 앞 목록에서
//!   지운 계정만 뺀다(경고는 같은 문구면 한 번). 디렉터리가 없는 계정을 축에 남기면 claude 가 그 경로를 새로 만들어 미로그인으로 뜬다.
//! - 스레드별 고르기(`AccountAssigner::lane_for`)도 이 축을 본다. 고른 뒤에도 지운 계정을 한 번 더 거른다(`present_accounts`).
//! - 시도마다의 `CLAUDE_CONFIG_DIR`·기록 홈은 이 축의 계정에서만 나온다(`turn_attempt_account::AttemptAccount`).
use crate::account_assign::{
    AccountAssigner, AccountAssignerDeps, ClaudeAccount, ClaudePoolLane, CurrentLane, Lane,
    create_account_assigner,
};
use crate::session_store::SessionStore;
use crate::turn_attempt_account::LaneSnapshot;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 다시 읽기 최소 간격(정본 `minIntervalMs` 5초).
pub const LANE_REFRESH_MIN: Duration = Duration::from_secs(5);

fn account_of(a: harkroom_accounts::ClaudeAccount) -> ClaudeAccount {
    ClaudeAccount {
        name: a.name,
        config_dir: a.config_dir,
        pool: a.pool,
    }
}

/// 풀 해석의 입력(기동 때 한 번 정한다). env 는 러너 env 다 — 오퍼레이터가 판정할 때 본 값과 같다.
#[derive(Clone, Debug)]
pub struct LaneSource {
    pub root: PathBuf,
    pub agent_id: String,
    /// `HARKROOM_CLAUDE_POOL`.
    pub forced_pool: Option<String>,
    /// `HARKROOM_CLAUDE_ACCOUNTS`.
    pub order: Option<String>,
    pub env: BTreeMap<String, String>,
}

impl LaneSource {
    pub fn from_env(env: &BTreeMap<String, String>, home: &Path, agent_id: &str) -> Self {
        let get = |k: &str| env.get(k).cloned();
        LaneSource {
            root: harkroom_accounts::claude_accounts_root(get, home),
            agent_id: agent_id.to_string(),
            forced_pool: env
                .get("HARKROOM_CLAUDE_POOL")
                .cloned()
                .filter(|s| !s.is_empty()),
            order: env.get("HARKROOM_CLAUDE_ACCOUNTS").cloned(),
            env: env.clone(),
        }
    }

    /// 정본 `loadClaudeAccountLane` → `CurrentLane`(계정이 없으면 축 `[None]`).
    pub fn load(&self) -> Result<CurrentLane, String> {
        let l = harkroom_accounts::load_claude_account_lane(
            &self.root,
            &self.agent_id,
            self.forced_pool.as_deref(),
            self.order.as_deref(),
            |k| self.env.get(k).cloned(),
        )?;
        let accounts: Vec<ClaudeAccount> = l.accounts.into_iter().map(account_of).collect();
        Ok(CurrentLane {
            pool: l.pool,
            lane: to_lane(accounts),
            chain: l.chain.map(|c| {
                c.into_iter()
                    .map(|p| ClaudePoolLane {
                        pool: p.pool,
                        accounts: p.accounts.into_iter().map(account_of).collect(),
                    })
                    .collect()
            }),
        })
    }
}

fn to_lane(accounts: Vec<ClaudeAccount>) -> Lane {
    if accounts.is_empty() {
        vec![None]
    } else {
        accounts.into_iter().map(Some).collect()
    }
}

fn is_dir(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_dir())
}

/// 정본 `presentAccounts` — 디렉터리가 있는 계정만(링크는 따라간다). 전부 사라지면 `[None]`(시스템 기본 로그인).
pub fn present_accounts(lane: Lane) -> Lane {
    let kept: Lane = lane
        .into_iter()
        .filter(|a| a.as_ref().is_none_or(|a| is_dir(&a.config_dir)))
        .collect();
    if kept.is_empty() { vec![None] } else { kept }
}

fn present_chain(chain: Option<Vec<ClaudePoolLane>>) -> Option<Vec<ClaudePoolLane>> {
    chain.map(|c| {
        c.into_iter()
            .map(|p| ClaudePoolLane {
                pool: p.pool,
                accounts: p
                    .accounts
                    .into_iter()
                    .filter(|a| is_dir(&a.config_dir))
                    .collect(),
            })
            .collect()
    })
}

struct LiveState {
    last: CurrentLane,
    read_at: Option<Instant>,
    warned: Option<String>,
}

/// 정본 `createLiveAccountLane` — 턴마다 다시 읽는 축.
pub struct LiveAccountLane {
    source: LaneSource,
    state: Mutex<LiveState>,
    log: Box<dyn Fn(&str) + Send + Sync>,
}

impl LiveAccountLane {
    pub fn new(
        source: LaneSource,
        initial: CurrentLane,
        log: Box<dyn Fn(&str) + Send + Sync>,
    ) -> Self {
        LiveAccountLane {
            source,
            state: Mutex::new(LiveState {
                last: initial,
                read_at: Some(Instant::now()),
                warned: None,
            }),
            log,
        }
    }

    /// 지금 축. 5초 안이면 앞 값(지운 계정만 뺀다), 지났으면 다시 읽는다.
    pub fn current(&self) -> CurrentLane {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = st.read_at.is_some_and(|t| t.elapsed() < LANE_REFRESH_MIN);
        if !fresh {
            match self.source.load() {
                Ok(next) => {
                    st.last = next;
                    st.warned = None;
                }
                Err(e) => {
                    if st.warned.as_deref() != Some(e.as_str()) {
                        (self.log)(&format!(
                            "[claudeAccounts] 계정 축을 다시 읽지 못했다 — 앞 목록에서 지운 계정만 뺀다: {e}"
                        ));
                    }
                    st.warned = Some(e);
                }
            }
            st.read_at = Some(Instant::now());
        }
        let last = st.last.clone();
        CurrentLane {
            pool: last.pool,
            lane: present_accounts(last.lane),
            chain: present_chain(last.chain),
        }
    }

    /// 칩이 보는 몫(정본 `liveLane.snapshot()`).
    pub fn snapshot(&self) -> LaneSnapshot {
        let c = self.current();
        LaneSnapshot {
            pool: c.pool,
            chain: c.chain.unwrap_or_default(),
            lane: c.lane,
        }
    }
}

/// 러너 하나의 계정 축 묶음 — 다시 읽는 축 + 스레드별 고르기.
pub struct AccountLaneHub {
    live: Arc<LiveAccountLane>,
    assigner: AccountAssigner,
}

impl AccountLaneHub {
    /// 기동 때 축을 읽는다. 강제 풀이 없는 풀이면 `Err` — 정본처럼 러너가 뜨지 않는다(사람이 방금 친 의도를 무시하지 않는다).
    pub fn start(
        source: LaneSource,
        store: Arc<SessionStore>,
        log: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Result<Self, String> {
        let initial = source.load()?;
        let root = source.root.clone();
        let log2 = Arc::clone(&log);
        let live = Arc::new(LiveAccountLane::new(
            source,
            initial.clone(),
            Box::new(move |l| log2(l)),
        ));
        let (s1, s2, s3) = (Arc::clone(&store), Arc::clone(&store), Arc::clone(&store));
        let mut deps = AccountAssignerDeps::new(initial.lane, initial.pool, root, move |k| {
            s1.get(k).and_then(|r| r.claude_account)
        });
        let cur = Arc::clone(&live);
        deps.current = Some(Box::new(move || cur.current()));
        deps.pinned_pool_of = Some(Box::new(move |k| {
            s2.get(k).and_then(|r| r.claude_pool).flatten()
        }));
        deps.session_id_of = Some(Box::new(move |k| s3.get(k).and_then(|r| r.session_id)));
        let log3 = Arc::clone(&log);
        deps.log = Some(Box::new(move |l| log3(l)));
        Ok(AccountLaneHub {
            live,
            assigner: create_account_assigner(deps),
        })
    }

    /// 이 스레드의 페일오버 순서(정본 `laneFor` → `presentAccounts`).
    pub fn lane_for(&self, thread_key: &str, model: Option<&str>) -> Lane {
        present_accounts(self.assigner.lane_for(thread_key, model))
    }

    pub fn snapshot(&self) -> LaneSnapshot {
        self.live.snapshot()
    }
}

#[cfg(test)]
#[path = "account_lane_tests.rs"]
mod tests;
