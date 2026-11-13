//! [`McpPrepareIo`] — 정본 `readThread` 두 번과 같은 인자로 묻는지, 실패를 어떻게 다루는지.
use std::collections::VecDeque;
use std::sync::Mutex;

use harkroom_proto::p1::RunnerLinkResponse;
use serde_json::{Value, json};

use super::*;
use crate::link::LinkRequest;
use crate::mcp::{HarkroomMcpClient, MCP_PROTOCOL_VERSION};
use crate::rest::RunnerLink;

/// `Ok(messages)` 는 그 글들을, `Err(())` 는 링크 오류를 돌려준다.
type Reply = Result<Vec<Value>, ()>;

#[derive(Default)]
struct Link {
    calls: Mutex<Vec<Value>>,
    replies: Mutex<VecDeque<Reply>>,
}

impl Link {
    fn with(replies: Vec<Reply>) -> Self {
        Self {
            calls: Mutex::default(),
            replies: Mutex::new(replies.into()),
        }
    }
    fn calls(&self) -> Vec<Value> {
        self.calls.lock().unwrap().clone()
    }
}

impl RunnerLink for &Link {
    fn request(&self, req: LinkRequest) -> RunnerLinkResponse {
        let LinkRequest::Mcp { payload } = req else {
            panic!("http")
        };
        let id = payload.get("id").cloned();
        let messages = match (payload["method"].as_str().unwrap(), id) {
            ("notifications/initialized", None) => vec![],
            ("initialize", Some(id)) => vec![json!({"jsonrpc":"2.0","id":id,"result":{
                "protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {}, "serverInfo": {"name":"s","version":"1"}}})],
            ("tools/call", Some(id)) => {
                self.calls.lock().unwrap().push(payload["params"].clone());
                match self.replies.lock().unwrap().pop_front().expect("reply") {
                    Ok(msgs) => vec![json!({"jsonrpc":"2.0","id":id,"result":{
                        "content":[{"type":"text","text": json!({"messages": msgs}).to_string()}], "isError": false}})],
                    Err(()) => {
                        return RunnerLinkResponse::McpError {
                            id: "x".into(),
                            status: 502,
                            message: "down".into(),
                        };
                    }
                }
            }
            other => panic!("unexpected {other:?}"),
        };
        RunnerLinkResponse::McpResponse {
            id: "x".into(),
            messages,
        }
    }
}

fn m(id: &str, seq: u64) -> Value {
    json!({"id": id, "seq": seq, "channelId": "c", "threadRootId": "root"})
}

fn read(link: &Link, since: u64) -> Result<(Vec<Value>, Vec<Value>), String> {
    let client = HarkroomMcpClient::new(link, "t");
    McpPrepareIo { client: &client }.thread_pages("c", "root", since)
}

#[test]
fn first_turn_reads_one_page_with_cursor_zero() {
    let link = Link::with(vec![Ok(vec![m("a", 1)])]);
    let (oldest, latest) = read(&link, 0).unwrap();
    assert_eq!(oldest, vec![m("a", 1)]);
    assert!(latest.is_empty());
    let calls = link.calls();
    assert_eq!(
        calls.len(),
        1,
        "커서가 0 이면 최신 페이지를 따로 읽지 않는다"
    );
    assert_eq!(calls[0]["name"], "message.read");
    assert_eq!(
        calls[0]["arguments"],
        json!({"channelId": "c", "threadRootId": "root", "since": 0, "limit": 30})
    );
}

#[test]
fn cursor_reads_oldest_then_latest_page_in_this_thread() {
    let link = Link::with(vec![Ok(vec![m("a", 11)]), Ok(vec![m("z", 90)])]);
    let (oldest, latest) = read(&link, 10).unwrap();
    assert_eq!(oldest, vec![m("a", 11)]);
    assert_eq!(latest, vec![m("z", 90)]);
    let calls = link.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0]["arguments"],
        json!({"channelId": "c", "threadRootId": "root", "since": 10, "limit": 30})
    );
    // 최신 페이지는 커서 없이, 같은 스레드로.
    assert_eq!(
        calls[1]["arguments"],
        json!({"channelId": "c", "threadRootId": "root", "limit": 30})
    );
}

#[test]
fn oldest_page_failure_is_unreadable() {
    let link = Link::with(vec![Err(())]);
    assert!(read(&link, 10).is_err());
    assert_eq!(
        link.calls().len(),
        1,
        "옛 페이지가 실패하면 최신 페이지를 묻지 않는다"
    );
}

#[test]
fn latest_page_failure_keeps_oldest_page() {
    let link = Link::with(vec![Ok(vec![m("a", 11)]), Err(())]);
    let (oldest, latest) = read(&link, 10).unwrap();
    assert_eq!(oldest, vec![m("a", 11)]);
    assert!(
        latest.is_empty(),
        "정본 `.catch(() => null)` — 옛 페이지만 쓴다"
    );
}
