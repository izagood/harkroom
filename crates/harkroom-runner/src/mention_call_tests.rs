//! [`run_mention_call`] — 호출 자리의 손님이 모두 그 에이전트 묶음 것인지(security ③b-2c ①), 멘션 하나의 deps 가 그 호출
//! 안에서 지어지고 떨어져 정상·패닉 모두에서 슬롯·턴 끝이 각 한 번인지(②), 턴 임대는 러너 수명 장부가 쥐어 재시도 갈래에서
//! 놓지도 다시 청하지도 않고, 결말이 놓는 갈래·패닉에서 한 번 놓는지(정본 `secretLeases`).
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::time::Duration;

use harkroom_proto::p1::RunnerLinkResponse;
use serde_json::json;

use super::*;
use crate::adapter::{AgentHarness, MentionPermission};
use crate::link::LinkRequest;
use crate::mcp::MCP_PROTOCOL_VERSION;
use crate::memory_pin::MemoryContext;
use crate::mention_hooks::{Booked, LeaseHandoff};
use crate::mention_parts::SystemInputs;
use crate::pty_turn::{PromptHooks, PtyTurnOptions};
use crate::rest::RunnerLink;
use crate::session_store::SessionStore;
use crate::turn_attempt::LeaseNotice;
use crate::turn_command::TurnCommandOptions;
use crate::turn_end::EndConfig;
use crate::turn_notice::NudgeCaller;
use crate::turn_preset::TurnMode;
use crate::turn_success::SilentPath;

/// 스레드 읽기(`message.read`)에서 어떻게 할지.
#[derive(Clone, Copy, PartialEq)]
enum Read {
    /// 오류 결과 — 준비 실패로 접힌다(정상 길).
    Error,
    /// 패닉 — 호출 자리 안에서 패닉이 난다.
    Panic,
}

/// 받은 요청·오퍼레이터 알림을 세는 에이전트 링크.
struct Link {
    read: Read,
    tools: Mutex<Vec<String>>,
    http: Mutex<Vec<String>>,
    leased: Mutex<Vec<String>>,
    lease_ended: Mutex<Vec<String>>,
}

fn link(read: Read) -> Link {
    Link {
        read,
        tools: Mutex::default(),
        http: Mutex::default(),
        leased: Mutex::default(),
        lease_ended: Mutex::default(),
    }
}

fn got<T: Clone>(m: &Mutex<Vec<T>>) -> Vec<T> {
    m.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

fn n<T: Clone>(m: &Mutex<Vec<T>>) -> usize {
    got(m).len()
}

fn push(m: &Mutex<Vec<String>>, s: String) {
    m.lock().unwrap_or_else(|p| p.into_inner()).push(s);
}

impl RunnerLink for &Link {
    fn request(&self, req: LinkRequest) -> RunnerLinkResponse {
        match req {
            LinkRequest::Http { method, path, .. } => {
                push(&self.http, format!("{method} {path}"));
                let body = if path == "/agent/turn-leases" {
                    json!({ "lease": { "id": "L1", "token": "LEASE_TOKEN_VALUE", "expiresAt": "2099-01-01T00:00:00Z" } })
                } else {
                    json!({})
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
                        push(&self.tools, name.clone());
                        match (name.as_str(), self.read) {
                            ("message.read", Read::Panic) => panic!("호출 자리 안 패닉(시험)"),
                            ("message.read", Read::Error) => {
                                vec![json!({"jsonrpc":"2.0","id":id,"result":{
                                "content":[{"type":"text","text":"SERVER_ERROR"}], "isError": true}})]
                            }
                            _ => vec![json!({"jsonrpc":"2.0","id":id,"result":{
                                "content":[{"type":"text","text": json!({"messages": [], "message": {"seq": 1}, "read": 1}).to_string()}], "isError": false}})],
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
    fn lease_ended(&self, cause: &str) {
        push(&self.lease_ended, cause.into());
    }
}
impl LeaseHandoff for Link {
    fn lease(&self, cause: &str, _lease_id: &str, _token: &str, _expires_at: &str) {
        push(&self.leased, cause.into());
    }
    fn lease_ended(&self, cause: &str) {
        push(&self.lease_ended, cause.into());
    }
}
impl AgentLink for &Link {
    type Operator = Link;
    fn operator(&self) -> &Link {
        self
    }
}

/// 스케줄러 몫 기록.
#[derive(Clone, Default)]
struct Sched(Arc<Mutex<Vec<String>>>);
impl SchedulerHooks for Sched {
    fn notice_fenced(&mut self) {}
    fn turn_outcome(&mut self, _ok: bool) {}
    fn stop_requested(&mut self, _at: &str) {}
    fn executable_missing(&mut self) {}
    fn release_slot(&mut self, k: &str) {
        push(&self.0, format!("slot {k}"));
    }
    fn turn_ended(&mut self, k: &str, m: &str) {
        push(&self.0, format!("ended {k} {m}"));
    }
}

#[derive(Default)]
struct Sink;
impl PromptHooks for Sink {}
impl PtyTurnSink for Sink {}

fn launch(ledger: &Mutex<Ledger>) -> Launch {
    let tried = ledger.lock().unwrap().start(&[7], "c:t");
    Launch {
        lead_entry: json!({ "id": 7, "reason": "mention", "messageId": "m7" }),
        lead_mention: json!({ "id": "m7", "channelId": "c", "threadRootId": "t" }),
        bundled: vec![],
        anchor: "t".into(),
        thread_key: "c:t".into(),
        tried,
        claim: None,
        slot_held: true,
    }
}

fn fresh() -> Mutex<Ledger> {
    Mutex::new(Ledger::new(&[], 0))
}

fn no_report(_s: &[String], _t: i64) {}

fn watch<'a>() -> MentionWatchInputs<'a> {
    MentionWatchInputs {
        key: "k".into(),
        me_id: "me".into(),
        channel_id: "c".into(),
        anchor: Some("t".into()),
        harness: AgentHarness::ClaudeCode,
        home: None,
        omp_home: None,
        end_cfg: EndConfig::new(60_000),
        lane_tui: false,
        caller: NudgeCaller::Human,
        report_auth: &no_report,
        clock: || 1,
        probe_ms: Duration::from_millis(1),
    }
}

fn system() -> SystemInputs {
    SystemInputs {
        handle: "agent".into(),
        channel_name: "general".into(),
        instructions: String::new(),
        guide: String::new(),
        memory: MemoryContext::Unavailable,
        read_only: false,
        turn_budget_ms: None,
        merge: None,
        permissions: None,
        api: None,
        secret_create: false,
        lane_model: None,
    }
}

/// 묶음이 넘긴 몫을 본 결과.
#[derive(Default)]
struct Seen {
    /// 준비 손님 = 묶음의 MCP 손님.
    prepare_is_bundle: Option<bool>,
    /// after 닫개를 불렀을 때 (내 링크 tools 증가, 다른 링크 tools 증가).
    after_calls: Option<(usize, usize)>,
}

struct World {
    root: PathBuf,
    state: PathBuf,
    store: SessionStore,
    env: BTreeMap<String, String>,
}
impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn world(tag: &str) -> World {
    let root = std::env::temp_dir().join(format!("hk-mcall-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let state = root.join("state");
    std::fs::create_dir_all(&state).unwrap();
    World {
        store: SessionStore::new(root.join("sessions.json")),
        state,
        root,
        env: BTreeMap::new(),
    }
}

fn plan() -> AfterTurnPlan {
    AfterTurnPlan {
        silent: SilentPath::WakeProgress,
        post_count: 0,
        check_report_promise: false,
        watch_missed: false,
        delegation_report_missed: false,
    }
}

fn quiet(_l: &str) {}

#[allow(clippy::result_large_err, clippy::too_many_arguments)]
/// 멘션 하나를 호출 자리로 돌린다. `call_after` 면 묶음이 넘긴 after 닫개를 한 번 불러 어느 링크로 가는지 본다.
fn call<'a>(
    w: &'a World,
    ledger: &Mutex<Ledger>,
    book: &'a LeaseBook,
    links: (&'a Link, &'a Link),
    clients: &'a AgentClients<&'a Link>,
    sched: Sched,
    seen: &'a RefCell<Seen>,
    call_after: bool,
) {
    let (mine, other) = links;
    let slots = MentionSlots::default();
    let l = launch(ledger);
    let state: &'a Path = &w.state;
    let inputs = CallInputs {
        key: "c:t".into(),
        lane: Box::new(|_k, _a| vec![None]),
        now: || 1_000,
        claim_holder: None,
        log: &quiet,
        watch: watch(),
        after: Box::new(|_a, _rows| AfterData {
            plan: plan(),
            inputs: OwnedAfterInputs {
                key: "k".into(),
                me_id: "me".into(),
                channel_id: "c".into(),
                anchor: Some("t".into()),
                mention_id: "m7".into(),
                background_wait_ms: 1,
                turn_id: "turn".into(),
                ..OwnedAfterInputs::default()
            },
            last_said: None,
        }),
        build_parts: Box::new(move |mut b: BundleParts<'a, &'a Link>| {
            let mut s = seen.borrow_mut();
            s.prepare_is_bundle = Some(std::ptr::eq(b.io.client, clients.mcp()));
            if call_after {
                let (m0, o0) = (n(&mine.tools), n(&other.tools));
                let secrets = TurnSecrets::build("pat-value-0123456789", &[], None);
                let _ = (b.after)(&secrets, &crate::mention_parts::AfterCtx::default());
                s.after_calls = Some((n(&mine.tools) - m0, n(&other.tools) - o0));
            }
            let base = TurnCommandOptions::new(
                AgentHarness::ClaudeCode,
                TurnMode::Mention,
                MentionPermission::Auto,
                "/bin/op",
            );
            let mut p = MentionParts::with_parts(
                b.io,
                &w.store,
                base,
                system(),
                Box::new(PtyTurnOptions::default),
                Sink,
                Box::new(|_a, _s, _l, _e| Ok(crate::mention_run::TurnOk::default())),
                b.after,
                Box::new(|_| Ok(())),
            );
            p.key = "c:t".into();
            p.me_id = "me".into();
            p.state_dir = state.to_path_buf();
            p.new_workspace_dir = "/ws/new".into();
            p.home = w.root.join("home");
            p.slot = b.slot;
            p.watch_loop = Some(b.watch_loop);
            p
        }),
        base: BaseInputs {
            harness: AgentHarness::ClaudeCode,
            can_register_turn_keys: false,
            state_dir: state,
            mcp_config_path: state,
            runner_env: &w.env,
            pat: "pat-value-0123456789",
        },
    };
    run_mention_call(ledger, &slots, book, clients, l, sched, inputs, |_| None);
    assert!(!slots.is_open("m7"), "멘션 자리는 호출 안에서 닫혔다");
}

/// ① 호출 자리가 쓰는 손님이 모두 묶음 것이다 — 준비 손님은 묶음의 MCP 손님(`ptr::eq`), after 닫개는 묶음의 MCP 손님(내 링크)으로만
/// 가고, 턴 임대·준비 읽기·임대 넘기기도 내 링크로만 간다. 다른 에이전트 링크는 0건.
#[test]
fn call_site_uses_only_the_bundle() {
    let w = world("bundle");
    let (mine, other) = (link(Read::Error), link(Read::Error));
    let clients = AgentClients::new(&mine, "t");
    let _b = AgentClients::new(&other, "t");
    let seen = RefCell::new(Seen::default());
    let (ledger, book) = (fresh(), LeaseBook::default());
    call(
        &w,
        &ledger,
        &book,
        (&mine, &other),
        &clients,
        Sched::default(),
        &seen,
        true,
    );

    let s = seen.borrow();
    assert_eq!(s.prepare_is_bundle, Some(true), "준비 = 묶음의 MCP 손님");
    let (m, o) = s.after_calls.expect("after 닫개를 불렀다");
    assert!(m >= 1, "after = 내 링크로 갔다");
    assert_eq!(o, 0, "after 가 다른 링크로 가지 않았다");

    assert_eq!(
        got(&mine.http),
        ["POST /agent/turn-leases"],
        "턴 임대 = 내 링크"
    );
    assert!(
        got(&mine.tools).iter().any(|t| t == "message.read"),
        "준비 읽기 = 내 링크"
    );
    assert_eq!(got(&mine.leased), ["m7"], "임대 넘기기 = 내 링크");
    assert_eq!(n(&other.tools), 0);
    assert_eq!(n(&other.http), 0);
    assert_eq!(n(&other.leased), 0);
    assert_eq!(n(&other.lease_ended), 0);
}

/// ② 정상 길(준비 실패 → 재시도 갈래) — 슬롯·턴 끝은 각 한 번, 턴 임대는 **놓지 않고** 장부가 쥔다(정본 `secretLeases`:
/// 재시도 갈래는 `release` 하지 않는다).
#[test]
fn normal_path_releases_slot_once_and_keeps_lease_for_retry() {
    let w = world("normal");
    let (mine, other) = (link(Read::Error), link(Read::Error));
    let clients = AgentClients::new(&mine, "t");
    let seen = RefCell::new(Seen::default());
    let sched = Sched::default();
    let (ledger, book) = (fresh(), LeaseBook::default());
    call(
        &w,
        &ledger,
        &book,
        (&mine, &other),
        &clients,
        sched.clone(),
        &seen,
        false,
    );

    assert_eq!(
        got(&sched.0),
        ["slot c:t", "ended c:t m7"],
        "슬롯 → 턴 끝, 각 한 번"
    );
    assert_eq!(n(&mine.lease_ended), 0, "재시도 갈래는 임대를 놓지 않는다");
    assert_eq!(book.get("m7"), Some(Booked::Held), "장부가 쥔다");
}

/// 재시도 갈래 두 번 → 발급 1회·임대 끝 0회, 마지막 실패(시도 상한) → 임대 끝 1회·장부 빔. 되돌리면(Drop 이 정상 길에서도 놓으면)
/// 둘째 시도가 다시 발급을 청한다(서버는 끝난 멘션에 409 `lease_used`).
#[test]
fn retries_reuse_one_lease_and_final_failure_ends_it_once() {
    let w = world("retry");
    let (mine, other) = (link(Read::Error), link(Read::Error));
    let clients = AgentClients::new(&mine, "t");
    let seen = RefCell::new(Seen::default());
    let (ledger, book) = (fresh(), LeaseBook::default());

    for _ in 0..2 {
        call(
            &w,
            &ledger,
            &book,
            (&mine, &other),
            &clients,
            Sched::default(),
            &seen,
            false,
        );
    }
    assert_eq!(got(&mine.http), ["POST /agent/turn-leases"], "발급은 한 번");
    assert_eq!(got(&mine.leased), ["m7"], "오퍼레이터 맡김도 한 번");
    assert_eq!(n(&mine.lease_ended), 0, "재시도 사이 임대 끝 없음");
    assert_eq!(book.get("m7"), Some(Booked::Held));

    call(
        &w,
        &ledger,
        &book,
        (&mine, &other),
        &clients,
        Sched::default(),
        &seen,
        false,
    );
    assert_eq!(
        got(&mine.http),
        ["POST /agent/turn-leases"],
        "마지막 시도도 다시 청하지 않는다"
    );
    assert_eq!(
        got(&mine.lease_ended),
        ["m7"],
        "마지막 실패에 임대 끝 한 번"
    );
    assert!(book.is_empty(), "장부에서 지웠다");
    assert_eq!(n(&other.lease_ended), 0);
}

/// ② 호출 자리 안에서 패닉 — 그 멘션의 슬롯·턴 끝·임대 끝이 각 한 번(deps 가 이 호출 안에서 지어져 풀림 중 떨어진다).
#[test]
fn panic_in_call_site_releases_each_once() {
    let w = world("panic");
    let (mine, other) = (link(Read::Panic), link(Read::Error));
    let clients = AgentClients::new(&mine, "t");
    let seen = RefCell::new(Seen::default());
    let sched = Sched::default();
    let (ledger, book) = (fresh(), LeaseBook::default());
    let r = catch_unwind(AssertUnwindSafe(|| {
        call(
            &w,
            &ledger,
            &book,
            (&mine, &other),
            &clients,
            sched.clone(),
            &seen,
            false,
        )
    }));
    assert!(r.is_err(), "패닉이 났다");

    assert_eq!(got(&mine.leased), ["m7"], "임대는 받았었다");
    assert_eq!(
        got(&sched.0),
        ["slot c:t", "ended c:t m7"],
        "패닉에도 슬롯 → 턴 끝, 각 한 번"
    );
    assert_eq!(got(&mine.lease_ended), ["m7"], "패닉에도 임대 끝 한 번");
    assert!(book.is_empty(), "패닉 길도 장부에서 지운다");
    assert_eq!(n(&other.lease_ended), 0);
}
