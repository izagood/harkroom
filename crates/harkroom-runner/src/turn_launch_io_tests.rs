use std::cell::Cell;
use std::sync::Mutex;

use harkroom_proto::p1::RunnerLinkResponse;
use serde_json::json;

use super::*;
use crate::link::LinkRequest;
use crate::provider_lane::ProviderLaneDeps;
use crate::rest::{HttpReply, TURN_KEYS_END_PATH, TURN_KEYS_PATH, issue_turn_keys};
use crate::turn_launch::{LaunchGuard, LaunchPlan, Launched, launch_guarded};

/// 경로마다 정한 상태로 답하는 링크. 본 경로를 차례로 적는다.
struct Link {
    status: Mutex<BTreeMap<&'static str, u16>>,
    seen: Mutex<Vec<String>>,
}

impl Link {
    fn new(pairs: &[(&'static str, u16)]) -> Self {
        Link {
            status: Mutex::new(pairs.iter().copied().collect()),
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
        let status = self
            .status
            .lock()
            .unwrap()
            .get(path.as_str())
            .copied()
            .unwrap_or(0);
        RunnerLinkResponse::HttpResponse {
            id: "x".into(),
            status,
            body: "{}".into(),
        }
    }
}

struct Tmp(std::path::PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// claude lane — 비밀 파일 하나와 그 경로를 돌려주는 마운트.
fn lane(tag: &str, mount_status: u16) -> (ProviderLane, Tmp) {
    let root = std::env::temp_dir().join(format!("hk-launch-io-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let dir = root.join("turn-secrets").join("lease-1");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("secret-1");
    std::fs::write(&file, "tok-lane-value-123\n").unwrap();
    let body =
        json!({ "lane": { "baseUrl": "https://gateway.example", "path": file.to_str().unwrap() } })
            .to_string();
    let mut d = ProviderLaneDeps::new(Box::new(move |_| HttpReply {
        status: mount_status,
        body: body.clone(),
    }));
    d.turn_secrets_dir = Some(root.join("turn-secrets"));
    (ProviderLane::new(d), Tmp(root))
}

const ALL: LaunchPlan = LaunchPlan {
    turn_keys: true,
    secrets: true,
    lane_keys: true,
};

fn turn() -> OpenTurn {
    OpenTurn {
        turn_id: "t1".into(),
        cause: Some("m1".into()),
        keys: issue_turn_keys(),
    }
}

#[test]
fn real_launch_registers_mounts_spawns_and_releases_once() {
    let link = Link::new(&[(TURN_KEYS_PATH, 200), (TURN_KEYS_END_PATH, 200)]);
    let client = HarkroomRestClient::new(&link);
    let (lane, _tmp) = lane("ok", 200);
    let slot = LaneSlot::default();
    let (mounted, ended) = (Cell::new(0), Cell::new(0));
    let mut io = RestLaunch {
        client: &client,
        turn: turn(),
        lane: Some(&lane),
        harness: AgentHarness::ClaudeCode,
        cause: "m1",
        lane_slot: slot.clone(),
        mount_secrets: Some(Box::new(|| {
            mounted.set(mounted.get() + 1);
            Ok(())
        })),
        spawn: Some(Box::new(|env: LaneEnv| {
            env.get("ANTHROPIC_AUTH_TOKEN").cloned()
        })),
    };
    let mut guard = LaunchGuard::new(RestRelease {
        client: &client,
        turn_id: "t1".into(),
        lane: Some(&lane),
        lane_slot: slot.clone(),
        end_secrets: Some(Box::new(|| ended.set(ended.get() + 1))),
    });
    let r = launch_guarded(ALL, &mut io, &mut || Ok(()), &mut guard);
    assert_eq!(
        r.launched,
        Launched::Ran(Some("tok-lane-value-123".to_string())),
        "lane env 가 하네스에 간다"
    );
    assert!(r.turn_keys_registered);
    assert_eq!(mounted.get(), 1);
    assert!(guard.finish().is_empty());
    assert_eq!(ended.get(), 1);
    assert!(slot.get().is_none(), "lane env 를 거뒀다");
    assert_eq!(link.seen(), [TURN_KEYS_PATH, TURN_KEYS_END_PATH]);
}

/// 열쇠 맡기기가 실패해도(응답만 놓쳤을 수 있다) 턴 끝에 거두기를 보낸다 · 그 뒤 단계는 하지 않는다.
#[test]
fn turn_keys_register_failure_still_ends_keys() {
    let link = Link::new(&[(TURN_KEYS_PATH, 500), (TURN_KEYS_END_PATH, 200)]);
    let client = HarkroomRestClient::new(&link);
    let slot = LaneSlot::default();
    let spawned = Cell::new(false);
    let mut io = RestLaunch {
        client: &client,
        turn: turn(),
        lane: None,
        harness: AgentHarness::ClaudeCode,
        cause: "m1",
        lane_slot: slot.clone(),
        mount_secrets: None,
        spawn: Some(Box::new(|_| spawned.set(true))),
    };
    let mut guard = LaunchGuard::new(RestRelease {
        client: &client,
        turn_id: "t1".into(),
        lane: None,
        lane_slot: slot,
        end_secrets: None,
    });
    let r = launch_guarded(ALL, &mut io, &mut || Ok(()), &mut guard);
    assert_eq!(r.launched, Launched::SetupFailed(LaunchStep::TurnKeys));
    assert!(!spawned.get());
    assert!(guard.finish().is_empty());
    assert_eq!(link.seen(), [TURN_KEYS_PATH, TURN_KEYS_END_PATH]);
}

/// lane 마운트 실패 사유는 접힌 코드만 — 경로·값이 섞이지 않는다. 받은 것(열쇠·비밀)은 거둔다.
#[test]
fn lane_failure_returns_code_only_and_releases_earlier_steps() {
    let link = Link::new(&[(TURN_KEYS_PATH, 200), (TURN_KEYS_END_PATH, 200)]);
    let client = HarkroomRestClient::new(&link);
    let (lane, tmp) = lane("fail", 0);
    let slot = LaneSlot::default();
    let ended = Cell::new(0);
    let mut io = RestLaunch {
        client: &client,
        turn: turn(),
        lane: Some(&lane),
        harness: AgentHarness::ClaudeCode,
        cause: "m1",
        lane_slot: slot.clone(),
        mount_secrets: Some(Box::new(|| Ok(()))),
        spawn: Some(Box::new(|_| ())),
    };
    let mut err = None;
    // prepare 를 직접 불러 오류 문자열을 본다.
    assert!(io.prepare(LaunchStep::TurnKeys).is_ok());
    if let Err(e) = io.prepare(LaunchStep::LaneKeys) {
        err = Some(e);
    }
    let e = err.expect("lane 실패");
    assert!(
        !e.contains('/') && !e.contains("tok-lane") && !e.contains(tmp.0.to_str().unwrap()),
        "{e}"
    );
    assert!(
        e.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
        "코드 꼴: {e}"
    );
    assert!(slot.get().is_none());
    let mut rel = RestRelease {
        client: &client,
        turn_id: "t1".into(),
        lane: Some(&lane),
        lane_slot: slot,
        end_secrets: Some(Box::new(|| ended.set(ended.get() + 1))),
    };
    let failed = crate::turn_launch::release_launch(
        &[
            LaunchStep::TurnKeys,
            LaunchStep::Secrets,
            LaunchStep::LaneKeys,
        ],
        &mut rel,
    );
    assert!(
        failed.is_empty(),
        "받지 못한 lane env 를 거두는 것은 무해: {failed:?}"
    );
    assert_eq!(ended.get(), 1);
}

/// 거두기를 두 번 해도 무해하다 · 열쇠 끝이 실패하면 실패로 센다.
#[test]
fn release_twice_is_harmless_and_end_failure_counts() {
    let link = Link::new(&[(TURN_KEYS_END_PATH, 503)]);
    let client = HarkroomRestClient::new(&link);
    let (lane, _tmp) = lane("twice", 200);
    let slot = LaneSlot::default();
    slot.put(lane.env_for("m1", AgentHarness::ClaudeCode).unwrap());
    let ended = Cell::new(0);
    let mut rel = RestRelease {
        client: &client,
        turn_id: "t1".into(),
        lane: Some(&lane),
        lane_slot: slot.clone(),
        end_secrets: Some(Box::new(|| ended.set(ended.get() + 1))),
    };
    let all = [
        LaunchStep::TurnKeys,
        LaunchStep::Secrets,
        LaunchStep::LaneKeys,
    ];
    let failed = crate::turn_launch::release_launch(&all, &mut rel);
    assert_eq!(failed, [LaunchStep::TurnKeys]);
    let failed = crate::turn_launch::release_launch(&all, &mut rel);
    assert_eq!(failed, [LaunchStep::TurnKeys]);
    assert_eq!(ended.get(), 1, "비밀 끝은 한 번만");
    assert!(slot.get().is_none());
}

/// lane 을 켰는데 lane 이 없으면 띄우지 않는다(닫히는 쪽).
#[test]
fn lane_step_without_lane_closes() {
    let link = Link::new(&[]);
    let client = HarkroomRestClient::new(&link);
    let mut io: RestLaunch<'_, &Link, ()> = RestLaunch {
        client: &client,
        turn: turn(),
        lane: None,
        harness: AgentHarness::ClaudeCode,
        cause: "m1",
        lane_slot: LaneSlot::default(),
        mount_secrets: None,
        spawn: None,
    };
    assert_eq!(
        io.prepare(LaunchStep::LaneKeys),
        Err("lane_off".to_string())
    );
}
