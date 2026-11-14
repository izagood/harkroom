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
    /// 이 원인의 `env_for` 가 남긴 판 경고(한 번만). 기본은 없음.
    fn take_notice(&self, _cause: &str) -> Option<String> {
        None
    }
}

impl LaneSource for ProviderLane {
    fn env_for(&self, cause: &str, harness: AgentHarness) -> Result<LaneEnv, LaneFileError> {
        ProviderLane::env_for(self, cause, harness)
    }
    fn release(&self, env: &LaneEnv) -> io::Result<()> {
        ProviderLane::release(self, env)
    }
    fn take_notice(&self, cause: &str) -> Option<String> {
        ProviderLane::take_notice(self, cause)
    }
}

/// 시도 하나에서 임대 끝 알림을 **한 번만** 보낸다 — 띄우기 정리(비밀 단계의 `end_lease`)와 [`LaneFirst`] 가 같은 이
/// 자리를 쓴다. 그래서 lane + 비밀 턴에서도 `lease_ended` 는 한 번이다. 시도마다 새로 만든다.
pub struct OnceLease<'a, N: LeaseNotice> {
    inner: &'a N,
    ended: std::cell::Cell<bool>,
}

impl<'a, N: LeaseNotice> OnceLease<'a, N> {
    pub fn new(inner: &'a N) -> Self {
        Self {
            inner,
            ended: std::cell::Cell::new(false),
        }
    }
}

impl<N: LeaseNotice> LeaseNotice for OnceLease<'_, N> {
    fn lease_ended(&self, cause: &str) {
        if !self.ended.replace(true) {
            self.inner.lease_ended(cause);
        }
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
        // 빈 env 는 받지 않는다 — 띄우는 쪽(`pty_turn_plan`)은 빈 lane env 를 「lane 아님」으로 읽어 부모 env 걷기·고정 env 를
        // 건너뛴다. 실물 `ProviderLane` 은 성공이면 늘 한 칸 이상을 주지만, 그 약속이 깨져도 기본 로그인 env 로 뜨지 않게 닫는다.
        Ok(env) if env.is_empty() => {
            eprintln!("[mentionTurn] lane 키 받기 실패 — 빈 env");
            notice.lease_ended(cause);
            Err(LaneFirstError::Failed("lane_unset".to_string()))
        }
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
