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
use crate::turn_notice::quoted_line;
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

/// 일어난 일을 적고, 임대 끝에는 오퍼레이터처럼 임대 디렉터리를 지운다.
struct Ops {
    log: RefCell<Vec<String>>,
    lease: PathBuf,
}

impl Ops {
    fn push(&self, s: &str) {
        self.log.borrow_mut().push(s.into());
    }
    fn all(&self) -> Vec<String> {
        self.log.borrow().clone()
    }
}

impl LeaseNotice for Ops {
    fn lease_ended(&self, _c: &str) {
        self.push("lease_ended");
        let _ = std::fs::remove_dir_all(&self.lease);
    }
}

const PAT: &str = "hk_pat_secret_value_88";
const SID: &str = "11111111-2222-4333-8444-555555555555";

struct World {
    root: PathBuf,
    cfg: PathBuf,
    lease: PathBuf,
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

/// 비밀 파일은 **아직 없다** — 마운트 닫개가 쓴다. 기록 파일도 하네스(띄우기 닫개)가 쓴다.
fn world(tag: &str) -> World {
    let root = std::env::temp_dir().join(format!("hk-run-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let cfg = root.join("cfg");
    let proj = cfg.join("projects").join("-w");
    std::fs::create_dir_all(&proj).unwrap();
    let mcp = root.join(crate::provider_lane::TURN_MCP_DIR);
    std::fs::create_dir_all(&mcp).unwrap();
    let turn_cfg = mcp.join("t1.json");
    std::fs::write(&turn_cfg, "{}").unwrap();
    World {
        lease: root.join("lease"),
        record: proj.join(format!("{SID}.jsonl")),
        root,
        cfg,
        turn_cfg,
        key: format!("hkt_bridge_{}", "z".repeat(30)),
        secret: format!("sk-live-{}", "r".repeat(30)),
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

fn setup(w: &World) -> AttemptSetup<'_> {
    AttemptSetup {
        files: files(w),
        secrets: SecretsSource {
            pat: PAT,
            turn_key_values: vec![w.key.clone()],
            lease_dir: Some(w.lease.clone()),
        },
        scrub: RecordScrub {
            key: "k",
            session_id: Some(SID),
            homes: TranscriptHomes {
                claude_config_dir: Some(&w.cfg),
                ..TranscriptHomes::default()
            },
        },
    }
}

/// 마운트 닫개가 임대 디렉터리에 비밀을 쓰고, 띄우기 닫개(하네스)가 그 비밀과 턴 열쇠를 기록에 남긴다.
fn input<'a>(
    client: &'a HarkroomRestClient<&'a Link>,
    w: &'a World,
    ops: &'a Ops,
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
            ops.push("mount");
            std::fs::create_dir_all(&w.lease).unwrap();
            std::fs::write(w.lease.join("secret-1"), &w.secret).unwrap();
            Ok(())
        })),
        spawn: Box::new(move |_| {
            ops.push("spawn");
            std::fs::write(&w.record, format!("{} {}", w.key, w.secret)).unwrap();
            Ok(TurnResult {
                exit_code: code,
                timed_out: false,
                tail: String::new(),
            })
        }),
        after_run: None,
    }
}

/// 결과 접기 닫개 — 받은 목록으로 비밀을 가려 보고(`masked`), 실제 결과를 접는다.
#[allow(clippy::result_large_err)]
fn outcome_with<'e>(
    end: &'e Mutex<EndState>,
    live: &'e LiveTurn,
    w: &'e World,
    masked: &'e Cell<bool>,
) -> impl FnOnce(Attempted<PtyOut>, &TurnSecrets) -> Result<TurnOk, AttemptError> + 'e {
    move |a, s| {
        let line = quoted_line(
            Some(&format!("{} {}", w.secret, w.key)),
            s.pat(),
            s.needles(),
        );
        masked.set(!line.contains(&w.secret) && !line.contains(&w.key));
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

fn link() -> Link {
    Link {
        status: [(TURN_KEYS_PATH, 200), (TURN_KEYS_END_PATH, 200)].into(),
    }
}

/// #2032 security: 마운트한 비밀이 **실제 순서**(마운트 → 하네스 → 가리기 → 임대 끝)에서 기록·실패 문장·턴 뒤 글
/// 모두에서 가려진다 — 목록은 마운트 뒤·임대 끝 전에 지어져 임대 디렉터리가 지워진 뒤에도 그대로 쓰인다.
#[test]
fn mounted_secret_is_masked_in_records_outcome_and_after_turn() {
    let w = world("ok");
    let link = link();
    let client = HarkroomRestClient::new(&link);
    let ops = Ops {
        log: RefCell::default(),
        lease: w.lease.clone(),
    };
    let (end, live) = (Mutex::new(EndState::default()), LiveTurn::default());
    let (outcome_masked, after_masked) = (Cell::new(false), Cell::new(false));
    let r = run_attempt(
        setup(&w),
        input(&client, &w, &ops, 0),
        &ops,
        &live,
        outcome_with(&end, &live, &w, &outcome_masked),
        |s| {
            let wake = crate::silent_notice::silent_wake_notice(
                Some(&format!("끝 {} {}", w.secret, w.key)),
                s.pat(),
                s.needles(),
            );
            after_masked.set(!wake.contains(&w.secret) && !wake.contains(&w.key));
            Ok(())
        },
    );
    assert!(r.is_ok());
    assert_eq!(ops.all(), ["mount", "spawn", "lease_ended"]);
    assert!(!w.lease.exists(), "임대가 끝나 비밀 파일이 지워졌다");
    let rec = std::fs::read_to_string(&w.record).unwrap();
    assert!(
        !rec.contains(&w.secret) && !rec.contains(&w.key),
        "기록: {rec}"
    );
    assert!(
        outcome_masked.get(),
        "결과 접기가 받은 목록에 마운트한 비밀이 있다"
    );
    assert!(
        after_masked.get(),
        "턴 뒤 글이 받은 목록에 마운트한 비밀이 있다"
    );
    assert!(!Path::new(&w.turn_cfg).exists());
}

/// 실패해도 기록·실패 문장의 목록에 마운트한 비밀이 있다 · 턴 뒤 IO 는 돌지 않는다.
#[test]
fn failure_still_masks_mounted_secret_and_skips_after_turn() {
    let w = world("fail");
    let link = link();
    let client = HarkroomRestClient::new(&link);
    let ops = Ops {
        log: RefCell::default(),
        lease: w.lease.clone(),
    };
    let (end, live, masked) = (
        Mutex::new(EndState::default()),
        LiveTurn::default(),
        Cell::new(false),
    );
    let after_ran = Cell::new(false);
    let r = run_attempt(
        setup(&w),
        input(&client, &w, &ops, 1),
        &ops,
        &live,
        outcome_with(&end, &live, &w, &masked),
        |_| {
            after_ran.set(true);
            Ok(())
        },
    );
    assert_eq!(r.unwrap_err().message, "harness 종료 1");
    assert!(masked.get());
    assert!(!after_ran.get());
    assert!(
        !std::fs::read_to_string(&w.record)
            .unwrap()
            .contains(&w.secret)
    );
}

/// [중단] 뒤 시도: 띄우지 않았으니 목록은 PAT·턴 열쇠만으로 접힌다(비밀은 하네스에 간 적 없음) · 턴 뒤 IO 없음.
#[test]
#[allow(clippy::result_large_err)]
fn blocked_folds_with_pat_and_turn_keys_only() {
    let w = world("cancel");
    let link = link();
    let client = HarkroomRestClient::new(&link);
    let ops = Ops {
        log: RefCell::default(),
        lease: w.lease.clone(),
    };
    let (end, live) = (Mutex::new(EndState::default()), LiveTurn::default());
    live.cancel("human-1");
    let key_masked = Cell::new(false);
    let r = run_attempt(
        setup(&w),
        input(&client, &w, &ops, 0),
        &ops,
        &live,
        |a, s| {
            let line = quoted_line(Some(&format!("x {}", w.key)), s.pat(), s.needles());
            key_masked.set(!line.contains(&w.key));
            outcome_with(&end, &live, &w, &Cell::new(false))(a, s)
        },
        |_| panic!("돌면 안 된다"),
    );
    assert!(r.unwrap_err().message.contains("human-1"));
    assert!(
        ops.all().is_empty(),
        "열쇠·비밀도 안 받았다: {:?}",
        ops.all()
    );
    assert!(key_masked.get(), "턴 열쇠는 그래도 가린다");
    assert!(!Path::new(&w.turn_cfg).exists());
}

/// 턴 뒤 IO 실패는 턴을 실패로 만들지 않는다(best-effort).
#[test]
fn after_turn_failure_keeps_ok() {
    let w = world("after");
    let link = link();
    let client = HarkroomRestClient::new(&link);
    let ops = Ops {
        log: RefCell::default(),
        lease: w.lease.clone(),
    };
    let (end, live, masked) = (
        Mutex::new(EndState::default()),
        LiveTurn::default(),
        Cell::new(false),
    );
    let r = run_attempt(
        setup(&w),
        input(&client, &w, &ops, 0),
        &ops,
        &live,
        outcome_with(&end, &live, &w, &masked),
        |_| Err("mcp down".into()),
    );
    assert!(r.is_ok());
}

#[test]
fn turn_end_line_matches_ts_shape() {
    use crate::pty_turn::TurnResult;
    let ok: PtyOut = Ok(TurnResult {
        exit_code: 0,
        timed_out: false,
        tail: String::new(),
    });
    assert_eq!(
        super::turn_end_line("c/a", 28_000, &ok).as_deref(),
        Some("[mentionTurn] c/a: 턴 종료 (경과=28000ms, exitCode=0)")
    );
    let slow: PtyOut = Ok(TurnResult {
        exit_code: 143,
        timed_out: true,
        tail: "x".into(),
    });
    assert_eq!(
        super::turn_end_line("c/a", 5, &slow).as_deref(),
        Some("[mentionTurn] c/a: 턴 종료 (경과=5ms, exitCode=timeout (143))")
    );
    let failed: PtyOut = Err(crate::pty_turn::PtyTurnError::Spawn(std::io::Error::other(
        "no",
    )));
    assert_eq!(super::turn_end_line("c/a", 1, &failed), None);
}
