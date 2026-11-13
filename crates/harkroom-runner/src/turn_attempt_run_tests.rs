use std::fs;
use std::sync::Mutex;

use harkroom_proto::p1::RunnerLinkResponse;
use serde_json::{Value, json};

use super::*;
use crate::link::LinkRequest;
use crate::mention_target::build_mention_target;
use crate::pty_turn::TurnResult;
use crate::rest::{TURN_KEYS_END_PATH, TURN_KEYS_PATH};

type Log = Arc<Mutex<Vec<String>>>;

fn push(log: &Log, s: String) {
    log.lock().unwrap().push(s);
}

/// 서버 길 — 열쇠 맡기기·거두기를 턴 id 와 함께 적는다.
struct Link(Log);

impl RunnerLink for &Link {
    fn request(&self, req: LinkRequest) -> RunnerLinkResponse {
        let LinkRequest::Http { path, body, .. } = req else {
            panic!("mcp")
        };
        let turn: Value = serde_json::from_str(body.as_deref().unwrap_or("{}")).unwrap();
        let id = turn["turnId"].as_str().unwrap_or("?").to_string();
        let tag = match path.as_str() {
            TURN_KEYS_PATH => "keys",
            TURN_KEYS_END_PATH => "keys_end",
            _ => "other",
        };
        push(&self.0, format!("{tag} {id}"));
        RunnerLinkResponse::HttpResponse {
            id: "x".into(),
            status: 200,
            body: "{}".into(),
        }
    }
}

/// 임대 끝 — 오퍼레이터처럼 임대 디렉터리를 지운다.
struct Notice {
    log: Log,
    lease: PathBuf,
}

impl LeaseNotice for Notice {
    fn lease_ended(&self, cause: &str) {
        push(&self.log, format!("lease_ended {cause}"));
        let _ = fs::remove_dir_all(&self.lease);
    }
}

/// 시도마다 본 것.
#[derive(Default)]
struct Seen {
    turn_id: String,
    keys: Option<(String, String)>,
    mcp_path: PathBuf,
    /// 이 시도를 준비할 때 앞 시도의 턴 설정 파일이 이미 지워졌나.
    prev_file_gone: Option<bool>,
}

struct Parts {
    log: Log,
    lease: PathBuf,
    secrets: bool,
    /// 시도마다 하네스 종료 코드(앞에서부터).
    exits: Vec<i32>,
    bound: Option<Arc<LiveTurn>>,
    lives: Vec<Arc<LiveTurn>>,
    seen: Vec<Seen>,
    needles_had_secret: Vec<bool>,
    /// 띄우기 도중 패닉한다.
    panic_spawn: bool,
    /// 띄울 때 받은 lane env 표지.
    lane_envs: Vec<Option<String>>,
    /// 걸자마자 사람이 [중단] 한다.
    cancel_on_bind: bool,
    /// 듣기를 놓는 순간 중계 세션에 입력을 넣어 본다(그때 입력 통로가 이미 놓였나).
    probe_on_unbind: Option<(Arc<RelaySessions>, String)>,
    /// 중계 세션이 있으면 띄울 때 이 PTY 를 잇는다.
    pty: Option<Arc<RelayPty>>,
    /// 띄울 때 받은 감시용 가림 목록에 마운트한 비밀·PAT 가 있었나.
    spawn_notice: Vec<bool>,
}

const SECRET: &str = "sk-live-rrrrrrrrrrrrrrrrrrrrrrrrrr";

impl AttemptParts for Parts {
    fn bind_live(&mut self, live: Option<Arc<LiveTurn>>) {
        push(
            &self.log,
            if live.is_some() { "bind" } else { "unbind" }.into(),
        );
        if live.is_none()
            && let Some((relay, sid)) = &self.probe_on_unbind
        {
            push(&self.log, "probe".into());
            relay_input(relay, sid, b"probe");
        }
        if let Some(l) = &live {
            self.lives.push(Arc::clone(l));
            if self.cancel_on_bind {
                l.cancel("human-1");
            }
        }
        self.bound = live;
    }

    fn prepare(
        &mut self,
        _t: &MentionTarget,
        account: Option<&ClaudeAccount>,
        _last: bool,
        turn_id: &str,
    ) -> AttemptPrep {
        push(
            &self.log,
            format!(
                "prepare {turn_id} {}",
                account.map(|a| a.name.as_str()).unwrap_or("-")
            ),
        );
        let prev_file_gone = self.seen.last().map(|s| !s.mcp_path.exists());
        self.seen.push(Seen {
            turn_id: turn_id.into(),
            prev_file_gone,
            ..Seen::default()
        });
        AttemptPrep {
            key: "k".into(),
            cause: "m1".into(),
            secrets: self.secrets,
            lease_dir: Some(self.lease.clone()),
            session_id: None,
            homes: OwnedHomes::default(),
        }
    }

    fn mount_secrets(&mut self, cause: &str) -> Result<(), SecretMountError> {
        push(&self.log, format!("mount {cause}"));
        fs::create_dir_all(&self.lease).unwrap();
        fs::write(self.lease.join("secret-1"), SECRET).unwrap();
        Ok(())
    }

    fn spawn(&mut self, args: SpawnArgs<'_>, delivered: &mut bool) -> PtyOut {
        let SpawnArgs {
            turn_id,
            keys,
            mcp_config_path,
            lane_env,
            notice,
            relay,
        } = args;
        push(&self.log, format!("spawn {turn_id}"));
        self.lane_envs.push(lane_env.get("HK_LANE").cloned());
        if let (Some(r), Some(pty)) = (relay, &self.pty) {
            r.session().bind_input(pty.clone());
        }
        self.spawn_notice.push(
            notice.mounted.iter().any(|n| n == SECRET) && notice.pat == "hk_pat_secret_value_88",
        );
        assert!(!self.panic_spawn, "띄우기 도중 패닉");
        let s = self.seen.last_mut().unwrap();
        assert_eq!(s.turn_id, turn_id);
        s.keys = keys.map(|k| (k.bridge.clone(), k.shell.clone()));
        s.mcp_path = mcp_config_path.to_path_buf();
        assert!(
            mcp_config_path.exists(),
            "띄울 때 이 시도의 설정 파일이 있다"
        );
        *delivered = true;
        let code = self.exits.remove(0);
        Ok(TurnResult {
            exit_code: code,
            timed_out: false,
            tail: String::new(),
        })
    }

    fn outcome(
        &mut self,
        attempted: Attempted<PtyOut>,
        secrets: &TurnSecrets,
        live: &LiveTurn,
    ) -> Result<TurnOk, AttemptError> {
        push(&self.log, "outcome".into());
        assert!(
            Arc::ptr_eq(
                self.bound.as_ref().unwrap(),
                &self.lives[self.lives.len() - 1]
            ) && std::ptr::eq(live, Arc::as_ptr(self.bound.as_ref().unwrap())),
            "결과 접기는 이 시도의 LiveTurn 을 본다"
        );
        self.needles_had_secret
            .push(secrets.needles().iter().any(|n| n == SECRET));
        match attempted {
            Attempted::Ran(Ok(r)) if r.exit_code == 0 => Ok(TurnOk::default()),
            Attempted::Blocked(_) => Err(AttemptError {
                message: "blocked".into(),
                ..AttemptError::default()
            }),
            _ => Err(AttemptError {
                message: "fail".into(),
                ..AttemptError::default()
            }),
        }
    }

    fn after(&mut self, _s: &TurnSecrets) -> Result<(), String> {
        push(&self.log, "after".into());
        Ok(())
    }
}

struct World {
    root: PathBuf,
    mcp: PathBuf,
    lease: PathBuf,
    env: BTreeMap<String, String>,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn world(tag: &str) -> World {
    let root = std::env::temp_dir().join(format!("hk-attempt-run-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let mcp = root.join("mcp.json");
    fs::write(
        &mcp,
        json!({ "mcpServers": { "harkroom": { "command": "/bin/harkroom-operator", "args": ["mcp"], "env": {} } } })
            .to_string(),
    )
    .unwrap();
    World {
        lease: root.join("lease"),
        root,
        mcp,
        env: BTreeMap::new(),
    }
}

fn parts(w: &World, log: &Log, secrets: bool, exits: Vec<i32>) -> Parts {
    Parts {
        log: Arc::clone(log),
        lease: w.lease.clone(),
        secrets,
        exits,
        bound: None,
        lives: Vec::new(),
        seen: Vec::new(),
        needles_had_secret: Vec::new(),
        panic_spawn: false,
        lane_envs: Vec::new(),
        cancel_on_bind: false,
        probe_on_unbind: None,
        pty: None,
        spawn_notice: Vec::new(),
    }
}

fn attempt<'a>(
    w: &'a World,
    client: &'a HarkroomRestClient<&'a Link>,
    notice: &'a Notice,
    can_keys: bool,
    p: Parts,
) -> PtyTurnAttempt<'a, &'a Link, Notice, Parts> {
    let mut n = 0;
    PtyTurnAttempt {
        client,
        notice,
        harness: AgentHarness::ClaudeCode,
        can_register_turn_keys: can_keys,
        state_dir: &w.root,
        mcp_config_path: &w.mcp,
        runner_env: &w.env,
        pat: "hk_pat_secret_value_88",
        new_turn_id: Box::new(move || {
            n += 1;
            format!("t-{n}")
        }),
        parts: RefCell::new(p),
        relay: None,
        lane: None,
    }
}

fn target() -> MentionTarget {
    let m = json!({ "id": "m1", "channelId": "c1", "body": "사유", "seq": 9, "meta": null });
    build_mention_target(&json!({ "id": "e1" }), &m, "root", &[])
}

fn account(name: &str) -> ClaudeAccount {
    ClaudeAccount {
        name: name.into(),
        config_dir: PathBuf::from("/nonexistent").join(name),
        pool: None,
    }
}

fn pos(log: &[String], item: &str) -> usize {
    log.iter()
        .position(|s| s == item)
        .unwrap_or_else(|| panic!("{item} 없음: {log:?}"))
}

/// security: 계정을 바꿔 다시 부를 때 시도마다 턴 id·열쇠·턴 설정 파일·`LiveTurn` 을 새로 만들고, 다음 시도는 앞 시도의
/// 정리(열쇠 거두기·임대 끝·설정 파일 지우기·듣기 놓기)가 끝난 **뒤에** 시작한다.
#[test]
fn account_retry_gets_fresh_attempt_after_previous_cleanup() {
    let w = world("retry");
    let log: Log = Log::default();
    let link = Link(Arc::clone(&log));
    let client = HarkroomRestClient::new(&link);
    let notice = Notice {
        log: Arc::clone(&log),
        lease: w.lease.clone(),
    };
    let mut a = attempt(
        &w,
        &client,
        &notice,
        true,
        parts(&w, &log, true, vec![1, 0]),
    );
    let t = target();
    let (acc1, acc2) = (account("a1"), account("a2"));

    let mut d1 = false;
    let r1 = a.run(&t, Some(&acc1), false, &mut d1);
    assert_eq!(r1.unwrap_err().message, "fail");
    let mut d2 = false;
    let r2 = a.run(&t, Some(&acc2), true, &mut d2);
    assert!(r2.is_ok());
    assert!(d1 && d2);

    let log = log.lock().unwrap().clone();
    assert_eq!(
        log,
        [
            "bind",
            "prepare t-1 a1",
            "keys t-1",
            "mount m1",
            "spawn t-1",
            "lease_ended m1",
            "keys_end t-1",
            "outcome",
            "unbind",
            "bind",
            "prepare t-2 a2",
            "keys t-2",
            "mount m1",
            "spawn t-2",
            "lease_ended m1",
            "keys_end t-2",
            "outcome",
            "after",
            "unbind",
        ]
    );
    assert!(pos(&log, "keys_end t-1") < pos(&log, "prepare t-2 a2"));

    let p = a.parts.borrow();
    let (s1, s2) = (&p.seen[0], &p.seen[1]);
    assert_eq!((s1.turn_id.as_str(), s2.turn_id.as_str()), ("t-1", "t-2"));
    let (k1, k2) = (s1.keys.clone().unwrap(), s2.keys.clone().unwrap());
    assert!(k1.0 != k2.0 && k1.1 != k2.1, "열쇠를 다시 쓰지 않는다");
    assert_ne!(s1.mcp_path, s2.mcp_path, "턴 설정 파일을 다시 쓰지 않는다");
    assert_eq!(
        s2.prev_file_gone,
        Some(true),
        "다음 준비 전에 앞 설정 파일이 지워졌다"
    );
    assert!(!s2.mcp_path.exists());
    assert!(
        !Arc::ptr_eq(&p.lives[0], &p.lives[1]),
        "LiveTurn 을 새로 만든다"
    );
    assert!(p.bound.is_none(), "끝나면 듣기를 놓는다");
    assert_eq!(
        p.needles_had_secret,
        [true, true],
        "시도마다 마운트 뒤 목록"
    );
}

/// 앞 시도의 펜스 잃음·[중단] 이 다음 시도를 막지 않는다(새 `LiveTurn`) · 이 시도의 [중단] 은 이 시도를 막는다.
#[test]
fn previous_live_does_not_leak_into_next_attempt() {
    let w = world("live");
    let log: Log = Log::default();
    let link = Link(Arc::clone(&log));
    let client = HarkroomRestClient::new(&link);
    let notice = Notice {
        log: Arc::clone(&log),
        lease: w.lease.clone(),
    };
    let mut a = attempt(
        &w,
        &client,
        &notice,
        true,
        parts(&w, &log, false, vec![1, 0]),
    );
    let t = target();
    let mut d = false;
    assert!(a.run(&t, None, false, &mut d).is_err());
    {
        let p = a.parts.borrow();
        p.lives[0].fence_lost();
        p.lives[0].cancel("human-1");
    }
    let mut d = false;
    assert!(a.run(&t, None, true, &mut d).is_ok());
    assert!(log.lock().unwrap().iter().any(|s| s == "spawn t-2"));
}

/// 턴 MCP 설정을 못 만들면 띄우지 않고 고정 문장으로 접는다(경로 없음) · 듣기는 놓는다.
#[test]
fn turn_mcp_failure_folds_to_fixed_message() {
    let w = world("mcpfail");
    fs::remove_file(&w.mcp).unwrap();
    let log: Log = Log::default();
    let link = Link(Arc::clone(&log));
    let client = HarkroomRestClient::new(&link);
    let notice = Notice {
        log: Arc::clone(&log),
        lease: w.lease.clone(),
    };
    let mut a = attempt(&w, &client, &notice, true, parts(&w, &log, true, vec![0]));
    let mut d = false;
    let e = a.run(&target(), None, true, &mut d).unwrap_err();
    assert_eq!(e.message, TURN_MCP_FAILED);
    assert!(!e.message.contains(w.root.to_str().unwrap()));
    assert_eq!(*log.lock().unwrap(), ["bind", "prepare t-1 -", "unbind"]);
    assert!(!d);
}

/// 열쇠를 맡길 길이 없으면 열쇠 단계 없이 기본 MCP 설정으로 띄운다.
#[test]
fn without_turn_keys_uses_base_config() {
    let w = world("nokeys");
    let log: Log = Log::default();
    let link = Link(Arc::clone(&log));
    let client = HarkroomRestClient::new(&link);
    let notice = Notice {
        log: Arc::clone(&log),
        lease: w.lease.clone(),
    };
    let mut a = attempt(&w, &client, &notice, false, parts(&w, &log, false, vec![0]));
    let mut d = false;
    assert!(a.run(&target(), None, true, &mut d).is_ok());
    assert_eq!(
        *log.lock().unwrap(),
        [
            "bind",
            "prepare t-1 -",
            "spawn t-1",
            "outcome",
            "after",
            "unbind"
        ]
    );
    let p = a.parts.borrow();
    assert!(p.seen[0].keys.is_none());
    assert_eq!(p.seen[0].mcp_path, w.mcp);
    assert!(w.mcp.exists(), "기본 설정은 지우지 않는다");
}

/// security nit ①: 띄우기 도중 패닉해도 이 시도의 `LiveTurn` 듣기를 놓는다(drop 가드).
#[test]
fn panic_during_spawn_still_unbinds_live() {
    let w = world("panic");
    let log: Log = Log::default();
    let link = Link(Arc::clone(&log));
    let client = HarkroomRestClient::new(&link);
    let notice = Notice {
        log: Arc::clone(&log),
        lease: w.lease.clone(),
    };
    let mut p = parts(&w, &log, false, vec![0]);
    p.panic_spawn = true;
    let mut a = attempt(&w, &client, &notice, true, p);
    let t = target();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut d = false;
        let _ = a.run(&t, None, true, &mut d);
    }));
    assert!(r.is_err(), "패닉이 밖으로 나온다");
    let log = log.lock().unwrap().clone();
    assert_eq!(log.last().map(String::as_str), Some("unbind"), "{log:?}");
    assert!(a.parts.borrow().bound.is_none(), "듣기를 놓았다");
    assert!(
        log.iter().any(|s| s == "keys_end t-1"),
        "열쇠도 거뒀다: {log:?}"
    );
}

/// security nit ②: 실물 생성자의 턴 id 는 시도마다 새로 뽑은 무작위 v4 다(카운터·고정값 아님).
#[test]
fn real_constructor_draws_random_v4_turn_ids() {
    let w = world("uuid");
    let log: Log = Log::default();
    let link = Link(Arc::clone(&log));
    let client = HarkroomRestClient::new(&link);
    let notice = Notice {
        log: Arc::clone(&log),
        lease: w.lease.clone(),
    };
    let mut a = PtyTurnAttempt::new(
        AttemptBase {
            client: &client,
            notice: &notice,
            harness: AgentHarness::ClaudeCode,
            can_register_turn_keys: true,
            state_dir: &w.root,
            mcp_config_path: &w.mcp,
            runner_env: &w.env,
            pat: "hk_pat_secret_value_88",
        },
        parts(&w, &log, false, vec![0, 0, 0]),
    );
    let t = target();
    for _ in 0..3 {
        let mut d = false;
        assert!(a.run(&t, None, true, &mut d).is_ok());
    }
    let ids: Vec<String> = a
        .parts
        .borrow()
        .seen
        .iter()
        .map(|s| s.turn_id.clone())
        .collect();
    let v4 =
        regex::Regex::new("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
            .unwrap();
    for id in &ids {
        assert!(v4.is_match(id), "v4 꼴: {id}");
    }
    let uniq: std::collections::BTreeSet<_> = ids.iter().collect();
    assert_eq!(uniq.len(), 3, "시도마다 다르다: {ids:?}");
}

// ---- 시도 범위의 중계 세션 가드 ----

use crate::relay_session::{OpenSessionInput, PtyInput, RelaySessions};
use base64::Engine;

#[derive(Default)]
struct RelayPty(Mutex<Vec<u8>>);
impl PtyInput for RelayPty {
    fn write(&self, chunk: &[u8]) {
        self.0.lock().unwrap().extend_from_slice(chunk);
    }
    fn resize(&self, _c: u16, _r: u16) {}
}

fn relay_input(l: &Arc<RelaySessions>, sid: &str, text: &[u8]) {
    l.on_frame(json!({"type": "input", "sessionId": sid,
        "data": base64::engine::general_purpose::STANDARD.encode(text)}));
}

/// security ①: `RelayAttempt` 는 `run` 의 시도 범위에서 만들어 `LiveBinding` 과 함께 떨어진다 — 정상 끝·패닉 둘 다,
/// 시도가 끝난 뒤 온 입력은 그 시도 PTY 로 가지 않는다. 세션(멘션 것)은 열려 있다.
#[test]
fn relay_attempt_lives_in_attempt_scope() {
    let w = world("relayscope");
    let log: Log = Log::default();
    let link = Link(Arc::clone(&log));
    let client = HarkroomRestClient::new(&link);
    let notice = Notice {
        log: Arc::clone(&log),
        lease: w.lease.clone(),
    };
    let relay = RelaySessions::new(None, Box::new(|_| {}));
    let session = relay.open_session(OpenSessionInput {
        agent_account_id: "agent".into(),
        channel_id: "c".into(),
        harness: "claude-code".into(),
        accepts_input: true,
        ..Default::default()
    });
    let sid = session.session_id().to_string();
    let (p1, p2) = (Arc::new(RelayPty::default()), Arc::new(RelayPty::default()));
    let mut parts1 = parts(&w, &log, false, vec![1, 0]);
    parts1.pty = Some(p1.clone());
    let mut a = attempt(&w, &client, &notice, true, parts1).with_relay(&session);
    let t = target();
    let mut d = false;
    assert!(a.run(&t, None, false, &mut d).is_err());
    relay_input(&relay, &sid, b"after-1");
    // 다음 시도는 패닉한다 — 그래도 놓인다.
    {
        let mut p = a.parts.borrow_mut();
        p.pty = Some(p2.clone());
        p.panic_spawn = true;
    }
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut d = false;
        let _ = a.run(&t, None, true, &mut d);
    }));
    assert!(r.is_err());
    relay_input(&relay, &sid, b"after-2");
    assert!(
        p1.0.lock().unwrap().is_empty(),
        "정상 끝 뒤 입력은 a1 PTY 로 안 간다"
    );
    assert!(
        p2.0.lock().unwrap().is_empty(),
        "패닉 뒤 입력은 a2 PTY 로 안 간다"
    );
    assert!(a.parts.borrow().bound.is_none());
    assert_eq!(relay.len(), 1, "세션은 멘션 것이라 열려 있다");
}

// ---- lane env 는 턴 MCP 계획 앞에서 ----

struct FakeLane(Log);
impl crate::turn_lane_first::LaneSource for FakeLane {
    fn env_for(
        &self,
        cause: &str,
        _h: AgentHarness,
    ) -> Result<LaneEnv, crate::provider_lane::LaneFileError> {
        push(&self.0, format!("lane_env {cause}"));
        Ok([("HK_LANE".to_string(), "on".to_string())].into())
    }
    fn release(&self, _env: &LaneEnv) -> std::io::Result<()> {
        push(&self.0, "lane_release".into());
        Ok(())
    }
}

/// lane 턴: env 를 계획·열쇠 맡기기·띄우기보다 먼저 받고, 띄울 때 그 env 가 간다. 시도가 끝난 뒤(결과 접기 뒤) 임대를
/// 끝내고 lane 턴 파일을 거둔다.
#[test]
fn lane_env_comes_before_plan_and_is_released_after() {
    let w = world("lanefirst");
    let log: Log = Log::default();
    let link = Link(Arc::clone(&log));
    let client = HarkroomRestClient::new(&link);
    let notice = Notice {
        log: Arc::clone(&log),
        lease: w.lease.clone(),
    };
    let lane = FakeLane(Arc::clone(&log));
    let mut a =
        attempt(&w, &client, &notice, true, parts(&w, &log, false, vec![0])).with_lane(&lane);
    let mut d = false;
    assert!(a.run(&target(), None, true, &mut d).is_ok());
    assert_eq!(
        *log.lock().unwrap(),
        [
            "bind",
            "prepare t-1 -",
            "lane_env m1",
            "keys t-1",
            "spawn t-1",
            "keys_end t-1",
            "outcome",
            "after",
            "lease_ended m1",
            "lane_release",
            "unbind",
        ]
    );
    assert_eq!(a.parts.borrow().lane_envs, [Some("on".to_string())]);
}

/// 관문이 막은 시도는 lane env 를 받지 않고 띄우지도 않는다.
#[test]
fn blocked_lane_attempt_mounts_nothing() {
    let w = world("laneblocked");
    let log: Log = Log::default();
    let link = Link(Arc::clone(&log));
    let client = HarkroomRestClient::new(&link);
    let notice = Notice {
        log: Arc::clone(&log),
        lease: w.lease.clone(),
    };
    let lane = FakeLane(Arc::clone(&log));
    let mut p = parts(&w, &log, false, vec![0]);
    p.cancel_on_bind = true;
    let mut a = attempt(&w, &client, &notice, true, p).with_lane(&lane);
    let mut d = false;
    assert!(a.run(&target(), None, true, &mut d).is_err());
    let log = log.lock().unwrap().clone();
    assert!(
        !log.iter()
            .any(|s| s.starts_with("lane_env") || s.starts_with("spawn")),
        "{log:?}"
    );
    assert!(a.parts.borrow().lane_envs.is_empty());
}

/// #2051 + #2053 함께: lane 턴 + 멘션 중계 세션. 차례 — 결과 접기 뒤 lane 가드(임대 끝 → lane 턴 파일) → 중계 가드(입력
/// 통로 놓기) → 듣기 놓기. 듣기를 놓는 순간 넣은 입력은 그 시도 PTY 로 가지 않는다.
#[test]
fn lane_and_relay_guards_both_release_in_order() {
    let w = world("lanerelay");
    let log: Log = Log::default();
    let link = Link(Arc::clone(&log));
    let client = HarkroomRestClient::new(&link);
    let notice = Notice {
        log: Arc::clone(&log),
        lease: w.lease.clone(),
    };
    let lane = FakeLane(Arc::clone(&log));
    let relay = RelaySessions::new(None, Box::new(|_| {}));
    let session = relay.open_session(OpenSessionInput {
        agent_account_id: "agent".into(),
        channel_id: "c".into(),
        harness: "claude-code".into(),
        accepts_input: true,
        ..Default::default()
    });
    let sid = session.session_id().to_string();
    let pty = Arc::new(RelayPty::default());
    let mut p = parts(&w, &log, false, vec![0]);
    p.pty = Some(pty.clone());
    p.probe_on_unbind = Some((Arc::clone(&relay), sid));
    let mut a = attempt(&w, &client, &notice, true, p)
        .with_lane(&lane)
        .with_relay(&session);
    let mut d = false;
    assert!(a.run(&target(), None, true, &mut d).is_ok());
    let log = log.lock().unwrap().clone();
    let tail: Vec<&str> = log.iter().rev().take(5).rev().map(String::as_str).collect();
    assert_eq!(
        tail,
        ["after", "lease_ended m1", "lane_release", "unbind", "probe"],
        "{log:?}"
    );
    assert!(
        pty.0.lock().unwrap().is_empty(),
        "듣기를 놓을 때는 입력 통로가 이미 놓였다"
    );
    assert_eq!(a.parts.borrow().lane_envs, [Some("on".to_string())]);
}

/// security: lane + 비밀 턴에서도 임대 끝 알림은 한 번 — 띄우기 정리(비밀)와 lane 가드가 한 자리를 같이 쓴다.
#[test]
fn lane_and_secrets_end_lease_once() {
    let w = world("leaseonce");
    let log: Log = Log::default();
    let link = Link(Arc::clone(&log));
    let client = HarkroomRestClient::new(&link);
    let notice = Notice {
        log: Arc::clone(&log),
        lease: w.lease.clone(),
    };
    let lane = FakeLane(Arc::clone(&log));
    let mut a =
        attempt(&w, &client, &notice, true, parts(&w, &log, true, vec![0])).with_lane(&lane);
    let mut d = false;
    assert!(a.run(&target(), None, true, &mut d).is_ok());
    let log = log.lock().unwrap().clone();
    assert_eq!(
        log.iter().filter(|s| s.starts_with("lease_ended")).count(),
        1,
        "{log:?}"
    );
    assert!(
        log.iter().any(|s| s == "mount m1"),
        "비밀도 마운트한 턴이다"
    );
    assert!(log.iter().any(|s| s == "lane_release"));
}

/// security(멘션 단위 임대 전제): a1 비밀 턴 → 계정 전환 → a2 비밀 턴. a1 정리에서 임대가 끝난(비밀 파일이 지워진)
/// 뒤에도 a2 는 같은 원인으로 다시 마운트하고, a2 의 가림 목록·감시 목록에 그 비밀이 있다.
#[test]
fn secrets_mount_again_after_account_switch() {
    let w = world("remount");
    let log: Log = Log::default();
    let link = Link(Arc::clone(&log));
    let client = HarkroomRestClient::new(&link);
    let notice = Notice {
        log: Arc::clone(&log),
        lease: w.lease.clone(),
    };
    let mut a = attempt(
        &w,
        &client,
        &notice,
        true,
        parts(&w, &log, true, vec![1, 0]),
    );
    let t = target();
    let (a1, a2) = (account("a1"), account("a2"));
    let mut d = false;
    assert!(a.run(&t, Some(&a1), false, &mut d).is_err());
    assert!(
        !w.lease.exists(),
        "a1 정리에서 임대가 끝나 비밀 파일이 지워졌다"
    );
    let mut d = false;
    assert!(a.run(&t, Some(&a2), true, &mut d).is_ok());
    let log = log.lock().unwrap().clone();
    let ended_a1 = log.iter().position(|s| s == "lease_ended m1").unwrap();
    let mounts: Vec<usize> = log
        .iter()
        .enumerate()
        .filter(|(_, s)| *s == "mount m1")
        .map(|(i, _)| i)
        .collect();
    assert_eq!(mounts.len(), 2, "{log:?}");
    assert!(
        mounts[1] > ended_a1,
        "a2 는 a1 임대 끝 뒤에 다시 마운트한다"
    );
    assert_eq!(
        log.iter().filter(|s| *s == "lease_ended m1").count(),
        2,
        "시도마다 한 번"
    );
    let p = a.parts.borrow();
    assert_eq!(
        p.needles_had_secret,
        [true, true],
        "a2 의 가림 목록에도 비밀"
    );
    assert_eq!(p.spawn_notice, [true, true], "a2 의 감시 목록에도 비밀");
}
