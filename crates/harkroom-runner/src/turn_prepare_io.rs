//! [`PrepareIo`] 실물 — 정본 `runMentionTurn` 준비 구간의 스레드 두 번 읽기(`readThread`)를 MCP `message.read` 로 한다.
//!
//! - 옛 페이지: 커서(`lastFedSeq`) 뒤 가장 옛 글부터 한 페이지(정본 `readThread(channelId, anchor, rec.lastFedSeq)`).
//!   못 읽으면 `Err` — 준비가 `ThreadUnreadable` 로 멈춘다.
//! - 최신 페이지: 커서가 있을 때만(`> 0`) 커서 없이 최신 한 페이지. 못 읽으면 **빈 페이지**로 두고 옛 페이지만 쓴다
//!   (정본 `.catch(() => null)`). 실패 원문은 로컬 로그에만.
//!
//! 두 페이지 모두 `threadRootId` 를 실어 이 스레드만 묻는다. 서버가 그래도 다른 글을 섞어 돌려주면 `prepare_turn` 의
//! 스레드 거르개가 버린다 — 이 파일은 거르지 않고 나르기만 한다.

use serde_json::Value;

use crate::mcp::HarkroomMcpClient;
use crate::prompt::DELTA_MAX_MESSAGES;
use crate::rest::RunnerLink;
use crate::turn_prepare::PrepareIo;

/// 정본 `readThread` 의 기본 한 페이지(`limit = 30`).
pub const THREAD_PAGE: u32 = 30;

/// MCP 로 스레드 두 페이지를 읽는 [`PrepareIo`].
pub struct McpPrepareIo<'a, L: RunnerLink> {
    pub client: &'a HarkroomMcpClient<L>,
}

impl<L: RunnerLink> PrepareIo for McpPrepareIo<'_, L> {
    fn thread_pages(
        &mut self,
        channel_id: &str,
        thread_root_id: &str,
        since: u64,
    ) -> Result<(Vec<Value>, Vec<Value>), String> {
        let since_i = i64::try_from(since).unwrap_or(i64::MAX);
        let oldest = self
            .client
            .read_thread(channel_id, Some(thread_root_id), Some(since_i), THREAD_PAGE)
            .map_err(|e| e.to_string())?;
        if since == 0 {
            return Ok((oldest, Vec::new()));
        }
        let latest = self
            .client
            .read_thread(
                channel_id,
                Some(thread_root_id),
                None,
                u32::try_from(DELTA_MAX_MESSAGES).unwrap_or(THREAD_PAGE),
            )
            .unwrap_or_else(|e| {
                eprintln!("[mentionTurn] 최신 페이지 읽기 실패(옛 페이지만 쓴다) — {e}");
                Vec::new()
            });
        Ok((oldest, latest))
    }
}

#[cfg(test)]
#[path = "turn_prepare_io_tests.rs"]
mod tests;
