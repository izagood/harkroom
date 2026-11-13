//! 이 에이전트의 서버 손님 묶음 — MCP 손님과 REST 손님을 **한 링크**에서 지어 쥐고, 멘션 실행이 쓰는 서버 길을 모두 여기서만
//! 꺼낸다(security ③b 조건): 준비([`McpPrepareIo`]), 멘션 deps([`LinkIo`] — 실패 통지·읽음·턴 임대), 감시 루프
//! ([`crate::mention_watch::mention_watch_loop`] — 탐침 sink·스레드 읽기·앵커 밖 확인).
//!
//! 손님 칸은 비공개다. 멘션 실행 쪽 짓개는 손님을 따로 받지 않고 이 묶음만 받으므로, 다른 계정(다른 링크)의 손님이 끼어들
//! 자리가 없다. 러너 하나가 에이전트 하나이고 링크는 그 에이전트의 것이다.

use crate::mcp::HarkroomMcpClient;
use crate::mention_deps::LinkIo;
use crate::rest::{HarkroomRestClient, RunnerLink};
use crate::turn_prepare_io::McpPrepareIo;

/// 이 에이전트의 MCP·REST 손님(같은 링크).
pub struct AgentClients<L: RunnerLink> {
    mcp: HarkroomMcpClient<L>,
    rest: HarkroomRestClient<L>,
}

impl<L: RunnerLink + Clone> AgentClients<L> {
    /// 링크 하나로 두 손님을 짓는다.
    pub fn new(link: L, version: impl Into<String>) -> Self {
        Self {
            mcp: HarkroomMcpClient::new(link.clone(), version),
            rest: HarkroomRestClient::new(link),
        }
    }
}

impl<L: RunnerLink> AgentClients<L> {
    pub fn mcp(&self) -> &HarkroomMcpClient<L> {
        &self.mcp
    }
    pub fn rest(&self) -> &HarkroomRestClient<L> {
        &self.rest
    }
    /// 준비가 스레드를 읽는 길.
    pub fn prepare_io(&self) -> McpPrepareIo<'_, L> {
        McpPrepareIo { client: &self.mcp }
    }
    /// 멘션 deps 의 서버 길.
    pub fn link_io<'a>(
        &'a self,
        claim_holder: Option<&'a str>,
        log: &'a dyn Fn(&str),
    ) -> LinkIo<'a, L> {
        LinkIo {
            mcp: &self.mcp,
            rest: &self.rest,
            claim_holder,
            log,
        }
    }
}

#[cfg(test)]
#[path = "mention_clients_tests.rs"]
mod tests;
