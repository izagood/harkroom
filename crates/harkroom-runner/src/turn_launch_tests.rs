use super::*;
use std::cell::Cell;
use std::fs;

#[derive(Default)]
struct Io {
    log: Vec<String>,
    fail_at: Option<LaunchStep>,
}

impl LaunchIo for Io {
    type Out = &'static str;
    fn prepare(&mut self, step: LaunchStep) -> Result<(), String> {
        self.log.push(format!("{step:?}"));
        if self.fail_at == Some(step) {
            return Err("boom".into());
        }
        Ok(())
    }
    fn spawn(&mut self) -> &'static str {
        self.log.push("Spawn".into());
        "ran"
    }
}

const ALL: LaunchPlan = LaunchPlan {
    turn_keys: true,
    secrets: true,
    lane_keys: true,
};

#[test]
fn gate_checked_before_every_step_and_spawn() {
    let calls = Cell::new(0);
    let mut io = Io::default();
    let r = launch(ALL, &mut io, &mut || {
        calls.set(calls.get() + 1);
        Ok(())
    });
    assert_eq!(r.launched, Launched::Ran("ran"));
    assert!(r.turn_keys_registered);
    assert_eq!(io.log, ["TurnKeys", "Secrets", "LaneKeys", "Spawn"]);
    assert_eq!(calls.get(), 4, "단계 셋 + 띄우기 앞");
}

#[test]
fn blocked_before_anything_does_nothing() {
    for why in [SpawnBlocked::FencedOut, SpawnBlocked::Canceled] {
        let mut io = Io::default();
        let r = launch(ALL, &mut io, &mut || Err(why));
        assert_eq!(r.launched, Launched::Blocked(why));
        assert!(!r.turn_keys_registered);
        assert!(io.log.is_empty(), "열쇠·비밀·lane 키·하네스 모두 안 함");
    }
}

#[test]
fn fence_lost_mid_setup_stops_later_steps() {
    // 열쇠를 맡긴 뒤 임대를 잃었다 → 비밀·lane 키·띄우기 없음, 맡긴 열쇠는 거둘 수 있게 알린다.
    let n = Cell::new(0);
    let mut io = Io::default();
    let r = launch(ALL, &mut io, &mut || {
        n.set(n.get() + 1);
        if n.get() >= 2 {
            Err(SpawnBlocked::FencedOut)
        } else {
            Ok(())
        }
    });
    assert_eq!(r.launched, Launched::Blocked(SpawnBlocked::FencedOut));
    assert!(r.turn_keys_registered);
    assert_eq!(io.log, ["TurnKeys"]);
}

#[test]
fn canceled_right_before_spawn_never_spawns() {
    let n = Cell::new(0);
    let mut io = Io::default();
    let r = launch(ALL, &mut io, &mut || {
        n.set(n.get() + 1);
        if n.get() == 4 {
            Err(SpawnBlocked::Canceled)
        } else {
            Ok(())
        }
    });
    assert_eq!(r.launched, Launched::Blocked(SpawnBlocked::Canceled));
    assert_eq!(io.log, ["TurnKeys", "Secrets", "LaneKeys"]);
}

#[test]
fn setup_failure_closes_without_spawn() {
    let mut io = Io {
        fail_at: Some(LaunchStep::TurnKeys),
        ..Io::default()
    };
    let r = launch(ALL, &mut io, &mut || Ok(()));
    assert_eq!(r.launched, Launched::SetupFailed(LaunchStep::TurnKeys));
    assert!(!r.turn_keys_registered, "못 맡긴 열쇠는 맡긴 것이 아니다");
    assert_eq!(io.log, ["TurnKeys"]);

    let mut io = Io {
        fail_at: Some(LaunchStep::Secrets),
        ..Io::default()
    };
    let r = launch(ALL, &mut io, &mut || Ok(()));
    assert_eq!(r.launched, Launched::SetupFailed(LaunchStep::Secrets));
    assert!(r.turn_keys_registered);
    assert_eq!(io.log, ["TurnKeys", "Secrets"]);
}

#[test]
fn skipped_steps_still_gate_spawn() {
    let calls = Cell::new(0);
    let mut io = Io::default();
    let r = launch(LaunchPlan::default(), &mut io, &mut || {
        calls.set(calls.get() + 1);
        Ok(())
    });
    assert_eq!(r.launched, Launched::Ran("ran"));
    assert_eq!(io.log, ["Spawn"]);
    assert_eq!(calls.get(), 1);
    let mut io = Io::default();
    let r = launch(LaunchPlan::default(), &mut io, &mut || {
        Err(SpawnBlocked::Canceled)
    });
    assert_eq!(r.launched, Launched::Blocked(SpawnBlocked::Canceled));
    assert!(io.log.is_empty());
}

#[test]
fn record_paths_include_claude_session_sidecar_only() {
    let t = Path::new("/r/projects/x/abc.jsonl");
    assert_eq!(
        turn_record_paths(AgentHarness::ClaudeCode, Some(t), Some("abc")),
        vec![t.to_path_buf(), PathBuf::from("/r/projects/x/abc")]
    );
    // 세션 id 를 사후에 찾는 하네스(codex)는 rollout 파일 하나.
    assert_eq!(
        turn_record_paths(AgentHarness::Codex, Some(t), Some("abc")),
        vec![t.to_path_buf()]
    );
    // pi·omp 는 옆 디렉터리를 쓰지 않는다.
    for h in [AgentHarness::Pi, AgentHarness::Omp] {
        assert_eq!(
            turn_record_paths(h, Some(t), Some("abc")),
            vec![t.to_path_buf()],
            "{h:?}"
        );
    }
    assert!(turn_record_paths(AgentHarness::ClaudeCode, None, Some("abc")).is_empty());
    // 경로 조각처럼 생긴 세션 id 로 밖을 가리키지 않는다.
    for bad in ["..", ".", "a/b", ""] {
        assert_eq!(
            turn_record_paths(AgentHarness::ClaudeCode, Some(t), Some(bad)),
            vec![t.to_path_buf()],
            "{bad}"
        );
    }
}

#[test]
fn scrub_turn_records_hits_transcript_and_sidecar() {
    let key = format!("hkt_bridge_{}", "q".repeat(30));
    let needles = crate::secret_scrub::turn_key_needles(&[&key]);
    let dir = std::env::temp_dir().join(format!("hk-launch-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("sid").join("tool-results")).unwrap();
    let t = dir.join("sid.jsonl");
    fs::write(&t, &key).unwrap();
    fs::write(dir.join("sid").join("tool-results").join("o.txt"), &key).unwrap();
    let tally = scrub_turn_records(
        "k",
        AgentHarness::ClaudeCode,
        Some(&t),
        Some("sid"),
        &needles,
    );
    assert_eq!(
        tally,
        ScrubTally {
            replaced: 2,
            failed: 0
        }
    );
    assert_eq!(
        fs::read_to_string(dir.join("sid").join("tool-results").join("o.txt")).unwrap(),
        "***"
    );
    assert_eq!(
        scrub_turn_records("k", AgentHarness::ClaudeCode, Some(&t), Some("sid"), &[]),
        ScrubTally::default()
    );
    let _ = fs::remove_dir_all(&dir);
}
