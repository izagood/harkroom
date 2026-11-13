//! [`link_admit_fn`] — 실물 받아들이기가 묶음 링크로만 서버를 부르고, 띄우기는 받은 상자에만 넣는지.
use std::sync::Mutex;
use std::time::Duration;

use harkroom_proto::p1::RunnerLinkResponse;
use serde_json::json;

use super::*;
use crate::link::LinkRequest;
use crate::mcp::MCP_PROTOCOL_VERSION;

/// 받은 요청을 적는 링크(모두 성공).
#[derive(Default)]
struct Link {
    calls: Mutex<Vec<String>>,
}

fn link() -> &'static Link {
    Box::leak(Box::default())
}

impl Link {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl RunnerLink for &'static Link {
    fn request(&self, req: LinkRequest) -> RunnerLinkResponse {
        match req {
            LinkRequest::Http { method, path, .. } => {
                self.calls.lock().unwrap().push(format!("{method} {path}"));
                RunnerLinkResponse::HttpResponse {
                    id: "x".into(),
                    status: 200,
                    body: json!({"ok": true}).to_string(),
                }
            }
            LinkRequest::Mcp { payload } => {
                let id = payload.get("id").cloned();
                let messages = match (payload["method"].as_str().unwrap(), id) {
                    ("notifications/initialized", None) => vec![],
                    ("initialize", Some(id)) => vec![json!({"jsonrpc":"2.0","id":id,"result":{
                        "protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {}, "serverInfo": {"name":"s","version":"1"}}})],
                    ("tools/call", Some(id)) => {
                        let name = payload["params"]["name"].as_str().unwrap_or("").to_string();
                        self.calls.lock().unwrap().push(format!("tool {name}"));
                        vec![json!({"jsonrpc":"2.0","id":id,"result":{
                            "content":[{"type":"text","text": json!({"read": 1, "message": {"seq": 1}}).to_string()}], "isError": false}})]
                    }
                    other => panic!("unexpected {other:?}"),
                };
                RunnerLinkResponse::McpResponse {
                    id: "x".into(),
                    messages,
                }
            }
        }
    }
}

fn now() -> u64 {
    1_000
}

fn ctx() -> BatchContext {
    let mut c = BatchContext::default();
    c.human_ids.insert("u1".into());
    c
}

fn batch(ids: &[(i64, &str, &str)]) -> Value {
    let entries: Vec<Value> = ids
        .iter()
        .map(|(id, m, _)| json!({"id": id, "messageId": m, "reason": "mention"}))
        .collect();
    let messages: Vec<Value> = ids
        .iter()
        .map(|(_, m, root)| json!({"id": m, "seq": 7, "channelId": "c", "threadRootId": root, "authorId": "u1", "kind": "user", "body": "hi"}))
        .collect();
    json!({"entries": entries, "messages": messages})
}

/// security L3c: 실물 닫개는 그 묶음 링크로만(임대·자리 포함) 서버를 부르고, 다른 링크는 0건. 띄우기는 받은 상자에만 —
/// 두 스레드의 멘션이 각자 자기 멘션 id 로 상자에 들어간다.
#[test]
fn real_admit_uses_only_the_bundle_and_queues_launches() {
    let (mine, other) = (link(), link());
    let _other_bundle = Arc::new(AgentClients::new(other, "t"));
    let clients = Arc::new(AgentClients::new(mine, "t"));
    let claims = Arc::new(ThreadClaims::with_timing(
        Arc::clone(&clients),
        "me".into(),
        90,
        Duration::from_secs(3600),
    ));
    let f = link_admit_fn(clients, claims, MentionSlots::default(), now);
    let mut ledger = Ledger::new(&[], 0);
    let mut q = LaunchQueue::default();
    let out = f(
        &mut ledger,
        &batch(&[(1, "m1", "t1"), (2, "m2", "t2")]),
        &ctx(),
        &mut q,
    )
    .unwrap();

    assert_eq!(out.started, 2);
    let mut ids: Vec<String> = q.0.iter().map(|(_, m)| m.clone()).collect();
    ids.sort();
    assert_eq!(ids, ["m1", "m2"]);
    assert!(ledger.thread_in_flight("c/t1") && ledger.thread_in_flight("c/t2"));
    let calls = mine.calls();
    assert_eq!(
        calls
            .iter()
            .filter(|c| *c == "POST /agent/thread-claims")
            .count(),
        2,
        "임대 = 묶음 링크: {calls:?}"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|c| *c == "POST /agent/turn-slots")
            .count(),
        2,
        "자리 = 묶음 링크: {calls:?}"
    );
    assert!(
        other.calls().is_empty(),
        "다른 링크에는 한 건도 가지 않는다"
    );
}
