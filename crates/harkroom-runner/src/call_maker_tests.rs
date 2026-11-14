//! [`RunnerMaker`] — 멘션마다 새 값(두 멘션 동시에 지어도 안 섞임, security L3c-2 ④), 기억은 짓개가 쥔 묶음 링크로만,
//! 기본 로그인(`vec![None]`)은 계정 폴더 없이 홈 기본, 명령 옵션·세션 저장소·MCP 설정·지시문 자리는 그 멘션 것.
use std::sync::Mutex;

use harkroom_proto::p1::RunnerLinkResponse;
use serde_json::{Value, json};

use super::*;
use crate::link::LinkRequest;
use crate::mcp::MCP_PROTOCOL_VERSION;
use crate::mention_call::BundleParts;
use crate::mention_hooks::LeaseHandoff;
use crate::mention_inputs::{read_mention, system_inputs};
use crate::mention_parts::{AfterCtx, LoopCtx};
use crate::mention_scheduler::{WakeReportTo, WakeTarget};
use crate::rest::RunnerLink;
use crate::turn_attempt::LeaseNotice;
use crate::turn_attempt_account::LiveSlot;

/// 에이전트 링크 — 받은 요청을 적는다(HTTP 경로·MCP 도구 이름).
struct Link {
    seen: Mutex<Vec<String>>,
}

fn link() -> &'static Link {
    Box::leak(Box::new(Link {
        seen: Mutex::default(),
    }))
}

impl Link {
    fn saw(&self, what: &str) -> usize {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|s| *s == what)
            .count()
    }
}

fn tool_result(id: Value, body: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":{
        "content":[{"type":"text","text": body.to_string()}], "isError": false}})
}

impl RunnerLink for &'static Link {
    fn request(&self, req: LinkRequest) -> RunnerLinkResponse {
        match req {
            LinkRequest::Http { path, .. } => {
                self.seen.lock().unwrap().push(path.clone());
                let body = match path.as_str() {
                    "/agent/config" => {
                        json!({"instructions": "지시", "stopRequestedAt": null, "harness": "claude-code"})
                    }
                    // 두 스레드의 머지 승인 — 지시문에는 그 멘션 스레드 것만.
                    "/agent/merge-grants" => json!({"repos": [], "approvals": [
                        {"repo": "o/r", "number": 1, "channelId": "c1", "threadRootId": "t1"},
                        {"repo": "o/r", "number": 2, "channelId": "c2", "threadRootId": "t2"},
                    ]}),
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
                        let name = payload["params"]["name"].as_str().unwrap_or("").to_string();
                        self.seen.lock().unwrap().push(name.clone());
                        let body = match name.as_str() {
                            "memory.list" => json!({"slugs": ["core", "mem/a"], "rev": "r1",
                                "entries": [{"slug": "mem/a", "description": "에이", "kind": "topic"}]}),
                            "memory.get" => json!({"value": "CORE-A"}),
                            _ => json!({}),
                        };
                        vec![tool_result(id, body)]
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
impl crate::pty_turn::PromptHooks for Sink {}
impl PtyTurnSink for Sink {}

struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn cfg(tag: &str) -> (MakerConfig, Root) {
    let root = std::env::temp_dir().join(format!("hk-cmaker-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("state")).unwrap();
    let c = MakerConfig {
        operator_bin: "/bin/op".into(),
        command_hook: true,
        post_tool_hook: false,
        state_dir: root.join("state"),
        mcp_config_path: root.join("state/mcp.json"),
        runner_env: BTreeMap::new(),
        parent_env: BTreeMap::from([("PATH".to_string(), "/usr/bin".to_string())]),
        pat: "pat-value-0123456789".into(),
        home: root.join("home"),
        turn_timeout_ms: 1_800_000,
        harness_stall_ms: 600_000,
        workspace_base_dir: root.join("ws"),
        me_id: "me".into(),
        claim_holder: "holder-1".into(),
        can_register_turn_keys: true,
        pty_record_dir: None,
    };
    (c, Root(root))
}

fn no_report(_s: &[String], _t: i64) {}

fn maker(tag: &str) -> (RunnerMaker<&'static Link>, &'static Link, Root) {
    let l = link();
    let (c, root) = cfg(tag);
    let m = RunnerMaker::new(c, Arc::new(AgentClients::new(l, "t")), Box::new(no_report));
    (m, l, root)
}

fn target(n: u8, wake: Option<TargetWake>, author: &str) -> MentionTarget {
    MentionTarget {
        channel_id: format!("c{n}"),
        thread_root_id: format!("t{n}"),
        mention_id: format!("m{n}"),
        mention_row: json!({"id": format!("m{n}"), "authorId": author}),
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

fn scheduled_with_report() -> TargetWake {
    TargetWake::Scheduled(WakeTarget {
        reason: "CI 확인".into(),
        report_to: Some(WakeReportTo {
            channel_id: "rc".into(),
            thread_root_id: "rt".into(),
        }),
        scheduled_seq: Some(42),
        scheduled_turn_id: Some("t-prev".into()),
        watch: true,
        origin: None,
    })
}

fn after_ctx(turn: &str) -> AfterCtx {
    AfterCtx {
        ctx: LoopCtx {
            turn_id: turn.into(),
            turn_start_seq: 7,
            ..LoopCtx::default()
        },
        background_cut: None,
    }
}

fn bundle<'a>(m: &'a RunnerMaker<&'static Link>) -> BundleParts<'a, &'static Link> {
    BundleParts {
        io: m.clients.prepare_io(),
        after: Box::new(|_s, _a| Ok(())),
        watch_loop: Box::new(|_w, _n, _c, _s| {}),
        slot: LiveSlot::default(),
    }
}

/// 한 멘션을 끝까지 지어 본 것.
#[derive(Debug, PartialEq)]
struct Built {
    key: String,
    watch: (String, String, Option<String>, NudgeCaller),
    after: (
        String,
        String,
        Option<String>,
        String,
        Option<String>,
        bool,
        bool,
    ),
    parts: (String, Vec<u64>, String, bool, PathBuf),
}

fn build(m: &RunnerMaker<&'static Link>, t: &MentionTarget, turn: &str) -> Built {
    let clients = m.clients();
    let book = LeaseBook::default();
    let reads = read_mention(&clients, t).unwrap();
    let ctx = <RunnerMaker<_> as CallMaker<_, Sink>>::system_context(m, t, &reads);
    let system = system_inputs(&reads, t, ctx);
    let i: CallInputs<'_, _, Sink> = m.call_inputs(&clients, &book, t, reads, system);
    let w = &i.watch;
    let watch = (
        w.key.clone(),
        w.channel_id.clone(),
        w.anchor.clone(),
        w.caller,
    );
    let key = i.key.clone();
    let mut after = i.after;
    let d = after(&after_ctx(turn), &[]);
    let p = d.inputs.promise.as_ref();
    let after = (
        d.inputs.key.clone(),
        d.inputs.mention_id.clone(),
        d.inputs.anchor.clone(),
        d.inputs.turn_id.clone(),
        p.map(|p| p.report_to.thread_root_id.clone()),
        d.plan.check_report_promise,
        d.inputs.record_proxy,
    );
    let parts = (i.build_parts)(bundle(m));
    assert!(
        std::ptr::eq(parts.store, &*m.store),
        "세션 저장소는 짓개의 것"
    );
    assert_eq!(parts.base.mcp_config_path, m.mcp_config, "MCP 설정");
    let approved = parts
        .system
        .merge
        .as_ref()
        .map(|g| g.approved.iter().map(|a| a.number).collect())
        .unwrap_or_default();
    Built {
        key,
        watch,
        after,
        parts: (
            parts.key.clone(),
            approved,
            parts.me_id.clone(),
            parts.base.command_hook,
            parts.state_dir.clone(),
        ),
    }
}

#[test]
fn two_mentions_built_at_once_do_not_mix() {
    let (m, _l, _root) = maker("mix");
    m.set_names(Names {
        agent_ids: Some(HashSet::from(["agent-x".to_string()])),
        ..Names::default()
    });
    let t1 = target(1, None, "agent-x");
    let t2 = target(2, Some(scheduled_with_report()), "human-y");
    // 같은 짓개로 두 멘션을 동시에 여러 번 짓는다 — 어느 회차든 그 멘션 값만 나와야 한다.
    let (b1, b2) = std::thread::scope(|s| {
        let h1 = s.spawn(|| {
            (0..20)
                .map(|_| build(&m, &t1, "turn-1"))
                .collect::<Vec<_>>()
        });
        let h2 = s.spawn(|| {
            (0..20)
                .map(|_| build(&m, &t2, "turn-2"))
                .collect::<Vec<_>>()
        });
        (h1.join().unwrap(), h2.join().unwrap())
    });
    let state = m.cfg.state_dir.clone();
    let want1 = Built {
        key: "c1/t1".into(),
        watch: (
            "c1/t1".into(),
            "c1".into(),
            Some("t1".into()),
            NudgeCaller::Agent,
        ),
        after: (
            "c1/t1".into(),
            "m1".into(),
            Some("t1".into()),
            "turn-1".into(),
            None,
            false,
            false,
        ),
        parts: ("c1/t1".into(), vec![1], "me".into(), true, state.clone()),
    };
    let want2 = Built {
        key: "c2/t2".into(),
        watch: (
            "c2/t2".into(),
            "c2".into(),
            Some("t2".into()),
            NudgeCaller::Wake,
        ),
        after: (
            "c2/t2".into(),
            "m2".into(),
            Some("t2".into()),
            "turn-2".into(),
            Some("rt".into()),
            true,
            false,
        ),
        parts: ("c2/t2".into(), vec![2], "me".into(), true, state),
    };
    assert!(b1.iter().all(|b| *b == want1), "{:?}", b1[0]);
    assert!(b2.iter().all(|b| *b == want2), "{:?}", b2[0]);
}

#[test]
fn memory_is_read_only_through_the_makers_bundle() {
    let (m, l, _root) = maker("mem");
    m.set_names(Names {
        me_handle: "harkroom".into(),
        channel_names: HashMap::from([("c1".to_string(), "task".to_string())]),
        ..Names::default()
    });
    let t = target(1, None, "h");
    let clients = m.clients();
    assert!(
        Arc::ptr_eq(&clients, &m.clients),
        "몸통은 짓개와 같은 묶음을 쥔다"
    );
    let reads = read_mention(&clients, &t).unwrap();
    let ctx = <RunnerMaker<_> as CallMaker<_, Sink>>::system_context(&m, &t, &reads);
    assert_eq!(
        (ctx.handle.as_str(), ctx.channel_name.as_str()),
        ("harkroom", "task")
    );
    match &ctx.memory {
        MemoryContext::Read(r) => {
            assert_eq!(r.core.as_deref(), Some("CORE-A"));
            assert_eq!(r.slugs, vec!["mem/a".to_string()]);
        }
        MemoryContext::Unavailable => panic!("기억을 묶음 링크로 읽어야 한다"),
    }
    assert_eq!((l.saw("memory.list"), l.saw("memory.get")), (1, 1));
}

#[test]
fn default_login_has_no_account_dir_and_finds_records_in_home() {
    let (m, _l, _root) = maker("lane");
    let t = target(1, None, "h");
    let clients = m.clients();
    let book = LeaseBook::default();
    let reads = read_mention(&clients, &t).unwrap();
    let ctx = <RunnerMaker<_> as CallMaker<_, Sink>>::system_context(&m, &t, &reads);
    assert_eq!(ctx.lane_model, None, "API 키 레인 없음");
    let system = system_inputs(&reads, &t, ctx);
    let mut i: CallInputs<'_, _, Sink> = m.call_inputs(&clients, &book, &t, reads, system);
    let lanes = (i.lane)("c1/t1", "t1");
    assert_eq!(lanes.len(), 1);
    assert!(lanes[0].is_none(), "기본 로그인 — 계정 폴더 없음");
    assert_eq!(
        i.watch.home.as_deref(),
        Some(m.cfg.home.as_path()),
        "기록 찾기는 홈 기본"
    );
    assert_eq!(i.watch.omp_home, None);
    assert!(!i.watch.lane_tui);
    assert_eq!(i.claim_holder, Some("holder-1"));
    assert_eq!(i.base.mcp_config_path, m.cfg.mcp_config_path.as_path());
    assert!(i.base.can_register_turn_keys);
    let parts = (i.build_parts)(bundle(&m));
    assert_eq!(parts.home, m.cfg.home);
    assert_eq!(
        parts.parent_env.get("PATH").map(String::as_str),
        Some("/usr/bin")
    );
    assert!(
        std::path::Path::new(&parts.new_workspace_dir).starts_with(&m.cfg.workspace_base_dir),
        "작업 폴더는 뿌리 아래 스레드 폴더"
    );
}

fn workspace_of(m: &RunnerMaker<&'static Link>, t: &MentionTarget) -> String {
    let clients = m.clients();
    let book = LeaseBook::default();
    let reads = read_mention(&clients, t).unwrap();
    let ctx = <RunnerMaker<_> as CallMaker<_, Sink>>::system_context(m, t, &reads);
    let system = system_inputs(&reads, t, ctx);
    let i: CallInputs<'_, _, Sink> = m.call_inputs(&clients, &book, t, reads, system);
    (i.build_parts)(bundle(m)).new_workspace_dir.clone()
}

/// 스레드마다 작업 폴더가 따로다(정본 `resolveWorkspaceDir`) — 두 스레드는 다른 폴더, 같은 스레드는 다시 지어도 같은 폴더.
#[test]
fn each_thread_gets_its_own_workspace_dir() {
    let (m, _l, _root) = maker("ws");
    let w1 = workspace_of(&m, &target(1, None, "h"));
    let w2 = workspace_of(&m, &target(2, None, "h"));
    assert_ne!(w1, w2, "두 스레드가 한 폴더를 나눠 쓰지 않는다");
    assert_eq!(
        workspace_of(&m, &target(1, None, "h")),
        w1,
        "같은 스레드는 같은 폴더"
    );
    for w in [&w1, &w2] {
        let p = std::path::Path::new(w);
        assert!(p.is_dir() && p.starts_with(&m.cfg.workspace_base_dir));
    }
}

fn argv_system() -> SystemInputs {
    SystemInputs {
        handle: "agent".into(),
        channel_name: "general".into(),
        instructions: String::new(),
        guide: String::new(),
        memory: crate::memory_pin::MemoryContext::Unavailable,
        read_only: false,
        turn_budget_ms: None,
        merge: Some(crate::mention_parts::MergeInputs {
            operator_bin: "/op".into(),
            repos: vec!["o/r".into()],
            approved: vec![],
        }),
        permissions: Some(crate::mention_parts::PermissionInputs {
            tool_allows: vec!["Bash(git status)".into()],
            ..Default::default()
        }),
        api: Some(crate::mention_parts::ApiInputs {
            operator_bin: "/op".into(),
            connectors: vec!["conn-1".into()],
            delegatable: vec!["deleg-1".into()],
        }),
        secret_create: false,
        lane_model: None,
    }
}

/// security L3d ①: 명령 칸은 그 멘션의 것 — 허용 도구·머지 저장소·API 는 지시문 입력에서, 모델·effort 는 그 멘션 읽기에서.
/// 허용 도구가 실제 argv 에 실린다.
#[test]
fn argv_carries_this_mentions_tool_allows_repos_api_and_model() {
    use crate::turn_command::{TurnCommandOptions, build_turn_command};
    let sys = argv_system();
    let argv = owned_argv(
        "c/t",
        AgentHarness::ClaudeCode,
        false,
        Some("opus".into()),
        Some("high".into()),
    );
    let mut base = TurnCommandOptions::new(
        AgentHarness::ClaudeCode,
        crate::turn_preset::TurnMode::Mention,
        MentionPermission::Auto,
        "/op",
    );
    base.mcp_config_path = "/m.json";
    base.session_id = Some("sid");
    let o = crate::mention_parts::with_argv(&base, &sys, &argv);
    assert_eq!(o.tool_allows, ["Bash(git status)".to_string()]);
    assert_eq!(o.merge_repos, ["o/r".to_string()]);
    assert_eq!(o.api_connectors, ["conn-1".to_string()]);
    assert_eq!(o.api_delegatable, ["deleg-1".to_string()]);
    assert_eq!((o.model, o.effort), (Some("opus"), Some("high")));
    let plan = build_turn_command(
        &o,
        &std::collections::BTreeMap::new(),
        std::path::Path::new("/h"),
    )
    .unwrap();
    assert!(
        plan.args.iter().any(|a| a == "Bash(git status)"),
        "허용 도구가 argv 에 있다: {:?}",
        plan.args
    );
    assert!(plan.args.iter().any(|a| a == "opus"), "모델이 argv 에 있다");
}

/// security L3d ①: 이름을 하네스에게 물어야 하는 하네스(pi)는 읽기 전용 목록을 아직 못 지어 **띄우지 않는다** — 빈 목록·내장
/// 도구만 여는 기본값으로 우회하지 않는다. 글롭 하네스(omp)는 묻지 않고 짓는다. 읽기 전용이 아니면 목록은 없다.
#[test]
fn readonly_list_is_never_defaulted_to_launch() {
    use crate::turn_command::{TurnCommandError, TurnCommandOptions, build_turn_command};
    let argv = owned_argv("c/t", AgentHarness::Pi, true, None, None);
    assert_eq!(argv.readonly_tool_list, None);
    let mut base = TurnCommandOptions::new(
        AgentHarness::Pi,
        crate::turn_preset::TurnMode::Mention,
        MentionPermission::Readonly,
        "/op",
    );
    base.mcp_config_path = "/m.json";
    base.session_id = Some("sid");
    base.pi_home = Some(std::path::Path::new("/pi"));
    let mut sys = argv_system();
    sys.read_only = true;
    let o = crate::mention_parts::with_argv(&base, &sys, &argv);
    let r = build_turn_command(
        &o,
        &std::collections::BTreeMap::new(),
        std::path::Path::new("/h"),
    );
    assert!(
        matches!(r, Err(TurnCommandError::ReadonlyToolListMissing(_))),
        "{:?}",
        r.err()
    );
    assert!(
        owned_argv("c/t", AgentHarness::Omp, true, None, None)
            .readonly_tool_list
            .is_some()
    );
    assert_eq!(
        owned_argv("c/t", AgentHarness::Omp, false, None, None).readonly_tool_list,
        None
    );
}

/// security C6 전 P1: 하네스는 그 멘션이 읽은 정의에서 — 기본값이 없다. codex 정의면 codex 로 짓고, 없거나 모르는 값이면
/// 짓지 않는다(패닉 → 몸통 지킴이 놓는다). 패닉 문구에는 값이 없다.
#[test]
fn harness_comes_from_this_mentions_definition_without_default() {
    assert_eq!(
        harness_of(&json!({"harness": "codex"})),
        AgentHarness::Codex
    );
    assert_eq!(
        harness_of(&json!({"harness": "claude-code"})),
        AgentHarness::ClaudeCode
    );

    let (m, _l, _root) = maker("def-harness");
    let t = target(1, None, "h");
    let clients = m.clients();
    let book = LeaseBook::default();
    let mut reads = read_mention(&clients, &t).unwrap();
    reads.def["harness"] = json!("codex");
    let ctx = <RunnerMaker<_> as CallMaker<_, Sink>>::system_context(&m, &t, &reads);
    assert_eq!(ctx.harness, AgentHarness::Codex);
    let system = system_inputs(&reads, &t, ctx);
    let i: CallInputs<'_, _, Sink> = m.call_inputs(&clients, &book, &t, reads, system);
    assert_eq!(i.base.harness, AgentHarness::Codex, "명령도 정의의 하네스");

    for def in [json!({}), json!({"harness": "--evil-not-a-harness"})] {
        let r = std::panic::catch_unwind(|| harness_of(&def));
        let msg = r
            .err()
            .and_then(|e| {
                e.downcast_ref::<String>()
                    .cloned()
                    .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
            })
            .expect("패닉해야 한다");
        assert!(!msg.contains("evil"), "값을 싣지 않는다: {msg}");
    }
}
