//! [`report_promise`]·[`system_inputs`] — 보고처 약속은 그 멘션의 예약 깨움에서만, 머지 승인은 그 스레드 것만.
use serde_json::json;

use super::*;
use crate::mention_scheduler::{WakeReportTo, WakeTarget};
use crate::rest::MergeApproval;
use crate::thread_model::{AxisSource, TurnModelSource};

fn target(wake: Option<TargetWake>) -> MentionTarget {
    MentionTarget {
        channel_id: "c".into(),
        thread_root_id: "root".into(),
        mention_id: "m".into(),
        mention_row: json!({}),
        bundled_rows: vec![],
        wake,
        canceled_wakes: vec![],
        started_in: None,
        team: None,
        delegation: None,
        delegation_followup: None,
        delegation_update: None,
        delegations: vec![],
        delegated_by: None,
        edited_mention: None,
    }
}

fn scheduled(report: bool, seq: Option<i64>) -> TargetWake {
    TargetWake::Scheduled(WakeTarget {
        reason: "CI 확인".into(),
        report_to: report.then(|| WakeReportTo {
            channel_id: "c2".into(),
            thread_root_id: "r2".into(),
        }),
        scheduled_seq: seq,
        scheduled_turn_id: Some("t-prev".into()),
        watch: false,
        origin: None,
    })
}

#[test]
fn promise_only_from_this_mentions_scheduled_wake() {
    let p = report_promise(&target(Some(scheduled(true, Some(42))))).unwrap();
    assert_eq!(p.report_to.thread_root_id, "r2");
    assert_eq!((p.base_seq, p.reason.as_str()), (42, "CI 확인"));
    assert_eq!(p.scheduled_turn_id.as_deref(), Some("t-prev"));
    assert_eq!(report_promise(&target(None)), None, "깨움이 아니면 없다");
    assert_eq!(
        report_promise(&target(Some(scheduled(false, Some(42))))),
        None,
        "보고처 없음"
    );
    assert_eq!(
        report_promise(&target(Some(scheduled(true, None)))),
        None,
        "예약 seq 없으면 판정을 접는다"
    );
    assert_eq!(
        report_promise(&target(Some(TargetWake::AskClosed("x")))),
        None,
        "카드 깨움은 아니다"
    );
}

fn reads() -> MentionReads {
    MentionReads {
        def: json!({"instructions": "지시", "mentionPermission": "auto"}),
        guide: "가이드".into(),
        merge: MergeGrantInfo {
            repos: vec!["o/a".into()],
            approvals: vec![
                MergeApproval {
                    repo: "o/b".into(),
                    number: 7,
                    channel_id: "c".into(),
                    thread_root_id: "root".into(),
                },
                MergeApproval {
                    repo: "o/x".into(),
                    number: 9,
                    channel_id: "c".into(),
                    thread_root_id: "other".into(),
                },
            ],
        },
        api: ApiGrantInfo::default(),
        secret_create: true,
        rules: ToolRuleSets::default(),
        turn_model: TurnModel {
            model: None,
            effort: None,
            source: TurnModelSource {
                model: AxisSource::Agent,
                effort: AxisSource::Agent,
            },
        },
    }
}

#[test]
fn merge_approvals_are_this_threads_only() {
    let s = system_inputs(
        &reads(),
        &target(None),
        SystemContext {
            handle: "h".into(),
            channel_name: "task".into(),
            memory: MemoryContext::Unavailable,
            operator_bin: "/bin/op",
            harness: AgentHarness::ClaudeCode,
            command_hook: false,
            post_tool_hook: false,
            lane: false,
            lane_model: None,
            turn_budget_ms: 1_800_000,
        },
    );
    let m = s.merge.unwrap();
    assert_eq!(m.repos, vec!["o/a".to_string(), "o/b".to_string()]);
    assert_eq!(m.approved.len(), 1, "다른 스레드 승인은 싣지 않는다");
    assert_eq!(m.approved[0].repo, "o/b");
    assert_eq!(
        (s.instructions.as_str(), s.secret_create, s.read_only),
        ("지시", true, false)
    );
}

/// 명령 전체 규칙만 열리는 문장은 **lane 턴이면** 붙는다 — 모델 id 가 비어도(정본 `Boolean(deps.providerEnv) && usesXdgHome`).
#[test]
fn exact_shell_only_follows_lane_not_model_id() {
    let ctx = |harness, lane, lane_model: Option<&str>| SystemContext {
        handle: "h".into(),
        channel_name: "task".into(),
        memory: MemoryContext::Unavailable,
        operator_bin: "/bin/op",
        harness,
        command_hook: false,
        post_tool_hook: false,
        lane,
        lane_model: lane_model.map(str::to_string),
        turn_budget_ms: 1_800_000,
    };
    let exact = |c| {
        system_inputs(&reads(), &target(None), c)
            .permissions
            .unwrap()
            .exact_shell_only
    };
    assert!(
        exact(ctx(AgentHarness::Opencode, true, None)),
        "lane·모델 없음"
    );
    assert!(
        exact(ctx(AgentHarness::Opencode, true, Some("harkroom-lane/m"))),
        "lane·모델 있음"
    );
    assert!(
        !exact(ctx(AgentHarness::Opencode, false, None)),
        "기본 로그인"
    );
    assert!(
        !exact(ctx(AgentHarness::ClaudeCode, true, None)),
        "xdg 아닌 하네스"
    );
}

// ---- read_mention: 일곱 읽기를 한꺼번에 ----

use crate::link::LinkRequest;
use crate::mcp::MCP_PROTOCOL_VERSION;
use crate::rest::RunnerLink;
use harkroom_proto::p1::RunnerLinkResponse;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

/// 요청마다 잠깐 머무는 서버 — 동시에 걸린 요청 수의 최고값과 받은 호출 이름을 적는다.
#[derive(Default)]
struct SlowLink {
    seen: Mutex<Vec<String>>,
    in_flight: AtomicUsize,
    peak: AtomicUsize,
    /// 정의(`/agent/config`)에 줄 상태.
    config_status: u16,
}

impl RunnerLink for &SlowLink {
    fn request(&self, req: LinkRequest) -> RunnerLinkResponse {
        let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(now, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(60));
        let res = match req {
            LinkRequest::Http { path, .. } => {
                let name = path.split('?').next().unwrap_or("").to_string();
                let (status, body) = match name.as_str() {
                    "/agent/config" => (
                        self.config_status,
                        json!({"instructions": "지시", "model": "m-def"}).to_string(),
                    ),
                    "/agent/thread-model" => (
                        200,
                        json!({"model": "m-thread", "effort": null,
                               "source": {"model": "thread", "effort": "agent"}})
                        .to_string(),
                    ),
                    _ => (200, "{}".to_string()),
                };
                self.seen.lock().unwrap().push(name);
                RunnerLinkResponse::HttpResponse {
                    id: "x".into(),
                    status,
                    body,
                }
            }
            LinkRequest::Mcp { payload } => {
                let id = payload.get("id").cloned();
                let messages = match (payload["method"].as_str().unwrap(), id) {
                    ("notifications/initialized", None) => vec![],
                    ("initialize", Some(id)) => vec![json!({"jsonrpc":"2.0","id":id,"result":{
                        "protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {},
                        "serverInfo": {"name":"s","version":"1"}}})],
                    ("tools/call", Some(id)) => {
                        let name = payload["params"]["name"].as_str().unwrap_or("").to_string();
                        self.seen.lock().unwrap().push(name);
                        vec![json!({"jsonrpc":"2.0","id":id,"result":{
                            "content":[{"type":"text","text": json!({"guide": "가이드"}).to_string()}],
                            "isError": false}})]
                    }
                    other => panic!("unexpected {other:?}"),
                };
                RunnerLinkResponse::McpResponse {
                    id: "x".into(),
                    messages,
                }
            }
        };
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        res
    }
}

impl crate::turn_attempt::LeaseNotice for SlowLink {
    fn lease_ended(&self, _cause: &str) {}
}
impl crate::mention_hooks::LeaseHandoff for SlowLink {
    fn heartbeat(&self, _cause: &str) {}
    fn lease(&self, _cause: &str, _lease_id: &str, _token: &str, _expires_at: &str) {}
    fn lease_ended(&self, _cause: &str) {}
}
impl AgentLink for &SlowLink {
    type Operator = SlowLink;
    fn operator(&self) -> &SlowLink {
        self
    }
}

#[test]
fn read_mention_calls_all_seven_at_once_and_keeps_every_answer() {
    let link = SlowLink {
        config_status: 200,
        ..Default::default()
    };
    let clients = AgentClients::new(&link, "t");
    let r = read_mention(&clients, &target(None)).expect("정의를 읽었다");

    let mut seen = link.seen.lock().unwrap().clone();
    seen.sort();
    assert_eq!(
        seen,
        [
            "/agent/api-grants",
            "/agent/config",
            "/agent/merge-grants",
            "/agent/secret-create",
            "/agent/thread-model",
            "/agent/tool-allows",
            "workspace.guide",
        ],
        "일곱 읽기가 빠짐없이, 한 번씩"
    );
    // 차례로 부르면 최고값은 1 이다. 서로 겹쳐야 왕복 일곱 번이 한 번 남짓으로 줄어든다.
    assert!(
        link.peak.load(Ordering::SeqCst) >= 4,
        "동시에 걸린 요청 최고 {}",
        link.peak.load(Ordering::SeqCst)
    );
    // 답은 차례로 부를 때와 같은 칸에 들어간다 — 스레드 모델은 미리 읽은 값을 정의 값과 합친다.
    assert_eq!(r.guide, "가이드");
    assert_eq!(r.def["instructions"], "지시");
    assert_eq!(r.turn_model.model.as_deref(), Some("m-thread"));
    assert_eq!(r.turn_model.source.model, AxisSource::Thread);
}

#[test]
fn read_mention_without_a_definition_does_not_launch() {
    let link = SlowLink {
        config_status: 500,
        ..Default::default()
    };
    let clients = AgentClients::new(&link, "t");
    assert_eq!(
        read_mention(&clients, &target(None)).unwrap_err(),
        DefinitionUnreadable
    );
}
