//! 배정 조정기(s21c-1) — 서버의 `assign`/`unassign` 을 "이 머신에서 무엇을 띄우고 내릴까"로 바꾼다.
//! 옮겨 온 원본은 옛 Node 오퍼레이터(P3 에서 지움)의 `src/assignments.ts`(`createAssignmentReconciler`)다. 스펙 2026-09-20 §3(배정)·§9(drain 상한).
//!
//! 러너 env 는 여기서 조립한다 — **URL·PAT 은 없다**(스펙 §5). 러너가 받는 것은 이 머신의 오퍼레이터 소켓과
//! 자기 id·secret, 하네스에 물려줄 `mcp-bridge` 명령의 경로뿐이다. id·secret 은 spawn 마다 새로 만들고
//! **spawn 직전에** `link.expect` 로 적는다 — 그래야 러너의 hello 가 통한다. 안 띄웠으면(이미 있음·retiring·실패) 바로 잊는다.
//!
//! spawn·signal·시계·예약을 전부 `AssignmentDeps` 로 받는다 — 결정을 프로세스 없이 재려고(TS 와 같은 이유).
//! 실제 프로세스 소유는 `runners.rs` 가 맡는다. 서버 링크 배선(assign 프레임 → 여기)은 이 PR 범위 밖이다(기본 node).
//!
//! **TS 와 다른 점**: `deps` 의 비동기 함수(`operatorOwnerId`·`mcpConfig`·hook·chrome)는 동기 함수다 — 실패를 deps 가
//! TS 의 `.catch` 기본값(commandHook 꺼짐·postToolHook 켜짐·chrome 닫힘)으로 바꿔 돌려준다.
use crate::runner_pick::RunnerPick;
use harkroom_proto::p2::{AgentDefinition, CredentialScope};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};

/// shared `EX_CONFIG`.
pub const EX_CONFIG: i32 = 78;
/// shared `PROVIDER_LANE_ENV`.
pub const PROVIDER_LANE_ENV: &str = "HARKROOM_PROVIDER_LANE";

/// 취소 손잡이.
pub type Cancel = Box<dyn FnOnce() + Send>;
pub type Task = Box<dyn FnOnce() + Send>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sig {
    Term,
    Kill,
}

/// TS `LocalAgentConfig` 중 env 에 실리는 것.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct LocalAgent {
    pub working_dir: Option<String>,
    pub claude_pool: Option<String>,
    /// 날 값(`providerLane`). 켜짐 판정은 `read_provider_lane_config` 로 한다.
    pub provider_lane: Option<Value>,
    /// 적힌 러너 구현(B4-5a `runner`, `runner_kind_of`). `None` 은 안 적음 = 기본 rust(s9①). env 에는 안 실리고 `runner_pick` 이 읽는다.
    pub runner: Option<crate::local_agents::RunnerKind>,
    /// 러너 풀(I1b, `runnerPool: true`) — 러너를 상주시키지 않고 깨움·훑기 때만 빌려 띄운다. 기본 꺼짐.
    pub pool: bool,
}

fn pool_on(local: Option<&LocalAgent>) -> bool {
    local.is_some_and(|l| l.pool)
}

/// 러너에게 「할 일이 없으면 스스로 끝나라」고 알리는 env(풀 에이전트만 '1').
pub const RUNNER_ONE_JOB_ENV: &str = "HARKROOM_RUNNER_ONE_JOB";
/// 반납된 풀 에이전트를 이만큼마다 한 번 띄워 훑는다(깨움을 놓쳤을 때의 안전망).
pub const POOL_SWEEP_MS: u64 = 5 * 60_000;
/// 턴 칸이 차서 못 빌렸을 때 다시 보는 간격.
pub const POOL_WAIT_RETRY_MS: u64 = 10_000;

/// 풀 에이전트에 깨움·훑기가 왔을 때의 결과.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolWake {
    /// 이 조정기의 배정이 아니다.
    NotMine,
    /// 풀 에이전트가 아니다 — 상주 러너가 받는다.
    Resident,
    /// 러너가 떠 있거나 다시 뜨는 중이다(재기동 백오프·회수 포함) — 그 러너가 받는다.
    Running,
    /// 빌려 띄웠다.
    Borrowed,
    /// 턴 칸이 차서 기다린다(곧 다시 본다).
    WaitFull,
    /// 띄우지 못했다 — 다음 훑기 때 다시 본다.
    Failed,
}

/// 그 턴 스레드의 실행 조합이 바라는 러너 모드(J2c 「다」). `Local` 은 조합 줄 없음 — 로컬 설정 그대로다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComboWant {
    Local,
    /// 키 조합 — API 키 연결 모드 러너.
    Key,
    /// 풀 조합 — 그 계정 풀 이름으로 뜬 구독 풀 모드 러너.
    Pool(String),
}

/// 다음 기동 모드(`over`)를 얹은 API 키 연결 켜짐. 없으면 로컬 설정이다.
fn eff_lane(local: Option<&LocalAgent>, over: Option<&ComboWant>) -> bool {
    match over {
        Some(ComboWant::Key) => true,
        Some(ComboWant::Pool(_)) => false,
        _ => lane_on(local),
    }
}

/// 다음 기동 모드(`over`)를 얹은 계정 풀 이름. 풀 조합이면 그 이름, 아니면 로컬 설정(`claudePool`)이다.
fn eff_pool(local: Option<&LocalAgent>, over: Option<&ComboWant>) -> Option<String> {
    match over {
        Some(ComboWant::Pool(n)) => Some(n.clone()),
        _ => local
            .and_then(|l| l.claude_pool.clone())
            .filter(|p| !p.is_empty()),
    }
}

fn lane_on(local: Option<&LocalAgent>) -> bool {
    local
        .and_then(|l| l.provider_lane.as_ref())
        .and_then(crate::local_agents::read_provider_lane_config)
        .is_some()
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpawnResult {
    pub spawned: bool,
    pub pid: i32,
    pub runner_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SpawnError {
    /// 앞 세대 러너가 아직 물러나는 중(TS `code: 'retiring'`).
    Retiring(String),
    Other(String),
}

/// TS `AssignOutcome`.
#[derive(Debug, Clone, PartialEq)]
pub enum AssignOutcome {
    Spawned,
    Already,
    Retiring,
    Refused(String),
}

pub trait AssignmentDeps: Send + Sync {
    /// 이미 살아 있으면 `spawned: false` 로 기존 것을 돌려준다.
    fn spawn(
        &self,
        agent_id: &str,
        env: &BTreeMap<String, String>,
        runner_id: &str,
        pick: RunnerPick,
    ) -> Result<SpawnResult, SpawnError>;
    /// 오퍼레이터 옆에 Rust 러너 파일이 있는가(B4-5c). 없으면 `rust` 를 청한 에이전트도 node 로 돈다.
    fn rust_runner_present(&self) -> bool {
        false
    }
    /// node 러너를 띄울 수 있는가 — 러너가 물려받는 PATH 에 `node` 가 있는가(s9). node 러너는 `#!/usr/bin/env node`
    /// 스크립트라 node 가 없으면 127 로 곧장 죽고, 재기동 백오프가 끝없이 돈다. 기본은 있다고 본다(시험·옛 길 그대로).
    fn node_present(&self) -> bool {
        true
    }
    /// 이 에이전트의 러너가 계정 풀로 돌 수 있는가(B4-5e). **기본은 `Unreadable`** — 모르면 Rust 러너로 보내지 않는다.
    fn claude_account_use(
        &self,
        _agent_id: &str,
        _forced_pool: Option<&str>,
    ) -> crate::runner_pick::AccountUse {
        crate::runner_pick::AccountUse::Unreadable
    }
    /// 그 이름이 이 기기에 **설정된 이름 있는 계정 풀**인가(s34 J2c-2, security J1·B1). **기본은 거짓** — 모르면 받지 않는다.
    /// `claude_account_use` 로 대신 재지 않는다: `pools.json` 이 없으면 그 해석은 강제 풀 이름을 보지 않는다.
    fn claude_pool_known(&self, _name: &str) -> bool {
        false
    }
    fn signal(&self, agent_id: &str, sig: Sig) -> bool;
    fn is_alive(&self, agent_id: &str) -> bool;
    fn list_runners(&self) -> Vec<Value>;
    fn link_expect(&self, runner_id: &str, agent_id: &str, secret: &str);
    fn link_forget(&self, runner_id: &str);
    /// `operator.json` 의 `commandHook === true`. 못 읽으면 false.
    fn command_hook(&self) -> bool {
        false
    }
    /// `operator.json` 의 `postToolHook !== false`. 못 읽으면 true.
    fn post_tool_hook(&self) -> bool {
        true
    }
    /// 이 머신이 Claude in Chrome 을 열 수 있는가. 못 재면 false.
    fn chrome_host(&self) -> bool {
        false
    }
    /// 러너 하나를 더 빌릴 턴 칸이 있는가(I1b). `idle_pool_runners` 는 떠 있지만 아직 턴을 안 잡았을 수 있는 풀 러너 id —
    /// 그것까지 쓴 칸으로 쳐야 몰린 깨움이 전부 빌리지 않는다. 기본은 있다(상한 없음).
    fn pool_room(&self, _idle_pool_runners: &[String]) -> bool {
        true
    }
    /// 이 오퍼레이터의 소유자 id. 모르면 None — personal 배정은 거절한다.
    fn operator_owner_id(&self) -> Option<String>;
    /// 하네스 MCP 설정 파일을 쓴다. 정의가 없는 이름이 있으면 `Err(missing)`.
    fn mcp_config(&self, definition: &AgentDefinition) -> Result<String, Vec<String>>;
    fn schedule(&self, task: Task, ms: u64) -> Cancel;
    fn log(&self, line: &str);
    fn now_ms(&self) -> u64;
    fn new_runner_id(&self) -> String {
        crate::runners::new_incarnation_id().unwrap_or_default()
    }
    /// 24바이트 base64url(TS `randomBytes(24).toString('base64url')`).
    fn new_secret(&self) -> String {
        use base64::Engine;
        use ring::rand::{SecureRandom, SystemRandom};
        let mut b = [0u8; 24];
        if SystemRandom::new().fill(&mut b).is_err() {
            return String::new();
        }
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
    }
}

/// 고정값과 시간 상수. 기본값은 TS 와 같다.
#[derive(Debug, Clone)]
pub struct AssignmentOptions {
    pub socket_path: String,
    pub operator_bin: String,
    pub login_path: Option<String>,
    pub app_version: Option<String>,
    pub turn_secrets_dir: Option<String>,
    pub drain_timeout_ms: u64,
    pub kill_grace_ms: u64,
    pub respawn_backoff_ms: u64,
    pub respawn_ceiling_ms: u64,
    pub login_respawn_floor_ms: u64,
    pub retiring_retry_ms: u64,
}

impl AssignmentOptions {
    pub fn new(socket_path: impl Into<String>, operator_bin: impl Into<String>) -> Self {
        Self {
            socket_path: socket_path.into(),
            operator_bin: operator_bin.into(),
            login_path: None,
            app_version: None,
            turn_secrets_dir: None,
            drain_timeout_ms: 10 * 60_000,
            kill_grace_ms: 5_000,
            respawn_backoff_ms: 1_000,
            respawn_ceiling_ms: 60_000,
            login_respawn_floor_ms: 5 * 60_000,
            retiring_retry_ms: 5_000,
        }
    }
}

/// "한동안 살았다"의 기준 — 이보다 오래 살았으면 다음 죽음의 백오프는 처음부터다.
const STABLE_MS: u64 = 5 * 60_000;

#[derive(Clone)]
struct Assigned {
    base_url: String,
    definition: AgentDefinition,
    local: Option<LocalAgent>,
}

#[derive(Default)]
struct State {
    reclaims: HashMap<String, Cancel>,
    assigned: HashMap<String, Assigned>,
    last_spawn_at: HashMap<String, u64>,
    backoff: HashMap<String, u64>,
    respawns: HashMap<String, Cancel>,
    runner_lane: HashMap<String, bool>,
    current_runner: HashMap<String, String>,
    /// 러너를 반납한 풀 에이전트 → 반납 시각(ms). 여기 있는 것만 깨움·훑기가 다시 띄운다.
    parked: HashMap<String, u64>,
    /// 풀 러너가 떠 있는 동안 깨움이 온 에이전트. 그 러너가 이미 빈 폴을 보고 물러나는 중이었다면 그 깨움은 아무도 못 본다 —
    /// 코드 0 으로 끝났을 때 이 표지가 있으면 반납하지 않고 바로 다시 띄운다. 러너를 띄울 때 지운다.
    woke: HashSet<String>,
    /// 사람의 [재시작]·설정 변경으로 SIGTERM 을 보낸 풀 에이전트. 그 뒤의 코드 0 은 반납이 아니라 재기동이다.
    restarting: HashSet<String>,
    /// 다음 기동 모드(J2c 「다」, 에이전트마다) — 문지기가 조합과 러너 모드가 다를 때 적는다. **메모리에만** 둔다:
    /// 오퍼레이터가 다시 뜨면 로컬 설정 모드로 돌아가고 문지기가 다시 맞춘다. `Local` 은 넣지 않는다(칸을 지운다).
    next_mode: HashMap<String, ComboWant>,
    /// 러너가 뜬 계정 풀 이름(env `HARKROOM_CLAUDE_POOL` 에 실은 값, 없으면 None).
    runner_pool: HashMap<String, Option<String>>,
    /// 다음 기동 모드를 얹어 뜬 러너.
    runner_over: HashSet<String>,
}

pub struct AssignmentReconciler {
    deps: Arc<dyn AssignmentDeps>,
    opts: AssignmentOptions,
    state: Mutex<State>,
    me: Weak<AssignmentReconciler>,
}

fn take_and_cancel(map: &mut HashMap<String, Cancel>, key: &str) -> Option<Cancel> {
    map.remove(key)
}

impl AssignmentReconciler {
    pub fn new(deps: Arc<dyn AssignmentDeps>, opts: AssignmentOptions) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            deps,
            opts,
            state: Mutex::new(State::default()),
            me: me.clone(),
        })
    }

    fn st(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 배정이 살아 있을 때만 다시 `on_assign` 하는 예약.
    fn schedule_reassign(&self, agent_id: &str, ms: u64) {
        let me = self.me.clone();
        let id = agent_id.to_string();
        let cancel = self.deps.schedule(
            Box::new(move || {
                let Some(me) = me.upgrade() else { return };
                // 예약 시점의 local 이 아니라 지금 배정 표의 값으로 띄운다(TS 는 같은 객체를 고쳐 같은 효과).
                let now = {
                    let mut st = me.st();
                    st.respawns.remove(&id);
                    st.assigned.get(&id).cloned()
                };
                let Some(cur) = now else { return };
                match me.on_assign(&cur.base_url, cur.definition, cur.local) {
                    Err(e) => me.deps.log(&format!("다시 띄우기 실패: {e}")),
                    // 다시 띄우다 거절됐다(node 없음 등) — 더 예약하지 않는다(끝없는 재기동 고리를 끊는다).
                    Ok(AssignOutcome::Refused(r)) => me
                        .deps
                        .log(&format!("다시 띄우지 않는다: agent={id} — {r}")),
                    Ok(_) => {}
                }
            }),
            ms,
        );
        let prev = self.st().respawns.insert(agent_id.to_string(), cancel);
        if let Some(c) = prev {
            c();
        }
    }

    pub fn on_assign(
        &self,
        base_url: &str,
        definition: AgentDefinition,
        local: Option<LocalAgent>,
    ) -> Result<AssignOutcome, String> {
        let agent_id = definition.agent_id.clone();
        // 교차 불변식(스펙 §7) — 오퍼레이터는 서버만 믿지 않는다.
        if definition.credential_scope == CredentialScope::Personal {
            let owner = self.deps.operator_owner_id();
            if owner.is_none() || owner != definition.owner_account_id {
                self.deps.log(&format!(
                    "배정을 거절한다: agent={} — personal 자격증명인데 이 오퍼레이터의 소유자가 아니다",
                    definition.handle
                ));
                return Ok(AssignOutcome::Refused(
                    "personal_on_foreign_operator".into(),
                ));
            }
        }
        let mcp_path = match self.deps.mcp_config(&definition) {
            Ok(p) => p,
            Err(missing) => {
                self.deps.log(&format!(
                    "배정을 거절한다: agent={} — 이 머신에 MCP 정의가 없다: {}",
                    definition.handle,
                    missing.join(", ")
                ));
                return Ok(AssignOutcome::Refused(format!(
                    "mcp_server_missing:{}",
                    missing.join(",")
                )));
            }
        };
        let (old_respawn, old_reclaim) = {
            let mut st = self.st();
            st.assigned.insert(
                agent_id.clone(),
                Assigned {
                    base_url: base_url.to_string(),
                    definition: definition.clone(),
                    local: local.clone(),
                },
            );
            // 띄우는 길에 들어섰다 — 반납 표지를 지운다(실패하면 풀 길이 다시 적는다).
            st.parked.remove(&agent_id);
            st.woke.remove(&agent_id);
            st.restarting.remove(&agent_id);
            (
                take_and_cancel(&mut st.respawns, &agent_id),
                // 회수 중이던 에이전트가 다시 배정됐다 — 예약된 SIGKILL 을 놓는다.
                take_and_cancel(&mut st.reclaims, &agent_id),
            )
        };
        if let Some(c) = old_respawn {
            c();
        }
        if let Some(c) = old_reclaim {
            c();
        }

        let runner_id = self.deps.new_runner_id();
        let secret = self.deps.new_secret();
        if runner_id.is_empty() || secret.is_empty() {
            return Err("러너 id·secret 난수를 얻지 못했다".into());
        }
        self.deps.link_expect(&runner_id, &agent_id, &secret);
        // 다음 기동 모드(J2c 「다」) — 문지기가 적어 둔 것이 있으면 로컬 설정 위에 얹는다.
        let over = self.st().next_mode.get(&agent_id).cloned();
        let env = self.runner_env(
            &runner_id,
            &secret,
            &mcp_path,
            local.as_ref(),
            over.as_ref(),
        );
        let pool_name = eff_pool(local.as_ref(), over.as_ref());
        // 러너 구현(B4-5c → L3c-3e). pi·omp 하네스·풀 해석 못 읽음·파일 없음이면 node 다(`runner_pick.rs`).
        // 칸 없음은 기본 rust 다(`ABSENT_RUNNER_DEFAULTS_TO_RUST`) — node 유무는 node 대상인 에이전트에서만 뜻이 있다.
        let node_present = self.deps.node_present();
        let wants = crate::runner_pick::wants_rust(local.as_ref(), node_present);
        let account_use = || {
            self.deps
                .claude_account_use(&agent_id, pool_name.as_deref())
        };
        let mut pick = if wants {
            crate::runner_pick::pick_runner(
                local.as_ref(),
                self.deps.rust_runner_present(),
                account_use(),
                &definition.harness,
                node_present,
            )
        } else {
            crate::runner_pick::RunnerPick::NODE
        };
        // node 러너로 가는데 node 가 없다(s9) — 띄우면 127 로 죽고 끝없이 다시 뜬다. Rust 러너 조건(허용 하네스·풀 읽힘·
        // 파일 있음)을 넘으면 Rust 로, 못 넘으면 띄우지 않고 거절해 서버에 사유를 남긴다(조용히 돌지 않게).
        if pick.kind == crate::local_agents::RunnerKind::Node && !node_present {
            // 명시 `"node"`(모르는 값 포함)는 「Rust 에서 문제가 나서 되돌린」 뜻일 수 있다 — Rust 로 넘기지 않고 거절한다(security #2169).
            let explicit_node = local.as_ref().and_then(|l| l.runner)
                == Some(crate::local_agents::RunnerKind::Node);
            let rust = if explicit_node {
                crate::runner_pick::RunnerPick::NODE
            } else {
                crate::runner_pick::pick_runner(
                    Some(&LocalAgent {
                        runner: Some(crate::local_agents::RunnerKind::Rust),
                        ..local.clone().unwrap_or_default()
                    }),
                    self.deps.rust_runner_present(),
                    account_use(),
                    &definition.harness,
                    node_present,
                )
            };
            if rust.kind == crate::local_agents::RunnerKind::Rust {
                self.deps.log(&format!(
                    "러너: node 러너 대상이지만 이 기기에 node 가 없다 — Rust 러너로 띄운다: agent={}",
                    definition.handle
                ));
                pick = rust;
            } else {
                self.deps.link_forget(&runner_id);
                self.deps.log(&format!(
                    "러너를 띄우지 않는다: agent={} — node 가 없고 Rust 러너 조건도 못 넘었다({})",
                    definition.handle,
                    if explicit_node {
                        "runner: \"node\" 명시"
                    } else {
                        rust.fallback.map_or("unknown", |f| f.as_str())
                    }
                ));
                return Ok(AssignOutcome::Refused("runner_node_missing".into()));
            }
        }
        if let Some(f) = pick.fallback {
            self.deps.log(&format!(
                "러너: rust 대상이지만 node 로 띄운다({}): agent={}",
                f.as_str(),
                definition.handle
            ));
        }
        let result = match self.deps.spawn(&agent_id, &env, &runner_id, pick) {
            Ok(r) => r,
            Err(err) => {
                self.deps.link_forget(&runner_id);
                let msg = match err {
                    SpawnError::Retiring(m) => m,
                    SpawnError::Other(m) => {
                        // 조용히 안 뜨지 않게 — 거절로 돌려 서버에 사유를 남긴다(s9). 원문(경로 등)은 로그에만.
                        self.deps.log(&format!(
                            "러너를 띄우지 못했다: agent={} — {m}",
                            definition.handle
                        ));
                        return Ok(AssignOutcome::Refused("runner_spawn_failed".into()));
                    }
                };
                // 앞 세대 러너는 우리 표에 없어 죽어도 통지가 없다 — 되풀이해 물어야 자리가 비었을 때 띄운다.
                self.deps.log(&format!(
                    "{msg} — {}초 뒤 다시 띄워 본다: agent={}",
                    (self.opts.retiring_retry_ms as f64 / 1000.0).round(),
                    definition.handle
                ));
                self.schedule_reassign(&agent_id, self.opts.retiring_retry_ms);
                return Ok(AssignOutcome::Retiring);
            }
        };
        if result.spawned {
            let now = self.deps.now_ms();
            let mut st = self.st();
            st.last_spawn_at.insert(agent_id.clone(), now);
            if let Some(prev) = st.current_runner.get(&agent_id).cloned()
                && prev != runner_id
            {
                st.runner_lane.remove(&prev);
                st.runner_pool.remove(&prev);
                st.runner_over.remove(&prev);
            }
            st.current_runner
                .insert(agent_id.clone(), runner_id.clone());
            st.runner_lane
                .insert(runner_id.clone(), eff_lane(local.as_ref(), over.as_ref()));
            st.runner_pool.insert(runner_id.clone(), pool_name.clone());
            if over.is_some() {
                st.runner_over.insert(runner_id.clone());
            }
        } else {
            // 안 띄웠으면 방금 적은 secret 은 아무 러너도 안 쓴다 — 남겨 두면 장부가 자라기만 한다.
            self.deps.link_forget(&runner_id);
        }
        self.deps.log(&if result.spawned {
            format!(
                "러너 spawn: agent={} pid={} runner={}",
                definition.handle,
                result.pid,
                pick.kind.as_str()
            )
        } else {
            format!(
                "러너가 이미 있다 — 새로 안 띄운다: agent={} pid={}",
                definition.handle, result.pid
            )
        });
        Ok(if result.spawned {
            AssignOutcome::Spawned
        } else {
            AssignOutcome::Already
        })
    }

    /// TS `onAssign` 의 env 조립. 켜짐 값(post tool·chrome·lane)은 **늘 '0'/'1' 로 명시한다**(security F1) —
    /// 러너 env 는 오퍼레이터 env 위에 얹히므로 키를 빼면 띄운 셸에 있던 값이 샌다.
    fn runner_env(
        &self,
        runner_id: &str,
        secret: &str,
        mcp_path: &str,
        local: Option<&LocalAgent>,
        over: Option<&ComboWant>,
    ) -> BTreeMap<String, String> {
        let o = &self.opts;
        let mut env = BTreeMap::new();
        let mut put = |k: &str, v: &str| {
            env.insert(k.to_string(), v.to_string());
        };
        put("HARKROOM_OPERATOR_SOCKET", &o.socket_path);
        put("HARKROOM_RUNNER_ID", runner_id);
        put("HARKROOM_RUNNER_SECRET", secret);
        put("HARKROOM_OPERATOR_BIN", &o.operator_bin);
        put("HARKROOM_MCP_CONFIG", mcp_path);
        let nonempty =
            |v: &Option<String>| v.as_deref().filter(|s| !s.is_empty()).map(str::to_string);
        if let Some(d) = nonempty(&o.turn_secrets_dir) {
            put("HARKROOM_TURN_SECRETS_DIR", &d);
        }
        if let Some(p) = nonempty(&o.login_path) {
            put("PATH", &p);
        }
        // 없으면 넣지 않는다 — 거짓 버전을 심는 것보다 '모른다'가 낫다.
        if let Some(v) = nonempty(&o.app_version) {
            put("AGENT_VERSION", &v);
        }
        if let Some(l) = local
            && let Some(w) = nonempty(&l.working_dir)
        {
            put("HARKROOM_WORKING_DIR", &w);
        }
        // 풀 조합으로 다시 뜨면 그 풀 이름이 로컬 설정(`claudePool`)을 이긴다.
        if let Some(p) = eff_pool(local, over) {
            put("HARKROOM_CLAUDE_POOL", &p);
        }
        if self.deps.command_hook() {
            put("HARKROOM_COMMAND_HOOK", "1");
        }
        let bit = |b: bool| if b { "1" } else { "0" };
        put("HARKROOM_POST_TOOL_HOOK", bit(self.deps.post_tool_hook()));
        put("HARKROOM_CHROME_HOST", bit(self.deps.chrome_host()));
        // 늘 명시한다 — 키 모드에서 풀 모드로 바꿔 띄울 때 옛 값을 물려받지 않는다(security J2).
        put(PROVIDER_LANE_ENV, bit(eff_lane(local, over)));
        put(RUNNER_ONE_JOB_ENV, bit(pool_on(local)));
        env
    }

    pub fn on_unassign(&self, _base_url: &str, agent_id: &str, drain: bool) {
        let respawn = {
            let mut st = self.st();
            st.assigned.remove(agent_id);
            st.parked.remove(agent_id);
            st.woke.remove(agent_id);
            st.restarting.remove(agent_id);
            st.next_mode.remove(agent_id);
            st.respawns.remove(agent_id)
        };
        if let Some(c) = respawn {
            c();
        }
        if !self.deps.is_alive(agent_id) {
            return;
        }
        let prev = self.st().reclaims.remove(agent_id);
        if let Some(c) = prev {
            c();
        }
        // SIGTERM 이 1차다 — 러너는 진행 중인 턴을 끝내고 물러난다(drain). 차이는 유예의 길이뿐이다.
        self.deps.signal(agent_id, Sig::Term);
        let grace = if drain {
            self.opts.drain_timeout_ms
        } else {
            self.opts.kill_grace_ms
        };
        self.deps.log(&format!(
            "배정 해제: agent={agent_id} — SIGTERM, {}초 뒤 SIGKILL",
            (grace as f64 / 1000.0).round()
        ));
        let me = self.me.clone();
        let id = agent_id.to_string();
        let cancel = self.deps.schedule(
            Box::new(move || {
                let Some(me) = me.upgrade() else { return };
                me.st().reclaims.remove(&id);
                // 스스로 끝났으면 아무것도 하지 않는다 — 새 프로세스를 죽이는 사고를 막는다.
                if me.deps.is_alive(&id) {
                    me.deps.signal(&id, Sig::Kill);
                }
            }),
            grace,
        );
        self.st().reclaims.insert(agent_id.to_string(), cancel);
    }

    /// 사람의 [재시작] — 배정은 두고 SIGTERM. 배정이 없거나 회수 중이거나 러너가 없으면 false.
    pub fn restart(&self, agent_id: &str) -> bool {
        let handle = {
            let mut st = self.st();
            let Some(h) = st
                .assigned
                .get(agent_id)
                .map(|a| a.definition.handle.clone())
            else {
                return false;
            };
            if st.reclaims.contains_key(agent_id) {
                return false;
            }
            if !self.deps.is_alive(agent_id) {
                return false;
            }
            st.backoff.remove(agent_id);
            st.last_spawn_at.remove(agent_id);
            st.restarting.insert(agent_id.to_string());
            h
        };
        self.deps.log(&format!(
            "재시작: agent={handle} — SIGTERM, 물러나면 다시 띄운다"
        ));
        self.deps.signal(agent_id, Sig::Term)
    }

    /// 로컬 설정이 바뀌었다. API 키 연결 켜짐이 바뀌면 러너를 다시 띄운다.
    pub fn set_local(&self, agent_id: &str, local: Option<LocalAgent>) -> &'static str {
        let (handle, now_on, lane_changed, now_pool, pool_changed, parked) = {
            let mut st = self.st();
            let Some(entry) = st.assigned.get_mut(agent_id) else {
                return "none";
            };
            let (was, was_pool) = (lane_on(entry.local.as_ref()), pool_on(entry.local.as_ref()));
            entry.local = local;
            let (now_on, now_pool) = (lane_on(entry.local.as_ref()), pool_on(entry.local.as_ref()));
            if was == now_on && was_pool == now_pool {
                return "updated";
            }
            let handle = entry.definition.handle.clone();
            let parked = st.parked.contains_key(agent_id);
            (
                handle,
                now_on,
                was != now_on,
                now_pool,
                was_pool != now_pool,
                parked,
            )
        };
        if lane_changed {
            self.deps.log(&format!(
                "API 키 연결 {}: agent={handle} — 러너를 다시 띄운다(도는 턴이 끝난 뒤)",
                if now_on { "켬" } else { "끔" }
            ));
        }
        if pool_changed {
            self.deps.log(&format!(
                "러너 풀 {}: agent={handle} — 러너를 다시 띄운다(도는 턴이 끝난 뒤)",
                if now_pool { "켬" } else { "끔" }
            ));
            // 풀을 껐는데 러너가 반납된 채다 — 상주 러너가 받아야 하므로 지금 띄운다(반납 표지는 `on_assign` 이 지운다).
            if !now_pool && parked {
                self.schedule_reassign(agent_id, 0);
                return "restarting";
            }
        }
        if !self.deps.is_alive(agent_id) {
            return "restarting";
        }
        {
            let mut st = self.st();
            st.backoff.remove(agent_id);
            st.last_spawn_at.remove(agent_id);
            st.restarting.insert(agent_id.to_string());
        }
        self.deps.signal(agent_id, Sig::Term);
        "restarting"
    }

    pub fn note_runner_lane(&self, runner_id: &str, on: bool) {
        self.st().runner_lane.insert(runner_id.to_string(), on);
    }

    fn lane_mismatch_in(st: &State, runner_id: &str, agent_id: &str) -> bool {
        let Some(entry) = st.assigned.get(agent_id) else {
            return false;
        };
        let mode = st.runner_lane.get(runner_id).copied();
        if lane_on(entry.local.as_ref()) {
            mode != Some(true)
        } else {
            mode == Some(true)
        }
    }

    /// 문지기(J2c 「다」) — 그 턴 스레드의 조합이 바라는 모드와 이 러너의 모드를 견준다. **막아야 하면 true**.
    ///
    /// - `Local`(조합 줄 없음): 지금까지의 판정([`Self::lane_mismatch_in`]) 그대로. 다음 기동 모드를 얹어 뜬 러너만 계정 풀
    ///   이름까지 로컬 설정과 견준다.
    /// - `Key`: 러너가 API 키 연결 모드여야 한다. `Pool(이름)`: 구독 풀 모드이고 그 이름으로 뜬 러너여야 한다.
    /// - 다르면 다음 기동 모드를 적고, 묻는 러너가 **지금 러너**일 때만 SIGTERM 을 한 번 보낸다(도는 턴이 끝난 뒤 다시 뜬다).
    ///   물러나는 옛 러너의 물음으로 새 러너를 죽이지 않는다.
    pub fn combo_gate(&self, runner_id: &str, agent_id: &str, want: &ComboWant) -> bool {
        {
            let mut st = self.st();
            let Some(entry) = st.assigned.get(agent_id) else {
                // 배정이 없는 러너 — 조합 줄이 없으면 지금까지처럼 지나가고, 있으면 모드를 몰라 막는다.
                return *want != ComboWant::Local;
            };
            let local = entry.local.clone();
            let lane = st.runner_lane.get(runner_id).copied();
            let pool = st.runner_pool.get(runner_id).cloned().flatten();
            let over = st.runner_over.contains(runner_id);
            let had_next = st.next_mode.contains_key(agent_id);
            let ok = match want {
                ComboWant::Local => {
                    !Self::lane_mismatch_in(&st, runner_id, agent_id)
                        && (!over || lane == Some(true) || pool == eff_pool(local.as_ref(), None))
                }
                ComboWant::Key => lane == Some(true),
                ComboWant::Pool(name) => lane == Some(false) && pool.as_deref() == Some(name),
            };
            // 다음 기동 모드는 **지금 러너**의 물음으로만 바뀐다 — 물러나는 옛 러너의 물음은 견주기만 한다.
            let current = st.current_runner.get(agent_id).map(String::as_str) == Some(runner_id);
            if !current {
                return !ok;
            }
            if ok {
                if *want == ComboWant::Local {
                    st.next_mode.remove(agent_id);
                }
                return false;
            }
            let next = (*want != ComboWant::Local).then(|| want.clone());
            let changed = st.next_mode.get(agent_id) != next.as_ref();
            match next {
                Some(w) => st.next_mode.insert(agent_id.to_string(), w),
                None => st.next_mode.remove(agent_id),
            };
            // 조합 줄이 없고 얹은 모드도 없던 러너는 지금까지처럼 막기만 한다(설정 변경 길이 이미 SIGTERM 을 보냈다).
            let ours = *want != ComboWant::Local || over || had_next;
            if !ours || (!changed && st.restarting.contains(agent_id)) {
                return true;
            }
            st.backoff.remove(agent_id);
            st.last_spawn_at.remove(agent_id);
            st.restarting.insert(agent_id.to_string());
        }
        // 값·주소·풀 이름은 찍지 않는다 — 모드가 바뀐다는 사실만.
        self.deps.log(&format!(
            "실행 조합: agent={agent_id} 러너 모드가 그 스레드의 조합과 달라 다시 띄운다(도는 턴이 끝난 뒤)"
        ));
        if self.deps.is_alive(agent_id) {
            self.deps.signal(agent_id, Sig::Term);
        }
        true
    }

    /// 그 계정 풀 이름이 이 기기에 설정된 이름 있는 풀이고 계정이 있는가(security J1·B1 — 서버가 준 이름을 꼴만 보고
    /// 받지 않고, 암묵 풀로 대신 돌게 두지도 않는다). 강제 풀 해석은 에이전트 배정을 보지 않아 `agent_id` 는 쓰지 않는다.
    pub fn pool_known(&self, _agent_id: &str, name: &str) -> bool {
        self.deps.claude_pool_known(name)
    }

    /// 배정된 풀 에이전트(`runnerPool: true`)인가 — 잡기(I2b)가 묻는다.
    pub fn is_pool(&self, agent_id: &str) -> bool {
        self.st()
            .assigned
            .get(agent_id)
            .is_some_and(|e| pool_on(e.local.as_ref()))
    }

    pub fn lane_mismatch(&self, runner_id: &str, agent_id: &str) -> bool {
        Self::lane_mismatch_in(&self.st(), runner_id, agent_id)
    }

    pub fn lane_mismatch_of_runner(&self, runner_id: &str) -> bool {
        let st = self.st();
        let agent = st
            .current_runner
            .iter()
            .find(|(_, id)| id.as_str() == runner_id)
            .map(|(a, _)| a.clone());
        agent.is_some_and(|a| Self::lane_mismatch_in(&st, runner_id, &a))
    }

    pub fn lane_pending(&self) -> BTreeMap<String, bool> {
        let agents: Vec<String> = self.st().assigned.keys().cloned().collect();
        let alive: HashMap<String, bool> = agents
            .iter()
            .map(|a| (a.clone(), self.deps.is_alive(a)))
            .collect();
        let st = self.st();
        let mut out = BTreeMap::new();
        for (agent_id, entry) in &st.assigned {
            let v = if !alive.get(agent_id).copied().unwrap_or(false) {
                false
            } else {
                match st.current_runner.get(agent_id) {
                    None => lane_on(entry.local.as_ref()),
                    Some(id) => Self::lane_mismatch_in(&st, id, agent_id),
                }
            };
            out.insert(agent_id.clone(), v);
        }
        out
    }

    /// 러너가 죽었다. 배정이 살아 있으면 백오프 뒤 다시 띄운다. `reason` 은 러너 로그 꼬리로 가린 78 의 사유.
    pub fn on_runner_exit(&self, agent_id: &str, code: Option<i32>, reason: Option<&str>) {
        let now = self.deps.now_ms();
        let (entry, delay) = {
            let mut st = self.st();
            let Some(entry) = st.assigned.get(agent_id).cloned() else {
                return;
            };
            // 회수 중이면 죽는 것이 맞다 — 다시 띄우면 unassign 이 무의미해진다.
            if st.reclaims.contains_key(agent_id) {
                return;
            }
            // 표지는 이 끝남에만 쓴다 — 어느 갈래로 가든 걷는다.
            let restarting = st.restarting.remove(agent_id);
            let woke = st.woke.remove(agent_id);
            // 풀 에이전트가 코드 0 으로 끝났지만 반납이 아니다: 사람이 재시작을 눌렀거나 설정이 바뀌어 물러났거나(재기동이 맞다),
            // 떠 있는 동안 깨움이 왔다(물러나던 러너가 못 봤을 수 있다). 기다리지 않고 바로 다시 띄운다.
            // 풀이 꺼진 에이전트는 이 갈래에 오지 않는다 — 예전 재기동 길 그대로다.
            if pool_on(entry.local.as_ref()) && code == Some(0) && (restarting || woke) {
                st.backoff.remove(agent_id);
                drop(st);
                self.deps.log(&format!(
                    "러너가 물러났다: agent={} — {}, 바로 다시 띄운다",
                    entry.definition.handle,
                    if restarting {
                        "재시작"
                    } else {
                        "떠 있는 동안 깨움이 왔다"
                    }
                ));
                self.schedule_reassign(agent_id, 0);
                return;
            }
            // 풀 에이전트가 할 일을 마치고 스스로 끝났다(코드 0) — 죽음이 아니라 반납이다. 다시 띄우지 않고 다음 깨움·훑기를 기다린다.
            if pool_on(entry.local.as_ref()) && code == Some(0) {
                st.backoff.remove(agent_id);
                st.parked.insert(agent_id.to_string(), now);
                drop(st);
                self.deps.log(&format!(
                    "러너 반납(풀): agent={} — 깨움이 오거나 {}분 뒤 훑을 때 다시 띄운다",
                    entry.definition.handle,
                    POOL_SWEEP_MS / 60_000
                ));
                self.schedule_pool(agent_id, POOL_SWEEP_MS);
                return;
            }
            let last = st.last_spawn_at.get(agent_id).copied().unwrap_or(0);
            let stable = now.saturating_sub(last) > STABLE_MS;
            let base = if stable {
                self.opts.respawn_backoff_ms
            } else {
                st.backoff
                    .get(agent_id)
                    .copied()
                    .unwrap_or(self.opts.respawn_backoff_ms)
            };
            // 하네스 로그인이 풀려 물러났다 — 종료 코드도 함께 본다(security n1).
            let delay = if code == Some(EX_CONFIG) && reason == Some("harness-login-required") {
                base.max(self.opts.login_respawn_floor_ms)
            } else {
                base
            };
            st.backoff.insert(
                agent_id.to_string(),
                (base * 2).min(self.opts.respawn_ceiling_ms),
            );
            (entry, delay)
        };
        self.deps.log(&format!(
            "러너가 죽었다: agent={} code={}{} — {}초 뒤 다시 띄운다",
            entry.definition.handle,
            code.map_or_else(|| "signal".to_string(), |c| c.to_string()),
            reason.map(|r| format!(" ({r})")).unwrap_or_default(),
            (delay as f64 / 1000.0).round()
        ));
        self.schedule_reassign(agent_id, delay);
    }

    /// 반납된 풀 에이전트를 `ms` 뒤에 다시 본다. 예약은 `respawns` 에 둔다 — 배정·해제·다른 띄움이 알아서 걷는다.
    fn schedule_pool(&self, agent_id: &str, ms: u64) {
        let me = self.me.clone();
        let id = agent_id.to_string();
        let cancel = self.deps.schedule(
            Box::new(move || {
                let Some(me) = me.upgrade() else { return };
                me.st().respawns.remove(&id);
                me.pool_borrow(&id);
            }),
            ms,
        );
        let prev = self.st().respawns.insert(agent_id.to_string(), cancel);
        if let Some(c) = prev {
            c();
        }
    }

    /// 깨움이 왔다(I1b). 반납된 풀 에이전트면 칸을 빌려 러너를 띄운다. 그 밖에는 아무것도 하지 않는다.
    pub fn on_wake(&self, agent_id: &str) -> PoolWake {
        self.pool_borrow(agent_id)
    }

    fn pool_borrow(&self, agent_id: &str) -> PoolWake {
        let now = self.deps.now_ms();
        let (cur, parked_at, others) = {
            let mut st = self.st();
            let Some(cur) = st.assigned.get(agent_id).cloned() else {
                return PoolWake::NotMine;
            };
            if !pool_on(cur.local.as_ref()) {
                return PoolWake::Resident;
            }
            // 반납 표지가 없으면 러너가 떠 있거나 재기동·회수 길에 있다 — 그 길을 앞지르지 않는다(백오프를 건너뛰지 않게).
            let Some(at) = st.parked.get(agent_id).copied() else {
                // 그 러너가 이미 빈 폴을 보고 물러나는 중일 수 있다 — 표지를 남겨, 코드 0 으로 끝나면 바로 다시 띄우게 한다.
                st.woke.insert(agent_id.to_string());
                return PoolWake::Running;
            };
            let others: Vec<String> = st
                .assigned
                .iter()
                .filter(|(a, e)| {
                    a.as_str() != agent_id
                        && pool_on(e.local.as_ref())
                        && !st.parked.contains_key(a.as_str())
                })
                .filter_map(|(a, _)| st.current_runner.get(a).cloned())
                .collect();
            (cur, at, others)
        };
        // 훑기 기한이 찬 것은 칸이 없어도 띄운다 — 러너가 제 차례를 기다린다(오늘의 상주 러너와 같다). 안전망이 칸에 막히지 않게.
        let due = now.saturating_sub(parked_at) >= POOL_SWEEP_MS;
        if !due && !self.deps.pool_room(&others) {
            self.schedule_pool(agent_id, POOL_WAIT_RETRY_MS);
            return PoolWake::WaitFull;
        }
        let handle = cur.definition.handle.clone();
        match self.on_assign(&cur.base_url, cur.definition, cur.local) {
            Ok(AssignOutcome::Spawned) | Ok(AssignOutcome::Already) => PoolWake::Borrowed,
            // 앞 세대가 물러나는 중 — `on_assign` 이 다시 띄우기를 예약했다.
            Ok(AssignOutcome::Retiring) => PoolWake::Running,
            other => {
                self.deps.log(&format!(
                    "풀 러너를 띄우지 못했다: agent={handle} — {} · {}분 뒤 다시 본다",
                    match &other {
                        Ok(AssignOutcome::Refused(r)) => r.as_str(),
                        Err(e) => e.as_str(),
                        _ => "",
                    },
                    POOL_SWEEP_MS / 60_000
                ));
                // 배정이 그 사이 풀리지 않았을 때만 다시 반납 자리에 둔다.
                let still = {
                    let mut st = self.st();
                    let still = st.assigned.contains_key(agent_id);
                    if still {
                        st.parked.insert(agent_id.to_string(), now);
                    }
                    still
                };
                if still {
                    self.schedule_pool(agent_id, POOL_SWEEP_MS);
                }
                PoolWake::Failed
            }
        }
    }

    pub fn announce(&self) -> Vec<Value> {
        self.deps.list_runners()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    type SpawnLog = Vec<(String, BTreeMap<String, String>, String)>;
    type Queue = Vec<(u64, Option<Task>, Arc<Mutex<bool>>)>;

    #[derive(Default)]
    struct Fake {
        alive: Mutex<HashMap<String, bool>>,
        spawns: Mutex<SpawnLog>,
        signals: Mutex<Vec<(String, Sig)>>,
        expects: Mutex<Vec<(String, String, String)>>,
        forgets: Mutex<Vec<String>>,
        scheduled: Mutex<Queue>,
        now: Mutex<u64>,
        owner: Mutex<Option<String>>,
        missing: Mutex<Vec<String>>,
        spawn_err: Mutex<Option<SpawnError>>,
        existing: Mutex<bool>,
        chrome: Mutex<bool>,
        n: Mutex<u32>,
        owner_asked: Mutex<u32>,
        picks: Mutex<Vec<RunnerPick>>,
        logs: Mutex<Vec<String>>,
        rust_present: Mutex<bool>,
        /// `Some(false)` 면 node 가 없다(기본은 있음).
        node_missing: Mutex<bool>,
        account_use: Mutex<crate::runner_pick::AccountUse>,
        /// 이 기기에 설정된 이름 있는 풀(J1).
        known_pools: Mutex<Vec<String>>,
        /// 턴 칸이 찼다(풀 러너를 더 못 빌린다).
        pool_full: Mutex<bool>,
    }

    impl AssignmentDeps for Fake {
        fn pool_room(&self, _idle: &[String]) -> bool {
            !*self.pool_full.lock().unwrap()
        }
        fn spawn(
            &self,
            agent_id: &str,
            env: &BTreeMap<String, String>,
            runner_id: &str,
            pick: RunnerPick,
        ) -> Result<SpawnResult, SpawnError> {
            self.picks.lock().unwrap().push(pick);
            if let Some(e) = self.spawn_err.lock().unwrap().take() {
                return Err(e);
            }
            if *self.existing.lock().unwrap() {
                return Ok(SpawnResult {
                    spawned: false,
                    pid: 1,
                    runner_id: "old".into(),
                });
            }
            self.spawns
                .lock()
                .unwrap()
                .push((agent_id.into(), env.clone(), runner_id.into()));
            self.alive.lock().unwrap().insert(agent_id.into(), true);
            Ok(SpawnResult {
                spawned: true,
                pid: 42,
                runner_id: runner_id.into(),
            })
        }
        fn signal(&self, agent_id: &str, sig: Sig) -> bool {
            self.signals.lock().unwrap().push((agent_id.into(), sig));
            true
        }
        fn rust_runner_present(&self) -> bool {
            *self.rust_present.lock().unwrap()
        }
        fn node_present(&self) -> bool {
            !*self.node_missing.lock().unwrap()
        }
        fn claude_account_use(
            &self,
            _agent_id: &str,
            _forced_pool: Option<&str>,
        ) -> crate::runner_pick::AccountUse {
            *self.account_use.lock().unwrap()
        }
        fn claude_pool_known(&self, name: &str) -> bool {
            self.known_pools.lock().unwrap().iter().any(|p| p == name)
        }
        fn is_alive(&self, agent_id: &str) -> bool {
            self.alive
                .lock()
                .unwrap()
                .get(agent_id)
                .copied()
                .unwrap_or(false)
        }
        fn list_runners(&self) -> Vec<Value> {
            vec![json!({"agentId": "a1", "runnerId": "r", "pid": 42})]
        }
        fn link_expect(&self, r: &str, a: &str, s: &str) {
            self.expects
                .lock()
                .unwrap()
                .push((r.into(), a.into(), s.into()));
        }
        fn link_forget(&self, r: &str) {
            self.forgets.lock().unwrap().push(r.into());
        }
        fn chrome_host(&self) -> bool {
            *self.chrome.lock().unwrap()
        }
        fn operator_owner_id(&self) -> Option<String> {
            *self.owner_asked.lock().unwrap() += 1;
            self.owner.lock().unwrap().clone()
        }
        fn mcp_config(&self, _d: &AgentDefinition) -> Result<String, Vec<String>> {
            let m = self.missing.lock().unwrap().clone();
            if m.is_empty() {
                Ok("/cfg/mcp.json".into())
            } else {
                Err(m)
            }
        }
        fn schedule(&self, task: Task, ms: u64) -> Cancel {
            let flag = Arc::new(Mutex::new(false));
            let at = *self.now.lock().unwrap() + ms;
            self.scheduled
                .lock()
                .unwrap()
                .push((at, Some(task), flag.clone()));
            Box::new(move || *flag.lock().unwrap() = true)
        }
        fn log(&self, line: &str) {
            self.logs.lock().unwrap().push(line.to_string());
        }
        fn now_ms(&self) -> u64 {
            *self.now.lock().unwrap()
        }
        fn new_runner_id(&self) -> String {
            let mut n = self.n.lock().unwrap();
            *n += 1;
            format!("runner-{n}")
        }
        fn new_secret(&self) -> String {
            format!("sec-{}", *self.n.lock().unwrap())
        }
    }

    impl Fake {
        /// 시계를 `ms` 만큼 돌리고, 그때까지 도래한(취소 안 된) 예약을 차례로 돌린다.
        fn advance(&self, ms: u64) {
            let target = *self.now.lock().unwrap() + ms;
            loop {
                let next = {
                    let mut q = self.scheduled.lock().unwrap();
                    let idx = q
                        .iter()
                        .enumerate()
                        .filter(|(_, (at, t, _))| t.is_some() && *at <= target)
                        .min_by_key(|(_, (at, _, _))| *at)
                        .map(|(i, _)| i);
                    idx.map(|i| {
                        let (at, t, flag) = &mut q[i];
                        (*at, t.take().unwrap(), flag.clone())
                    })
                };
                let Some((at, task, flag)) = next else { break };
                *self.now.lock().unwrap() = at;
                if !*flag.lock().unwrap() {
                    task();
                }
            }
            *self.now.lock().unwrap() = target;
        }
        fn kill(&self, a: &str) {
            self.alive.lock().unwrap().insert(a.into(), false);
        }
    }

    fn def(scope: CredentialScope, owner: Option<&str>) -> AgentDefinition {
        AgentDefinition {
            agent_id: "a1".into(),
            handle: "bot".into(),
            harness: "claude".into(),
            instructions: String::new(),
            model: None,
            effort: None,
            mention_permission: "anyone".into(),
            working_dir_default: None,
            credential_scope: scope,
            owner_account_id: owner.map(str::to_string),
            mcp_servers: vec![],
        }
    }

    fn setup() -> (Arc<Fake>, Arc<AssignmentReconciler>) {
        let f = Arc::new(Fake::default());
        let mut o = AssignmentOptions::new("/run/op.sock", "/bin/harkroom-operator");
        o.login_path = Some("/usr/bin:/bin".into());
        o.app_version = Some("0.4.0".into());
        let r = AssignmentReconciler::new(f.clone(), o);
        (f, r)
    }

    fn lane() -> LocalAgent {
        LocalAgent {
            provider_lane: Some(json!({"baseUrl": "https://api.example.com", "secretName": "k1"})),
            ..Default::default()
        }
    }

    /// L3c-3e: lane·풀 claude 에이전트 + rust → rust. 허용 목록 밖(모르는 이름) → node(이유를 로그에).
    /// 파일 없음 → node. `runner` 안 적음 → 기본 rust(s9①). `"node"` → node.
    #[test]
    fn runner_pick_opens_pool_and_lane_and_keeps_pi_omp_on_node() {
        use crate::local_agents::RunnerKind;
        use crate::runner_pick::{AccountUse, RunnerFallback};
        let rust_lane = LocalAgent {
            runner: Some(RunnerKind::Rust),
            ..lane()
        };
        let rust_pool = LocalAgent {
            runner: Some(RunnerKind::Rust),
            claude_pool: Some("p".into()),
            ..Default::default()
        };
        let rust_plain = LocalAgent {
            runner: Some(RunnerKind::Rust),
            ..Default::default()
        };
        let cases = [
            (
                rust_lane.clone(),
                "claude-code",
                AccountUse::None,
                true,
                RunnerKind::Rust,
                None,
            ),
            (
                rust_pool.clone(),
                "claude-code",
                AccountUse::Pool,
                true,
                RunnerKind::Rust,
                None,
            ),
            (
                rust_plain.clone(),
                "claude-code",
                AccountUse::Pool,
                true,
                RunnerKind::Rust,
                None,
            ),
            (
                rust_plain.clone(),
                "pi",
                AccountUse::None,
                true,
                RunnerKind::Rust,
                None,
            ),
            (
                rust_lane.clone(),
                "omp",
                AccountUse::Pool,
                true,
                RunnerKind::Rust,
                None,
            ),
            (
                rust_plain.clone(),
                "codex",
                AccountUse::None,
                true,
                RunnerKind::Rust,
                None,
            ),
            (
                rust_plain.clone(),
                "opencode",
                AccountUse::None,
                true,
                RunnerKind::Rust,
                None,
            ),
            (
                rust_plain.clone(),
                "kilo",
                AccountUse::None,
                true,
                RunnerKind::Rust,
                None,
            ),
            (
                rust_plain.clone(),
                "kilo",
                AccountUse::None,
                true,
                RunnerKind::Rust,
                None,
            ),
            (
                rust_plain.clone(),
                "new-harness",
                AccountUse::None,
                true,
                RunnerKind::Node,
                Some(RunnerFallback::HarnessUnsupported),
            ),
            (
                rust_plain.clone(),
                "claude-code",
                AccountUse::None,
                false,
                RunnerKind::Node,
                Some(RunnerFallback::RunnerMissing),
            ),
            // `runner` 안 적음 → node 가 있어도 기본 rust(`ABSENT_RUNNER_DEFAULTS_TO_RUST`), 파일 없음이면 같은 이유로 node.
            (
                LocalAgent::default(),
                "claude-code",
                AccountUse::None,
                true,
                RunnerKind::Rust,
                None,
            ),
            (
                LocalAgent::default(),
                "claude-code",
                AccountUse::None,
                false,
                RunnerKind::Node,
                Some(RunnerFallback::RunnerMissing),
            ),
            // `runner: "node"` 되돌림 → 이유 없이 node.
            (
                LocalAgent {
                    runner: Some(RunnerKind::Node),
                    ..Default::default()
                },
                "claude-code",
                AccountUse::None,
                true,
                RunnerKind::Node,
                None,
            ),
        ];
        for (local, harness, use_, present, kind, fallback) in cases {
            let (f, r) = setup();
            *f.rust_present.lock().unwrap() = present;
            *f.account_use.lock().unwrap() = use_;
            let mut d = def(CredentialScope::Community, None);
            d.harness = harness.into();
            r.on_assign("https://srv", d, Some(local.clone())).unwrap();
            let picks = f.picks.lock().unwrap();
            assert_eq!(picks.len(), 1, "{local:?} {harness}");
            assert_eq!(picks[0].kind, kind, "{local:?} {harness}");
            assert_eq!(picks[0].fallback, fallback, "{local:?} {harness}");
            let logs = f.logs.lock().unwrap();
            assert!(
                logs.iter()
                    .any(|l| l.contains(&format!("runner={}", kind.as_str()))),
                "{logs:?}"
            );
            if let Some(fb) = fallback {
                assert!(logs.iter().any(|l| l.contains(fb.as_str())), "{logs:?}");
            }
        }
    }

    /// 「못 읽음은 node」 그대로 — 판정을 안 주면(기본) 닫힌 쪽.
    #[test]
    fn runner_pick_unreadable_and_default_stay_closed() {
        use crate::local_agents::RunnerKind;
        use crate::runner_pick::{AccountUse, RunnerFallback};
        let rust_only = LocalAgent {
            runner: Some(RunnerKind::Rust),
            ..Default::default()
        };
        for set in [Some(AccountUse::Unreadable), None] {
            let (f, r) = setup();
            *f.rust_present.lock().unwrap() = true;
            if let Some(u) = set {
                *f.account_use.lock().unwrap() = u;
            }
            let mut d = def(CredentialScope::Community, None);
            d.harness = "claude-code".into();
            r.on_assign("https://srv", d, Some(rust_only.clone()))
                .unwrap();
            let picks = f.picks.lock().unwrap();
            assert_eq!(picks[0].kind, RunnerKind::Node);
            assert_eq!(
                picks[0].fallback,
                Some(RunnerFallback::AccountPoolUnreadable)
            );
        }
    }

    #[test]
    fn assign_env_has_link_and_no_url_or_pat() {
        let (f, r) = setup();
        let local = LocalAgent {
            working_dir: Some("/w".into()),
            claude_pool: Some("p".into()),
            provider_lane: None,
            runner: Default::default(),
            pool: false,
        };
        let out = r
            .on_assign(
                "https://srv",
                def(CredentialScope::Community, None),
                Some(local),
            )
            .unwrap();
        assert_eq!(out, AssignOutcome::Spawned);
        let spawns = f.spawns.lock().unwrap();
        let (_, env, rid) = &spawns[0];
        let want: BTreeMap<String, String> = [
            ("HARKROOM_OPERATOR_SOCKET", "/run/op.sock"),
            ("HARKROOM_RUNNER_ID", "runner-1"),
            ("HARKROOM_RUNNER_SECRET", "sec-1"),
            ("HARKROOM_OPERATOR_BIN", "/bin/harkroom-operator"),
            ("HARKROOM_MCP_CONFIG", "/cfg/mcp.json"),
            ("PATH", "/usr/bin:/bin"),
            ("AGENT_VERSION", "0.4.0"),
            ("HARKROOM_WORKING_DIR", "/w"),
            ("HARKROOM_CLAUDE_POOL", "p"),
            ("HARKROOM_POST_TOOL_HOOK", "1"),
            ("HARKROOM_CHROME_HOST", "0"),
            ("HARKROOM_PROVIDER_LANE", "0"),
            ("HARKROOM_RUNNER_ONE_JOB", "0"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(env, &want);
        assert_eq!(rid, "runner-1");
        // spawn 전에 expect 가 불렸다
        assert_eq!(
            f.expects.lock().unwrap()[0],
            ("runner-1".into(), "a1".into(), "sec-1".into())
        );
        assert!(f.forgets.lock().unwrap().is_empty());
    }

    #[test]
    fn existing_runner_forgets_new_secret() {
        let (f, r) = setup();
        *f.existing.lock().unwrap() = true;
        let out = r
            .on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        assert_eq!(out, AssignOutcome::Already);
        assert_eq!(*f.forgets.lock().unwrap(), vec!["runner-1".to_string()]);
    }

    #[test]
    fn chrome_host_explicit_one() {
        let (f, r) = setup();
        *f.chrome.lock().unwrap() = true;
        r.on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        assert_eq!(f.spawns.lock().unwrap()[0].1["HARKROOM_CHROME_HOST"], "1");
    }

    #[test]
    fn unassign_drain_then_kill_unless_exited() {
        let (f, r) = setup();
        r.on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        r.on_unassign("u", "a1", true);
        assert_eq!(f.signals.lock().unwrap()[0], ("a1".into(), Sig::Term));
        f.advance(10 * 60_000 - 1);
        assert_eq!(f.signals.lock().unwrap().len(), 1);
        f.advance(1);
        assert_eq!(f.signals.lock().unwrap()[1], ("a1".into(), Sig::Kill));
    }

    #[test]
    fn unassign_exited_first_no_kill_and_no_respawn() {
        let (f, r) = setup();
        r.on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        r.on_unassign("u", "a1", false);
        f.kill("a1");
        r.on_runner_exit("a1", Some(0), None);
        f.advance(60_000);
        assert_eq!(f.signals.lock().unwrap().len(), 1);
        assert_eq!(f.spawns.lock().unwrap().len(), 1);
    }

    #[test]
    fn unassign_not_running_does_nothing() {
        let (f, r) = setup();
        r.on_unassign("u", "a1", true);
        assert!(f.signals.lock().unwrap().is_empty());
        assert!(f.scheduled.lock().unwrap().is_empty());
    }

    #[test]
    fn exit_respawns_with_growing_backoff_and_reset_when_stable() {
        let (f, r) = setup();
        r.on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        let mut delays = vec![];
        for _ in 0..3 {
            f.kill("a1");
            r.on_runner_exit("a1", Some(1), None);
            let n = f.spawns.lock().unwrap().len();
            let mut waited = 0;
            while f.spawns.lock().unwrap().len() == n {
                f.advance(500);
                waited += 500;
            }
            delays.push(waited);
        }
        assert_eq!(delays, vec![1000, 2000, 4000]);
        f.advance(STABLE_MS + 1);
        f.kill("a1");
        r.on_runner_exit("a1", Some(1), None);
        let n = f.spawns.lock().unwrap().len();
        f.advance(1000);
        assert_eq!(f.spawns.lock().unwrap().len(), n + 1);
    }

    #[test]
    fn login_exit_waits_floor_only_with_code_78() {
        let (f, r) = setup();
        r.on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        r.on_runner_exit("a1", Some(EX_CONFIG), Some("harness-login-required"));
        f.advance(5 * 60_000 - 1);
        assert_eq!(f.spawns.lock().unwrap().len(), 1);
        f.advance(1);
        assert_eq!(f.spawns.lock().unwrap().len(), 2);
        // 78 이 아니면 마커가 있어도 늦추지 않는다(security n1)
        let (f, r) = setup();
        r.on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        r.on_runner_exit("a1", Some(1), Some("harness-login-required"));
        f.advance(1000);
        assert_eq!(f.spawns.lock().unwrap().len(), 2);
    }

    #[test]
    fn retiring_retries_until_unassigned() {
        let (f, r) = setup();
        *f.spawn_err.lock().unwrap() = Some(SpawnError::Retiring("앞 세대가 물러나는 중".into()));
        let out = r
            .on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        assert_eq!(out, AssignOutcome::Retiring);
        assert_eq!(*f.forgets.lock().unwrap(), vec!["runner-1".to_string()]);
        f.advance(5_000);
        assert_eq!(f.spawns.lock().unwrap().len(), 1);
        // unassign 이 오면 다시 띄우지 않는다
        let (f, r) = setup();
        *f.spawn_err.lock().unwrap() = Some(SpawnError::Retiring("x".into()));
        r.on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        r.on_unassign("u", "a1", true);
        f.advance(5_000);
        assert!(f.spawns.lock().unwrap().is_empty());
    }

    #[test]
    fn other_spawn_error_is_a_visible_refusal() {
        // 실행 파일이 없는 등 띄우기 실패는 조용히 끝나지 않는다 — 거절 사유로 서버에 간다(s9).
        let (f, r) = setup();
        *f.spawn_err.lock().unwrap() = Some(SpawnError::Other("boom".into()));
        let out = r
            .on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        assert_eq!(out, AssignOutcome::Refused("runner_spawn_failed".into()));
        assert_eq!(f.forgets.lock().unwrap().len(), 1);
        assert!(f.logs.lock().unwrap().iter().any(|l| l.contains("boom")));
    }

    #[test]
    fn node_missing_moves_to_rust_when_rust_can_run() {
        use crate::local_agents::RunnerKind;
        use crate::runner_pick::AccountUse;
        let (f, r) = setup();
        *f.node_missing.lock().unwrap() = true;
        *f.rust_present.lock().unwrap() = true;
        *f.account_use.lock().unwrap() = AccountUse::None;
        // 칸 없는 에이전트는 node 가 없어도 기본대로 Rust 로 뜬다.
        let mut d = def(CredentialScope::Community, None);
        d.harness = "claude-code".into();
        let out = r.on_assign("u", d, Some(LocalAgent::default())).unwrap();
        assert_ne!(out, AssignOutcome::Refused("runner_node_missing".into()));
        let picks = f.picks.lock().unwrap();
        assert_eq!(picks.len(), 1);
        assert_eq!(picks[0].kind, RunnerKind::Rust);
        // Rust 가 기본이다 — 칸 없는 에이전트가 Rust 로 뜨는 것은 예외가 아니므로 node 를 들먹이는 줄을 남기지 않는다.
        assert!(
            !f.logs.lock().unwrap().iter().any(|l| l.contains("node")),
            "{:?}",
            f.logs.lock().unwrap()
        );
    }

    #[test]
    fn explicit_node_without_node_is_refused_not_moved_to_rust() {
        // 명시 `"node"` 는 「Rust 에서 문제가 나서 되돌린」 뜻일 수 있다 — Rust 가 돌 수 있어도 넘기지 않는다(security #2169).
        use crate::local_agents::RunnerKind;
        use crate::runner_pick::AccountUse;
        let (f, r) = setup();
        *f.node_missing.lock().unwrap() = true;
        *f.rust_present.lock().unwrap() = true;
        *f.account_use.lock().unwrap() = AccountUse::None;
        let mut d = def(CredentialScope::Community, None);
        d.harness = "claude-code".into();
        let local = LocalAgent {
            runner: Some(RunnerKind::Node),
            ..Default::default()
        };
        let out = r.on_assign("u", d, Some(local)).unwrap();
        assert_eq!(out, AssignOutcome::Refused("runner_node_missing".into()));
        assert!(f.picks.lock().unwrap().is_empty());
        assert_eq!(f.forgets.lock().unwrap().len(), 1);
    }

    #[test]
    fn absent_runner_with_node_present_takes_rust_default() {
        // node 가 있어도 칸 없는 에이전트는 기본 Rust(전수 시험 통과 뒤 전환).
        use crate::local_agents::RunnerKind;
        use crate::runner_pick::AccountUse;
        let (f, r) = setup();
        *f.rust_present.lock().unwrap() = true;
        *f.account_use.lock().unwrap() = AccountUse::None;
        let mut d = def(CredentialScope::Community, None);
        d.harness = "claude-code".into();
        r.on_assign("u", d, Some(LocalAgent::default())).unwrap();
        let picks = f.picks.lock().unwrap();
        assert_eq!(picks.len(), 1);
        assert_eq!(picks[0].kind, RunnerKind::Rust);
        assert_eq!(picks[0].fallback, None);
    }

    #[test]
    fn node_missing_and_rust_impossible_is_refused_not_spawned() {
        use crate::runner_pick::AccountUse;
        for (present, use_, harness) in [
            (false, AccountUse::None, "claude-code"),
            (true, AccountUse::Unreadable, "claude-code"),
            (true, AccountUse::None, "gemini"),
        ] {
            let (f, r) = setup();
            *f.node_missing.lock().unwrap() = true;
            *f.rust_present.lock().unwrap() = present;
            *f.account_use.lock().unwrap() = use_;
            let mut d = def(CredentialScope::Community, None);
            d.harness = harness.into();
            let out = r.on_assign("u", d, Some(LocalAgent::default())).unwrap();
            assert_eq!(
                out,
                AssignOutcome::Refused("runner_node_missing".into()),
                "{harness}"
            );
            assert!(f.picks.lock().unwrap().is_empty(), "띄우지 않는다");
            assert_eq!(f.forgets.lock().unwrap().len(), 1);
        }
    }

    #[test]
    fn personal_requires_same_owner() {
        let (f, r) = setup();
        *f.owner.lock().unwrap() = Some("me".into());
        let out = r
            .on_assign("u", def(CredentialScope::Personal, Some("other")), None)
            .unwrap();
        assert_eq!(
            out,
            AssignOutcome::Refused("personal_on_foreign_operator".into())
        );
        // 거절된 배정은 러너가 죽어도 다시 띄우지 않는다
        r.on_runner_exit("a1", Some(1), None);
        f.advance(60_000);
        assert!(f.spawns.lock().unwrap().is_empty());
        let out = r
            .on_assign("u", def(CredentialScope::Personal, Some("me")), None)
            .unwrap();
        assert_eq!(out, AssignOutcome::Spawned);
        // 모르면(None) 거절
        let (f, r) = setup();
        let out = r
            .on_assign("u", def(CredentialScope::Personal, None), None)
            .unwrap();
        assert_eq!(
            out,
            AssignOutcome::Refused("personal_on_foreign_operator".into())
        );
        // personal 이 아니면 묻지 않는다
        r.on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        assert_eq!(*f.owner_asked.lock().unwrap(), 1);
    }

    #[test]
    fn missing_mcp_refuses() {
        let (f, r) = setup();
        *f.missing.lock().unwrap() = vec!["gh".into(), "fs".into()];
        let out = r
            .on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        assert_eq!(
            out,
            AssignOutcome::Refused("mcp_server_missing:gh,fs".into())
        );
        assert!(f.expects.lock().unwrap().is_empty());
    }

    #[test]
    fn restart_terms_and_respawns_after_first_backoff() {
        let (f, r) = setup();
        assert!(!r.restart("a1"));
        r.on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        assert!(r.restart("a1"));
        f.kill("a1");
        r.on_runner_exit("a1", None, None);
        f.advance(1000);
        assert_eq!(f.spawns.lock().unwrap().len(), 2);
        f.kill("a1");
        assert!(!r.restart("a1"));
    }

    /// J2c 「다」: 조합이 바라는 모드와 다르면 다음 기동 모드를 적어 다시 띄우고, 새 env 가 그 모드를 따른다.
    #[test]
    fn combo_gate_sets_next_mode_and_respawns_in_it() {
        let (f, r) = setup();
        r.on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        let again = |f: &Fake, r: &AssignmentReconciler| {
            f.kill("a1");
            r.on_runner_exit("a1", Some(0), None);
            f.advance(1000);
        };
        // 조합 줄 없음 + 얹은 모드 없음 → 지금 그대로(신호 없음).
        assert!(!r.combo_gate("runner-1", "a1", &ComboWant::Local));
        assert!(f.signals.lock().unwrap().is_empty());
        // 구독 풀 모드 러너에 키 조합 → 막고 SIGTERM 한 번(되풀이해 물어도 한 번).
        assert!(r.combo_gate("runner-1", "a1", &ComboWant::Key));
        assert!(r.combo_gate("runner-1", "a1", &ComboWant::Key));
        assert_eq!(f.signals.lock().unwrap().len(), 1);
        again(&f, &r);
        let env = f.spawns.lock().unwrap()[1].1.clone();
        assert_eq!(env["HARKROOM_PROVIDER_LANE"], "1");
        assert!(!env.contains_key("HARKROOM_CLAUDE_POOL"));
        assert!(!r.combo_gate("runner-2", "a1", &ComboWant::Key));
        // 물러나는 옛 러너가 물어도 새 러너를 죽이지 않고, 다음 기동 모드도 건드리지 않는다.
        assert!(r.combo_gate("runner-1", "a1", &ComboWant::Key));
        assert!(!r.combo_gate("runner-1", "a1", &ComboWant::Local));
        assert_eq!(f.signals.lock().unwrap().len(), 1);
        assert!(!r.combo_gate("runner-2", "a1", &ComboWant::Key));
        // 키 모드 러너에 풀 조합 → 그 풀 이름으로, lane 은 '0' 으로 명시된다(security J2 — 옛 값을 물려받지 않는다).
        let team = ComboWant::Pool("team".into());
        assert!(r.combo_gate("runner-2", "a1", &team));
        assert_eq!(f.signals.lock().unwrap().len(), 2);
        again(&f, &r);
        let env = f.spawns.lock().unwrap()[2].1.clone();
        assert_eq!(env["HARKROOM_PROVIDER_LANE"], "0");
        assert_eq!(env["HARKROOM_CLAUDE_POOL"], "team");
        assert!(!r.combo_gate("runner-3", "a1", &team));
        // 다른 풀 이름이면 다시 뜬다.
        assert!(r.combo_gate("runner-3", "a1", &ComboWant::Pool("other".into())));
        again(&f, &r);
        assert_eq!(
            f.spawns.lock().unwrap()[3].1["HARKROOM_CLAUDE_POOL"],
            "other"
        );
        // 조합 줄 없는 스레드가 오면 로컬 설정 모드로 돌아간다(얹은 풀 이름이 로컬과 다르다).
        assert!(r.combo_gate("runner-4", "a1", &ComboWant::Local));
        again(&f, &r);
        let env = f.spawns.lock().unwrap()[4].1.clone();
        assert_eq!(env["HARKROOM_PROVIDER_LANE"], "0");
        assert!(!env.contains_key("HARKROOM_CLAUDE_POOL"));
        assert!(!r.combo_gate("runner-5", "a1", &ComboWant::Local));
        // 배정이 없는 에이전트: 조합 줄이 있으면 막고, 없으면 지금 그대로.
        assert!(r.combo_gate("x", "nobody", &ComboWant::Key));
        assert!(!r.combo_gate("x", "nobody", &ComboWant::Local));
        // 풀 이름 허용(J1)은 이 기기에 설정된 이름 있는 풀일 때만 — 넓은 판정(`claude_account_use`)이 「풀로 돈다」여도
        // 그것만으로는 받지 않는다(B1: `pools.json` 없이 평평한 계정만 있는 기기).
        *f.account_use.lock().unwrap() = crate::runner_pick::AccountUse::Pool;
        assert!(!r.pool_known("a1", "team"));
        *f.known_pools.lock().unwrap() = vec!["team".into()];
        assert!(r.pool_known("a1", "team"));
        assert!(!r.pool_known("a1", "other"));
    }

    #[test]
    fn lane_toggle_restarts_and_new_env_follows() {
        let (f, r) = setup();
        r.on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        assert_eq!(r.set_local("a1", Some(lane())), "restarting");
        assert_eq!(f.signals.lock().unwrap()[0].1, Sig::Term);
        // 옛 러너는 모드가 달라 막히고, 적용 대기
        assert!(r.lane_mismatch_of_runner("runner-1"));
        assert!(r.lane_pending()["a1"]);
        f.kill("a1");
        r.on_runner_exit("a1", Some(0), None);
        f.advance(1000);
        assert_eq!(f.spawns.lock().unwrap()[1].1["HARKROOM_PROVIDER_LANE"], "1");
        assert!(!r.lane_mismatch_of_runner("runner-2"));
        assert!(!r.lane_pending()["a1"]);
        // 주소만 바뀌면 다시 띄우지 않는다
        let mut l2 = lane();
        l2.provider_lane = Some(json!({"baseUrl": "https://api2.example.com", "secretName": "k1"}));
        assert_eq!(r.set_local("a1", Some(l2)), "updated");
        assert_eq!(r.set_local("zz", None), "none");
    }

    #[test]
    fn unknown_mode_runner_is_mismatch_while_lane_on() {
        let (_f, r) = setup();
        r.on_assign("u", def(CredentialScope::Community, None), Some(lane()))
            .unwrap();
        assert!(r.lane_mismatch("old-gen", "a1"));
        r.note_runner_lane("old-gen", true);
        assert!(!r.lane_mismatch("old-gen", "a1"));
        assert!(!r.lane_mismatch_of_runner("nobody"));
    }

    #[test]
    fn reassign_cancels_pending_kill() {
        let (f, r) = setup();
        r.on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        r.on_unassign("u", "a1", false);
        r.on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap();
        f.advance(5_000);
        assert!(!f.signals.lock().unwrap().iter().any(|s| s.1 == Sig::Kill));
        assert_eq!(r.announce().len(), 1);
    }

    fn pool() -> LocalAgent {
        LocalAgent {
            pool: true,
            ..Default::default()
        }
    }

    /// 풀 에이전트를 배정하고 러너가 할 일을 마쳐 스스로 끝난(코드 0) 자리까지 간다.
    fn parked() -> (Arc<Fake>, Arc<AssignmentReconciler>) {
        let (f, r) = setup();
        let out = r.on_assign(
            "https://srv",
            def(CredentialScope::Community, None),
            Some(pool()),
        );
        assert_eq!(out, Ok(AssignOutcome::Spawned));
        f.kill("a1");
        r.on_runner_exit("a1", Some(0), None);
        (f, r)
    }

    fn spawn_count(f: &Fake) -> usize {
        f.spawns.lock().unwrap().len()
    }

    #[test]
    fn one_job_env_is_always_explicit_and_on_only_for_pool_agents() {
        let (f, r) = setup();
        r.on_assign("https://srv", def(CredentialScope::Community, None), None)
            .unwrap();
        assert_eq!(f.spawns.lock().unwrap()[0].1[RUNNER_ONE_JOB_ENV], "0");
        let (f, _r) = parked();
        assert_eq!(f.spawns.lock().unwrap()[0].1[RUNNER_ONE_JOB_ENV], "1");
    }

    #[test]
    fn pool_runner_clean_exit_parks_instead_of_respawning() {
        let (f, _r) = parked();
        // 평소 재기동 백오프(1초)가 지나도 다시 뜨지 않는다.
        f.advance(60_000);
        assert_eq!(spawn_count(&f), 1);
        assert!(
            f.logs
                .lock()
                .unwrap()
                .iter()
                .any(|l| l.contains("러너 반납(풀)"))
        );
    }

    #[test]
    fn resident_agent_clean_exit_still_respawns_and_wake_does_nothing() {
        let (f, r) = setup();
        r.on_assign("https://srv", def(CredentialScope::Community, None), None)
            .unwrap();
        assert_eq!(r.on_wake("a1"), PoolWake::Resident);
        f.kill("a1");
        r.on_runner_exit("a1", Some(0), None);
        assert_eq!(r.on_wake("a1"), PoolWake::Resident);
        f.advance(1_000);
        assert_eq!(spawn_count(&f), 2);
    }

    #[test]
    fn wake_borrows_a_parked_pool_runner_once() {
        let (f, r) = parked();
        assert_eq!(r.on_wake("a1"), PoolWake::Borrowed);
        assert_eq!(spawn_count(&f), 2);
        // 떠 있는 동안의 깨움은 그 러너가 받는다 — 또 띄우지 않는다.
        assert_eq!(r.on_wake("a1"), PoolWake::Running);
        assert_eq!(spawn_count(&f), 2);
        // 빌린 뒤에는 훑기 예약도 걷혔다.
        f.advance(POOL_SWEEP_MS * 2);
        assert_eq!(spawn_count(&f), 2);
        assert_eq!(r.on_wake("nope"), PoolWake::NotMine);
    }

    #[test]
    fn parked_pool_runner_is_swept_every_five_minutes_without_a_wake() {
        let (f, r) = parked();
        f.advance(POOL_SWEEP_MS - 1);
        assert_eq!(spawn_count(&f), 1);
        f.advance(1);
        assert_eq!(spawn_count(&f), 2);
        // 훑은 러너도 할 일이 없으면 다시 반납하고, 다음 훑기가 또 온다.
        f.kill("a1");
        r.on_runner_exit("a1", Some(0), None);
        f.advance(POOL_SWEEP_MS);
        assert_eq!(spawn_count(&f), 3);
    }

    #[test]
    fn pool_runner_crash_keeps_backoff_and_wake_does_not_jump_it() {
        let (f, r) = setup();
        r.on_assign(
            "https://srv",
            def(CredentialScope::Community, None),
            Some(pool()),
        )
        .unwrap();
        f.kill("a1");
        r.on_runner_exit("a1", Some(1), None);
        // 죽은 것은 반납이 아니다 — 깨움이 백오프를 앞지르지 않는다.
        assert_eq!(r.on_wake("a1"), PoolWake::Running);
        assert_eq!(spawn_count(&f), 1);
        f.advance(1_000);
        assert_eq!(spawn_count(&f), 2);
    }

    #[test]
    fn full_pool_waits_then_borrows_when_room_opens_and_sweep_ignores_room() {
        let (f, r) = parked();
        *f.pool_full.lock().unwrap() = true;
        assert_eq!(r.on_wake("a1"), PoolWake::WaitFull);
        f.advance(POOL_WAIT_RETRY_MS * 2);
        assert_eq!(spawn_count(&f), 1, "칸이 찬 동안은 띄우지 않는다");
        *f.pool_full.lock().unwrap() = false;
        f.advance(POOL_WAIT_RETRY_MS);
        assert_eq!(spawn_count(&f), 2, "칸이 나면 다음 재시도에서 띄운다");
        // 칸이 계속 차 있어도 훑기 기한이 차면 띄운다(안전망이 칸에 막히지 않는다).
        f.kill("a1");
        r.on_runner_exit("a1", Some(0), None);
        *f.pool_full.lock().unwrap() = true;
        assert_eq!(r.on_wake("a1"), PoolWake::WaitFull);
        f.advance(POOL_SWEEP_MS);
        assert_eq!(spawn_count(&f), 3);
    }

    #[test]
    fn failed_borrow_parks_again_and_retries_at_next_sweep() {
        let (f, r) = parked();
        *f.spawn_err.lock().unwrap() = Some(SpawnError::Other("boom".into()));
        assert_eq!(r.on_wake("a1"), PoolWake::Failed);
        assert_eq!(spawn_count(&f), 1);
        f.advance(POOL_SWEEP_MS);
        assert_eq!(spawn_count(&f), 2);
    }

    #[test]
    fn unassign_drops_the_parked_agent_and_its_sweep() {
        let (f, r) = parked();
        r.on_unassign("https://srv", "a1", true);
        assert_eq!(r.on_wake("a1"), PoolWake::NotMine);
        f.advance(POOL_SWEEP_MS * 2);
        assert_eq!(spawn_count(&f), 1);
    }

    #[test]
    fn turning_pool_off_while_parked_brings_the_resident_runner_back() {
        let (f, r) = parked();
        assert_eq!(r.set_local("a1", None), "restarting");
        f.advance(0);
        assert_eq!(spawn_count(&f), 2);
        assert_eq!(f.spawns.lock().unwrap()[1].1[RUNNER_ONE_JOB_ENV], "0");
        // 이제 상주 러너다 — 코드 0 으로 끝나도 다시 뜬다.
        f.kill("a1");
        r.on_runner_exit("a1", Some(0), None);
        f.advance(1_000);
        assert_eq!(spawn_count(&f), 3);
    }

    #[test]
    fn turning_pool_on_restarts_the_resident_runner_into_a_pool_runner() {
        let (f, r) = setup();
        r.on_assign("https://srv", def(CredentialScope::Community, None), None)
            .unwrap();
        assert_eq!(r.set_local("a1", Some(pool())), "restarting");
        assert_eq!(f.signals.lock().unwrap().last().unwrap().1, Sig::Term);
        // 설정 변경으로 물러난 것(코드 0)은 반납이 아니라 재기동이다 — 깨움을 기다리지 않고 풀 러너가 바로 뜬다.
        f.kill("a1");
        r.on_runner_exit("a1", Some(0), None);
        f.advance(0);
        assert_eq!(spawn_count(&f), 2);
        assert_eq!(f.spawns.lock().unwrap()[1].1[RUNNER_ONE_JOB_ENV], "1");
        // 그 풀 러너가 할 일 없이 끝나면 그때는 반납이다.
        f.kill("a1");
        r.on_runner_exit("a1", Some(0), None);
        f.advance(60_000);
        assert_eq!(spawn_count(&f), 2);
        assert_eq!(r.on_wake("a1"), PoolWake::Borrowed);
    }

    /// 깨움으로 빌린 풀 러너가 떠 있는 자리.
    fn borrowed() -> (Arc<Fake>, Arc<AssignmentReconciler>) {
        let (f, r) = parked();
        assert_eq!(r.on_wake("a1"), PoolWake::Borrowed);
        assert_eq!(spawn_count(&f), 2);
        (f, r)
    }

    #[test]
    fn wake_during_a_running_pool_runner_reborrows_right_after_it_returns() {
        let (f, r) = borrowed();
        // 러너가 떠 있는 동안 온 깨움 — 그 러너가 이미 물러나는 중이면 못 본다.
        assert_eq!(r.on_wake("a1"), PoolWake::Running);
        f.kill("a1");
        r.on_runner_exit("a1", Some(0), None);
        f.advance(0);
        assert_eq!(spawn_count(&f), 3, "5분 훑기를 기다리지 않는다");
        assert!(
            f.logs
                .lock()
                .unwrap()
                .iter()
                .any(|l| l.contains("떠 있는 동안 깨움이 왔다"))
        );
        // 표지는 한 번만 쓴다 — 다시 뜬 러너가 조용히 끝나면 반납이다(되풀이 띄움 없음).
        f.kill("a1");
        r.on_runner_exit("a1", Some(0), None);
        f.advance(60_000);
        assert_eq!(spawn_count(&f), 3);
    }

    #[test]
    fn wake_mark_does_not_outlive_a_crash_or_jump_its_backoff() {
        let (f, r) = borrowed();
        assert_eq!(r.on_wake("a1"), PoolWake::Running);
        // 죽음(코드 0 아님)은 평소 백오프 길이다 — 표지가 그것을 앞지르지 않는다.
        f.kill("a1");
        r.on_runner_exit("a1", Some(1), None);
        f.advance(0);
        assert_eq!(spawn_count(&f), 2);
        f.advance(1_000);
        assert_eq!(spawn_count(&f), 3);
        // 다시 뜬 러너가 조용히 끝나면 반납이다 — 옛 표지가 남아 또 띄우지 않는다.
        f.kill("a1");
        r.on_runner_exit("a1", Some(0), None);
        f.advance(60_000);
        assert_eq!(spawn_count(&f), 3);
    }

    #[test]
    fn restart_of_a_pool_runner_respawns_instead_of_parking() {
        let (f, r) = borrowed();
        assert!(r.restart("a1"));
        assert_eq!(f.signals.lock().unwrap().last().unwrap().1, Sig::Term);
        // SIGTERM 으로 물러나면 코드 0 이다 — 반납으로 치지 않고 바로 다시 띄운다.
        f.kill("a1");
        r.on_runner_exit("a1", Some(0), None);
        f.advance(0);
        assert_eq!(spawn_count(&f), 3);
        assert_eq!(f.spawns.lock().unwrap()[2].1[RUNNER_ONE_JOB_ENV], "1");
        assert!(
            !f.logs
                .lock()
                .unwrap()
                .iter()
                .rev()
                .take(2)
                .any(|l| l.contains("러너 반납(풀)"))
        );
        // 재시작 표지도 한 번만 쓴다.
        f.kill("a1");
        r.on_runner_exit("a1", Some(0), None);
        f.advance(60_000);
        assert_eq!(spawn_count(&f), 3);
    }

    #[test]
    fn lane_change_on_a_pool_runner_respawns_instead_of_parking() {
        let (f, r) = borrowed();
        let mut l = lane();
        l.pool = true;
        assert_eq!(r.set_local("a1", Some(l)), "restarting");
        f.kill("a1");
        r.on_runner_exit("a1", Some(0), None);
        f.advance(0);
        assert_eq!(spawn_count(&f), 3);
        assert_eq!(f.spawns.lock().unwrap()[2].1["HARKROOM_PROVIDER_LANE"], "1");
    }

    #[test]
    fn marks_are_dropped_with_the_assignment() {
        let (f, r) = borrowed();
        assert_eq!(r.on_wake("a1"), PoolWake::Running);
        assert!(r.restart("a1"));
        r.on_unassign("https://srv", "a1", false);
        f.kill("a1");
        r.on_runner_exit("a1", Some(0), None);
        f.advance(60_000);
        assert_eq!(spawn_count(&f), 2);
    }
}
