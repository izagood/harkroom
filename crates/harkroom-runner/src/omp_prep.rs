//! omp 러너 홈 배선(o2) — 정본 `main.ts` 388(기동 때 `ensureOmpHome`)·480(omp 턴 직전 다시 씀)·`mentionTurn.ts` 1655~1676(스레드 자리).
//! 홈 만들기는 [`crate::omp_home`] 이 하고, 여기는 언제·무엇으로 부를지만 정한다.
//!
//! omp 는 API 키 연결(lane)로만 돈다 — 사람 로그인·설정을 하나도 물려받지 않는다. 루트 `<state>/omp-home` 은 lane 폴더와
//! 같은 검사(`ensure_lane_dir` — 링크·폴더 아님·남의 소유면 거절)를 지나야 쓴다.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::omp_home::{
    OmpThreadDirs, ensure_omp_home, ensure_omp_thread, omp_cwd_violations, omp_dirs,
    sweep_omp_thread_cwd, write_omp_session_header,
};

/// 한 러너의 omp 홈 자리.
#[derive(Clone, Debug)]
pub struct OmpPrep {
    /// 러너 전용 omp 루트(`<state>/omp-home`).
    pub home: PathBuf,
    /// 오퍼레이터가 쓴 MCP 표(`HARKROOM_MCP_CONFIG`) — 매번 다시 읽는다(표가 바뀔 수 있다).
    pub mcp_config_path: PathBuf,
    /// 러너 상태 폴더 — 스레드 cwd 위 폴더의 금지 이름 검사가 여기서 멈춘다(정본 `ompCwdViolations(cwd, stateDir)`).
    pub state_dir: PathBuf,
}

/// 러너의 omp 루트(정본 `ompHomeDir`). 링크·남의 소유면 거절한다.
pub fn omp_home_root(state_dir: &Path) -> std::io::Result<PathBuf> {
    let home = state_dir.join("omp-home");
    crate::account_lane::ensure_lane_dir(&home)?;
    Ok(home)
}

impl OmpPrep {
    /// 지금 MCP 표로 루트를 맞춘다(멱등). 기동 때·omp 턴 직전에 부른다.
    pub fn ensure(&self) -> Result<PathBuf, String> {
        let mcp: Map<String, Value> = crate::turn_files::read_mcp_servers(&self.mcp_config_path)
            .map_err(|e| format!("MCP 표를 읽지 못했다: {e}"))?;
        ensure_omp_home(&self.home, &mcp).map_err(|e| e.to_string())
    }

    /// omp 턴 직전의 스레드 자리(정본 `mentionTurn.ts` 1664~1670): 스레드 폴더를 짓고, cwd 에 남은 것을 옮기고, cwd 와 그 위
    /// 폴더에 저장소 설정 이름이 있으면 거절하고, 세션 헤더를 그 cwd 로 미리 쓴다. 하나라도 못 하면 `Err` — 띄우지 않는다.
    pub fn prepare_thread(
        &self,
        key: &str,
        session_id: &str,
        path_env: Option<&str>,
    ) -> Result<OmpThreadDirs, String> {
        let t = ensure_omp_thread(&self.home, key, path_env).map_err(|e| e.to_string())?;
        let swept = sweep_omp_thread_cwd(&t, None).map_err(|e| e.to_string())?;
        if !swept.is_empty() {
            eprintln!(
                "[mentionTurn] {key}: omp 스레드 폴더에 남은 {}개를 옮겼다",
                swept.len()
            );
        }
        let bad = omp_cwd_violations(&t.cwd, &self.state_dir).map_err(|e| e.to_string())?;
        if !bad.is_empty() {
            return Err(format!(
                "omp 스레드 폴더를 비우지 못했거나 그 위 폴더에 설정 파일이 있다({}개)",
                bad.len()
            ));
        }
        write_omp_session_header(&omp_dirs(&self.home).sessions_dir, session_id, &t.cwd, None)
            .map_err(|e| e.to_string())?;
        Ok(t)
    }
}

#[cfg(test)]
#[path = "omp_prep_tests.rs"]
mod tests;
