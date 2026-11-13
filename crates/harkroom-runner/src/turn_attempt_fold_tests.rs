use std::sync::Mutex as StdMutex;

use harkroom_proto::p1::RunnerLinkResponse;
use serde_json::{Value, json};

use super::*;
use crate::adapter::AgentHarness;
use crate::link::LinkRequest;
use crate::mcp::MCP_PROTOCOL_VERSION;
use crate::mention_run::TurnError;
use crate::mention_settle::TurnEnd;
use crate::pty_turn::TurnResult;
use crate::thread_model::{AxisSource, TurnModelSource};
use crate::turn_success::SilentPath;

const PAT: &str = "hk_pat_secret_value_77";
const SECRET: &str = "sk-live-mmmmmmmmmmmmmmmmmmmmmmmmmm";

/// 마운트한 비밀이 든 임대 디렉터리로 목록을 짓는다(실제 순서: 마운트 뒤).
fn mounted(tag: &str) -> (std::path::PathBuf, TurnSecrets) {
    let dir = std::env::temp_dir().join(format!("hk-fold-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("secret-1"), SECRET).unwrap();
    let s = TurnSecrets::build(PAT, &[], Some(&dir));
    (dir, s)
}

fn inputs<'a>(tm: Option<&'a TurnModel>) -> OutcomeInputs<'a> {
    OutcomeInputs {
        thread_unreadable: false,
        turn_timeout_ms: 600_000,
        harness_stall_ms: 600_000,
        stall: StallInputs {
            watch_now: None,
            screen_tail: "",
            harness: AgentHarness::ClaudeCode,
            signal: None,
        },
        recorded_after: None,
        turn_model: tm,
        stop_requested_at: Some("2026-11-13T09:00:00Z".into()),
    }
}

/// 실패 글(스레드 모델 거절)에 실리는 API 오류 줄은 **그 시도의 목록**(마운트한 비밀 포함)으로 가려진다.
#[test]
fn fold_outcome_masks_with_mounted_secrets() {
    let (dir, s) = mounted("outcome");
    let end = Mutex::new(EndState {
        api_error: Some(format!("400 invalid model opus {SECRET} {PAT}")),
        ..EndState::default()
    });
    let tm = TurnModel {
        model: Some("opus".into()),
        effort: None,
        source: TurnModelSource {
            model: AxisSource::Thread,
            effort: AxisSource::Agent,
        },
    };
    let live = LiveTurn::default();
    let ran = Attempted::Ran(Ok(TurnResult {
        exit_code: 1,
        timed_out: false,
        tail: String::new(),
    }));
    let e = fold_outcome(ran, &s, &live, &end, inputs(Some(&tm))).unwrap_err();
    assert!(!e.message.contains(SECRET) && !e.message.contains(PAT));
    match e.into_turn_end() {
        TurnEnd::ThreadModelRejected { api_error, .. } => {
            assert!(!api_error.contains(SECRET), "{api_error}");
            assert!(!api_error.contains(PAT), "{api_error}");
        }
        other => panic!("{other:?}"),
    }
    let _ = std::fs::remove_dir_all(dir);
}

/// 깨끗한 종료는 종료 요청 시각을 그대로 넘긴다.
#[test]
fn fold_outcome_ok_passes_stop_time() {
    let (dir, s) = mounted("ok");
    let end = Mutex::new(EndState::default());
    let ok = fold_outcome(
        Attempted::Ran(Ok(TurnResult {
            exit_code: 0,
            timed_out: false,
            tail: String::new(),
        })),
        &s,
        &LiveTurn::default(),
        &end,
        inputs(None),
    )
    .unwrap();
    assert_eq!(
        ok.stop_requested_at.as_deref(),
        Some("2026-11-13T09:00:00Z")
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[derive(Default)]
struct Link {
    calls: StdMutex<Vec<Value>>,
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

fn after_inputs<'a>() -> AfterInputs<'a> {
    AfterInputs {
        key: "k",
        me_id: "me",
        channel_id: "c",
        anchor: Some("root"),
        mention_id: "men",
        caller: NudgeCaller::Human,
        proxy_head: "",
        record_proxy: false,
        wake_reason: "",
        background_wait_ms: 120_000,
        turn_start_seq: 1,
        turn_id: "t-1",
        promise: None,
    }
}

/// 턴 뒤 글(깨움 progress)의 끝말에 섞인 마운트 비밀·PAT 이 가려진다 — 목록은 `run_after_turn` 자리에서 `secrets` 로 짓는다.
#[test]
fn run_after_turn_masks_with_mounted_secrets() {
    let (dir, s) = mounted("after");
    let link = Link::default();
    let client = HarkroomMcpClient::new(&link, "t");
    let i = after_inputs();
    let said = format!("끝 {SECRET} {PAT}");
    let plan = AfterTurnPlan {
        silent: SilentPath::WakeProgress,
        post_count: 0,
        check_report_promise: false,
        watch_missed: false,
        delegation_report_missed: false,
    };
    run_after_turn(
        &client,
        &plan,
        &s,
        &i,
        Box::new(move || Some(said.clone())),
        Box::new(SilentSaid::default),
    )
    .unwrap();
    let calls = link.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["name"], "message.progress");
    let body = calls[0]["arguments"]["body"].as_str().unwrap();
    assert!(!body.contains(SECRET) && !body.contains(PAT), "{body}");
    assert!(body.contains("끝"), "{body}");
    let _ = std::fs::remove_dir_all(dir);
}
