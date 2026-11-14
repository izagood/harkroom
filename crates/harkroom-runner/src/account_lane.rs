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

/// lane 러너의 계정 폴더 이름(정본 `stateDir.ts` `providerLaneClaudeDir` = `<상태 폴더>/claude-provider-lane`).
pub const PROVIDER_LANE_CLAUDE_DIR: &str = "claude-provider-lane";
/// lane 러너의 계정 이름(정본 `providerLaneAccount.name`).
pub const PROVIDER_LANE_ACCOUNT: &str = "provider-lane";

/// lane 러너의 계정 축 — **이 에이전트 전용 폴더 하나**(정본 `providerLaneAccount`, security ⓒ). 풀·`~/.claude` 를 읽지 않는다.
/// 이 폴더는 비어 있어야 정상이다(로그인이 없다) — 키는 턴마다 env 로만 든다.
pub fn provider_lane_account(state_dir: &Path) -> ClaudeAccount {
    ClaudeAccount {
        name: PROVIDER_LANE_ACCOUNT.to_string(),
        config_dir: state_dir.join(PROVIDER_LANE_CLAUDE_DIR),
        pool: None,
    }
}

/// 이 러너의 기본 계정 축 — 축 묶음이 없을 때도 lane 러너는 **기본 로그인 축으로 띄우지 않는다**(L3c-3d, security 조건).
pub fn fallback_lane(runner_env: &BTreeMap<String, String>, state_dir: &Path) -> Lane {
    if runner_env.get("HARKROOM_PROVIDER_LANE").map(String::as_str) == Some("1") {
        vec![Some(provider_lane_account(state_dir))]
    } else {
        vec![None]
    }
}

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
    /// 있으면 디스크를 읽지 않고 늘 이 축이다(lane 러너 — 정본 `loadLane` 의 `providerLaneOn` 갈래).
    pub fixed: Option<CurrentLane>,
}

impl LaneSource {
    /// lane 러너의 축 — lane 전용 폴더 하나. 폴더를 0700 으로 만든다(정본 `mkdir(providerLaneClaudeDir, 0o700)`). 링크·남의 폴더면 `Err`.
    pub fn provider_lane(state_dir: &Path) -> std::io::Result<Self> {
        let account = provider_lane_account(state_dir);
        ensure_lane_dir(&account.config_dir)?;
        Ok(LaneSource {
            root: account.config_dir.clone(),
            agent_id: String::new(),
            forced_pool: None,
            order: None,
            env: BTreeMap::new(),
            fixed: Some(CurrentLane {
                pool: None,
                lane: vec![Some(account)],
                chain: None,
            }),
        })
    }

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
            fixed: None,
        }
    }

    /// 정본 `loadClaudeAccountLane` → `CurrentLane`(계정이 없으면 축 `[None]`).
    pub fn load(&self) -> Result<CurrentLane, String> {
        if let Some(f) = &self.fixed {
            return Ok(f.clone());
        }
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

/// lane 폴더를 0700 으로 만들고(없으면) **링크가 아닌 진짜 폴더이며 내 소유**인지 본다. 아니면 `Err` — 그 자리에 링크가 놓이면
/// `CLAUDE_CONFIG_DIR` 가 링크 너머(예: 사람의 `~/.claude`)를 가리킬 수 있다(#2129 security 조건). 닫힌 쪽: 호출자는 띄우지 않는다.
pub fn ensure_lane_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let m = std::fs::symlink_metadata(dir)?;
    let bad = |why: &str| Err(std::io::Error::other(why.to_owned()));
    if m.file_type().is_symlink() || !m.is_dir() {
        return bad("lane dir is not a real directory");
    }
    // SAFETY: geteuid 는 인자가 없고 실패하지 않는다.
    if m.uid() != unsafe { libc::geteuid() } {
        return bad("lane dir is not owned by this user");
    }
    Ok(())
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
        // lane 러너: 축은 lane 전용 폴더 하나로 고정이다. 폴더가 사라져도 거르지 않고 다시 만든다 — 걸러서 `[None]`(기본 로그인)이
        // 되는 길을 막는다(L3c-3d, security 조건).
        if self.source.fixed.is_some() {
            // 링크·남의 폴더면 여기선 로그만 — 턴은 `ProviderLane` 이 키를 받기 전에 거른다(`claude_dir`).
            for a in last.lane.iter().flatten() {
                if let Err(e) = ensure_lane_dir(&a.config_dir) {
                    (self.log)(&format!(
                        "[claudeAccounts] lane 폴더를 쓸 수 없다({})",
                        e.kind()
                    ));
                }
            }
            return last;
        }
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
        let lane = self.assigner.lane_for(thread_key, model);
        // lane 러너는 거르지 않는다(위 `current` 와 같은 까닭) — 기본 로그인 칸이 끼면 안 된다.
        if self.live.source.fixed.is_some() {
            return lane;
        }
        present_accounts(lane)
    }

    pub fn snapshot(&self) -> LaneSnapshot {
        self.live.snapshot()
    }
}

#[cfg(test)]
#[path = "account_lane_tests.rs"]
mod tests;
