//! opencode·kilo 러너 홈 배선(o1) — 정본 `main.ts` 369~378(기동 때 모든 XDG 앱)·`readTurnMcp`(턴마다 그 하네스 앱).
//! 홈 만들기는 [`crate::opencode_ensure`] 가 하고, 여기는 언제·무엇으로 부를지만 정한다.

use std::path::{Path, PathBuf};

use serde_json::Map;

use crate::adapter::{XdgApp, all_xdg_apps};
use crate::opencode_ensure::{EnsureOpencodeHome, LaneHome, ensure_opencode_home};
use crate::opencode_home::{source_opencode_config, source_opencode_data};

/// 한 러너의 opencode 홈 자리.
#[derive(Clone, Debug)]
pub struct OpencodePrep {
    /// 러너 전용 XDG 루트(`<state>/opencode-home`).
    pub home: PathBuf,
    /// API 키 연결 러너인가 — 사람 설정·로그인을 물리지 않고 lane 블록을 쓴다.
    pub lane: bool,
    /// 오퍼레이터가 쓴 MCP 표(`HARKROOM_MCP_CONFIG`) — 매번 다시 읽는다(표가 바뀔 수 있다).
    pub mcp_config_path: PathBuf,
    /// 사람 설정·data 를 찾을 자리(러너 env 의 `XDG_CONFIG_HOME`·`XDG_DATA_HOME`, 없으면 홈 기본).
    pub user_xdg_config: Option<String>,
    pub user_xdg_data: Option<String>,
    pub user_home: PathBuf,
    /// lane 턴의 스킬 자리(정본 `runnerSkillsDir(agentStateDir)`).
    pub skills_dir: Option<PathBuf>,
}

impl OpencodePrep {
    fn ensure_app(&self, app: &XdgApp, lane: Option<LaneHome<'_>>) -> Result<PathBuf, String> {
        let mcp: Map<String, serde_json::Value> =
            crate::turn_files::read_mcp_servers(&self.mcp_config_path)
                .map_err(|e| format!("MCP 표를 읽지 못했다: {e}"))?;
        let user_config_dir =
            source_opencode_config(self.user_xdg_config.as_deref(), &self.user_home, app)
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_default();
        let user_data_dir =
            source_opencode_data(self.user_xdg_data.as_deref(), &self.user_home, app);
        ensure_opencode_home(&EnsureOpencodeHome {
            opencode_home: &self.home,
            mcp_servers: &mcp,
            app,
            user_config_dir: &user_config_dir,
            user_data_dir: &user_data_dir,
            provider_lane: lane,
        })
        .map_err(|e| e.to_string())
    }

    /// 기동 때 — 모든 XDG 앱(opencode·kilo)의 설정을 쓴다. lane 러너는 모델 없이 lane 블록만.
    pub fn boot(&self) -> Result<(), String> {
        for app in all_xdg_apps() {
            let lane = self.lane.then_some(LaneHome {
                model: None,
                skills_dir: None,
                channel: None,
            });
            self.ensure_app(&app, lane)?;
        }
        Ok(())
    }

    /// 턴 직전 — 그 하네스 앱의 설정을 지금 MCP 표로 다시 쓴다. lane 러너면 그 턴의 모델·채널 칸까지(정본 `readTurnMcp`).
    pub fn before_turn(
        &self,
        app: &XdgApp,
        model: Option<&str>,
        channel: Option<(&str, &[String])>,
    ) -> Result<(), String> {
        let lane = self.lane.then_some(LaneHome {
            model,
            skills_dir: self.skills_dir.as_deref(),
            channel,
        });
        self.ensure_app(app, lane).map(|_| ())
    }
}

#[cfg(test)]
#[path = "opencode_prep_tests.rs"]
mod tests;
