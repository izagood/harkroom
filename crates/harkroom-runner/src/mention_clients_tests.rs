//! [`AgentClients`] — 준비·멘션 deps·감시가 같은 손님 하나(그 에이전트 링크)만 쓰는지.
use std::sync::Mutex;

use harkroom_proto::p1::RunnerLinkResponse;
use serde_json::json;

use super::*;
use crate::link::LinkRequest;
use crate::mcp::MCP_PROTOCOL_VERSION;
use crate::turn_prepare::PrepareIo;

/// 받은 요청 수를 세는 링크 — 어느 에이전트 링크로 갔는지 본다.
#[derive(Default)]
struct Link {
    tool_calls: Mutex<u32>,
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
                *self.tool_calls.lock().unwrap() += 1;
                vec![json!({"jsonrpc":"2.0","id":id,"result":{
                    "content":[{"type":"text","text": json!({"messages": [], "message": {"seq": 1}, "read": 1}).to_string()}], "isError": false}})]
            }
            other => panic!("unexpected {other:?}"),
        };
        RunnerLinkResponse::McpResponse {
            id: "x".into(),
            messages,
        }
    }
}

#[test]
fn prepare_link_and_watch_share_one_client() {
    let link = Link::default();
    let clients = AgentClients::new(&link, "t");
    let log = |_l: &str| {};
    let prep = clients.prepare_io();
    let deps = clients.link_io(None, &log);
    assert!(
        std::ptr::eq(prep.client, clients.mcp()),
        "준비 = 묶음의 MCP 손님"
    );
    assert!(
        std::ptr::eq(deps.mcp, clients.mcp()),
        "멘션 deps = 같은 MCP 손님"
    );
    assert!(
        std::ptr::eq(deps.rest, clients.rest()),
        "턴 임대 = 같은 묶음의 REST 손님"
    );
}

#[test]
fn another_agents_link_is_never_used() {
    let (mine, other) = (Link::default(), Link::default());
    let a = AgentClients::new(&mine, "t");
    let _b = AgentClients::new(&other, "t");
    let log = |_l: &str| {};
    a.prepare_io().thread_pages("c", "root", 0).unwrap();
    let mut deps = a.link_io(None, &log);
    crate::mention_deps::MentionIo::mark_read(&mut deps, &[1]).unwrap();
    assert_eq!(*mine.tool_calls.lock().unwrap(), 2, "내 링크로만 갔다");
    assert_eq!(
        *other.tool_calls.lock().unwrap(),
        0,
        "다른 에이전트 링크는 쓰이지 않는다"
    );
}

/// 호출 자리가 쓰는 손님 전부 — 준비·멘션 deps(MCP·REST)·시도 실물(턴 열쇠 REST·임대 끝 알림)·턴 뒤 IO(MCP)·임대 넘기기(링크) —
/// 가 한 묶음의 같은 손님·같은 링크다.
#[test]
fn call_site_clients_are_all_the_bundle() {
    use crate::config::OperatorLink;
    use crate::link::{LinkClient, LinkOptions};
    let link = LinkClient::new(LinkOptions::new(OperatorLink {
        socket_path: "/nonexistent".into(),
        runner_id: "r".into(),
        secret: "s".into(),
    }));
    let clients = AgentClients::new(&*link, "t");
    let log = |_l: &str| {};
    let (dir, env) = (
        std::path::PathBuf::from("/x"),
        std::collections::BTreeMap::new(),
    );
    let base = clients.attempt_base(
        crate::adapter::AgentHarness::ClaudeCode,
        false,
        &dir,
        &dir,
        &env,
        "",
    );
    let deps = clients.link_io(None, &log);
    let hooks = crate::mention_hooks::LinkHooks::new(*clients.link(), NoSched, "k".into(), || 1);
    assert!(std::ptr::eq(clients.prepare_io().client, clients.mcp()));
    assert!(std::ptr::eq(deps.mcp, clients.mcp()));
    assert!(std::ptr::eq(deps.rest, clients.rest()));
    assert!(
        std::ptr::eq(base.client, clients.rest()),
        "턴 열쇠 REST = 묶음"
    );
    assert!(std::ptr::eq(base.notice, &*link), "임대 끝 알림 = 그 링크");
    assert!(
        std::ptr::eq(hooks.operator, &*link),
        "임대 넘기기 = 그 링크"
    );
}

struct NoSched;
impl crate::mention_hooks::SchedulerHooks for NoSched {
    fn notice_fenced(&mut self) {}
    fn turn_outcome(&mut self, _ok: bool) {}
    fn stop_requested(&mut self, _at: &str) {}
    fn executable_missing(&mut self) {}
    fn release_slot(&mut self, _k: &str) {}
    fn turn_ended(&mut self, _k: &str, _m: &str) {}
}
