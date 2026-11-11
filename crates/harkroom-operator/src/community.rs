//! 서버 링크의 배정 배선(s21c-1b-2b) — TS `community.ts` 의 `onFrame`(assign·unassign·agent.restart)·`ownerAccountId`·
//! `notifyRunnerStarted/Exited`·`onRunnerExit` 와 `communities.ts` 의 `runnerDeps` 이식.
//!
//! **TS 와 다른 점**
//! - 배정 처리(MCP 설정 쓰기·OAuth refresh·spawn)는 링크 스레드를 붙잡지 않게 **작업 스레드 하나**에서 차례로 한다. TS 의
//!   `assignsInFlight`(재시작이 앞 assign 을 기다림)는 같은 큐의 순서로 지켜진다 — assign 다음에 온 restart 는 assign 뒤에 돈다.
//! - `chrome_host` 는 이 판에서 늘 닫힘이다(TS `chromeHostAvailable` 이식 전 — 못 재면 닫힘과 같은 값).
//! - 러너 종료 사유(`runnerExitReason(tailLines)`)는 serve.rs 가 종료 꼬리로 가려 넘긴다(`runner_log::runner_exit_reason`).
//! - `/operators/self` 의 operator id 를 `operator.json` 에 적는 일(`rememberOperatorId`)은 하지 않는다 — 앱 기본값용이고 아직 TS 몫.
use crate::assignments::{
    AssignOutcome, AssignmentDeps, AssignmentReconciler, Cancel, LocalAgent, Sig, SpawnError,
    SpawnResult, Task,
};
use crate::forward::Transport;
use crate::local_agents::LocalAgents;
use crate::mcp_config::{build_mcp_config, read_local_mcp_definitions, write_agent_mcp_config};
use crate::mcp_oauth::{DefRef, McpOAuth};
use crate::runner_link::RunnerLinkServer;
use crate::runners::{RunnerTable, SpawnOutcome, signal_sent};
use harkroom_proto::p2::{AgentDefinition, OperatorToServerFrame, ServerToOperatorFrame};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// personal 배정이 기다리는 최대 시간 — 붙자마자 온 assign 이 `/operators/self` 답을 기다린다(TS 는 약속을 기다린다).
pub const OWNER_WAIT: Duration = Duration::from_secs(15);

/// `/operators/self` 의 소유자 id — 붙을 때마다 새로 읽는다(TS `selfOwner`). 읽는 중이면 기다린다.
#[derive(Default)]
pub struct OwnerCell {
    st: Mutex<Option<Option<String>>>,
    cv: Condvar,
}

impl OwnerCell {
    /// 새로 읽기 시작 — 그 사이 묻는 쪽은 기다린다.
    pub fn begin(&self) {
        *lock(&self.st) = None;
    }
    pub fn set(&self, owner: Option<String>) {
        *lock(&self.st) = Some(owner);
        self.cv.notify_all();
    }
    /// 답이 오면 그 값, 시한을 넘기면 `None`(모른다 → personal 거절).
    pub fn wait(&self, timeout: Duration) -> Option<String> {
        let g = lock(&self.st);
        let (g, _) = self
            .cv
            .wait_timeout_while(g, timeout, |s| s.is_none())
            .unwrap_or_else(|p| p.into_inner());
        g.clone().flatten()
    }
}

/// TS `readSelf` — `GET <base>/operators/self`. 실패는 `None`(personal 배정 거절).
pub fn read_self(transport: &dyn Transport, base_url: &str, token: &str) -> Option<String> {
    let url = format!("{}/operators/self", base_url.trim_end_matches('/'));
    let headers = [("authorization".to_string(), format!("Bearer {token}"))];
    match transport.send("GET", &url, &headers, None) {
        Ok(r) if (200..300).contains(&r.status) => {
            let v: Value = serde_json::from_str(&r.body).ok()?;
            v.get("ownerAccountId")
                .and_then(Value::as_str)
                .map(str::to_string)
        }
        Ok(r) => {
            eprintln!(
                "/operators/self 실패({}) — personal 배정은 거절된다: {base_url}",
                r.status
            );
            None
        }
        Err(e) => {
            eprintln!("/operators/self 실패 — personal 배정은 거절된다: {e}");
            None
        }
    }
}

/// 로컬 설정의 한 에이전트 칸 → 조정기의 `LocalAgent`.
pub fn local_agent_of(entry: &Value) -> LocalAgent {
    let s = |k: &str| entry.get(k).and_then(Value::as_str).map(str::to_string);
    LocalAgent {
        working_dir: s("workingDir"),
        claude_pool: s("claudePool"),
        provider_lane: entry.get("providerLane").cloned(),
    }
}

/// 새로 띄운 러너를 서버에 알리는 자리(agent id, runner id).
pub type StartedSink = Box<dyn Fn(&str, &str) + Send + Sync>;

/// TS `runnerDeps` — 실제 러너 표·러너 링크·로컬 설정·MCP 정의에 잇는다.
pub struct SystemDeps {
    pub runners: Arc<RunnerTable>,
    pub link: Arc<RunnerLinkServer>,
    pub local: LocalAgents,
    pub mcp_registry: PathBuf,
    pub claude_config: Option<PathBuf>,
    pub oauth: Arc<McpOAuth>,
    /// 하네스 MCP 설정 파일을 쓸 폴더(`<root>/operator/mcp`).
    pub mcp_dir: PathBuf,
    pub operator_bin: String,
    pub owner: Arc<OwnerCell>,
    /// 새로 띄웠으면 서버에 `runner.started` 를 낸다(TS `notifyRunnerStarted`).
    pub on_started: StartedSink,
}

impl AssignmentDeps for SystemDeps {
    fn spawn(
        &self,
        agent_id: &str,
        env: &BTreeMap<String, String>,
        runner_id: &str,
    ) -> Result<SpawnResult, SpawnError> {
        let env: Vec<(String, String)> = env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        match self.runners.spawn_runner(agent_id, &env, Some(runner_id)) {
            Ok(SpawnOutcome::Started(r)) => {
                (self.on_started)(agent_id, &r.incarnation_id);
                Ok(SpawnResult {
                    spawned: true,
                    pid: r.pid,
                    runner_id: r.incarnation_id,
                })
            }
            Ok(SpawnOutcome::Existing(r)) => Ok(SpawnResult {
                spawned: false,
                pid: r.pid,
                runner_id: r.incarnation_id,
            }),
            Err(e) => Err(SpawnError::Other(e)),
        }
    }

    fn signal(&self, agent_id: &str, sig: Sig) -> bool {
        match sig {
            Sig::Term => self.runners.kill_runner(agent_id, None).is_some(),
            Sig::Kill => self.runners.force_kill(agent_id),
        }
    }

    fn is_alive(&self, agent_id: &str) -> bool {
        self.runners
            .records()
            .iter()
            .any(|r| r.agent_id == agent_id && signal_sent(r.pid, 0))
    }

    fn list_runners(&self) -> Vec<Value> {
        crate::hello::announce_of(&self.runners)
            .into_iter()
            .filter_map(|a| serde_json::to_value(a).ok())
            .collect()
    }

    fn link_expect(&self, runner_id: &str, agent_id: &str, secret: &str) {
        self.link.expect(runner_id, agent_id, secret);
    }

    fn link_forget(&self, runner_id: &str) {
        self.link.forget(runner_id);
    }

    fn command_hook(&self) -> bool {
        self.local
            .read_config()
            .is_ok_and(|c| c.get("commandHook") == Some(&Value::Bool(true)))
    }

    fn post_tool_hook(&self) -> bool {
        self.local
            .read_config()
            .map_or(true, |c| c.get("postToolHook") != Some(&Value::Bool(false)))
    }

    fn operator_owner_id(&self) -> Option<String> {
        self.owner.wait(OWNER_WAIT)
    }

    fn mcp_config(&self, definition: &AgentDefinition) -> Result<String, Vec<String>> {
        let definitions =
            match read_local_mcp_definitions(&self.mcp_registry, self.claude_config.as_deref()) {
                Ok(d) => d,
                Err(e) => {
                    // TS 는 읽기 실패를 배정 처리 실패로 던진다 — 여기서는 모든 이름을 missing 으로 거절한다(덜 띄우는 쪽).
                    eprintln!("MCP 정의를 읽지 못했다: {e}");
                    return Err(definition.mcp_servers.clone());
                }
            };
        let mut remote = BTreeMap::new();
        for n in &definition.mcp_servers {
            if let Some(d) = definitions.get(n)
                && let Some(url) = d.get("url").and_then(Value::as_str)
            {
                remote.insert(
                    n.clone(),
                    DefRef {
                        url: Some(url.to_string()),
                        client_id: d
                            .get("oauth")
                            .and_then(|o| o.get("clientId"))
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string),
                    },
                );
            }
        }
        let auth = self.oauth.tokens_for(&remote).unwrap_or_else(|e| {
            eprintln!("MCP OAuth 토큰을 읽지 못했다(토큰 없이 띄운다): {e:?}");
            Default::default()
        });
        let built = build_mcp_config(
            &self.operator_bin,
            &definition.mcp_servers,
            &definitions,
            &auth.tokens,
            &auth.expired,
        );
        if !built.missing.is_empty() {
            return Err(built.missing);
        }
        if !built.needs_auth.is_empty() {
            eprintln!(
                "MCP 인증 필요: agent={} — {} (데스크톱 › 에이전트 › MCP 에서 인증)",
                definition.handle,
                built.needs_auth.join(", ")
            );
        }
        match write_agent_mcp_config(&self.mcp_dir, &definition.agent_id, &built.mcp_servers) {
            Ok(p) => Ok(p.to_string_lossy().into_owned()),
            Err(e) => {
                eprintln!("MCP 설정 파일을 쓰지 못했다: {e}");
                Err(definition.mcp_servers.clone())
            }
        }
    }

    fn schedule(&self, task: Task, ms: u64) -> Cancel {
        schedule_thread(task, ms)
    }

    fn log(&self, line: &str) {
        eprintln!("{line}");
    }

    fn now_ms(&self) -> u64 {
        crate::runners::now_ms().max(0) as u64
    }
}

/// 예약 하나 = 잠자는 스레드 하나. 취소하면 깨어나도 아무것도 안 한다.
pub fn schedule_thread(task: Task, ms: u64) -> Cancel {
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancelled);
    let spawned = std::thread::Builder::new()
        .name("assign-timer".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_millis(ms));
            if !flag.load(Ordering::SeqCst) {
                task();
            }
        });
    if spawned.is_err() {
        eprintln!("예약 스레드를 띄우지 못했다({ms}ms)");
    }
    Box::new(move || cancelled.store(true, Ordering::SeqCst))
}

enum Job {
    Assign(Box<AgentDefinition>, LocalAgent),
    Unassign(String, bool),
    Restart(String),
    /// 앞에 넣은 일이 다 끝났다는 신호(시험·종료 정리용).
    Flush(Sender<()>),
}

/// 서버가 내린 배정 프레임을 조정기로 넘기는 배선. 처리는 작업 스레드 하나에서 받은 순서대로 한다.
pub struct AssignmentFrames {
    tx: Mutex<Sender<Job>>,
    assigned: Arc<Mutex<HashSet<String>>>,
    reconciler: Arc<AssignmentReconciler>,
    /// 회수 기준(s21c-2c-1b-2, TS community.ts `syncedKeep`) — 이번 연결에서 받은 「남길 것」. 못 받았으면 None.
    synced: Mutex<SyncedState>,
}

#[derive(Default)]
struct SyncedState {
    keep: Option<HashSet<String>>,
    this_link: HashSet<String>,
}

/// `assign.synced` 의 목록 모양 검사(TS `parseAssignSynced`) — 틀리면 None(= 못 받음 → 회수 안 함).
pub fn parse_synced_ids(ids: &[String]) -> Option<HashSet<String>> {
    if ids.len() > 10_000 {
        return None;
    }
    let mut out = HashSet::new();
    for id in ids {
        if id.is_empty() || id.chars().count() > 64 {
            return None;
        }
        out.insert(id.clone());
    }
    Some(out)
}

/// 배정에 없는 채택 러너 회수(TS `adoptedReap.ts`). 이 오퍼레이터는 커뮤니티 하나를 맡으므로 「모든 커뮤니티」는
/// 이 커뮤니티다. 채택한 러너 중 로컬 설정에 있는(`knows`) 에이전트이면서 남길 것에 없는 것만, 신호 직전에 남길 것을
/// 다시 보고 `kill_runner`(채택 러너면 커널 시작 시각 재대조)로 SIGTERM. 회수한 에이전트 id 를 돌려준다.
pub fn reap_unassigned_adopted(
    keep: &dyn Fn() -> Option<HashSet<String>>,
    table: &RunnerTable,
    knows: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let mut reaped = Vec::new();
    if keep().is_none() {
        return reaped;
    }
    for rec in table.records() {
        if !rec.adopted || !knows(&rec.agent_id) {
            continue;
        }
        // 다시 붙었거나 배정이 왔으면 안 죽인다 — 매번 지금 값을 본다.
        let unassigned = || matches!(keep(), Some(k) if !k.contains(&rec.agent_id));
        if !unassigned() {
            continue;
        }
        // 시작 시각 재대조(ps) 뒤 신호 직전에 한 번 더 본다 — ps 사이에 온 assign 을 놓치지 않게(security #1900 낮음).
        if table
            .kill_runner_if(&rec.agent_id, Some(&rec.incarnation_id), &unassigned)
            .is_some()
        {
            eprintln!(
                "채택 러너 회수: agent={} pid={} — 이 오퍼레이터의 배정에 없다(SIGTERM)",
                rec.agent_id, rec.pid
            );
            reaped.push(rec.agent_id);
        } else {
            eprintln!(
                "채택 러너 회수 안 함: agent={} pid={} — 세대가 바뀌었거나, 시작 시각이 장부와 다르거나, 그 사이 배정이 왔다",
                rec.agent_id, rec.pid
            );
        }
    }
    reaped
}

pub type SendFrame = Arc<dyn Fn(OperatorToServerFrame) -> bool + Send + Sync>;

impl AssignmentFrames {
    pub fn start(
        reconciler: Arc<AssignmentReconciler>,
        base_url: String,
        send: SendFrame,
        new_id: Box<dyn Fn() -> String + Send>,
    ) -> Arc<Self> {
        let (tx, rx) = channel::<Job>();
        let assigned = Arc::new(Mutex::new(HashSet::new()));
        let worker_rec = Arc::clone(&reconciler);
        let worker_set = Arc::clone(&assigned);
        let _ = std::thread::Builder::new()
            .name("assignments".into())
            .spawn(move || {
                for job in rx {
                    match job {
                        Job::Assign(def, local) => {
                            let agent_id = def.agent_id.clone();
                            match worker_rec.on_assign(&base_url, *def, Some(local)) {
                                Ok(AssignOutcome::Refused(reason)) => {
                                    // 거절은 조용히 안 뜨는 것이 아니다 — 서버가 사유를 본다. runnerId 는 이 통지만을 위한 새 값.
                                    lock(&worker_set).remove(&agent_id);
                                    send(OperatorToServerFrame::RunnerExited {
                                        runner_id: new_id(),
                                        code: None,
                                        reason: Some(reason),
                                        agent_id: Some(agent_id),
                                    });
                                }
                                Ok(_) => {}
                                Err(e) => eprintln!("배정 처리 실패: {e}"),
                            }
                        }
                        Job::Unassign(agent_id, drain) => {
                            worker_rec.on_unassign(&base_url, &agent_id, drain);
                        }
                        Job::Flush(done) => {
                            let _ = done.send(());
                        }
                        Job::Restart(agent_id) => {
                            if !worker_rec.restart(&agent_id) {
                                eprintln!("재시작 무시: agent={agent_id} — 배정·러너가 없다");
                            }
                        }
                    }
                }
            });
        Arc::new(Self {
            tx: Mutex::new(tx),
            assigned,
            reconciler,
            synced: Mutex::new(SyncedState::default()),
        })
    }

    fn push(&self, job: Job) {
        if lock(&self.tx).send(job).is_err() {
            eprintln!("배정 작업 스레드가 없다 — 프레임을 버린다");
        }
    }

    /// 앞서 넣은 프레임 처리가 끝날 때까지 기다린다. 시한 안에 끝나면 `true`.
    pub fn flush(&self, timeout: Duration) -> bool {
        let (tx, rx) = channel();
        self.push(Job::Flush(tx));
        rx.recv_timeout(timeout).is_ok()
    }

    /// 연결이 열리거나 끊겼다 — 받음 표지를 지운다(지난 연결의 목록으로 회수하지 않는다).
    pub fn reset_synced(&self) {
        *lock(&self.synced) = SyncedState::default();
    }

    /// 이번 연결의 「남길 것」. 아직 못 받았으면(옛 서버 포함) None.
    pub fn synced_keep(&self) -> Option<HashSet<String>> {
        lock(&self.synced).keep.clone()
    }

    /// assign·unassign·agent.restart 면 맡고 `true`. `local` 은 이 머신의 로컬 설정에서 그 에이전트 칸.
    pub fn on_frame(
        &self,
        frame: &ServerToOperatorFrame,
        local: &dyn Fn(&str) -> Option<LocalAgent>,
    ) -> bool {
        match frame {
            ServerToOperatorFrame::Assign {
                agent_id,
                definition,
            } => {
                // 「남길 것」은 받은 그대로 먼저 적는다 — 아래 검사로 거절해도 그 에이전트의 러너를 회수 길로 죽이지 않는다.
                {
                    let mut st = lock(&self.synced);
                    st.this_link.insert(agent_id.clone());
                    if let Some(k) = st.keep.as_mut() {
                        k.insert(agent_id.clone());
                    }
                }
                // 동의를 확인한 에이전트와 띄울 에이전트가 같아야 한다 — 다르면 로컬에 없는 에이전트가 남의 로컬 설정
                // (작업 폴더 등)으로 뜬다. 오퍼레이터는 서버만 믿지 않는다(security #1892 낮음).
                if definition.agent_id != *agent_id {
                    eprintln!(
                        "배정을 거절한다: agent={agent_id} — 정의의 agentId({})와 다르다",
                        definition.agent_id
                    );
                    return true;
                }
                // 양쪽 동의(스펙 §3): 로컬 설정에 없으면 서버가 무엇을 내려도 띄우지 않는다.
                let Some(l) = local(agent_id) else {
                    eprintln!("배정을 거절한다: agent={agent_id} — 이 머신의 로컬 설정에 없다");
                    return true;
                };
                lock(&self.assigned).insert(agent_id.clone());
                self.push(Job::Assign(Box::new(definition.clone()), l));
                true
            }
            ServerToOperatorFrame::Unassign { agent_id, drain } => {
                lock(&self.assigned).remove(agent_id);
                self.push(Job::Unassign(agent_id.clone(), *drain));
                true
            }
            ServerToOperatorFrame::AgentRestart { agent_id } => {
                self.push(Job::Restart(agent_id.clone()));
                true
            }
            ServerToOperatorFrame::AssignSynced { agent_ids } => {
                let Some(mut keep) = parse_synced_ids(agent_ids) else {
                    eprintln!("assign.synced 를 버린다 — agentIds 모양이 틀렸다");
                    return true;
                };
                let mut st = lock(&self.synced);
                keep.extend(st.this_link.iter().cloned());
                st.keep = Some(keep);
                true
            }
            _ => false,
        }
    }

    /// TS `onRunnerExit` — 이 커뮤니티의 배정이면 조정기에(재기동 판단).
    pub fn on_runner_exit(&self, agent_id: &str, code: Option<i32>, reason: Option<&str>) {
        if lock(&self.assigned).contains(agent_id) {
            self.reconciler.on_runner_exit(agent_id, code, reason);
        }
    }

    /// TS `setAgents` — 배정된 에이전트의 로컬 설정을 조정기에 넘긴다.
    pub fn set_locals(&self, local: &dyn Fn(&str) -> Option<LocalAgent>) {
        let ids: Vec<String> = lock(&self.assigned).iter().cloned().collect();
        for id in ids {
            self.reconciler.set_local(&id, local(&id));
        }
    }

    pub fn is_assigned(&self, agent_id: &str) -> bool {
        lock(&self.assigned).contains(agent_id)
    }
}

#[cfg(test)]
mod tests;
