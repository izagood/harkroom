//! [`run_body`] — 멘션마다 스레드 안에서 그 멘션의 재료(읽기·지시문 입력·`CallInputs`)를 새로 지어 섞이지 않는지(security L2 ④),
//! 정의를 못 읽으면 띄우지 않고 장부·임대·자리·턴 끝을 한 번 놓는지.
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use harkroom_proto::p1::RunnerLinkResponse;
use serde_json::json;

use super::*;
use crate::adapter::{AgentHarness, MentionPermission};
use crate::link::LinkRequest;
use crate::mcp::MCP_PROTOCOL_VERSION;
use crate::memory_pin::MemoryContext;
use crate::mention_admit::ThreadClaimHandle;
use crate::mention_admit_deps::{MentionLauncher, ThreadLauncher};
use crate::mention_call::{AfterData, BaseInputs, BundleParts, OwnedAfterInputs};
use crate::mention_hooks::LeaseHandoff;
use crate::mention_parts::MentionParts;
use crate::mention_sched::SchedEvent;
use crate::mention_watch::MentionWatchInputs;
use crate::pty_turn::{PromptHooks, PtyTurnOptions};
use crate::rest::RunnerLink;
use crate::session_store::SessionStore;
use crate::turn_attempt::LeaseNotice;
use crate::turn_command::TurnCommandOptions;
use crate::turn_end::EndConfig;
use crate::turn_notice::NudgeCaller;
use crate::turn_preset::TurnMode;
use crate::turn_success::{AfterTurnPlan, SilentPath};

/// 에이전트 링크 — 정의(`/agent/config`)는 `def_ok` 일 때만 읽힌다. 스레드 읽기는 오류(준비 실패 → 정상 끝).
struct Link {
    def_ok: AtomicBool,
}

fn link(def_ok: bool) -> &'static Link {
    Box::leak(Box::new(Link {
        def_ok: AtomicBool::new(def_ok),
    }))
}

impl RunnerLink for &'static Link {
    fn request(&self, req: LinkRequest) -> RunnerLinkResponse {
        match req {
            LinkRequest::Http { path, .. } => {
                let (status, body) = match path.as_str() {
                    "/agent/config" if !self.def_ok.load(Ordering::SeqCst) => (500, json!({})),
                    "/agent/config" => (200, json!({"instructions": "지시"})),
                    // 두 스레드의 머지 승인 — 지시문 입력에는 그 멘션 스레드 것만 실려야 한다.
                    "/agent/merge-grants" => (
                        200,
                        json!({"repos": [], "approvals": [
                            {"repo": "o/r", "number": 1, "channelId": "c", "threadRootId": "t1"},
                            {"repo": "o/r", "number": 2, "channelId": "c", "threadRootId": "t2"},
                        ]}),
                    ),
                    "/agent/turn-leases" => (
                        200,
                        json!({"lease": {"id": "L", "token": "TOK", "expiresAt": "2099-01-01T00:00:00Z"}}),
                    ),
                    _ => (200, json!({})),
                };
                RunnerLinkResponse::HttpResponse {
                    id: "x".into(),
                    status,
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
                        let name = payload["params"]["name"].as_str().unwrap_or("");
                        if name == "message.read" {
                            vec![json!({"jsonrpc":"2.0","id":id,"result":{
                                "content":[{"type":"text","text":"SERVER_ERROR"}], "isError": true}})]
                        } else {
                            vec![json!({"jsonrpc":"2.0","id":id,"result":{
                                "content":[{"type":"text","text": json!({"message": {"seq": 1}, "read": 1}).to_string()}], "isError": false}})]
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
    }
}

impl LeaseNotice for Link {
    fn lease_ended(&self, _c: &str) {}
}
impl LeaseHandoff for Link {
    fn heartbeat(&self, _c: &str) {}
    fn lease(&self, _c: &str, _l: &str, _t: &str, _e: &str) {}
    fn lease_ended(&self, _c: &str) {}
}
impl AgentLink for &'static Link {
    type Operator = Link;
    fn operator(&self) -> &Link {
        self
    }
}

#[derive(Default)]
struct Sink;
impl PromptHooks for Sink {}
impl PtyTurnSink for Sink {}

fn no_report(_s: &[String], _t: i64) {}
fn quiet(_l: &str) {}

/// 받은 재료를 적는 짓개. 적는 값: (지은 자리, 멘션 id, 그 지시문 입력의 승인 PR 번호).
struct Maker {
    root: PathBuf,
    state: PathBuf,
    store: SessionStore,
    env: BTreeMap<String, String>,
    seen: Mutex<Vec<(&'static str, String, Vec<u64>)>>,
    /// 짓개가 패닉할 자리(시험).
    panic_at: Option<&'static str>,
}

impl Drop for Maker {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn maker(tag: &str) -> Maker {
    let root = std::env::temp_dir().join(format!("hk-mbody-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let state = root.join("state");
    std::fs::create_dir_all(&state).unwrap();
    Maker {
        store: SessionStore::new(root.join("sessions.json")),
        state,
        root,
        env: BTreeMap::new(),
        seen: Mutex::default(),
        panic_at: None,
    }
}

fn approved(s: &SystemInputs) -> Vec<u64> {
    s.merge
        .as_ref()
        .map(|m| m.approved.iter().map(|a| a.number).collect())
        .unwrap_or_default()
}

impl CallMaker<&'static Link, Sink> for Maker {
    fn system_context(&self, _t: &MentionTarget, _r: &MentionReads) -> SystemContext<'_> {
        if self.panic_at == Some("system_context") {
            panic!("짓개 패닉(시험)");
        }
        SystemContext {
            handle: "agent".into(),
            channel_name: "general".into(),
            memory: MemoryContext::Unavailable,
            operator_bin: "/bin/op",
            harness: AgentHarness::ClaudeCode,
            command_hook: false,
            post_tool_hook: false,
            lane: false,
            lane_model: None,
            turn_budget_ms: 60_000,
        }
    }

    #[allow(clippy::result_large_err)]
    fn call_inputs<'a>(
        &'a self,
        _clients: &'a AgentClients<&'static Link>,
        _book: &'a LeaseBook,
        target: &MentionTarget,
        _reads: MentionReads,
        system: SystemInputs,
    ) -> CallInputs<'a, &'static Link, Sink> {
        if self.panic_at == Some("call_inputs") {
            panic!("짓개 패닉(시험)");
        }
        let (mid, ch, root) = (
            target.mention_id.clone(),
            target.channel_id.clone(),
            target.thread_root_id.clone(),
        );
        self.seen
            .lock()
            .unwrap()
            .push(("call_inputs", mid.clone(), approved(&system)));
        let key = format!("{ch}:{root}");
        let state: &'a std::path::Path = &self.state;
        let (mid2, key2) = (mid.clone(), key.clone());
        CallInputs {
            key: key.clone(),
            lane: Box::new(|_k, _a| vec![None]),
            now: || 1_000,
            claim_holder: None,
            log: &quiet,
            watch: MentionWatchInputs {
                key: key.clone(),
                me_id: "me".into(),
                channel_id: ch.clone(),
                anchor: Some(root.clone()),
                harness: AgentHarness::ClaudeCode,
                home: None,
                omp_home: None,
                end_cfg: EndConfig::new(60_000),
                lane_tui: false,
                caller: NudgeCaller::Human,
                report_auth: &no_report,
                clock: || 1,
                probe_ms: Duration::from_millis(1),
            },
            after: Box::new(move |_a, _rows| AfterData {
                plan: AfterTurnPlan {
                    silent: SilentPath::WakeProgress,
                    post_count: 0,
                    check_report_promise: false,
                    watch_missed: false,
                    delegation_report_missed: false,
                },
                inputs: OwnedAfterInputs {
                    key: key2.clone(),
                    me_id: "me".into(),
                    channel_id: ch.clone(),
                    anchor: Some(root.clone()),
                    mention_id: mid2.clone(),
                    background_wait_ms: 1,
                    caller: NudgeCaller::Human,
                    proxy_head: String::new(),
                    record_proxy: false,
                    wake_reason: String::new(),
                    turn_start_seq: 0,
                    turn_id: "turn".into(),
                    promise: None,
                },
                last_said: None,
            }),
            build_parts: Box::new(move |b: BundleParts<'a, &'static Link>| {
                // 띄우는 자리에 닿은 지시문 입력이 이 멘션 것인지 적는다.
                self.seen
                    .lock()
                    .unwrap()
                    .push(("build_parts", mid.clone(), approved(&system)));
                let base = TurnCommandOptions::new(
                    AgentHarness::ClaudeCode,
                    TurnMode::Mention,
                    MentionPermission::Auto,
                    "/bin/op",
                );
                let mut p = MentionParts::with_parts(
                    b.io,
                    &self.store,
                    base,
                    system,
                    Box::new(|| PtyTurnOptions::at(std::env::temp_dir())),
                    Sink,
                    Box::new(|_a, _s, _l, _e, _o| Ok(crate::mention_run::TurnOk::default())),
                    b.after,
                    Box::new(|_| Ok(())),
                );
                p.key = key;
                p.me_id = "me".into();
                p.state_dir = state.to_path_buf();
                p.new_workspace_dir = "/ws/new".into();
                p.home = self.root.join("home");
                p.slot = b.slot;
                p.watch_loop = Some(b.watch_loop);
                p
            }),
            base: BaseInputs {
                harness: AgentHarness::ClaudeCode,
                can_register_turn_keys: false,
                state_dir: state,
                mcp_config_path: state,
                runner_env: &self.env,
                pat: "pat-value-0123456789",
                lane: None,
            },
        }
    }
}

/// 놓기 횟수를 세는 임대 손잡이.
struct Claim(Arc<AtomicU32>);
impl ThreadClaimHandle for Claim {
    fn release(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn shared(
    l: &'static Link,
    m: Maker,
) -> (Arc<BodyShared<&'static Link, Maker>>, Receiver<SchedEvent>) {
    let (tx, rx) = channel();
    let sh = BodyShared {
        ledger: Arc::new(Mutex::new(Ledger::new(&[], 0))),
        slots: MentionSlots::default(),
        book: Arc::new(LeaseBook::default()),
        clients: Arc::new(AgentClients::new(l, "t")),
        sched: ChannelScheduler(tx),
        maker: m,
    };
    (Arc::new(sh), rx)
}

fn launch_in(
    sh: &BodyShared<&'static Link, Maker>,
    entry: i64,
    mid: &str,
    root: &str,
    claim: Option<Box<dyn ThreadClaimHandle>>,
) -> Launch {
    let key = format!("c:{root}");
    let tried = sh.ledger.lock().unwrap().start(&[entry], &key);
    Launch {
        lead_entry: json!({"id": entry, "reason": "mention", "messageId": mid}),
        lead_mention: json!({"id": mid, "channelId": "c", "threadRootId": root}),
        bundled: vec![],
        anchor: root.into(),
        thread_key: key,
        tried,
        claim,
        slot_held: true,
    }
}

fn ended(rx: &Receiver<SchedEvent>, n: usize) -> Vec<SchedEvent> {
    let mut out = Vec::new();
    while out
        .iter()
        .filter(|e| matches!(e, SchedEvent::TurnEnded { .. }))
        .count()
        < n
    {
        out.push(rx.recv_timeout(Duration::from_secs(10)).expect("턴 끝"));
    }
    out
}

/// security L2 ④: 두 멘션(다른 스레드)을 실물 띄우개로 동시에 — 각 멘션의 `CallInputs` 짓기와 띄우는 자리에 닿은 지시문 입력이
/// 그 멘션 스레드의 승인만 싣는다(m1 = #1, m2 = #2). 한 멘션의 재료가 다른 멘션에 섞이지 않는다.
#[test]
fn two_mentions_build_their_own_inputs_in_their_own_threads() {
    let l = link(true);
    let (sh, rx) = shared(l, maker("two"));
    let mut tl = ThreadLauncher::new(sh.slots.clone(), body_fn::<_, Sink, _>(Arc::clone(&sh)));
    tl.launch(launch_in(&sh, 1, "m1", "t1", None), "m1".into());
    tl.launch(launch_in(&sh, 2, "m2", "t2", None), "m2".into());
    ended(&rx, 2);

    let mut seen = sh.maker.seen.lock().unwrap().clone();
    seen.sort();
    assert_eq!(
        seen,
        vec![
            ("build_parts", "m1".to_string(), vec![1]),
            ("build_parts", "m2".to_string(), vec![2]),
            ("call_inputs", "m1".to_string(), vec![1]),
            ("call_inputs", "m2".to_string(), vec![2]),
        ]
    );
    let ledger = sh.ledger.lock().unwrap();
    assert!(!ledger.thread_in_flight("c:t1") && !ledger.thread_in_flight("c:t2"));
}

/// 정의를 못 읽으면 띄우지 않는다 — 짓개를 부르지 않고, 장부에서 놓고, 임대 1회·자리 1회·턴 끝 1회.
#[test]
fn unreadable_definition_releases_without_launching() {
    let l = link(false);
    let (sh, rx) = shared(l, maker("nodef"));
    let released = Arc::new(AtomicU32::new(0));
    let launch = launch_in(
        &sh,
        7,
        "m7",
        "t",
        Some(Box::new(Claim(Arc::clone(&released)))),
    );
    assert!(sh.ledger.lock().unwrap().thread_in_flight("c:t"));

    assert_eq!(
        run_body::<_, Sink, _>(&sh, launch),
        BodyEnd::DefinitionUnreadable
    );

    assert!(
        sh.maker.seen.lock().unwrap().is_empty(),
        "짓개를 부르지 않았다"
    );
    assert!(
        !sh.ledger.lock().unwrap().thread_in_flight("c:t"),
        "장부에서 놓았다"
    );
    assert_eq!(released.load(Ordering::SeqCst), 1, "임대 1회");
    let ev: Vec<SchedEvent> = rx.try_iter().collect();
    assert_eq!(
        ev,
        vec![
            SchedEvent::SlotReleased("c:t".into()),
            SchedEvent::TurnEnded {
                thread_key: "c:t".into(),
                mention_id: "m7".into()
            },
        ],
        "자리·턴 끝 각 한 번"
    );
    assert!(sh.book.get("m7").is_none(), "턴 임대는 받지 않았다");
}

/// security L3 ①: 띄우기 전 준비(짓개)가 패닉해도 정의 못 읽음과 같이 놓는다 — 장부 「도는 중」 풀림·임대 1·자리 1·턴 끝 1,
/// 턴 임대는 받지 않았다. 지시문 문맥·`CallInputs` 두 자리 다.
#[test]
fn maker_panic_before_launch_releases_like_unreadable_definition() {
    for at in ["system_context", "call_inputs"] {
        let l = link(true);
        let mut m = maker(&format!("panic-{at}"));
        m.panic_at = Some(at);
        let (sh, rx) = shared(l, m);
        let released = Arc::new(AtomicU32::new(0));
        let launch = launch_in(
            &sh,
            7,
            "m7",
            "t",
            Some(Box::new(Claim(Arc::clone(&released)))),
        );

        assert_eq!(
            run_body::<_, Sink, _>(&sh, launch),
            BodyEnd::PreparePanicked,
            "{at}"
        );

        assert!(
            !sh.ledger.lock().unwrap().thread_in_flight("c:t"),
            "{at}: 장부에서 놓았다"
        );
        assert_eq!(released.load(Ordering::SeqCst), 1, "{at}: 임대 1회");
        let ev: Vec<SchedEvent> = rx.try_iter().collect();
        assert_eq!(
            ev,
            vec![
                SchedEvent::SlotReleased("c:t".into()),
                SchedEvent::TurnEnded {
                    thread_key: "c:t".into(),
                    mention_id: "m7".into()
                },
            ],
            "{at}: 자리·턴 끝 각 한 번"
        );
        assert!(sh.book.get("m7").is_none(), "{at}: 턴 임대는 받지 않았다");
    }
}
