use super::*;
use crate::assignments::AssignmentOptions;
use crate::forward::HttpReply;
use harkroom_proto::p2::CredentialScope;
use serde_json::json;

#[derive(Default)]
struct Fake {
    spawns: Mutex<Vec<(String, String)>>,
    expects: Mutex<Vec<(String, String)>>,
    restarts_seen: Mutex<u32>,
    owner: Mutex<Option<String>>,
    alive: Mutex<bool>,
}

impl AssignmentDeps for Fake {
    fn spawn(
        &self,
        agent_id: &str,
        _env: &BTreeMap<String, String>,
        runner_id: &str,
    ) -> Result<SpawnResult, SpawnError> {
        lock(&self.spawns).push((agent_id.into(), runner_id.into()));
        *lock(&self.alive) = true;
        Ok(SpawnResult {
            spawned: true,
            pid: 42,
            runner_id: runner_id.into(),
        })
    }
    fn signal(&self, _agent_id: &str, _sig: Sig) -> bool {
        *lock(&self.restarts_seen) += 1;
        *lock(&self.alive) = false;
        true
    }
    fn is_alive(&self, _agent_id: &str) -> bool {
        *lock(&self.alive)
    }
    fn list_runners(&self) -> Vec<Value> {
        vec![]
    }
    fn link_expect(&self, r: &str, a: &str, _s: &str) {
        lock(&self.expects).push((r.into(), a.into()));
    }
    fn link_forget(&self, _r: &str) {}
    fn operator_owner_id(&self) -> Option<String> {
        lock(&self.owner).clone()
    }
    fn mcp_config(&self, _d: &AgentDefinition) -> Result<String, Vec<String>> {
        Ok("/cfg/mcp.json".into())
    }
    fn schedule(&self, _task: Task, _ms: u64) -> Cancel {
        Box::new(|| {})
    }
    fn log(&self, _line: &str) {}
    fn now_ms(&self) -> u64 {
        0
    }
}

fn def(id: &str, scope: CredentialScope, owner: Option<&str>) -> AgentDefinition {
    AgentDefinition {
        agent_id: id.into(),
        handle: "bot".into(),
        harness: "claude".into(),
        instructions: String::new(),
        model: None,
        effort: None,
        mention_permission: "anyone".into(),
        working_dir_default: None,
        credential_scope: scope,
        owner_account_id: owner.map(str::to_string),
        mcp_servers: vec![],
    }
}

type Sent = Arc<Mutex<Vec<OperatorToServerFrame>>>;

fn setup() -> (Arc<Fake>, Arc<AssignmentFrames>, Sent) {
    let f = Arc::new(Fake::default());
    let r = AssignmentReconciler::new(f.clone(), AssignmentOptions::new("/run/op.sock", "/bin/op"));
    let sent: Sent = Arc::default();
    let s2 = Arc::clone(&sent);
    let frames = AssignmentFrames::start(
        r,
        "https://h.example".into(),
        Arc::new(move |fr| {
            lock(&s2).push(fr);
            true
        }),
        Box::new(|| "notice-id".into()),
    );
    (f, frames, sent)
}

fn assign(d: AgentDefinition) -> ServerToOperatorFrame {
    ServerToOperatorFrame::Assign {
        agent_id: d.agent_id.clone(),
        definition: d,
    }
}

const WAIT: Duration = Duration::from_secs(5);

#[test]
fn assign_needs_local_consent_then_spawns_with_expected_id() {
    let (f, frames, sent) = setup();
    let none = |_: &str| None;
    assert!(frames.on_frame(&assign(def("a1", CredentialScope::Community, None)), &none));
    assert!(frames.flush(WAIT));
    assert!(
        lock(&f.spawns).is_empty(),
        "로컬 설정에 없으면 띄우지 않는다"
    );
    assert!(!frames.is_assigned("a1"));

    let some = |_: &str| Some(LocalAgent::default());
    frames.on_frame(&assign(def("a1", CredentialScope::Community, None)), &some);
    assert!(frames.flush(WAIT));
    let spawns = lock(&f.spawns).clone();
    assert_eq!(spawns.len(), 1);
    // 링크에 적은 id 와 띄운 id 가 같다(#1890).
    assert_eq!(lock(&f.expects)[0], (spawns[0].1.clone(), "a1".into()));
    assert!(frames.is_assigned("a1"));
    assert!(lock(&sent).is_empty());
}

#[test]
fn frame_agent_must_match_definition_agent() {
    let (f, frames, sent) = setup();
    // a1 은 로컬 설정에 있다 — 그러나 정의는 b2 다. a1 의 동의로 b2 를 띄우면 안 된다(security #1892).
    let local = |id: &str| (id == "a1").then(LocalAgent::default);
    let frame = ServerToOperatorFrame::Assign {
        agent_id: "a1".into(),
        definition: def("b2", CredentialScope::Community, None),
    };
    assert!(frames.on_frame(&frame, &local));
    assert!(frames.flush(WAIT));
    assert!(lock(&f.spawns).is_empty());
    assert!(!frames.is_assigned("a1"));
    assert!(!frames.is_assigned("b2"));
    assert!(lock(&sent).is_empty());
}

#[test]
fn refused_assign_tells_server_with_reason() {
    let (f, frames, sent) = setup();
    *lock(&f.owner) = Some("me".into());
    let some = |_: &str| Some(LocalAgent::default());
    frames.on_frame(
        &assign(def("a2", CredentialScope::Personal, Some("someone-else"))),
        &some,
    );
    assert!(frames.flush(WAIT));
    assert!(lock(&f.spawns).is_empty());
    assert!(!frames.is_assigned("a2"));
    let sent = lock(&sent).clone();
    assert_eq!(sent.len(), 1);
    match &sent[0] {
        OperatorToServerFrame::RunnerExited {
            runner_id,
            code,
            reason,
            agent_id,
        } => {
            assert_eq!(runner_id, "notice-id");
            assert_eq!(*code, None);
            assert!(reason.as_deref().is_some_and(|r| !r.is_empty()));
            assert_eq!(agent_id.as_deref(), Some("a2"));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn restart_runs_after_preceding_assign_and_unassign_stops_exit_routing() {
    let (f, frames, _sent) = setup();
    let some = |_: &str| Some(LocalAgent::default());
    frames.on_frame(&assign(def("a1", CredentialScope::Community, None)), &some);
    // 같은 큐 — assign 이 끝난 뒤에 restart 가 돈다(TS assignsInFlight).
    frames.on_frame(
        &ServerToOperatorFrame::AgentRestart {
            agent_id: "a1".into(),
        },
        &some,
    );
    assert!(frames.flush(WAIT));
    assert!(
        *lock(&f.restarts_seen) >= 1,
        "restart 가 러너에 SIGTERM 을 보냈다"
    );

    frames.on_frame(
        &ServerToOperatorFrame::Unassign {
            agent_id: "a1".into(),
            drain: false,
        },
        &some,
    );
    assert!(!frames.is_assigned("a1"));
    assert!(frames.flush(WAIT));
    // 배정이 아니면 종료를 조정기로 넘기지 않는다(넘겨도 조정기가 거르지만 여기서 먼저 거른다).
    frames.on_runner_exit("a1", Some(1), None);
}

#[test]
fn other_frames_are_not_taken() {
    let (_f, frames, _sent) = setup();
    let none = |_: &str| None;
    assert!(!frames.on_frame(
        &ServerToOperatorFrame::RunnerKill {
            runner_id: "r".into()
        },
        &none
    ));
}

#[test]
fn owner_cell_waits_and_times_out() {
    let c = Arc::new(OwnerCell::default());
    assert_eq!(
        c.wait(Duration::from_millis(20)),
        None,
        "읽는 중이면 시한 뒤 모른다"
    );
    let c2 = Arc::clone(&c);
    let h = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(30));
        c2.set(Some("o1".into()));
    });
    assert_eq!(c.wait(WAIT), Some("o1".into()));
    h.join().unwrap();
    c.set(None);
    assert_eq!(c.wait(WAIT), None, "답이 「없음」이면 바로 None");
    c.begin();
    assert_eq!(c.wait(Duration::from_millis(10)), None);
}

type Seen = Vec<(String, String, Vec<(String, String)>)>;

struct FakeHttp {
    status: u16,
    body: String,
    seen: Mutex<Seen>,
}

impl Transport for FakeHttp {
    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        _b: Option<Vec<u8>>,
    ) -> Result<HttpReply, String> {
        lock(&self.seen).push((method.into(), url.into(), headers.to_vec()));
        Ok(HttpReply {
            status: self.status,
            content_type: "application/json".into(),
            body: self.body.clone(),
        })
    }
}

#[test]
fn read_self_reads_owner_only_on_success() {
    let ok = FakeHttp {
        status: 200,
        body: json!({"id": "op1", "ownerAccountId": "acc1"}).to_string(),
        seen: Mutex::default(),
    };
    let tok = "x".repeat(16);
    assert_eq!(
        read_self(&ok, "https://h.example/", &tok),
        Some("acc1".into())
    );
    let seen = lock(&ok.seen).clone();
    assert_eq!(seen[0].0, "GET");
    assert_eq!(seen[0].1, "https://h.example/operators/self");
    assert_eq!(
        seen[0].2,
        vec![("authorization".to_string(), format!("Bearer {tok}"))]
    );
    let denied = FakeHttp {
        status: 401,
        body: "{}".into(),
        seen: Mutex::default(),
    };
    assert_eq!(read_self(&denied, "https://h.example", &tok), None);
    let shape = FakeHttp {
        status: 200,
        body: json!({"ownerAccountId": 7}).to_string(),
        seen: Mutex::default(),
    };
    assert_eq!(read_self(&shape, "https://h.example", &tok), None);
}

#[test]
fn local_agent_of_maps_fields() {
    let l =
        local_agent_of(&json!({"workingDir": "/w", "claudePool": "p", "providerLane": {"x": 1}}));
    assert_eq!(l.working_dir.as_deref(), Some("/w"));
    assert_eq!(l.claude_pool.as_deref(), Some("p"));
    assert_eq!(l.provider_lane, Some(json!({"x": 1})));
    assert_eq!(local_agent_of(&json!({})), LocalAgent::default());
}

#[test]
fn scheduled_task_runs_unless_cancelled() {
    let hit = Arc::new(AtomicBool::new(false));
    let h = Arc::clone(&hit);
    let _keep = schedule_thread(Box::new(move || h.store(true, Ordering::SeqCst)), 10);
    let miss = Arc::new(AtomicBool::new(false));
    let m = Arc::clone(&miss);
    let cancel = schedule_thread(Box::new(move || m.store(true, Ordering::SeqCst)), 30);
    cancel();
    std::thread::sleep(Duration::from_millis(120));
    assert!(hit.load(Ordering::SeqCst));
    assert!(!miss.load(Ordering::SeqCst));
}

#[test]
fn agent_entry_reads_only_this_community() {
    let root = std::env::temp_dir().join(format!("hkr-comm-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("operator")).unwrap();
    std::fs::write(
        root.join("operator").join("operator.json"),
        json!({
            "commandHook": true,
            "communities": {
                "https://h.example": { "agents": { "a1": { "workingDir": "/w" } } },
                "https://other.example": { "agents": { "a2": {} } },
            }
        })
        .to_string(),
    )
    .unwrap();
    let la = LocalAgents::new(root.to_str().unwrap(), "https://h.example");
    assert_eq!(la.agent_entry("a1"), Some(json!({ "workingDir": "/w" })));
    assert_eq!(
        la.agent_entry("a2"),
        None,
        "다른 커뮤니티의 칸은 동의가 아니다"
    );
    assert_eq!(la.agent_entry("zz"), None);
    let _ = std::fs::remove_dir_all(&root);
}

/// ①b(s21c-2c-1b-2) — `assign.synced` 는 받은 목록 ∪ 이 연결의 assign, 연결이 바뀌면 지운다, 모양이 틀리면 못 받음.
#[test]
fn assign_synced_keeps_list_plus_link_assigns_and_resets() {
    let (_f, frames, _sent) = setup();
    let none = |_: &str| None;
    assert_eq!(frames.synced_keep(), None);
    // 로컬에 없어 거절된 assign 도 남길 것에는 든다 — 회수 길로 죽이지 않는다.
    frames.on_frame(
        &assign(def("stranger", CredentialScope::Community, None)),
        &none,
    );
    assert!(frames.on_frame(
        &ServerToOperatorFrame::AssignSynced {
            agent_ids: vec!["a1".into()]
        },
        &none
    ));
    let k = frames.synced_keep().unwrap();
    assert!(k.contains("a1") && k.contains("stranger"));
    frames.on_frame(
        &assign(def("late", CredentialScope::Community, None)),
        &none,
    );
    assert!(frames.synced_keep().unwrap().contains("late"));
    frames.reset_synced();
    assert_eq!(frames.synced_keep(), None);
    // 다시 붙은 뒤 앞 연결의 assign 은 남지 않는다.
    frames.on_frame(
        &ServerToOperatorFrame::AssignSynced { agent_ids: vec![] },
        &none,
    );
    assert!(frames.synced_keep().unwrap().is_empty());
    // 모양이 틀리면 버리고 못 받음 그대로.
    frames.reset_synced();
    for bad in [vec![String::new()], vec!["x".repeat(65)]] {
        frames.on_frame(
            &ServerToOperatorFrame::AssignSynced { agent_ids: bad },
            &none,
        );
        assert_eq!(frames.synced_keep(), None);
    }
}
