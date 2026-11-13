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
}

const SECRET: &str = "sk-live-rrrrrrrrrrrrrrrrrrrrrrrrrr";

impl AttemptParts for Parts {
    fn bind_live(&mut self, live: Option<Arc<LiveTurn>>) {
        push(
            &self.log,
            if live.is_some() { "bind" } else { "unbind" }.into(),
        );
        if let Some(l) = &live {
            self.lives.push(Arc::clone(l));
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

    fn spawn(
        &mut self,
        turn_id: &str,
        keys: Option<&EnvTurnKeys>,
        mcp_config_path: &Path,
        _lane_env: LaneEnv,
        delivered: &mut bool,
    ) -> PtyOut {
        push(&self.log, format!("spawn {turn_id}"));
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
