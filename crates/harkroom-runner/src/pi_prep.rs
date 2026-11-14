//! pi 러너 홈 배선(p2) — 정본 `main.ts` 382~386(기동 때)·`readTurnMcp`(턴마다 `ensurePiHome`).
//! 홈 만들기는 [`crate::pi_home::ensure_pi_home`] 이 하고, 여기는 언제·무엇으로 부를지만 정한다.
//!
//! - 보통 러너: `<state>/pi-home` — 사람 `auth.json`·`models.json` 을 링크하고 기본 제공자·모델만 고른다.
//! - API 키 연결(lane) 러너: `<state>/pi-provider-lane` — 사람 것을 하나도 물려받지 않는다. 폴더는 claude·codex lane 과
//!   같은 검사(`ensure_lane_dir` — 링크·폴더 아님·남의 소유면 거절)로 만든다. 턴마다 쓰는 스레드 홈은 `pi_lane`.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::pi_home::ensure_pi_home;

/// 한 러너의 pi 홈 자리.
#[derive(Clone, Debug)]
pub struct PiPrep {
    /// 러너 전용 pi 루트(`<state>/pi-home` 또는 lane 이면 `<state>/pi-provider-lane`).
    pub home: PathBuf,
    /// API 키 연결 러너인가 — 사람 설정·로그인·제공자를 물려받지 않는다.
    pub lane: bool,
    /// 오퍼레이터가 쓴 MCP 표(`HARKROOM_MCP_CONFIG`) — 매번 다시 읽는다(표가 바뀔 수 있다).
    pub mcp_config_path: PathBuf,
    /// 사람 pi 상태 루트(`PI_CODING_AGENT_DIR`, 없으면 `~/.pi/agent`). 읽기·링크 대상으로만 쓴다.
    pub source_dir: PathBuf,
}

/// 보통 러너의 pi 루트(정본 `piHomeDir`).
pub fn pi_home_dir(state_dir: &Path) -> PathBuf {
    state_dir.join("pi-home")
}

/// lane 러너의 pi 루트(정본 `providerLanePiDir`). lane 폴더 검사를 지나야 돌려준다.
pub fn pi_lane_root(state_dir: &Path) -> std::io::Result<PathBuf> {
    let home = state_dir.join("pi-provider-lane");
    crate::account_lane::ensure_lane_dir(&home)?;
    Ok(home)
}

impl PiPrep {
    /// 지금 MCP 표로 루트를 맞춘다(멱등). 기동 때·pi 턴 직전에 부른다.
    pub fn ensure(&self) -> Result<PathBuf, String> {
        let mcp: Map<String, Value> = crate::turn_files::read_mcp_servers(&self.mcp_config_path)
            .map_err(|e| format!("MCP 표를 읽지 못했다: {e}"))?;
        ensure_pi_home(&self.home, &mcp, &self.source_dir, self.lane).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
#[path = "pi_prep_tests.rs"]
mod tests;
