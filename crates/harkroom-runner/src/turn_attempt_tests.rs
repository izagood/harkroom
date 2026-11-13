use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::Mutex;

use harkroom_proto::p1::RunnerLinkResponse;

use super::*;
use crate::link::LinkRequest;
use crate::rest::{TURN_KEYS_END_PATH, TURN_KEYS_PATH, issue_turn_keys};
use crate::turn_launch_io::LaneEnv;

struct Link {
    status: BTreeMap<&'static str, u16>,
    seen: Mutex<Vec<String>>,
}

impl Link {
    fn new(pairs: &[(&'static str, u16)]) -> Self {
        Link {
            status: pairs.iter().copied().collect(),
            seen: Mutex::new(Vec::new()),
        }
    }
    fn seen(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

impl RunnerLink for &Link {
    fn request(&self, req: LinkRequest) -> RunnerLinkResponse {
        let LinkRequest::Http { path, .. } = req else {
            panic!("mcp")
        };
        self.seen.lock().unwrap().push(path.clone());
        let status = self.status.get(path.as_str()).copied().unwrap_or(0);
        RunnerLinkResponse::HttpResponse {
            id: "x".into(),
            status,
            body: "{}".into(),
        }
    }
}

/// 일어난 일을 차례로 적는다.
#[derive(Default)]
struct Log(RefCell<Vec<String>>);

impl Log {
    fn push(&self, s: &str) {
        self.0.borrow_mut().push(s.to_string());
    }
    fn all(&self) -> Vec<String> {
        self.0.borrow().clone()
    }
}

impl LeaseNotice for Log {
    fn lease_ended(&self, cause: &str) {
        self.push(&format!("lease_ended:{cause}"));
    }
}

fn turn() -> OpenTurn {
    OpenTurn {
        turn_id: "t1".into(),
        cause: Some("m1".into()),
        keys: issue_turn_keys(),
    }
}

const KEYS_SECRETS: LaunchPlan = LaunchPlan {
    turn_keys: true,
    secrets: true,
    lane_keys: false,
};

fn input<'a>(
    client: &'a HarkroomRestClient<&'a Link>,
    log: &'a Log,
) -> AttemptInput<'a, &'a Link, &'static str> {
    AttemptInput {
        plan: KEYS_SECRETS,
        client,
        lane: None,
        harness: AgentHarness::ClaudeCode,
        cause: "m1",
        turn: turn(),
        mount_secrets: Some(Box::new(move || {
            log.push("mount");
            Ok(())
        })),
        spawn: Box::new(move |_env: LaneEnv| {
            log.push("spawn");
            "out"
        }),
        after_run: Some(Box::new(move |_o: &&str| log.push("scrub"))),
    }
}

/// 돌았다 → 기록 가리기가 임대 끝내기 **전에**, 임대 끝 알림은 `notify_secret_lease_ended(cause)` 한 번, 열쇠는 거둔다.
#[test]
fn ran_scrubs_before_lease_end_and_releases_once() {
    let link = Link::new(&[(TURN_KEYS_PATH, 200), (TURN_KEYS_END_PATH, 200)]);
    let client = HarkroomRestClient::new(&link);
    let log = Log::default();
    let r = attempt_once(input(&client, &log), &log, &mut || Ok(()));
    assert_eq!(r, Attempted::Ran("out"));
    assert_eq!(log.all(), ["mount", "spawn", "scrub", "lease_ended:m1"]);
    assert_eq!(link.seen(), [TURN_KEYS_PATH, TURN_KEYS_END_PATH]);
}

/// 비밀을 받은 뒤 띄우기 직전에 [중단] → 안 띄우고, 가리기도 없고, 임대는 한 번 끝낸다.
#[test]
fn blocked_after_secrets_ends_lease_without_spawn() {
    let link = Link::new(&[(TURN_KEYS_PATH, 200), (TURN_KEYS_END_PATH, 200)]);
    let client = HarkroomRestClient::new(&link);
    let log = Log::default();
    let mut n = 0;
    let r = attempt_once(input(&client, &log), &log, &mut || {
        n += 1;
        if n == 3 {
            Err(SpawnBlocked::Canceled)
        } else {
            Ok(())
        }
    });
    assert_eq!(r, Attempted::Blocked(SpawnBlocked::Canceled));
    assert_eq!(log.all(), ["mount", "lease_ended:m1"]);
    assert_eq!(link.seen(), [TURN_KEYS_PATH, TURN_KEYS_END_PATH]);
}

/// 처음부터 임대를 잃었다 → 아무것도 맡기지·받지 않고, 끝낼 임대도 거둘 열쇠도 없다.
#[test]
fn fenced_up_front_touches_nothing() {
    let link = Link::new(&[]);
    let client = HarkroomRestClient::new(&link);
    let log = Log::default();
    let r = attempt_once(input(&client, &log), &log, &mut || {
        Err(SpawnBlocked::FencedOut)
    });
    assert_eq!(r, Attempted::Blocked(SpawnBlocked::FencedOut));
    assert!(log.all().is_empty());
    assert!(link.seen().is_empty());
}

/// 열쇠 맡기기 실패 → 접힌 코드와 결말, 거두기는 보낸다.
#[test]
fn setup_failure_returns_code_and_turn_end() {
    let link = Link::new(&[(TURN_KEYS_PATH, 500), (TURN_KEYS_END_PATH, 200)]);
    let client = HarkroomRestClient::new(&link);
    let log = Log::default();
    let r = attempt_once(input(&client, &log), &log, &mut || Ok(()));
    assert_eq!(
        r,
        Attempted::SetupFailed {
            step: LaunchStep::TurnKeys,
            code: "turn_keys".into()
        }
    );
    assert!(log.all().is_empty(), "비밀 단계 전이라 임대도 안 건드린다");
    assert_eq!(link.seen(), [TURN_KEYS_PATH, TURN_KEYS_END_PATH]);
    assert!(matches!(
        setup_failure_end(LaunchStep::TurnKeys, "turn_keys"),
        TurnEnd::Other { .. }
    ));
}

#[test]
fn lane_setup_failure_folds_to_provider_lane_end() {
    match setup_failure_end(LaunchStep::LaneKeys, "operator_unreachable") {
        TurnEnd::ProviderLane { code, recallable } => {
            assert_eq!(code, "operator_unreachable");
            assert_eq!(recallable, provider_lane_recallable("operator_unreachable"));
        }
        other => panic!("{other:?}"),
    }
}

/// 띄우기에서 패닉 → 가드 Drop 이 임대를 한 번 끝낸다(가리기는 못 했다).
#[test]
fn panic_in_spawn_still_ends_lease_once() {
    let link = Link::new(&[(TURN_KEYS_PATH, 200), (TURN_KEYS_END_PATH, 200)]);
    let client = HarkroomRestClient::new(&link);
    let log = Log::default();
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut i = input(&client, &log);
        i.spawn = Box::new(|_| panic!("pty died"));
        attempt_once(i, &log, &mut || Ok(()))
    }));
    assert!(res.is_err());
    assert_eq!(log.all(), ["mount", "lease_ended:m1"]);
    assert_eq!(link.seen(), [TURN_KEYS_PATH, TURN_KEYS_END_PATH]);
}

/// after_run: 기록 파일 + `<sessionId>/` 의 tool-results·subagents 를 턴 열쇠 + 임대 비밀 바늘로 모두 가린다.
#[test]
fn scrub_after_run_covers_all_record_paths_with_key_and_secret_needles() {
    let root = std::env::temp_dir().join(format!("hk-attempt-scrub-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let lease = root.join("lease");
    std::fs::create_dir_all(&lease).unwrap();
    let secret = format!("sk-{}", "z".repeat(30));
    std::fs::write(lease.join("secret-1"), &secret).unwrap();
    // 심링크·큰 파일은 바늘을 만들지 않는다.
    std::os::unix::fs::symlink("/etc/hosts", lease.join("link")).unwrap();
    let proj = root.join("proj");
    std::fs::create_dir_all(proj.join("sid").join("tool-results")).unwrap();
    std::fs::create_dir_all(proj.join("sid").join("subagents")).unwrap();
    let key = format!("hkt_bridge_{}", "k".repeat(30));
    let t = proj.join("sid.jsonl");
    std::fs::write(&t, format!("{key} {secret}")).unwrap();
    std::fs::write(proj.join("sid").join("tool-results").join("o.txt"), &secret).unwrap();
    std::fs::write(proj.join("sid").join("subagents").join("a.jsonl"), &key).unwrap();
    let tally = scrub_after_run(
        "k",
        AgentHarness::ClaudeCode,
        Some(&t),
        Some("sid"),
        &[&key],
        Some(&lease),
    );
    assert_eq!(tally.replaced, 4, "{tally:?}");
    for p in [
        t.clone(),
        proj.join("sid/tool-results/o.txt"),
        proj.join("sid/subagents/a.jsonl"),
    ] {
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(
            !body.contains(&key) && !body.contains(&secret),
            "{}",
            p.display()
        );
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// 하네스 env 로 가는 값은 `Debug`(로그)에 실리지 않는다.
#[test]
fn spawn_side_debug_shows_names_not_values() {
    use crate::turn_env::{ChildEnvInput, TurnKeys};
    let lane: BTreeMap<String, String> = [(
        "ANTHROPIC_AUTH_TOKEN".to_string(),
        "tok-lane-secret-1".to_string(),
    )]
    .into();
    let keys = TurnKeys {
        shell: "shell-key-value-1".into(),
        bridge: "bridge-key-value-1".into(),
    };
    let mut input = ChildEnvInput::new(AgentHarness::ClaudeCode);
    input.provider_env = Some(&lane);
    input.turn_keys = Some(&keys);
    let d = format!("{input:?} {keys:?}");
    assert!(d.contains("ANTHROPIC_AUTH_TOKEN"), "{d}");
    for v in [
        "tok-lane-secret-1",
        "shell-key-value-1",
        "bridge-key-value-1",
    ] {
        assert!(!d.contains(v), "{d}");
    }
    let plan = crate::turn_command::TurnPlan {
        command: "claude",
        args: vec!["-p".into()],
        env: lane.clone(),
        stdin_file: None,
        cwd: None,
    };
    let d = format!("{plan:?}");
    assert!(
        d.contains("ANTHROPIC_AUTH_TOKEN") && !d.contains("tok-lane-secret-1"),
        "{d}"
    );
    // PTY 계획에는 env 로만 간다 — argv 에는 없다.
    let pty = plan.into_pty_plan();
    assert!(
        pty.env
            .iter()
            .any(|(k, v)| k == "ANTHROPIC_AUTH_TOKEN" && v == "tok-lane-secret-1")
    );
    assert!(pty.args.iter().all(|a| !a.contains("tok-lane-secret-1")));
}
