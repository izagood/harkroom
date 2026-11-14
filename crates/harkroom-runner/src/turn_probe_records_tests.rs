//! 기록 탐침 실구현 시험 — 가짜 기록·가짜 알림으로 security 조건 ①·③·④ 를 붙잡는다.

use super::*;
use crate::harness_errors::MacPermissionState;

#[derive(Default)]
struct FakeRecords {
    denials: Vec<PermissionDenial>,
    mac: Vec<MacPermissionWait>,
    mcp: Vec<String>,
    recorded: Option<String>,
    api: Option<String>,
}

impl ProbeRecords for FakeRecords {
    fn denials(&mut self) -> Vec<PermissionDenial> {
        self.denials.clone()
    }
    fn mac_waits(&mut self) -> Vec<MacPermissionWait> {
        self.mac.clone()
    }
    fn mcp_auth_rejections(&mut self) -> Vec<String> {
        self.mcp.clone()
    }
    fn recorded_api_error(&mut self) -> Option<String> {
        self.recorded.clone()
    }
    fn api_error(&mut self) -> Option<String> {
        self.api.clone()
    }
}

#[derive(Default)]
struct FakeSink {
    posted: Vec<String>,
    reported: Vec<Vec<String>>,
    logs: Vec<String>,
    fail_post: bool,
}

impl ProbeSink for FakeSink {
    fn progress(&mut self, body: &str) -> Result<(), String> {
        if self.fail_post {
            return Err("link down".into());
        }
        self.posted.push(body.to_owned());
        Ok(())
    }
    fn report_mcp_auth_rejected(&mut self, servers: &[String]) {
        self.reported.push(servers.to_vec());
    }
    fn log(&mut self, line: &str) {
        self.logs.push(line.to_owned());
    }
}

const MOUNTED: &str = "MOUNTEDsecretVALUE0123456789";
const PAT: &str = "hrkp_runnerpat_abcdefghijklmnop";

fn secrets() -> NoticeSecrets {
    NoticeSecrets {
        pat: PAT.into(),
        mounted: vec![MOUNTED.into()],
        lease_dir: None,
    }
}

fn denial(id: &str, cmd: &str, reason: &str) -> PermissionDenial {
    PermissionDenial {
        tool_use_id: id.into(),
        tool: "Bash".into(),
        input: cmd.into(),
        reason: reason.into(),
    }
}

#[test]
fn denial_notice_masks_mounted_secret_and_dedupes() {
    let mut st = RecordProbeState::default();
    let mut rec = FakeRecords {
        denials: vec![denial(
            "t1",
            &format!("curl -H {MOUNTED}"),
            "@someone said so",
        )],
        ..FakeRecords::default()
    };
    let mut sink = FakeSink::default();
    probe_denials(&mut st, &mut rec, &mut sink, &secrets());
    assert_eq!(sink.posted.len(), 1);
    let body = &sink.posted[0];
    assert!(!body.contains(MOUNTED), "마운트한 비밀이 실렸다: {body}");
    assert!(!body.split('`').next().unwrap().contains('@'));
    // 로컬 로그에 명령·이유 원문이 남지 않는다.
    assert!(
        sink.logs
            .iter()
            .all(|l| !l.contains(MOUNTED) && !l.contains("someone"))
    );
    // 같은 거부는 다시 알리지 않는다.
    probe_denials(&mut st, &mut rec, &mut sink, &secrets());
    assert_eq!(sink.posted.len(), 1);
}

#[test]
fn denial_notices_stop_at_the_per_turn_cap() {
    let mut st = RecordProbeState::default();
    let mut sink = FakeSink::default();
    for i in 0..(DENIAL_NOTICE_MAX_PER_TURN + 2) {
        let mut rec = FakeRecords {
            denials: vec![denial(&format!("t{i}"), "ls", "r")],
            ..FakeRecords::default()
        };
        probe_denials(&mut st, &mut rec, &mut sink, &secrets());
    }
    assert_eq!(sink.posted.len(), DENIAL_NOTICE_MAX_PER_TURN);
}

#[test]
fn mac_notice_masks_and_failed_post_only_logs() {
    let mut st = RecordProbeState::default();
    let mut rec = FakeRecords {
        mac: vec![MacPermissionWait {
            tool_use_id: "m1".into(),
            state: MacPermissionState::Waiting,
            target: Some("Finder".into()),
            input: format!("osascript -e '{MOUNTED}'"),
        }],
        ..FakeRecords::default()
    };
    let mut sink = FakeSink::default();
    probe_mac_permission(&mut st, &mut rec, &mut sink, &secrets());
    assert_eq!(sink.posted.len(), 1);
    assert!(!sink.posted[0].contains(MOUNTED));
    // 알리기에 실패해도 던지지 않고 로그만 — 같은 호출은 다시 알리지 않는다.
    let mut st2 = RecordProbeState::default();
    let mut failing = FakeSink {
        fail_post: true,
        ..FakeSink::default()
    };
    probe_mac_permission(&mut st2, &mut rec, &mut failing, &secrets());
    assert!(failing.logs.iter().any(|l| l.contains("통지 실패")));
    assert_eq!(st2.mac_notices, 1);
}

#[test]
fn mcp_auth_reports_each_server_once_and_never_posts() {
    let mut st = RecordProbeState::default();
    let mut rec = FakeRecords {
        mcp: vec!["harkroom".into(), "other".into()],
        ..FakeRecords::default()
    };
    let mut sink = FakeSink::default();
    probe_mcp_auth(&mut st, &mut rec, &mut sink);
    probe_mcp_auth(&mut st, &mut rec, &mut sink);
    assert_eq!(
        sink.reported,
        vec![vec!["harkroom".to_string(), "other".to_string()]]
    );
    assert!(sink.posted.is_empty());
}

#[test]
fn api_error_raw_text_stays_out_of_logs_and_notice_is_masked() {
    let mut end = EndState::default();
    let mut rec = FakeRecords {
        api: Some(format!("401 bad key {MOUNTED}")),
        ..FakeRecords::default()
    };
    let mut sink = FakeSink::default();
    assert!(probe_api_error(&mut end, &mut rec, &mut sink, &secrets()).is_some());
    assert!(sink.logs.iter().all(|l| !l.contains(MOUNTED)));
    let notice = end.api_error_notice(PAT, &[MOUNTED.to_string()]).unwrap();
    assert!(!notice.contains(MOUNTED), "{notice}");
}

#[test]
fn recorded_api_error_wins_and_is_masked_when_stored() {
    let mut end = EndState::default();
    let mut rec = FakeRecords {
        recorded: Some(format!("upstream said {MOUNTED}")),
        api: Some("other".into()),
        ..FakeRecords::default()
    };
    let mut sink = FakeSink::default();
    assert!(probe_api_error(&mut end, &mut rec, &mut sink, &secrets()).is_some());
    let stored = end.recorded_api_error.clone().unwrap();
    assert!(!stored.contains(MOUNTED), "{stored}");
    assert!(end.api_error.is_none(), "기록 갈래가 먼저다");
}

#[test]
fn api_error_ignored_after_turn_spoke() {
    let mut end = EndState {
        spoke: true,
        ..EndState::default()
    };
    let mut rec = FakeRecords {
        api: Some("boom".into()),
        ..FakeRecords::default()
    };
    let mut sink = FakeSink::default();
    assert_eq!(
        probe_api_error(&mut end, &mut rec, &mut sink, &secrets()),
        None
    );
    assert!(end.api_error.is_none());
}

#[test]
fn screen_said_goes_through_quoted_line() {
    // 조건 ①: 화면 원문은 가린 한 줄로만 올린다. 비밀 조각이 보이면 아예 올리지 않는다.
    let s = secrets();
    let ok = screen_said_for_post(Some("done.\nall good"), &s).unwrap();
    assert!(!ok.contains('\n'));
    assert_eq!(
        screen_said_for_post(Some(&format!("key is {}", &MOUNTED[..14])), &s),
        None
    );
    assert_eq!(screen_said_for_post(None, &s), None);
}

#[test]
fn spawn_gate_stops_before_spawn_when_fenced_or_canceled() {
    // 조건 ④: 펜스를 이미 잃었으면 watch_fence 는 표지만 세운다 — 부르는 쪽은 spawn_gate 로 띄우기·비밀·lane 키 전에 멈춘다.
    struct NoIo(Vec<&'static str>);
    impl crate::turn_life::LifeIo for NoIo {
        fn registry_register(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn registry_release(&mut self) {}
        fn listen_fence(&mut self) {
            self.0.push("listen");
        }
        fn unlisten_fence(&mut self) {}
        fn reclaim(&mut self, _end: &mut EndState) {
            self.0.push("reclaim");
        }
        fn cancel_probe(&mut self) {}
        fn cancel_reclaim(&mut self) {}
        fn cancel_silence(&mut self) {}
        fn cancel_gate_watch(&mut self) {}
        fn ledger_release(&mut self, _a: &str) {}
        fn provider_env_done(&mut self) {}
        fn close_session(&mut self) {}
        fn await_working(&mut self) {}
        fn remove_working_reaction(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn log(&mut self, _line: &str) {}
    }
    let mut life = TurnLife::default();
    let mut io = NoIo(vec![]);
    crate::turn_life::watch_fence(&mut life, true, &mut io);
    assert!(life.fenced_out);
    assert!(
        io.0.is_empty(),
        "이미 잃은 펜스는 회수·구독하지 않는다: {:?}",
        io.0
    );
    assert_eq!(spawn_gate(&life, false), Err(SpawnBlocked::FencedOut));

    let fresh = TurnLife::default();
    assert_eq!(spawn_gate(&fresh, true), Err(SpawnBlocked::Canceled));
    assert_eq!(spawn_gate(&fresh, false), Ok(()));
}

#[test]
fn notice_secrets_debug_hides_values() {
    let dbg = format!("{:?}", secrets());
    assert!(!dbg.contains(PAT) && !dbg.contains(MOUNTED), "{dbg}");
}

/// T3a: 띄운 **뒤** 임대 폴더에 생긴 값(턴 도중 `secret.mount`)도 통지에서 가린다 — 쓸 때 다시 읽는다(정본 `tailSecrets`).
/// 다른 임대 폴더의 값은 이 통지와 상관없다(섞이지 않는다).
#[test]
fn notice_masks_values_mounted_after_spawn() {
    let base = std::env::temp_dir().join(format!("hk-t3a-notice-{}", std::process::id()));
    let mine = base.join("lease-mine");
    let other = base.join("lease-other");
    std::fs::create_dir_all(&mine).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    let s = NoticeSecrets {
        pat: PAT.into(),
        mounted: vec![],
        lease_dir: Some(mine.clone()),
    };
    // 띄운 뒤 마운트
    std::fs::write(mine.join("API_KEY"), "LATE-MOUNTED-SECRET-VALUE-1234").unwrap();
    std::fs::write(other.join("API_KEY"), "OTHER-LEASE-VALUE-ZZZZ-9999").unwrap();
    let body = s
        .guard_body("screen says LATE-MOUNTED-SECRET-VALUE-1234 and OTHER-LEASE-VALUE-ZZZZ-9999")
        .unwrap();
    assert!(!body.contains("LATE-MOUNTED-SECRET-VALUE-1234"), "{body}");
    assert!(
        body.contains("OTHER-LEASE-VALUE-ZZZZ-9999"),
        "다른 임대 폴더는 안 읽는다: {body}"
    );
    let _ = std::fs::remove_dir_all(&base);
}

/// T3a(security 막음 1): 임대 폴더를 못 읽으면(권한 0000) 통지·화면 인용을 올리지 않는다. 폴더가 없으면(마운트 없음) 그대로 간다.
#[test]
fn notice_withheld_when_lease_unreadable() {
    use std::os::unix::fs::PermissionsExt;
    let base = std::env::temp_dir().join(format!("hk-t3a-blind-{}", std::process::id()));
    let dir = base.join("lease");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("K"), "UNREADABLE-SECRET-VALUE-5678").unwrap();
    let s = NoticeSecrets {
        pat: PAT.into(),
        mounted: vec![],
        lease_dir: Some(dir.clone()),
    };
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();
    let blocked = s.guard_body("tail UNREADABLE-SECRET-VALUE-5678");
    let quoted = screen_said_for_post(Some("said UNREADABLE-SECRET-VALUE-5678"), &s);
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(blocked, None, "못 읽으면 올리지 않는다");
    assert_eq!(quoted, None, "화면 인용을 뺀다");
    // 폴더가 없다 = 마운트한 것 없음 → 평소대로
    std::fs::remove_dir_all(&base).unwrap();
    assert_eq!(s.guard_body("plain").as_deref(), Some("plain"));
}
