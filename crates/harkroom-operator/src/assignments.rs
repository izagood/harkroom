//! 배정 조정기(s21c-1) — 서버의 `assign`/`unassign` 을 "이 머신에서 무엇을 띄우고 내릴까"로 바꾼다.
//! 정본은 `packages/operator/src/assignments.ts`(`createAssignmentReconciler`)다. 스펙 2026-09-20 §3(배정)·§9(drain 상한).
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
use harkroom_proto::p2::{AgentDefinition, CredentialScope};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
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
    ) -> Result<SpawnResult, SpawnError>;
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
                if let Err(e) = me.on_assign(&cur.base_url, cur.definition, cur.local) {
                    me.deps.log(&format!("다시 띄우기 실패: {e}"));
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
        let env = self.runner_env(&runner_id, &secret, &mcp_path, local.as_ref());
        let result = match self.deps.spawn(&agent_id, &env, &runner_id) {
            Ok(r) => r,
            Err(err) => {
                self.deps.link_forget(&runner_id);
                let msg = match err {
                    SpawnError::Retiring(m) => m,
                    SpawnError::Other(m) => return Err(m),
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
            }
            st.current_runner
                .insert(agent_id.clone(), runner_id.clone());
            st.runner_lane
                .insert(runner_id.clone(), lane_on(local.as_ref()));
        } else {
            // 안 띄웠으면 방금 적은 secret 은 아무 러너도 안 쓴다 — 남겨 두면 장부가 자라기만 한다.
            self.deps.link_forget(&runner_id);
        }
        self.deps.log(&if result.spawned {
            format!("러너 spawn: agent={} pid={}", definition.handle, result.pid)
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
        if let Some(l) = local {
            if let Some(w) = nonempty(&l.working_dir) {
                put("HARKROOM_WORKING_DIR", &w);
            }
            if let Some(p) = nonempty(&l.claude_pool) {
                put("HARKROOM_CLAUDE_POOL", &p);
            }
        }
        if self.deps.command_hook() {
            put("HARKROOM_COMMAND_HOOK", "1");
        }
        let bit = |b: bool| if b { "1" } else { "0" };
        put("HARKROOM_POST_TOOL_HOOK", bit(self.deps.post_tool_hook()));
        put("HARKROOM_CHROME_HOST", bit(self.deps.chrome_host()));
        put(PROVIDER_LANE_ENV, bit(lane_on(local)));
        env
    }

    pub fn on_unassign(&self, _base_url: &str, agent_id: &str, drain: bool) {
        let respawn = {
            let mut st = self.st();
            st.assigned.remove(agent_id);
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
            h
        };
        self.deps.log(&format!(
            "재시작: agent={handle} — SIGTERM, 물러나면 다시 띄운다"
        ));
        self.deps.signal(agent_id, Sig::Term)
    }

    /// 로컬 설정이 바뀌었다. API 키 연결 켜짐이 바뀌면 러너를 다시 띄운다.
    pub fn set_local(&self, agent_id: &str, local: Option<LocalAgent>) -> &'static str {
        let (handle, now_on) = {
            let mut st = self.st();
            let Some(entry) = st.assigned.get_mut(agent_id) else {
                return "none";
            };
            let was = lane_on(entry.local.as_ref());
            entry.local = local;
            let now_on = lane_on(entry.local.as_ref());
            if was == now_on {
                return "updated";
            }
            (entry.definition.handle.clone(), now_on)
        };
        self.deps.log(&format!(
            "API 키 연결 {}: agent={handle} — 러너를 다시 띄운다(도는 턴이 끝난 뒤)",
            if now_on { "켬" } else { "끔" }
        ));
        if !self.deps.is_alive(agent_id) {
            return "restarting";
        }
        {
            let mut st = self.st();
            st.backoff.remove(agent_id);
            st.last_spawn_at.remove(agent_id);
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
    }

    impl AssignmentDeps for Fake {
        fn spawn(
            &self,
            agent_id: &str,
            env: &BTreeMap<String, String>,
            runner_id: &str,
        ) -> Result<SpawnResult, SpawnError> {
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
        fn log(&self, _line: &str) {}
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

    #[test]
    fn assign_env_has_link_and_no_url_or_pat() {
        let (f, r) = setup();
        let local = LocalAgent {
            working_dir: Some("/w".into()),
            claude_pool: Some("p".into()),
            provider_lane: None,
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
    fn other_spawn_error_is_returned() {
        let (f, r) = setup();
        *f.spawn_err.lock().unwrap() = Some(SpawnError::Other("boom".into()));
        let e = r
            .on_assign("u", def(CredentialScope::Community, None), None)
            .unwrap_err();
        assert_eq!(e, "boom");
        assert_eq!(f.forgets.lock().unwrap().len(), 1);
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
}
