//! lane(API 키 연결) env 를 **턴 MCP 계획보다 먼저** 받는다(정본 `mentionTurn.ts` — `providerEnv` 를 받은 뒤에
//! `writeTurnMcpConfig`·opencode 턴 파일을 쓴다). 계획이 lane 전용 MCP 설정·opencode lane 턴 파일을 그 env 로 고른다.
//!
//! [`mount_lane_first`] 는 관문을 먼저 보고(막혔으면 받지 않는다) env 를 받아 [`LaneFirst`] 가드로 돌려준다. 가드가
//! 떨어지면(어느 길로든) 턴 임대를 끝내고 lane 턴 파일을 거둔다 — 띄우기 순서의 lane 키 단계 정리
//! (`RestRelease` 의 `LaneKeys`: 임대 끝 → `release`)와 같은 차례다. 받기가 실패해도 임대는 끝낸다(마운트 뒤 실패여도
//! 키 파일은 임대 끝내기가 거둔다). 서버·글로는 접힌 코드만, 경로·원인은 로컬 로그로만.

use std::io;

use crate::adapter::AgentHarness;
use crate::provider_lane::{LaneFileError, ProviderLane};
use crate::turn_attempt::LeaseNotice;
use crate::turn_launch_io::LaneEnv;
use crate::turn_probe_records::SpawnBlocked;

/// lane env 를 주고 거두는 쪽(실물은 [`ProviderLane`]).
pub trait LaneSource {
    fn env_for(&self, cause: &str, harness: AgentHarness) -> Result<LaneEnv, LaneFileError>;
    fn release(&self, env: &LaneEnv) -> io::Result<()>;
}

impl LaneSource for ProviderLane {
    fn env_for(&self, cause: &str, harness: AgentHarness) -> Result<LaneEnv, LaneFileError> {
        ProviderLane::env_for(self, cause, harness)
    }
    fn release(&self, env: &LaneEnv) -> io::Result<()> {
        ProviderLane::release(self, env)
    }
}

/// 받지 못했다.
#[derive(Debug, PartialEq, Eq)]
pub enum LaneFirstError {
    /// 관문이 막았다 — 받지 않았다.
    Blocked(SpawnBlocked),
    /// 받기 실패 — 접힌 코드만.
    Failed(String),
}

/// 받은 lane env — 떨어지면 임대를 끝내고 lane 턴 파일을 거둔다.
pub struct LaneFirst<'a, N: LeaseNotice> {
    lane: &'a dyn LaneSource,
    notice: &'a N,
    cause: String,
    env: LaneEnv,
}

impl<N: LeaseNotice> LaneFirst<'_, N> {
    pub fn env(&self) -> &LaneEnv {
        &self.env
    }
}

impl<N: LeaseNotice> Drop for LaneFirst<'_, N> {
    fn drop(&mut self) {
        self.notice.lease_ended(&self.cause);
        if let Err(e) = self.lane.release(&self.env) {
            eprintln!("[mentionTurn] lane 턴 파일 지우기 실패 — {:?}", e.kind());
        }
    }
}

/// 관문 → lane env 받기. 실패해도 임대는 끝낸다.
pub fn mount_lane_first<'a, N: LeaseNotice>(
    lane: &'a dyn LaneSource,
    notice: &'a N,
    cause: &str,
    harness: AgentHarness,
    gate: &mut dyn FnMut() -> Result<(), SpawnBlocked>,
) -> Result<LaneFirst<'a, N>, LaneFirstError> {
    gate().map_err(LaneFirstError::Blocked)?;
    match lane.env_for(cause, harness) {
        Ok(env) => Ok(LaneFirst {
            lane,
            notice,
            cause: cause.to_string(),
            env,
        }),
        Err(e) => {
            eprintln!("[mentionTurn] lane 키 받기 실패 — {}", e.local_detail());
            notice.lease_ended(cause);
            Err(LaneFirstError::Failed(
                e.lane_code().unwrap_or("lane_file").to_string(),
            ))
        }
    }
}

#[cfg(test)]
#[path = "turn_lane_first_tests.rs"]
mod tests;
