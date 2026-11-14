//! 기동 재료(L3d-3b-2) — `main.rs` 가 쓰는, 시험할 수 있는 순수 조립.
//!
//! - [`agent_state_dir`]: 정본 `stateDir.ts::resolveAgentStateDir` — 에이전트마다 `<상태 뿌리>/<에이전트 id>[/<인스턴스>]`.
//!   예약 이름(`c`·`by-name`)은 고르지 않고, 옛 `<handle>-<id>` 폴더가 있으면 그것을 쓴다.
//! - 작업 폴더 뿌리는 **에이전트마다 따로**(`<에이전트 상태>/workspaces`, security #2098). 옛 이름 찾기가 같은 스레드 해시로 끝나는
//!   어느 폴더든 집으므로, 뿌리를 에이전트끼리 나누면 같은 스레드에 불린 다른 에이전트의 폴더를 집는다.
//! - [`maker_config`]: 짓개 설정. 자식 env 는 허용 목록만(`harness_parent_env`), 가림 바늘은 러너 자격(링크 열쇠).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::call_maker::MakerConfig;
use crate::config::{Env, RunnerConfig};
use crate::turn_env::harness_parent_env;

/// 정본 `RESERVED_STATE_DIR_NAMES`.
const RESERVED_STATE_DIR_NAMES: [&str; 2] = ["c", "by-name"];

/// 정본 `resolveAgentStateDir` 의 `agentStateDir`.
pub fn agent_state_dir(
    base: &Path,
    agent_id: &str,
    instance: Option<&str>,
    existing: &[String],
) -> PathBuf {
    let adopted = existing.iter().find(|n| {
        !RESERVED_STATE_DIR_NAMES.contains(&n.as_str())
            && (n.as_str() == agent_id || n.ends_with(&format!("-{agent_id}")))
    });
    let dir = base.join(adopted.map(String::as_str).unwrap_or(agent_id));
    match instance {
        Some(i) => dir.join(i),
        None => dir,
    }
}

/// 상태 뿌리의 이름들(없으면 빈 목록).
pub fn state_dir_names(base: &Path) -> Vec<String> {
    std::fs::read_dir(base)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// 에이전트별 작업 폴더 뿌리.
pub fn workspace_base_dir(agent_state: &Path) -> PathBuf {
    agent_state.join("workspaces")
}

/// 기동 때 정해지는 값.
pub struct BootFacts<'a> {
    pub me_id: &'a str,
    pub claim_holder: &'a str,
    pub agent_state: PathBuf,
    pub home: PathBuf,
}

/// 짓개 설정.
pub fn maker_config(cfg: &RunnerConfig, env: &Env, f: BootFacts<'_>) -> MakerConfig {
    let runner_env: BTreeMap<String, String> =
        env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    MakerConfig {
        operator_bin: cfg.operator_bin.clone(),
        command_hook: cfg.command_hook,
        post_tool_hook: cfg.post_tool_hook,
        workspace_base_dir: workspace_base_dir(&f.agent_state),
        state_dir: f.agent_state,
        mcp_config_path: PathBuf::from(&cfg.mcp_config_path),
        parent_env: harness_parent_env(&runner_env),
        runner_env,
        // 링크 세계의 러너 자격은 링크 열쇠다 — 턴 기록 가리기의 바늘로만 쓴다(자식 env 로는 가지 않는다).
        pat: cfg.operator_link.secret.clone(),
        home: f.home,
        turn_timeout_ms: cfg.turn_timeout_ms,
        pty_record_dir: cfg.pty_record_dir.as_ref().map(PathBuf::from),
        harness_stall_ms: cfg.harness_stall_ms,
        me_id: f.me_id.to_string(),
        claim_holder: f.claim_holder.to_string(),
        // 지금 오퍼레이터는 턴 열쇠를 받는다(#2016). 맡기기에 실패한 턴은 브릿지가 못 붙는다(닫히는 쪽).
        can_register_turn_keys: true,
        // main.rs 가 lane 여부를 정한 뒤 채운다(`RunnerMaker::set_codex`).
        codex: None,
    }
}

#[cfg(test)]
#[path = "runner_boot_tests.rs"]
mod tests;
