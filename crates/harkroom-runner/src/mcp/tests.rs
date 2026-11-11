//! 가짜 링크로 MCP 절반을 본다 — 링크에 실리는 JSON-RPC 와 답 해석이 정본(`harkroom.ts`)과 같은지.
use super::*;
use std::collections::VecDeque;

/// 도구 결과 하나: `Ok(text)` 는 text 결과, `Err((status, msg))` 는 링크의 `mcp.error`.
type Reply = Result<String, (u16, String)>;

#[derive(Default)]
struct Fake {
    sent: Mutex<Vec<Value>>,
    tool_replies: Mutex<VecDeque<Reply>>,
    /// tools/call 의 JSON-RPC 오류(SDK McpError 로 오는 것).
    rpc_error: Mutex<Option<(i64, String)>>,
    is_error: Mutex<bool>,
}

impl Fake {
    fn with(replies: Vec<Reply>) -> Self {
        let f = Fake::default();
        *f.tool_replies.lock().unwrap() = replies.into();
        f
    }
    fn tool_calls(&self) -> Vec<Value> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m["method"] == "tools/call")
            .map(|m| m["params"].clone())
            .collect()
    }
    fn methods(&self) -> Vec<String> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .map(|m| m["method"].as_str().unwrap().to_string())
            .collect()
    }
}

impl RunnerLink for &Fake {
    fn request(&self, req: LinkRequest) -> RunnerLinkResponse {
        let LinkRequest::Mcp { payload } = req else {
            panic!("http")
        };
        self.sent.lock().unwrap().push(payload.clone());
        let id = payload.get("id").cloned();
        let method = payload["method"].as_str().unwrap();
        let messages = match (method, id) {
            ("notifications/initialized", None) => vec![],
            ("initialize", Some(id)) => vec![json!({"jsonrpc":"2.0","id":id,"result":{
                "protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {}, "serverInfo": {"name":"s","version":"1"}}})],
            ("tools/call", Some(id)) => {
                if let Some((code, msg)) = self.rpc_error.lock().unwrap().take() {
                    vec![json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":msg}})]
                } else {
                    match self.tool_replies.lock().unwrap().pop_front() {
                        Some(Ok(text)) => {
                            let is_error = *self.is_error.lock().unwrap();
                            vec![json!({"jsonrpc":"2.0","id":id,"result":{
                                "content":[{"type":"text","text":text}], "isError": is_error}})]
                        }
                        Some(Err((status, message))) => {
                            return RunnerLinkResponse::McpError {
                                id: "x".into(),
                                status,
                                message,
                            };
                        }
                        None => panic!("no reply for {payload}"),
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

fn ok(v: Value) -> Reply {
    Ok(v.to_string())
}

#[test]
fn initializes_once_then_calls_and_reset_reinitializes() {
    let f = Fake::with(vec![
        ok(json!({"id":"a1","handle":"h"})),
        ok(json!({"channels":[{"id":"c","name":"n"},{"bad":1}]})),
        ok(json!({"id":"a1","handle":"h2"})),
    ]);
    let c = HarkroomMcpClient::new(&f, "0.4.1");
    assert_eq!(c.me().unwrap(), ("a1".into(), "h".into()));
    assert_eq!(c.channels().unwrap(), vec![("c".into(), "n".into())]);
    c.reset();
    c.me().unwrap();
    assert_eq!(
        f.methods(),
        [
            "initialize",
            "notifications/initialized",
            "tools/call",
            "tools/call",
            "initialize",
            "notifications/initialized",
            "tools/call"
        ]
    );
    let init = &f.sent.lock().unwrap()[0];
    assert_eq!(init["params"]["protocolVersion"], MCP_PROTOCOL_VERSION);
    assert_eq!(init["params"]["clientInfo"]["name"], MCP_CLIENT_NAME);
    assert_eq!(init["params"]["clientInfo"]["version"], "0.4.1");
}

#[test]
fn transport_status_is_kept_and_zero_is_not_credential() {
    let f = Fake::with(vec![
        Err((401, "unauthorized".into())),
        Err((0, "operator link down".into())),
    ]);
    let c = HarkroomMcpClient::new(&f, "v");
    let e = c.me().unwrap_err();
    assert_eq!(e.status, Some(401));
    assert!(e.is_credential());
    let e = c.me().unwrap_err();
    assert_eq!(e.status, None);
    assert!(!e.is_credential());
}

#[test]
fn tool_errors_and_validation_text() {
    let f = Fake::with(vec![
        ok(json!({"error":{"code":"forbidden","message":"no"}})),
        Ok("MCP error -32602: Invalid arguments".into()),
    ]);
    let c = HarkroomMcpClient::new(&f, "v");
    let e = c.post("c", "b", None).unwrap_err();
    assert_eq!(e.message, "message.post: forbidden no");
    *f.is_error.lock().unwrap() = true;
    let e = c.post("c", "b", None).unwrap_err();
    assert_eq!(
        e.message,
        "message.post: MCP error -32602: Invalid arguments"
    );
}

#[test]
fn notice_falls_back_only_for_unknown_tool() {
    let f = Fake::default();
    let c = HarkroomMcpClient::new(&f, "v");
    // 옛 서버: 도구가 없다 → 일반 글.
    *f.rpc_error.lock().unwrap() = Some((-32602, "Tool message.notice not found".into()));
    f.tool_replies
        .lock()
        .unwrap()
        .push_back(ok(json!({"message":{"seq":7}})));
    let seq = c
        .notice("c", Some("r"), &json!({"key":"k","n":1}), "옛 본문")
        .unwrap();
    assert_eq!(seq, 7);
    let calls = f.tool_calls();
    assert_eq!(calls[0]["name"], "message.notice");
    assert_eq!(
        calls[0]["arguments"],
        json!({"channelId":"c","threadRootId":"r","key":"k","n":1})
    );
    assert_eq!(calls[1]["name"], "message.post");
    assert_eq!(calls[1]["arguments"]["body"], "옛 본문");
    // 다른 도구 이름의 -32602 는 물러나지 않는다.
    *f.rpc_error.lock().unwrap() = Some((-32602, "Tool message.post not found".into()));
    assert!(c.notice("c", None, &json!({"key":"k"}), "x").is_err());
}

#[test]
fn poll_inbox_args_and_shape() {
    let f = Fake::with(vec![
        ok(json!({"entries":[],"messages":[],"stopRequestedAt":null})),
        ok(json!({"entries":[]})),
    ]);
    let c = HarkroomMcpClient::new(&f, "0.4.9");
    let lane = ClaudeLane {
        pool: None,
        accounts: vec!["a".into()],
    };
    let lease = PollLease {
        runner_id: "r1".into(),
        holding: vec![3],
    };
    c.poll_inbox(25_000, Some(&lane), Some(&lease)).unwrap();
    assert_eq!(
        f.tool_calls()[0]["arguments"],
        json!({"timeoutMs":25000,"version":"0.4.9","inboxReasons":["delegation_update"],
               "claudeLane":{"pool":null,"accounts":["a"]},"lease":{"runnerId":"r1","holding":[3]}})
    );
    assert!(c.poll_inbox(1, None, None).is_err());
    assert!(
        !f.tool_calls()[1]["arguments"]
            .as_object()
            .unwrap()
            .contains_key("lease")
    );
}

#[test]
fn fail_carries_only_present_fields() {
    let f = Fake::with(vec![ok(json!({"message":{"seq":9}}))]);
    let c = HarkroomMcpClient::new(&f, "v");
    let opts = FailOpts {
        retryable: true,
        code: Some("account_gate".into()),
        mention_id: Some("m".into()),
        what: Some(String::new()),
        ..Default::default()
    };
    assert_eq!(c.fail("c", "b", Some("r"), &opts).unwrap(), 9);
    assert_eq!(
        f.tool_calls()[0]["arguments"],
        json!({"channelId":"c","body":"b","retryable":true,"threadRootId":"r","code":"account_gate","mentionId":"m"})
    );
}

#[test]
fn memory_and_reads() {
    let f = Fake::with(vec![
        ok(json!({"slugs":["mem/a","core"]})),
        ok(json!({"value":"CORE"})),
        ok(json!({"slugs":["mem/b"]})),
        ok(json!({"hits":[{"slug":"x"}],"terms":["t"]})),
        ok(json!({"messages":[{"seq":1}]})),
        ok(json!({"read":2})),
    ]);
    let c = HarkroomMcpClient::new(&f, "v");
    assert_eq!(
        c.read_memory().unwrap(),
        (Some("CORE".into()), vec!["mem/a".to_string()])
    );
    assert_eq!(c.read_memory().unwrap(), (None, vec!["mem/b".to_string()]));
    let ex: Vec<String> = (0..250).map(|i| format!("s{i}")).collect();
    let r = c.search_memory("q", 2, &ex, Some(2), Some("f")).unwrap();
    assert_eq!(r, json!({"hits":[{"slug":"x"}],"terms":["t"]}));
    let a = &f.tool_calls()[3]["arguments"];
    assert_eq!(a["exclude"].as_array().unwrap().len(), 200);
    assert_eq!(a["exclude"][0], "s50");
    assert_eq!(c.read_thread("c", Some("r"), Some(5), 30).unwrap().len(), 1);
    assert_eq!(
        f.tool_calls()[4]["arguments"],
        json!({"channelId":"c","limit":30,"threadRootId":"r","since":5})
    );
    assert_eq!(c.mark_read(&[]).unwrap(), 0);
    assert_eq!(c.mark_read(&[1, 2]).unwrap(), 2);
    assert_eq!(f.tool_calls().len(), 6);
    c.record_recall(&[]).unwrap();
    assert_eq!(f.tool_calls().len(), 6);
}

#[test]
fn note_plan_bg_shapes() {
    let f = Fake::with(vec![
        ok(json!({"note":{"body":"b","updatedAt":"t","flagged":{}}})),
        ok(json!({"note":{"body":1}})),
        ok(json!({"plan":null})),
        ok(json!({"plan":{"doc":{"groups":[]}}})),
        ok(json!({"job":{"id":"j","kind":"k","input":"bad"}})),
        ok(json!({"job":{"kind":"k"}})),
    ]);
    let c = HarkroomMcpClient::new(&f, "v");
    assert_eq!(
        c.read_thread_note("r").unwrap(),
        Some(ThreadNote {
            body: "b".into(),
            updated_at: "t".into(),
            flagged: Some("flagged".into())
        })
    );
    assert_eq!(c.read_thread_note("r").unwrap(), None);
    assert_eq!(c.read_thread_plan("r").unwrap(), None);
    assert!(c.read_thread_plan("r").is_err());
    let j = c.claim_bg().unwrap().unwrap();
    assert_eq!((j.day.as_str(), j.input.clone()), ("", json!({})));
    assert_eq!(c.claim_bg().unwrap(), None);
}
