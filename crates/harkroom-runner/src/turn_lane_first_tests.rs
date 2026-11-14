use std::cell::RefCell;

use super::*;

#[derive(Default)]
struct Log(RefCell<Vec<String>>);

struct Lane<'l> {
    log: &'l Log,
    fail: bool,
}
impl LaneSource for Lane<'_> {
    fn env_for(&self, cause: &str, _h: AgentHarness) -> Result<LaneEnv, LaneFileError> {
        self.log.0.borrow_mut().push(format!("env_for {cause}"));
        if self.fail {
            return Err(LaneFileError::BadName { what: "x" });
        }
        Ok([("OPENCODE_CONFIG".to_string(), "/lane/t.json".to_string())].into())
    }
    fn release(&self, _env: &LaneEnv) -> io::Result<()> {
        self.log.0.borrow_mut().push("release".into());
        Ok(())
    }
}
impl LeaseNotice for Log {
    fn lease_ended(&self, cause: &str) {
        self.0.borrow_mut().push(format!("lease_ended {cause}"));
    }
}

/// 받은 env 를 쥐고, 떨어지면 임대 끝 → lane 턴 파일 거두기 차례.
#[test]
fn mounts_then_releases_in_order() {
    let log = Log::default();
    let lane = Lane {
        log: &log,
        fail: false,
    };
    {
        let h =
            mount_lane_first(&lane, &log, "m1", AgentHarness::Opencode, &mut || Ok(())).unwrap();
        assert_eq!(
            h.env().get("OPENCODE_CONFIG").map(String::as_str),
            Some("/lane/t.json")
        );
    }
    assert_eq!(*log.0.borrow(), ["env_for m1", "lease_ended m1", "release"]);
}

/// 관문이 막으면 받지 않는다(임대도 건드리지 않는다 — 받은 것이 없다).
#[test]
fn blocked_gate_mounts_nothing() {
    let log = Log::default();
    let lane = Lane {
        log: &log,
        fail: false,
    };
    let r = mount_lane_first(&lane, &log, "m1", AgentHarness::Opencode, &mut || {
        Err(SpawnBlocked::Canceled)
    });
    assert_eq!(
        r.err(),
        Some(LaneFirstError::Blocked(SpawnBlocked::Canceled))
    );
    assert!(log.0.borrow().is_empty());
}

/// 받기 실패: 접힌 코드만 · 임대는 끝낸다.
#[test]
fn failure_folds_code_and_ends_lease() {
    let log = Log::default();
    let lane = Lane {
        log: &log,
        fail: true,
    };
    let r = mount_lane_first(&lane, &log, "m1", AgentHarness::Opencode, &mut || Ok(()));
    assert_eq!(r.err(), Some(LaneFirstError::Failed("lane_file".into())));
    assert_eq!(*log.0.borrow(), ["env_for m1", "lease_ended m1"]);
}

/// 패닉으로 풀려도 거둔다.
#[test]
fn panic_still_releases() {
    let log = Log::default();
    let lane = Lane {
        log: &log,
        fail: false,
    };
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _h =
            mount_lane_first(&lane, &log, "m1", AgentHarness::Opencode, &mut || Ok(())).unwrap();
        panic!("도중 패닉");
    }));
    assert!(r.is_err());
    assert_eq!(*log.0.borrow(), ["env_for m1", "lease_ended m1", "release"]);
}

/// 빈 env 로 「성공」하면 받지 않는다 — 띄우는 쪽이 빈 env 를 lane 아님으로 읽어 기본 로그인 env 로 뜨는 길을 닫는다(⑦).
#[test]
fn empty_env_is_refused_as_lane_unset() {
    struct Empty<'l>(&'l Log);
    impl LaneSource for Empty<'_> {
        fn env_for(&self, cause: &str, _h: AgentHarness) -> Result<LaneEnv, LaneFileError> {
            self.0.0.borrow_mut().push(format!("env_for {cause}"));
            Ok(LaneEnv::new())
        }
        fn release(&self, _env: &LaneEnv) -> io::Result<()> {
            self.0.0.borrow_mut().push("release".into());
            Ok(())
        }
    }
    let log = Log::default();
    let lane = Empty(&log);
    let r = mount_lane_first(&lane, &log, "m1", AgentHarness::ClaudeCode, &mut || Ok(()));
    assert_eq!(r.err(), Some(LaneFirstError::Failed("lane_unset".into())));
    assert_eq!(*log.0.borrow(), ["env_for m1", "lease_ended m1"]);
}
