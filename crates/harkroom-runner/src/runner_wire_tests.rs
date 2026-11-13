//! [`BundlePoll`]·[`LinkEvents`]·[`runner_exit_plan`] — 묶음 링크로만 가는지, 표지·종료 요청·실패가 맞는 자리로 가는지,
//! 물러나기 줄에 원문이 실리지 않는지.
use std::sync::Mutex;

use harkroom_proto::p1::RunnerLinkResponse;

use super::*;
use crate::link::LinkRequest;
use crate::mcp::MCP_PROTOCOL_VERSION;

#[derive(Default)]
struct Link {
    calls: Mutex<Vec<String>>,
    tools: Mutex<Vec<(String, Value)>>,
}

fn link() -> &'static Link {
    Box::leak(Box::default())
}

impl RunnerLink for &'static Link {
    fn request(&self, req: LinkRequest) -> RunnerLinkResponse {
        match req {
            LinkRequest::Http { method, path, .. } => {
                self.calls.lock().unwrap().push(format!("{method} {path}"));
                let body = match path.as_str() {
                    "/agent/config" => json!({"instructions": "x"}),
                    "/accounts" => json!({"accounts": []}),
                    _ => json!({}),
                };
                RunnerLinkResponse::HttpResponse {
                    id: "x".into(),
                    status: 200,
                    body: body.to_string(),
                }
            }
            LinkRequest::Mcp { payload } => {
                let id = payload.get("id").cloned();
                let messages = match (payload["method"].as_str().unwrap(), id) {
                    ("notifications/initialized", None) => vec![],
                    ("initialize", Some(id)) => vec![json!({"jsonrpc":"2.0","id":id,"result":{
                        "protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {}, "serverInfo": {"name":"s","version":"1"}}})],
                    ("tools/call", Some(id)) => {
                        let p = &payload["params"];
                        let name = p["name"].as_str().unwrap_or("").to_string();
                        self.calls.lock().unwrap().push(format!("tool {name}"));
                        self.tools
                            .lock()
                            .unwrap()
                            .push((name, p["arguments"].clone()));
                        vec![json!({"jsonrpc":"2.0","id":id,"result":{
                            "content":[{"type":"text","text": json!({"entries": [], "messages": [], "message": {"seq": 1}, "channels": []}).to_string()}], "isError": false}})]
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

fn tool_args(l: &Link, name: &str) -> Vec<Value> {
    l.tools
        .lock()
        .unwrap()
        .iter()
        .filter(|(n, _)| n == name)
        .map(|(_, a)| a.clone())
        .collect()
}

/// 폴 소스는 묶음 링크로만 — 롱폴에는 inbox 임대(러너 id·쥔 entry)가 실리고, 다른 링크는 0건.
#[test]
fn poll_source_uses_only_the_bundle_and_carries_the_lease() {
    let (mine, other) = (link(), link());
    let _other = Arc::new(AgentClients::new(other, "t"));
    let src = BundlePoll::new(
        Arc::new(AgentClients::new(mine, "t")),
        1_000,
        Some("r1".into()),
    );
    src.poll(&[3, 4]).unwrap();
    src.definition().unwrap();
    let _ = src.channels();
    let _ = src.accounts();
    src.reset();
    let polls = tool_args(mine, "inbox.poll");
    assert_eq!(polls.len(), 1);
    assert_eq!(
        polls[0]["lease"],
        json!({"runnerId": "r1", "holding": [3, 4]})
    );
    assert!(
        mine.calls
            .lock()
            .unwrap()
            .contains(&"GET /agent/config".to_string())
    );
    assert!(other.calls.lock().unwrap().is_empty(), "다른 링크 0건");

    // 임대가 꺼져 있으면 싣지 않는다.
    let off = link();
    BundlePoll::new(Arc::new(AgentClients::new(off, "t")), 1_000, None)
        .poll(&[3])
        .unwrap();
    assert!(tool_args(off, "inbox.poll")[0].get("lease").is_none());
}

/// 사건 받는 쪽: 자리 놓기·표지는 묶음 링크로, 표지 본문은 고정 키 `fenced` 이고 그 스레드에 단다. 종료 요청·실행 파일 없음은
/// 부르는 쪽 자리로 간다.
#[test]
fn events_go_to_the_bundle_or_the_caller() {
    let mine = link();
    let stops = Arc::new(Mutex::new(Vec::<String>::new()));
    let fatals = Arc::new(Mutex::new(Vec::<ExitPlan>::new()));
    let (s2, f2) = (Arc::clone(&stops), Arc::clone(&fatals));
    let ev = LinkEvents::new(
        Arc::new(AgentClients::new(mine, "t")),
        Box::new(move |at| s2.lock().unwrap().push(at.to_string())),
        Box::new(move |p| f2.lock().unwrap().push(p)),
        None,
    );
    ev.release_turn_slot("c/t");
    ev.notice_fenced("c", "t");
    ev.turn_outcome(true);
    ev.stop_requested("2026-11-14T00:00:00Z");
    ev.executable_missing();

    assert!(
        mine.calls
            .lock()
            .unwrap()
            .contains(&"POST /agent/turn-slots/release".to_string())
    );
    let notices = tool_args(mine, "message.notice");
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0]["channelId"], "c");
    assert_eq!(notices[0]["threadRootId"], "t");
    assert_eq!(notices[0]["key"], "fenced");
    assert_eq!(*stops.lock().unwrap(), ["2026-11-14T00:00:00Z"]);
    let f = fatals.lock().unwrap();
    assert_eq!(f.len(), 1);
    assert_eq!(f[0].code, EX_CONFIG);
    assert_eq!(
        f[0].lines.last().map(String::as_str),
        Some(EXECUTABLE_NOT_FOUND_LINE)
    );
}

/// 물러나기 판정은 상태로만 — 401·403 이면 78 과 마커, 그 밖은 물러나지 않는다. 오류 원문은 줄에 싣지 않는다.
#[test]
fn exit_plan_by_status_only_and_without_the_raw_message() {
    let e = |status: Option<u16>| HarkroomError {
        message: "body: secret-token-value".into(),
        status,
    };
    for s in [401, 403] {
        let p = runner_exit_plan(&e(Some(s))).unwrap();
        assert_eq!(p.code, EX_CONFIG);
        assert_eq!(
            p.lines.last().map(String::as_str),
            Some(CREDENTIAL_REJECTED_LINE)
        );
        assert!(!p.lines.iter().any(|l| l.contains("secret-token-value")));
    }
    assert_eq!(runner_exit_plan(&e(Some(500))), None);
    assert_eq!(runner_exit_plan(&e(None)), None);
    let mut msg_only = e(None);
    msg_only.message = "401 Unauthorized".into();
    assert_eq!(runner_exit_plan(&msg_only), None, "문구로 판정하지 않는다");
}
