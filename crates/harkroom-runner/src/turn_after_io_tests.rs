//! [`McpAfterIo`] — `apply_after_turn` 이 만든 글을 MCP 로 그대로 나르는지(새 문구 없음), 그리고 남은 Debug 가림.
use std::collections::BTreeMap;
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

impl Link {
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

const PAT: &str = "hk_pat_secret_value_123";

fn facts<'a>(reason: &'a str, secrets: &'a [String]) -> AfterFacts<'a> {
    AfterFacts {
        key: "k",
        channel_id: "c",
        anchor: Some("root"),
        mention_id: "men",
        caller: NudgeCaller::Human,
        proxy_head: "",
        record_proxy: false,
        wake_reason: reason,
        background_wait_ms: 120_000,
        pat: PAT,
        secrets,
    }
}

fn plan(silent: SilentPath) -> AfterTurnPlan {
    AfterTurnPlan {
        silent,
        post_count: 0,
        check_report_promise: false,
        watch_missed: false,
        delegation_report_missed: false,
    }
}

fn io<'a>(client: &'a HarkroomMcpClient<&'a Link>, said: &'a str) -> McpAfterIo<'a, &'a Link> {
    McpAfterIo {
        client,
        last_said: Box::new(move || Some(said.to_string())),
        silent_said: Box::new(SilentSaid::default),
        off_anchor: Box::new(|| None),
        report_promise: Box::new(|| Ok(())),
    }
}

/// progress 본문은 `silent_wake_notice` 가 만든 그대로(가린 끝말) — MCP 로 나를 뿐이다.
#[test]
fn wake_progress_carries_the_phrase_function_output() {
    let link = Link::default();
    let client = HarkroomMcpClient::new(&link, "t");
    let said = format!("끝 {PAT}");
    let mut io = io(&client, &said);
    apply_after_turn(&plan(SilentPath::WakeProgress), &facts("", &[]), &mut io).unwrap();
    let calls = link.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["name"], "message.progress");
    let body = calls[0]["arguments"]["body"].as_str().unwrap();
    assert_eq!(body, clip_body(&silent_wake_notice(Some(&said), PAT, &[])));
    assert!(!body.contains(PAT), "{body}");
    assert_eq!(calls[0]["arguments"]["threadRootId"], "root");
}

/// ✅ 는 멘션 글에 단다.
#[test]
fn wake_ack_reacts_on_the_mention() {
    let link = Link::default();
    let client = HarkroomMcpClient::new(&link, "t");
    let mut io = io(&client, "");
    apply_after_turn(&plan(SilentPath::WakeAck), &facts("", &[]), &mut io).unwrap();
    let calls = link.calls();
    assert_eq!(calls[0]["name"], "message.react");
    assert_eq!(calls[0]["arguments"]["messageId"], "men");
    assert_eq!(calls[0]["arguments"]["emoji"], SILENT_ACK_EMOJI);
}

/// 감시 끊김 실패 줄 — 사유는 `watch_missed_notice` 가 가리고 `@` 를 ＠ 로 바꾼 그대로.
#[test]
fn watch_missed_fail_carries_masked_reason() {
    let link = Link::default();
    let client = HarkroomMcpClient::new(&link, "t");
    let mut io = io(&client, "");
    let mut p = plan(SilentPath::Nothing);
    p.watch_missed = true;
    let reason = format!("@task_manager 5분마다 {PAT}");
    apply_after_turn(&p, &facts(&reason, &[]), &mut io).unwrap();
    let calls = link.calls();
    assert_eq!(calls[0]["name"], "message.fail");
    let body = calls[0]["arguments"]["body"].as_str().unwrap();
    assert_eq!(body, clip_body(&watch_missed_notice(&reason, PAT, &[])));
    assert!(!body.contains('@') && !body.contains(PAT), "{body}");
    assert_eq!(calls[0]["arguments"]["retryable"], false);
}

/// 남은 Debug nit: `EndState`(API 오류 원문)·`TurnMcpInput`(러너 env) 은 값을 찍지 않는다.
#[test]
fn end_state_and_mcp_input_debug_hide_values() {
    let end = crate::turn_end::EndState {
        api_error: Some(format!("401 bad key {PAT}")),
        recorded_api_error: Some("rec-err-value".into()),
        ..Default::default()
    };
    let d = format!("{end:?}");
    assert!(!d.contains(PAT) && !d.contains("rec-err-value"), "{d}");
    assert!(d.contains("bytes"), "{d}");
    let runner_env: BTreeMap<String, String> =
        [("HARKROOM_TOKEN".to_string(), PAT.to_string())].into();
    let lane: BTreeMap<String, String> =
        [("ANTHROPIC_AUTH_TOKEN".to_string(), "tok-lane-9".to_string())].into();
    let input = crate::turn_mcp_plan::TurnMcpInput {
        harness: crate::adapter::AgentHarness::ClaudeCode,
        can_register_turn_keys: true,
        provider_env: Some(&lane),
        state_dir: std::path::Path::new("/s"),
        mcp_config_path: std::path::Path::new("/s/mcp.json"),
        turn_id: "t1",
        runner_env: &runner_env,
    };
    let d = format!("{input:?}");
    assert!(
        d.contains("HARKROOM_TOKEN") && d.contains("ANTHROPIC_AUTH_TOKEN"),
        "{d}"
    );
    assert!(!d.contains(PAT) && !d.contains("tok-lane-9"), "{d}");
}
