//! [`LinkAdmitDeps`]·[`FenceCell`] — 임대 잃음이 그 멘션 슬롯으로 틈 없이 가는지, 손님은 묶음 하나뿐인지, 읽음은 받은 id 만인지.
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use harkroom_proto::p1::RunnerLinkResponse;
use serde_json::{Value, json};

use super::*;
use crate::link::LinkRequest;
use crate::mcp::MCP_PROTOCOL_VERSION;
use crate::mention_admit::ThreadClaimHandle;
use crate::mention_clients::AgentLink;
use crate::mention_hooks::LeaseHandoff;
use crate::mention_inputs::read_mention;
use crate::turn_attempt::LeaseNotice;
use crate::turn_attempt_account::LiveSlot;
use crate::turn_attempt_live::LiveTurn;

/// 받은 요청을 적는 링크. 임대 잡기·박동은 `claims` 차례대로 답한다(비면 200).
#[derive(Default)]
struct Link {
    http: Mutex<Vec<String>>,
    tools: Mutex<Vec<(String, Value)>>,
    claims: Mutex<VecDeque<u16>>,
}

fn link() -> &'static Link {
    Box::leak(Box::default())
}

fn lk<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Link {
    fn calls(&self) -> usize {
        lk(&self.http).len() + lk(&self.tools).len()
    }
    fn releases(&self) -> usize {
        lk(&self.http)
            .iter()
            .filter(|p| p.ends_with("/agent/thread-claims/release"))
            .count()
    }
}

impl RunnerLink for &'static Link {
    fn request(&self, req: LinkRequest) -> RunnerLinkResponse {
        match req {
            LinkRequest::Http { method, path, .. } => {
                lk(&self.http).push(format!("{method} {path}"));
                let status = if path == "/agent/thread-claims" {
                    lk(&self.claims).pop_front().unwrap_or(200)
                } else {
                    200
                };
                let body = if path == "/agent/config" {
                    json!({"instructions": "지시"})
                } else {
                    json!({"ok": true})
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
                        let p = &payload["params"];
                        lk(&self.tools).push((
                            p["name"].as_str().unwrap_or("").to_string(),
                            p["arguments"].clone(),
                        ));
                        vec![json!({"jsonrpc":"2.0","id":id,"result":{
                            "content":[{"type":"text","text": json!({"message": {"seq": 1}, "read": 1, "guide": "g"}).to_string()}], "isError": false}})]
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
    fn lease_ended(&self, _cause: &str) {}
}
impl LeaseHandoff for Link {
    fn heartbeat(&self, _cause: &str) {}
    fn lease(&self, _c: &str, _l: &str, _t: &str, _e: &str) {}
    fn lease_ended(&self, _cause: &str) {}
}
impl AgentLink for &'static Link {
    type Operator = Link;
    fn operator(&self) -> &Link {
        self
    }
}

/// 띄우기를 받기만 한다.
#[derive(Default)]
struct Launched(Vec<(String, Launch)>);
impl MentionLauncher for &mut Launched {
    fn launch(&mut self, launch: Launch, mention_id: String) {
        self.0.push((mention_id, launch));
    }
}

fn now() -> u64 {
    1_000
}

type Clients = AgentClients<&'static Link>;

fn clients(l: &'static Link) -> Arc<Clients> {
    Arc::new(AgentClients::new(l, "t"))
}

fn claims(c: &Arc<Clients>) -> ThreadClaims<Clients> {
    ThreadClaims::with_timing(Arc::clone(c), "me".into(), 90, Duration::from_millis(5))
}

fn launch_of(mention_id: &str, claim: Option<Box<dyn ThreadClaimHandle>>) -> Launch {
    Launch {
        lead_entry: json!({"id": 1, "messageId": mention_id, "reason": "mention"}),
        lead_mention: json!({"id": mention_id, "channelId": "c", "threadRootId": "root", "seq": 5}),
        bundled: vec![],
        anchor: "root".into(),
        thread_key: "c/root".into(),
        tried: 1,
        claim,
        slot_held: false,
    }
}

/// 걸린 시도가 펜스를 보는가.
fn fenced_after_bind(slot: &LiveSlot) -> bool {
    let live = Arc::new(LiveTurn::default());
    slot.bind(Some(Arc::clone(&live)));
    live.fenced_out()
}

fn wait_until(mut f: impl FnMut() -> bool) -> bool {
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(2) {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    false
}

/// security L2 ①: 잃음이 띄우기·슬롯 열기보다 먼저 와도(가장 이른 틈) 슬롯을 열 때 표지가 함께 선다.
#[test]
fn lost_before_launch_fences_the_slot_when_it_opens() {
    let slots = MentionSlots::default();
    let cell = FenceCell::new(slots.clone());
    (cell.on_lost())(); // 아직 멘션을 모른다.
    cell.bind("m1");
    assert!(!slots.is_open("m1"));
    let opened = slots.open("m1");
    assert!(fenced_after_bind(&opened.slot()), "열 때 표지가 함께 선다");
    let other = slots.open("m2");
    assert!(
        !fenced_after_bind(&other.slot()),
        "다른 멘션에는 번지지 않는다"
    );
}

/// security L2 ①: 띄운 뒤·슬롯 열기 전에 잃어도 같다. 열린 뒤에 잃으면 걸린 시도에 바로 선다.
#[test]
fn lost_between_launch_and_open_or_after_open_reaches_the_slot() {
    let slots = MentionSlots::default();
    let cell = FenceCell::new(slots.clone());
    cell.bind("m1");
    (cell.on_lost())();
    let opened = slots.open("m1");
    assert!(fenced_after_bind(&opened.slot()), "열기 전 잃음");

    let slots = MentionSlots::default();
    let cell = FenceCell::new(slots.clone());
    cell.bind("m1");
    let opened = slots.open("m1");
    let live = Arc::new(LiveTurn::default());
    opened.slot().bind(Some(Arc::clone(&live)));
    (cell.on_lost())();
    assert!(live.fenced_out(), "열린 뒤 잃음은 걸린 시도에 바로");
}

/// 시도 사이에 잃어도 다음 시도가 펜스를 본다(표지는 멘션 단위로 남는다).
#[test]
fn lost_between_attempts_reaches_the_next_attempt() {
    let slots = MentionSlots::default();
    let opened = slots.open("m1");
    let s = opened.slot();
    s.bind(Some(Arc::new(LiveTurn::default())));
    s.bind(None); // a1 끝.
    slots.fence_lost_or_hold("m1");
    assert!(fenced_after_bind(&s), "a2 가 걸리면 바로 펜스");
    assert!(s.stop_requested());
}

/// 열지 못하고 끝난 멘션의 대기 표지는 지우면 다음 시도(새 임대)에 남지 않는다.
#[test]
fn forgotten_pending_fence_does_not_reach_a_later_open() {
    let slots = MentionSlots::default();
    slots.fence_lost_or_hold("m1");
    slots.forget_pending_fence("m1");
    let opened = slots.open("m1");
    assert!(!fenced_after_bind(&opened.slot()));
}

/// security L2 ① + ②: 실물 deps 로 잡은 임대가 박동에서 409 를 받으면 그 멘션 슬롯에 펜스가 서고, `on_lost` 는 놓지 않는다
/// (놓기 요청 0건 — 박동 시계 스레드 안에서 놓으면 교착). 놓기는 손잡이를 놓을 때 한 번.
#[test]
fn heartbeat_taken_fences_that_mention_and_does_not_release() {
    let l = link();
    lk(&l.claims).extend([200, 409]); // 잡기 200, 첫 박동 409.
    let c = clients(l);
    let tc = claims(&c);
    let slots = MentionSlots::default();
    let mut got = Launched::default();
    let mut deps = LinkAdmitDeps::new(&c, &tc, slots.clone(), now, &mut got);
    let ClaimHold::Held(claim) = deps.hold_claim("c", "root") else {
        panic!("잡혀야 한다")
    };
    deps.launch(launch_of("m1", Some(claim)));
    drop(deps);
    let (mid, launch) = got.0.pop().unwrap();
    assert_eq!(mid, "m1");
    let claim = launch.claim.as_ref().unwrap();
    assert!(wait_until(|| claim.fenced()), "박동 409 → 잃음");
    let opened = slots.open("m1");
    assert!(fenced_after_bind(&opened.slot()), "열 때 표지가 선다");
    assert_eq!(l.releases(), 0, "on_lost 는 놓지 않는다");
    claim.release();
    assert_eq!(l.releases(), 1);
}

/// 잡기 뒤 띄우기 전에 잃음을 이미 알고 있으면(손잡이 `fenced`) 띄울 때 표지를 세운다.
#[test]
fn launch_of_an_already_fenced_claim_fences_on_open() {
    struct Lost;
    impl ThreadClaimHandle for Lost {
        fn release(&self) {}
        fn fenced(&self) -> bool {
            true
        }
    }
    let l = link();
    let c = clients(l);
    let tc = claims(&c);
    let slots = MentionSlots::default();
    let mut got = Launched::default();
    let mut deps = LinkAdmitDeps::new(&c, &tc, slots.clone(), now, &mut got);
    deps.launch(launch_of("m1", Some(Box::new(Lost))));
    let opened = slots.open("m1");
    assert!(fenced_after_bind(&opened.slot()));
}

/// security L2 ⑤: 읽음 처리는 받은 id 만 — `inbox.read` 한 번, 그 id 들만.
#[test]
fn mark_read_sends_only_the_given_ids() {
    let l = link();
    let c = clients(l);
    let tc = claims(&c);
    let mut got = Launched::default();
    let mut deps = LinkAdmitDeps::new(&c, &tc, MentionSlots::default(), now, &mut got);
    deps.mark_read(&[7, 9]).unwrap();
    let reads: Vec<Value> = lk(&l.tools)
        .iter()
        .filter(|(n, _)| n == "inbox.read")
        .map(|(_, a)| a.clone())
        .collect();
    assert_eq!(reads, vec![json!({"ids": [7, 9]})]);
}

/// security L2 ③: 손님은 묶음에서만 — 받아들이기의 서버 일과 `read_mention` 은 그 묶음 링크로만 가고, 다른 링크에는 0건.
#[test]
fn deps_and_read_mention_use_only_the_bundle_link() {
    let (mine, other) = (link(), link());
    let _other_bundle = clients(other); // 지어 두기만 한다 — 아무 데도 넘기지 않는다.
    let c = clients(mine);
    let tc = claims(&c);
    let mut got = Launched::default();
    let mut deps = LinkAdmitDeps::new(&c, &tc, MentionSlots::default(), now, &mut got);
    deps.notice("c", "root", &AdmitNotice::BlockedByTurn)
        .unwrap();
    deps.fail("c", "root", "본문", "w", "r").unwrap();
    assert!(deps.acquire_slot("c/root").is_some());
    deps.release_slot("c/root");
    let ClaimHold::Held(claim) = deps.hold_claim("c", "root") else {
        panic!("잡혀야 한다")
    };
    claim.release();
    deps.mark_read(&[1]).unwrap();
    drop(deps);
    let target = crate::mention_target::build_mention_target(
        &json!({"id": 1, "reason": "mention"}),
        &json!({"id": "m1", "channelId": "c", "threadRootId": "root"}),
        "root",
        &[],
    );
    assert!(read_mention(&c, &target).is_ok());
    assert!(mine.calls() > 0);
    assert_eq!(other.calls(), 0, "다른 링크에는 한 건도 가지 않는다");
    let http = lk(&mine.http).clone();
    assert!(http.contains(&"GET /agent/config".to_string()), "{http:?}");
}

/// 옛 서버: 잃을 임대가 없다 — 띄우기는 그대로, 표지는 서지 않는다.
#[test]
fn unsupported_claim_still_launches_unfenced() {
    let l = link();
    lk(&l.claims).push_back(404);
    let c = clients(l);
    let tc = claims(&c);
    let slots = MentionSlots::default();
    let mut got = Launched::default();
    let mut deps = LinkAdmitDeps::new(&c, &tc, slots.clone(), now, &mut got);
    let ClaimHold::Held(claim) = deps.hold_claim("c", "root") else {
        panic!("옛 서버도 잡힌 것으로")
    };
    deps.launch(launch_of("m1", Some(claim)));
    drop(deps);
    assert_eq!(got.0.len(), 1);
    let opened = slots.open("m1");
    assert!(!fenced_after_bind(&opened.slot()));
}

/// 실물 띄우개: 멘션마다 스레드 하나로 몸통을 부르고, 끝나면(패닉 포함) 그 멘션의 대기 펜스 표지를 지운다.
#[test]
fn thread_launcher_runs_each_mention_and_clears_its_pending_fence() {
    let slots = MentionSlots::default();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let tx = Mutex::new(tx);
    let mut tl = ThreadLauncher::new(slots.clone(), move |launch: Launch, m: &str| {
        let _ = lk(&tx).send(format!("{m}:{}", launch.lead_id()));
        if m == "boom" {
            panic!("몸통 패닉(시험)");
        }
    });
    slots.fence_lost_or_hold("m1");
    slots.fence_lost_or_hold("boom");
    tl.launch(launch_of("m1", None), "m1".into());
    tl.launch(launch_of("boom", None), "boom".into());
    let mut seen = vec![
        rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        rx.recv_timeout(Duration::from_secs(2)).unwrap(),
    ];
    seen.sort();
    assert_eq!(seen, vec!["boom:1".to_string(), "m1:1".to_string()]);
    // 몸통이 돌아온 뒤(패닉 포함) 지운다 — 다음 시도의 슬롯에는 남지 않는다.
    assert!(wait_until(|| {
        !slots.has_pending_fence("m1") && !slots.has_pending_fence("boom")
    }));
}
