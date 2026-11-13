//! [`ProbeSink`] 실물 — 탐침 통지를 MCP `message.progress` 로 이 스레드에, MCP 헤더 거절은 오퍼레이터에, 로그는 로컬에.
//!
//! **스레드에 가는 본문은 [`NoticeSecrets::guard_body`] 하나만 지난다**(security ②-2 조건 ①): 통지 함수가 이미 가린 본문이어도
//! 마운트한 비밀·PAT 를 통째로 가리고 토큰 꼴을 가린 뒤, 비밀 조각이 남으면 올리지 않는다. 가림 목록은 그 시도의 감시 목록
//! (`SpawnArgs::notice`)이다 — 시도마다 새로 받는다.
//!
//! 오퍼레이터 알림에는 서버 **이름**만 간다(정본 `reportMcpAuthRejected`). 로컬 로그에는 부르는 쪽이 건수·도구 이름만 넘긴다.

use crate::mcp::HarkroomMcpClient;
use crate::rest::RunnerLink;
use crate::turn_probe_records::{NoticeSecrets, ProbeSink};

/// 비밀 조각이 남아 통지를 올리지 않았다.
pub const NOTICE_WITHHELD: &str = "통지 본문에 비밀 조각이 보여 올리지 않았다";

/// MCP 헤더를 거절당한 서버 이름을 오퍼레이터에 알린다(실물 `LinkClient::notify_mcp_auth_rejected`).
pub type ReportAuthRejected<'a> = Box<dyn FnMut(&[String]) + 'a>;

/// [`ProbeSink`] 실물.
pub struct McpProbeSink<'a, L: RunnerLink> {
    pub client: &'a HarkroomMcpClient<L>,
    pub key: String,
    pub channel_id: String,
    pub anchor: Option<String>,
    pub secrets: NoticeSecrets,
    pub report_auth: ReportAuthRejected<'a>,
}

impl<L: RunnerLink> ProbeSink for McpProbeSink<'_, L> {
    fn progress(&mut self, body: &str) -> Result<(), String> {
        let Some(body) = self.secrets.guard_body(body) else {
            return Err(NOTICE_WITHHELD.to_string());
        };
        self.client
            .progress(&self.channel_id, &body, self.anchor.as_deref())
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn report_mcp_auth_rejected(&mut self, servers: &[String]) {
        (self.report_auth)(servers);
    }

    fn log(&mut self, line: &str) {
        eprintln!("[mentionTurn] {}: {line}", self.key);
    }
}

#[cfg(test)]
#[path = "turn_probe_sink_tests.rs"]
mod tests;
