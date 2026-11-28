//! 백그라운드 회차의 배선(정본 `main.ts` 의 `bgExecutor` 자리) — 실물 plan 조립과 주기 스레드. 실행기는 [`crate::bg_tick`].
//!
//! 물어볼 때인지는 서버가 정한다(`bg.claim`) — 러너는 5분마다 묻기만 한다. API 키 lane 러너와 claude-code 가 아닌 하네스는 돌리지 않는다.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;

use crate::adapter::{AgentHarness, MentionPermission};
use crate::bg_executor::{
    BG_POLL_INTERVAL, BG_SYSTEM_PROMPT, BG_TIMEOUT, BgJob, write_bg_mcp_config,
};
use crate::bg_tick::{
    BgExecutor, BgExecutorDeps, BgHarkroom, BgOutcome, BgPlan, BgSlots, SlotGrant,
};
use crate::call_maker::{MakerConfig, RunnerMaker, harness_of};
use crate::link::random_uuid;
use crate::mention_clients::{AgentClients, AgentLink};
use crate::rest::{OpenTurn, SlotOutcome};
use crate::turn_assemble::env_turn_keys;
use crate::turn_command::{TurnCommandOptions, build_turn_command};
use crate::turn_files::{read_mcp_servers, write_system_prompt_file};
use crate::turn_mcp_plan::{TurnFiles, TurnMcpInput, TurnMcpPlan, turn_mcp_plan};
use crate::turn_preset::TurnMode;

/// 회차 작업 폴더의 뿌리(상태 폴더 아래).
pub const BG_DIR: &str = "bg";

struct Client<L: AgentLink>(Arc<AgentClients<L>>);

impl<L: AgentLink + Send + Sync> BgHarkroom for Client<L> {
    fn claim_bg(&self) -> Result<Option<BgJob>, String> {
        let j = self.0.mcp().claim_bg().map_err(|e| e.message)?;
        Ok(j.map(|j| BgJob {
            id: j.id,
            kind: j.kind,
            day: j.day,
            input: j.input.as_object().cloned().unwrap_or_default(),
        }))
    }
    fn complete_bg(&self, job_id: &str, outcome: &BgOutcome) -> Result<(), String> {
        let v = serde_json::to_value(outcome).map_err(|e| e.to_string())?;
        self.0.mcp().complete_bg(job_id, v).map_err(|e| e.message)
    }
}

impl<L: AgentLink + Send + Sync> BgSlots for Client<L> {
    fn acquire(&self, key: &str, keep_free: u32) -> SlotGrant {
        match self.0.rest().acquire_turn_slot(key, Some(keep_free)) {
            SlotOutcome::Granted => SlotGrant::Granted,
            // 배경 회차는 거절도 자리 없음으로 미룬다 — 실패 통지는 멘션 길만 낸다.
            SlotOutcome::Full | SlotOutcome::Refused(_) => SlotGrant::Full,
            SlotOutcome::Unsupported => SlotGrant::Unsupported,
        }
    }
    fn release(&self, key: &str) {
        self.0.rest().release_turn_slot(key);
    }
}

/// 회차의 MCP 설정 — harkroom 하나만 담은 설정을 작업 폴더에 쓰고, 그 위에 턴 열쇠를 얹는다.
fn mcp_plan(c: &MakerConfig, turn_id: &str, cwd: &Path) -> Result<TurnMcpPlan, String> {
    let servers = read_mcp_servers(&c.mcp_config_path).map_err(|_| "MCP 설정을 읽지 못했다")?;
    let bg = write_bg_mcp_config(cwd, &servers).map_err(|e| e.to_string())?;
    let p = turn_mcp_plan(&TurnMcpInput {
        harness: AgentHarness::ClaudeCode,
        can_register_turn_keys: c.can_register_turn_keys,
        provider_env: None,
        state_dir: &c.state_dir,
        mcp_config_path: &bg,
        turn_id,
        runner_env: &c.runner_env,
    })
    .map_err(|_| "턴 MCP 설정을 쓰지 못했다")?;
    Ok(p)
}

#[allow(clippy::too_many_arguments)]
/// 명령 조립 — 권한 인자는 `bg_executor_args` 가 dontAsk + 허용 목록으로 바꾼다.
fn command(
    c: &MakerConfig,
    def: &Value,
    job: &BgJob,
    session_id: &str,
    turn_id: &str,
    cwd: &Path,
    claude_dir: Option<&Path>,
    mcp: &TurnMcpPlan,
) -> Result<crate::turn_command::TurnPlan, String> {
    let prompt_file = write_system_prompt_file(cwd, "bg", BG_SYSTEM_PROMPT)
        .map_err(|_| "지시문을 쓰지 못했다")?;
    let prompt_file = prompt_file.to_string_lossy();
    let mcp_path = mcp.mcp_config_path.to_string_lossy();
    let cause = format!("bg:{}", job.id);
    let keys = env_turn_keys(mcp);
    let mut o = TurnCommandOptions::new(
        AgentHarness::ClaudeCode,
        TurnMode::Mention,
        MentionPermission::Readonly,
        &c.operator_bin,
    );
    o.session_id = Some(session_id);
    o.system_prompt = BG_SYSTEM_PROMPT;
    o.system_prompt_file = Some(&prompt_file);
    o.model = def.get("model").and_then(Value::as_str);
    o.effort = def.get("effort").and_then(Value::as_str);
    o.mcp_config_path = &mcp_path;
    o.claude_config_dir = claude_dir;
    o.cause_message_id = Some(&cause);
    o.turn_id = Some(turn_id);
    o.turn_keys = keys.as_ref();
    // 오류의 자세한 꼴은 싣지 않는다(경로·env 이름이 로그에 남지 않게).
    build_turn_command(&o, &c.parent_env, &c.home).map_err(|_| "명령을 짓지 못했다".into())
}

/// 실물 plan(정본 `buildPlan`). 맡기기·조립이 실패하면 열쇠와 설정 파일을 바로 거둔다 — 열쇠 없이 띄우지 않는다.
fn build_plan<L: AgentLink + Send + Sync + 'static>(
    maker: &RunnerMaker<L>,
    job: &BgJob,
    session_id: &str,
    cwd: &Path,
) -> Result<BgPlan, String> {
    let c = maker.config();
    let clients = maker.clients();
    let def = clients.rest().definition().map_err(|e| e.message)?;
    if harness_of(&def) != AgentHarness::ClaudeCode {
        return Err("하네스가 그 사이 바뀌었다".into());
    }
    let claude_dir: Option<PathBuf> = maker.bg_account_dir();
    let turn_id = random_uuid();
    let mcp = mcp_plan(c, &turn_id, cwd)?;
    let files = TurnFiles::of(&mcp, &c.state_dir, &turn_id);
    let Some(keys) = mcp.turn_keys.clone() else {
        return Err("턴 열쇠가 없다".into());
    };
    let (rc, id) = (Arc::clone(&clients), turn_id.clone());
    let release = move || {
        let _ = rc.rest().end_turn_keys(&id);
        drop(files);
    };
    let turn = OpenTurn {
        turn_id: turn_id.clone(),
        cause: Some(format!("bg:{}", job.id)),
        keys,
    };
    let built = clients
        .rest()
        .register_turn_keys(turn)
        .map_err(|e| e.to_string())
        .and_then(|()| {
            let dir = claude_dir.as_deref();
            command(c, &def, job, session_id, &turn_id, cwd, dir, &mcp)
        });
    match built {
        Ok(p) => Ok(BgPlan {
            command: p.command,
            args: p.args,
            env: p.env.into_iter().collect(),
            release: Some(Box::new(release)),
        }),
        Err(e) => {
            release();
            Err(e)
        }
    }
}

/// 지난 러너가 비정상 종료해 남긴 회차 작업 폴더를 쓸어 낸다. 물러나는 중인 옛 러너의 것일 수 있어 회차 시한이 지난 것만 지운다.
pub fn sweep_bg_dirs(state_dir: &Path, now: SystemTime) -> usize {
    let Ok(rd) = std::fs::read_dir(state_dir.join(BG_DIR)) else {
        return 0;
    };
    let mut n = 0;
    for e in rd.flatten() {
        let old = e.metadata().is_ok_and(|m| {
            m.is_dir()
                && m.modified()
                    .ok()
                    .and_then(|t| now.duration_since(t).ok())
                    .is_some_and(|d| d > BG_TIMEOUT * 2)
        });
        if old && std::fs::remove_dir_all(e.path()).is_ok() {
            n += 1;
        }
    }
    n
}

/// 도는 주기 스레드의 손잡이 — 러너가 물러날 때 쓴다.
pub struct BgLoop {
    ex: Arc<BgExecutor>,
    closed: Arc<AtomicBool>,
}

impl BgLoop {
    /// 새 회차를 집지 않는다(폴이 멈출 때). 도는 회차는 둔다.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    /// 도는 회차를 죽이고 보고·정리가 끝나기를 기다린다. 끝났으면 참.
    pub fn shutdown(&self, limit: Duration) -> bool {
        self.close();
        self.ex.stop();
        let t0 = Instant::now();
        while self.ex.running() && t0.elapsed() < limit {
            std::thread::sleep(Duration::from_millis(50));
        }
        !self.ex.running()
    }
}

/// 실행기를 짓고 주기 스레드를 띄운다.
pub fn start<L: AgentLink + Send + Sync + 'static>(
    maker: &Arc<RunnerMaker<L>>,
) -> std::io::Result<BgLoop> {
    let clients = maker.clients();
    let state_dir = maker.config().state_dir.clone();
    sweep_bg_dirs(&state_dir, SystemTime::now());
    let (hc, pm) = (Arc::clone(&clients), Arc::clone(maker));
    let ex = Arc::new(BgExecutor::new(BgExecutorDeps {
        harness: Box::new(move || {
            hc.rest()
                .definition()
                .map(|d| harness_of(&d))
                .map_err(|e| e.message)
        }),
        harkroom: Box::new(Client(Arc::clone(&clients))),
        build_plan: Box::new(move |j, sid, cwd| build_plan(&pm, j, sid, cwd)),
        provider_lane_on: false,
        slots: Box::new(Client(clients)),
        state_dir,
        spawn: None,
        timeout: None,
        log: Some(Box::new(|l| eprintln!("{l}"))),
    }));
    spawn_loop(ex, BG_POLL_INTERVAL)
}

/// 첫 틱도 한 간격 뒤다 — 기동 직후의 멘션 턴을 먼저 받는다.
fn spawn_loop(ex: Arc<BgExecutor>, every: Duration) -> std::io::Result<BgLoop> {
    let closed = Arc::new(AtomicBool::new(false));
    let (e, c) = (Arc::clone(&ex), Arc::clone(&closed));
    std::thread::Builder::new()
        .name("bg-tick".into())
        .spawn(move || {
            let mut next = Instant::now() + every;
            while !c.load(Ordering::SeqCst) {
                if Instant::now() < next {
                    std::thread::sleep(every.min(Duration::from_millis(500)));
                    continue;
                }
                let tick = std::panic::AssertUnwindSafe(|| e.tick());
                if std::panic::catch_unwind(tick).is_err() {
                    eprintln!("[bg] tick 이 패닉으로 끝났다");
                }
                next = Instant::now() + every;
            }
        })?;
    Ok(BgLoop { ex, closed })
}

#[cfg(test)]
#[path = "bg_wire_tests.rs"]
mod tests;
