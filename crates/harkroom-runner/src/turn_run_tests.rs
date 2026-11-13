use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use harkroom_proto::p1::RunnerLinkResponse;

use super::*;
use crate::adapter::AgentHarness;
use crate::link::LinkRequest;
use crate::rest::{
    HarkroomRestClient, OpenTurn, TURN_KEYS_END_PATH, TURN_KEYS_PATH, issue_turn_keys,
};
use crate::turn_end::EndState;
use crate::turn_failure::StallInputs;
use crate::turn_launch::LaunchPlan;
use crate::turn_mcp_plan::TurnMcpPlan;
use crate::turn_outcome::{OutcomeFacts, attempt_outcome};

struct Link {
    status: BTreeMap<&'static str, u16>,
}

impl RunnerLink for &Link {
    fn request(&self, req: LinkRequest) -> RunnerLinkResponse {
        let LinkRequest::Http { path, .. } = req else {
            panic!("mcp")
        };
        let status = self.status.get(path.as_str()).copied().unwrap_or(0);
        RunnerLinkResponse::HttpResponse {
            id: "x".into(),
            status,
            body: "{}".into(),
        }
    }
}

#[derive(Default)]
struct Log(RefCell<Vec<String>>);

impl Log {
    fn push(&self, s: &str) {
        self.0.borrow_mut().push(s.into());
    }
    fn all(&self) -> Vec<String> {
        self.0.borrow().clone()
    }
}

impl LeaseNotice for Log {
    fn lease_ended(&self, _c: &str) {
        self.push("lease_ended");
    }
}

const PAT: &str = "hk_pat_secret_value_88";
const SID: &str = "11111111-2222-4333-8444-555555555555";

struct World {
    root: PathBuf,
    cfg: PathBuf,
    record: PathBuf,
    turn_cfg: PathBuf,
    key: String,
    secret: String,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn world(tag: &str) -> World {
    let root = std::env::temp_dir().join(format!("hk-run-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let lease = root.join("lease");
    std::fs::create_dir_all(&lease).unwrap();
    let secret = format!("sk-live-{}", "r".repeat(30));
    std::fs::write(lease.join("secret-1"), &secret).unwrap();
    let cfg = root.join("cfg");
    let proj = cfg.join("projects").join("-w");
    std::fs::create_dir_all(&proj).unwrap();
    let key = format!("hkt_bridge_{}", "z".repeat(30));
    let record = proj.join(format!("{SID}.jsonl"));
    std::fs::write(&record, format!("{key} {secret}")).unwrap();
    let mcp = root.join(crate::provider_lane::TURN_MCP_DIR);
    std::fs::create_dir_all(&mcp).unwrap();
    let turn_cfg = mcp.join("t1.json");
    std::fs::write(&turn_cfg, "{}").unwrap();
    World {
        root,
        cfg,
        record,
        turn_cfg,
        key,
        secret,
    }
}

fn files(w: &World) -> TurnFiles {
    let plan = TurnMcpPlan {
        turn_keys: None,
        mcp_config_path: w.turn_cfg.clone(),
        opencode_turn_config: None,
        owned_turn_config: None,
    };
    TurnFiles::of(&plan, &w.root, "t1")
}

fn input<'a>(
    client: &'a HarkroomRestClient<&'a Link>,
    log: &'a Log,
    code: i32,
) -> AttemptInput<'a, &'a Link, PtyOut> {
    AttemptInput {
        plan: LaunchPlan {
            turn_keys: true,
            secrets: true,
            lane_keys: false,
        },
        client,
        lane: None,
        harness: AgentHarness::ClaudeCode,
        cause: "m1",
        turn: OpenTurn {
            turn_id: "t1".into(),
            cause: Some("m1".into()),
            keys: issue_turn_keys(),
        },
        mount_secrets: Some(Box::new(move || {
            log.push("mount");
            Ok(())
        })),
        spawn: Box::new(move |_| {
            log.push("spawn");
            Ok(TurnResult {
                exit_code: code,
                timed_out: false,
                tail: String::new(),
            })
        }),
        after_run: None,
    }
}

#[allow(clippy::result_large_err)]
fn outcome_with<'e>(
    end: &'e Mutex<EndState>,
    live: &'e LiveTurn,
    seen: &'e Cell<usize>,
) -> impl FnOnce(Attempted<PtyOut>, &TurnSecrets) -> Result<TurnOk, AttemptError> + 'e {
    move |a, s| {
        seen.set(s as *const TurnSecrets as usize);
        let end = end.lock().unwrap();
        attempt_outcome(
            a,
            &OutcomeFacts {
                end: &end,
                live,
                thread_unreadable: false,
                turn_timeout_ms: 1,
                harness_stall_ms: 1,
                stall: StallInputs {
                    watch_now: None,
                    screen_tail: "",
                    harness: AgentHarness::ClaudeCode,
                    signal: None,
                },
                recorded_after: None,
                turn_model: None,
                pat: s.pat(),
                secrets: s.needles(),
                stop_requested_at: None,
            },
        )
    }
}

fn homes(w: &World) -> TranscriptHomes<'_> {
    TranscriptHomes {
        claude_config_dir: Some(&w.cfg),
        ..TranscriptHomes::default()
    }
}

/// 성공: 기록 가리기(같은 목록) → 열쇠 거두기·임대 끝 → 턴 설정 파일 지움 → 결과 접기·턴 뒤 IO 가 **같은** `TurnSecrets` 를 받는다.
#[test]
fn success_runs_everything_in_order_with_one_secrets() {
    let w = world("ok");
    let link = Link {
        status: [(TURN_KEYS_PATH, 200), (TURN_KEYS_END_PATH, 200)].into(),
    };
    let client = HarkroomRestClient::new(&link);
    let log = Log::default();
    let secrets = TurnSecrets::build(PAT, &[&w.key], Some(&w.root.join("lease")));
    let (end, live, seen_outcome, seen_after) = (
        Mutex::new(EndState::default()),
        LiveTurn::default(),
        Cell::new(0),
        Cell::new(0),
    );
    let r = run_attempt(
        AttemptSetup {
            files: files(&w),
            secrets: &secrets,
            scrub: RecordScrub {
                key: "k",
                session_id: Some(SID),
                homes: homes(&w),
            },
        },
        input(&client, &log, 0),
        &log,
        &live,
        outcome_with(&end, &live, &seen_outcome),
        |s| {
            seen_after.set(s as *const TurnSecrets as usize);
            Ok(())
        },
    );
    assert!(r.is_ok());
    assert_eq!(log.all(), ["mount", "spawn", "lease_ended"]);
    let rec = std::fs::read_to_string(&w.record).unwrap();
    assert!(!rec.contains(&w.key) && !rec.contains(&w.secret), "{rec}");
    assert!(!Path::new(&w.turn_cfg).exists());
    let me = &secrets as *const TurnSecrets as usize;
    assert_eq!(
        (seen_outcome.get(), seen_after.get()),
        (me, me),
        "세 자리가 같은 목록"
    );
}

/// 실패: 턴 뒤 IO 는 돌지 않는다(정본 실패 갈래) · 기록은 그래도 가린다.
#[test]
fn failure_skips_after_turn_io() {
    let w = world("fail");
    let link = Link {
        status: [(TURN_KEYS_PATH, 200), (TURN_KEYS_END_PATH, 200)].into(),
    };
    let client = HarkroomRestClient::new(&link);
    let log = Log::default();
    let secrets = TurnSecrets::build(PAT, &[&w.key], Some(&w.root.join("lease")));
    let (end, live, seen) = (
        Mutex::new(EndState::default()),
        LiveTurn::default(),
        Cell::new(0),
    );
    let after_ran = Cell::new(false);
    let r = run_attempt(
        AttemptSetup {
            files: files(&w),
            secrets: &secrets,
            scrub: RecordScrub {
                key: "k",
                session_id: Some(SID),
                homes: homes(&w),
            },
        },
        input(&client, &log, 1),
        &log,
        &live,
        outcome_with(&end, &live, &seen),
        |_| {
            after_ran.set(true);
            Ok(())
        },
    );
    assert_eq!(r.unwrap_err().message, "harness 종료 1");
    assert!(!after_ran.get());
    assert!(
        !std::fs::read_to_string(&w.record)
            .unwrap()
            .contains(&w.secret)
    );
}

/// [중단] 뒤 시도: 관문이 지금 값으로 막아 띄우지 않고, 턴 뒤 IO 도 없다.
#[test]
fn live_cancel_blocks_spawn() {
    let w = world("cancel");
    let link = Link {
        status: [(TURN_KEYS_PATH, 200), (TURN_KEYS_END_PATH, 200)].into(),
    };
    let client = HarkroomRestClient::new(&link);
    let log = Log::default();
    let secrets = TurnSecrets::build(PAT, &[&w.key], None);
    let (end, live, seen) = (
        Mutex::new(EndState::default()),
        LiveTurn::default(),
        Cell::new(0),
    );
    live.cancel("human-1");
    let r = run_attempt(
        AttemptSetup {
            files: files(&w),
            secrets: &secrets,
            scrub: RecordScrub {
                key: "k",
                session_id: Some(SID),
                homes: homes(&w),
            },
        },
        input(&client, &log, 0),
        &log,
        &live,
        outcome_with(&end, &live, &seen),
        |_| panic!("돌면 안 된다"),
    );
    assert!(r.unwrap_err().message.contains("human-1"));
    assert!(
        log.all().is_empty(),
        "열쇠·비밀도 안 받았다: {:?}",
        log.all()
    );
    assert!(
        !Path::new(&w.turn_cfg).exists(),
        "막혀도 턴 설정 파일은 지운다"
    );
}

/// 턴 뒤 IO 실패는 턴을 실패로 만들지 않는다(best-effort).
#[test]
fn after_turn_failure_keeps_ok() {
    let w = world("after");
    let link = Link {
        status: [(TURN_KEYS_PATH, 200), (TURN_KEYS_END_PATH, 200)].into(),
    };
    let client = HarkroomRestClient::new(&link);
    let log = Log::default();
    let secrets = TurnSecrets::build(PAT, &[], None);
    let (end, live, seen) = (
        Mutex::new(EndState::default()),
        LiveTurn::default(),
        Cell::new(0),
    );
    let r = run_attempt(
        AttemptSetup {
            files: files(&w),
            secrets: &secrets,
            scrub: RecordScrub {
                key: "k",
                session_id: Some(SID),
                homes: homes(&w),
            },
        },
        input(&client, &log, 0),
        &log,
        &live,
        outcome_with(&end, &live, &seen),
        |_| Err("mcp down".into()),
    );
    assert!(r.is_ok());
}
