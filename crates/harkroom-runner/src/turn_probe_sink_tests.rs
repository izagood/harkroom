//! [`McpProbeSink`] — 스레드에 가는 본문이 `NoticeSecrets` 가림을 지나는지, 조각이 남으면 올리지 않는지.
use std::sync::Mutex;

use harkroom_proto::p1::RunnerLinkResponse;
use serde_json::{Value, json};

use super::*;
use crate::link::LinkRequest;
use crate::mcp::{HarkroomMcpClient, MCP_PROTOCOL_VERSION};
use crate::rest::RunnerLink;

#[derive(Default)]
struct Link {
    calls: Mutex<Vec<Value>>,
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
                vec![json!({"jsonrpc":"2.0","id":id,"result":{
                    "content":[{"type":"text","text": json!({"message":{"seq":1}}).to_string()}], "isError": false}})]
            }
            other => panic!("unexpected {other:?}"),
        };
        RunnerLinkResponse::McpResponse {
            id: "x".into(),
            messages,
        }
    }
}

const PAT: &str = "hk_pat_secret_value_123456";
const MOUNTED: &str = "mounted-secret-value-abcdefghij";

fn secrets() -> NoticeSecrets {
    NoticeSecrets {
        pat: PAT.into(),
        mounted: vec![MOUNTED.into()],
        lease_dir: None,
    }
}

fn sink<'a>(
    client: &'a HarkroomMcpClient<&'a Link>,
    reported: &'a Mutex<Vec<String>>,
) -> McpProbeSink<'a, &'a Link> {
    McpProbeSink {
        client,
        key: "k".into(),
        channel_id: "c".into(),
        anchor: Some("root".into()),
        secrets: secrets(),
        report_auth: Box::new(move |s: &[String]| {
            reported.lock().unwrap().extend(s.iter().cloned())
        }),
    }
}

#[test]
fn progress_masks_whole_secrets_and_posts_to_this_thread() {
    let link = Link::default();
    let client = HarkroomMcpClient::new(&link, "t");
    let reported = Mutex::default();
    let mut s = sink(&client, &reported);
    s.progress(&format!("거부됨: echo {MOUNTED} 와 {PAT}"))
        .unwrap();
    let calls = link.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["name"], "message.progress");
    let args = &calls[0]["arguments"];
    assert_eq!(args["channelId"], "c");
    assert_eq!(args["threadRootId"], "root");
    let body = args["body"].as_str().unwrap();
    assert!(!body.contains(MOUNTED), "{body}");
    assert!(!body.contains(PAT), "{body}");
}

#[test]
fn progress_withholds_body_with_secret_fragment() {
    let link = Link::default();
    let client = HarkroomMcpClient::new(&link, "t");
    let reported = Mutex::default();
    let mut s = sink(&client, &reported);
    // 터미널 폭에 쪼개진 값 — 통째 가림에 걸리지 않고 12자 조각이 남는다.
    let split = format!("{}\n{}", &MOUNTED[..16], &MOUNTED[16..]);
    let err = s.progress(&format!("명령: {split}")).unwrap_err();
    assert_eq!(err, NOTICE_WITHHELD);
    assert!(link.calls.lock().unwrap().is_empty(), "올리지 않는다");
}

#[test]
fn progress_masks_unknown_token_shapes() {
    let link = Link::default();
    let client = HarkroomMcpClient::new(&link, "t");
    let reported = Mutex::default();
    let mut s = sink(&client, &reported);
    s.progress("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123")
        .unwrap();
    let calls = link.calls.lock().unwrap().clone();
    let body = calls[0]["arguments"]["body"].as_str().unwrap();
    assert!(!body.contains("abcdefghijklmnopqrstuvwxyz0123"), "{body}");
}

#[test]
fn auth_rejection_goes_to_operator_only() {
    let link = Link::default();
    let client = HarkroomMcpClient::new(&link, "t");
    let reported = Mutex::default();
    let mut s = sink(&client, &reported);
    s.report_mcp_auth_rejected(&["github".into()]);
    assert_eq!(*reported.lock().unwrap(), vec!["github".to_string()]);
    assert!(
        link.calls.lock().unwrap().is_empty(),
        "스레드에는 쓰지 않는다"
    );
}
