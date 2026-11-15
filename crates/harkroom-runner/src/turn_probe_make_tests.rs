//! [`probe_make`] — 시도마다 받은 자리·목록·문맥으로만 짓는지(앞 시도의 것이 다음 시도 탐침에 남지 않는지).
use harkroom_proto::p1::RunnerLinkResponse;

use super::*;
use crate::link::LinkRequest;

struct NoLink;
impl RunnerLink for &NoLink {
    fn request(&self, _req: LinkRequest) -> RunnerLinkResponse {
        panic!("짓기만 한다 — 링크를 부르지 않는다")
    }
}

fn no_report(_s: &[String], _t: i64) {}

fn ctx(tag: &str, seq: i64, at: i64) -> LoopCtx {
    LoopCtx {
        turn_id: format!("turn-{tag}"),
        session_id: Some(format!("sess-{tag}")),
        turn_started_at_ms: at,
        turn_start_seq: seq,
        claude_config_dir: None,
        ended: Arc::new(AtomicBool::new(false)),
    }
}

fn notice(tag: &str) -> NoticeSecrets {
    NoticeSecrets {
        pat: "pat".into(),
        mounted: vec![format!("mounted-{tag}")],
        lease_dir: None,
    }
}

fn config<'a>(
    client: &'a HarkroomMcpClient<&'a NoLink>,
    slot: LiveSlot,
) -> ProbeLoopConfig<'a, &'a NoLink> {
    ProbeLoopConfig {
        client,
        key: "k".into(),
        me_id: "me".into(),
        channel_id: "c".into(),
        anchor: Some("root".into()),
        harness: AgentHarness::ClaudeCode,
        home: None,
        omp_home: None,
        opencode: None,
        end_cfg: EndConfig::new(60_000),
        lane_tui: false,
        caller: NudgeCaller::Human,
        report_auth: &no_report,
        slot,
        clock: || 1,
    }
}

#[test]
fn a1_context_does_not_stay_in_the_a2_loop() {
    let link = NoLink;
    let client = HarkroomMcpClient::new(&link, "t");
    let cfg = config(&client, LiveSlot::default());
    let make = probe_make(cfg);
    let (w1, w2) = (Watch::default(), Watch::default());

    let p1 = make(&w1, &notice("a1"), &ctx("a1", 10, 1_000));
    let p2 = make(&w2, &notice("a2"), &ctx("a2", 20, 2_000));

    for (p, w, tag, seq, at) in [(&p1, &w1, "a1", 10, 1_000), (&p2, &w2, "a2", 20, 2_000)] {
        let io = &p.io;
        let sess = format!("sess-{tag}");
        assert_eq!(
            io.spoke_key.turn_id.as_deref(),
            Some(format!("turn-{tag}").as_str())
        );
        assert_eq!(io.spoke_key.since_seq, seq);
        assert_eq!(io.turn_started_at_ms, at);
        assert_eq!(p.probe.turn_started_at_ms, at);
        assert_eq!(io.records.session_id.as_deref(), Some(sess.as_str()));
        assert_eq!(io.records.since_ms, at);
        assert_eq!(
            io.turn_state_records.session_id.as_deref(),
            Some(sess.as_str())
        );
        assert_eq!(io.secrets.mounted, vec![format!("mounted-{tag}")]);
        assert_eq!(io.sink.secrets.mounted, vec![format!("mounted-{tag}")]);
        assert!(
            Arc::ptr_eq(&io.rest.nudge.watch, w),
            "재촉 IO 는 그 시도의 자리"
        );
    }
    assert!(
        !Arc::ptr_eq(&p2.io.rest.nudge.watch, &w1),
        "a2 재촉이 a1 자리를 쥐지 않는다"
    );
}

#[test]
fn fence_check_follows_the_bound_attempt() {
    use crate::turn_attempt_live::LiveTurn;
    let link = NoLink;
    let client = HarkroomMcpClient::new(&link, "t");
    let slot = LiveSlot::default();
    let cfg = config(&client, slot.clone());
    let make = probe_make(cfg);
    let mut p = make(&Watch::default(), &notice("a"), &ctx("a", 1, 1));
    let live = Arc::new(LiveTurn::default());
    slot.bind(Some(live.clone()));
    let f = p.fence.as_mut().unwrap();
    assert!(!(f.lost)());
    live.fence_lost();
    assert!((f.lost)(), "걸린 시도가 임대를 잃으면 펜스가 잃음을 본다");
}

fn transcript(dir: &std::path::Path, session: &str, said: &str) -> std::path::PathBuf {
    let p = dir.join("projects").join("p");
    std::fs::create_dir_all(&p).unwrap();
    let f = p.join(format!("{session}.jsonl"));
    let rec = serde_json::json!({
        "type": "assistant",
        "timestamp": "2026-11-13T14:00:00.000Z",
        "message": {"role": "assistant", "stop_reason": "end_turn", "content": said},
    });
    std::fs::write(&f, format!("{rec}\n")).unwrap();
    f
}

/// security #2073 막음 1: 계정 폴더는 그 시도 것만 — 같은 세션 id 여도 a2 읽개(records·said·mtime)는 a2 계정 폴더를 본다.
#[test]
fn readers_use_the_attempts_account_folder() {
    let root = std::env::temp_dir().join(format!("hk-pmake-acct-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let (d1, d2) = (root.join("acct1"), root.join("acct2"));
    transcript(&d1, "sess-x", "a1 said");
    let f2 = transcript(&d2, "sess-x", "a2 said");

    let link = NoLink;
    let client = HarkroomMcpClient::new(&link, "t");
    let cfg = config(&client, LiveSlot::default());
    let make = probe_make(cfg);
    let at = |dir: &std::path::Path| LoopCtx {
        session_id: Some("sess-x".into()),
        claude_config_dir: Some(dir.to_path_buf()),
        ..ctx("a", 1, 0)
    };
    let _p1 = make(&Watch::default(), &notice("a1"), &at(&d1));
    let mut p2 = make(&Watch::default(), &notice("a2"), &at(&d2));

    assert_eq!(p2.io.records.config_dir.as_deref(), Some(d2.as_path()));
    assert_eq!(
        p2.io.turn_state_records.config_dir.as_deref(),
        Some(d2.as_path())
    );
    assert_eq!(
        crate::turn_probe_rest::NudgeIo::read_said(&mut p2.io.rest.nudge).as_deref(),
        Some("a2 said"),
        "마지막 말은 a2 계정 폴더에서"
    );
    let want = std::fs::metadata(&f2)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    assert_eq!(
        (p2.io.rest.transcript_mtime_ms)(),
        Some(want),
        "mtime 은 a2 기록"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// security #2073 막음 2: 끝 신호는 시도마다 새로 — a1 이 끝난 뒤에도 a2 루프는 임대 잃음에 접고 SIGTERM 을 보낸다.
#[test]
fn a1_end_signal_does_not_stop_the_a2_loop() {
    use crate::turn_attempt_live::LiveTurn;
    use crate::turn_watch::run_watch_guarded;
    let link = NoLink;
    let client = HarkroomMcpClient::new(&link, "t");
    let slot = LiveSlot::default();
    let cfg = config(&client, slot.clone());
    let end_cfg = cfg.end_cfg;
    let make = probe_make(cfg);

    let c1 = ctx("a1", 1, 1);
    let _p1 = make(&Watch::default(), &notice("a1"), &c1);
    c1.ended.store(true, std::sync::atomic::Ordering::SeqCst); // a1 PTY 턴이 끝났다.

    let w2 = Watch::default();
    w2.lock().unwrap().end.has_controls = true;
    let c2 = ctx("a2", 2, 2);
    let mut p2 = make(&w2, &notice("a2"), &c2);
    let live = Arc::new(LiveTurn::default());
    slot.bind(Some(live.clone()));
    live.fence_lost();

    let kills = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let k = kills.clone();
    let terminate: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        k.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });
    run_watch_guarded(
        &w2,
        &mut p2.probe,
        &end_cfg,
        &mut p2.io,
        std::time::Duration::from_millis(1),
        crate::turn_watch::WatchStops {
            stop: &AtomicBool::new(false),
            ended: p2.ended.as_deref(),
            fence: p2.fence.as_mut(),
            terminate: Some(terminate),
        },
    );
    assert!(w2.lock().unwrap().end.reclaimed, "a2 자리에 거둠");
    assert_eq!(
        kills.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "a2 에 SIGTERM"
    );
}

/// P2: 러너 물러남(`stop_all`)도 감시 루프의 거둠 확인을 연다 — 같은 SIGTERM 길이다. 걸린 시도는 임대 잃음이 아니다.
#[test]
fn shutdown_stopping_opens_the_reclaim_check() {
    use crate::turn_attempt_account::MentionSlots;
    use crate::turn_attempt_live::LiveTurn;
    let slots = MentionSlots::default();
    let opened = slots.open("m1");
    let slot = opened.slot();
    let link = NoLink;
    let client = HarkroomMcpClient::new(&link, "t");
    let make = probe_make(config(&client, slot.clone()));
    let mut p = make(&Watch::default(), &notice("a"), &ctx("a", 1, 1));
    let live = Arc::new(LiveTurn::default());
    slot.bind(Some(live.clone()));
    let f = p.fence.as_mut().unwrap();
    assert!(!(f.lost)());
    slots.stop_all();
    assert!((f.lost)(), "물러남이 거둠을 연다");
    assert!(!live.fenced_out());
}

// ───────────────────────── opencode·kilo 차례 끝 조회(r-nudge) ─────────────────────────

struct Tmp(std::path::PathBuf);
impl Tmp {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!(
            "hk-probe-make-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        Self(std::fs::canonicalize(&p).unwrap())
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 러너 부모 env 에 열쇠가 섞여 있다고 놓는다 — 조회 env 에 하나도 가면 안 된다.
fn parent_with_keys(path: &str) -> BTreeMap<String, String> {
    [
        ("PATH", path),
        ("HOME", "/h"),
        ("LANG", "C.UTF-8"),
        ("XDG_DATA_HOME", "/human/data"),
        ("HARKROOM_RUNNER_SECRET", "runner-secret-x"),
        ("HARKROOM_TURN_BRIDGE_KEY", "bridge-key-x"),
        ("HARKROOM_RUNNER_SOCKET", "/sock"),
        ("OPENAI_API_KEY", "api-key-x"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

#[test]
fn opencode_query_env_is_the_allow_list_plus_isolated_xdg() {
    let parent = parent_with_keys("/usr/bin:/bin");
    let env = opencode_query_env(
        AgentHarness::Opencode,
        &parent,
        Path::new("/h"),
        Path::new("/oc"),
    );
    for k in [
        "HARKROOM_RUNNER_SECRET",
        "HARKROOM_TURN_BRIDGE_KEY",
        "HARKROOM_RUNNER_SOCKET",
        "OPENAI_API_KEY",
    ] {
        assert!(!env.contains_key(k), "{k} 가 조회 env 에 들어갔다");
    }
    assert!(!env.values().any(|v| v.ends_with("-x")), "열쇠 값이 샜다");
    // 격리 홈 자리가 사람 XDG 를 덮는다.
    assert_eq!(env["XDG_CONFIG_HOME"], "/oc/config");
    assert_eq!(env["XDG_DATA_HOME"], "/oc/data");
    assert_eq!(env["XDG_STATE_HOME"], "/oc/state");
    // 프로젝트 설정 끄기 스위치와 하네스 PATH(설치 관례 자리 덧붙임).
    assert_eq!(env["OPENCODE_DISABLE_PROJECT_CONFIG"], "1");
    assert_eq!(env["PATH"], "/usr/bin:/bin:/h/.opencode/bin");
    assert_eq!(env["LANG"], "C.UTF-8");
}

#[test]
fn opencode_query_only_for_xdg_harnesses_with_a_home() {
    let parent = parent_with_keys("/usr/bin");
    let (h, ws) = (Path::new("/h"), Path::new("/ws"));
    let oc = Some(Path::new("/oc"));
    assert!(opencode_query(AgentHarness::ClaudeCode, &parent, h, oc, ws).is_none());
    assert!(opencode_query(AgentHarness::Omp, &parent, h, oc, ws).is_none());
    assert!(opencode_query(AgentHarness::Opencode, &parent, h, None, ws).is_none());
    let k = opencode_query(AgentHarness::Kilo, &parent, h, oc, ws).unwrap();
    assert_eq!(k.command, PathBuf::from("kilo"));
    assert_eq!(k.cwd, PathBuf::from("/ws"));
    assert_eq!(k.env["KILO_DISABLE_PROJECT_CONFIG"], "1");
}

/// 가짜 `opencode` — 작업 폴더에서 불렸을 때만 목록을 내고, 받은 env 이름을 파일에 적는다.
fn fake_opencode(tmp: &Path, ws: &Path, started: i64) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let bin = tmp.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let t = started + 1_000;
    let list = serde_json::json!([{"id":"ses_1","directory":ws.to_string_lossy(),"created":t}]);
    let exp = serde_json::json!({"info":{},"messages":[
        {"info":{"role":"user"}},
        {"info":{"role":"assistant","time":{"created":t,"completed":t+1},"finish":"stop"},"parts":[]}
    ]});
    std::fs::write(tmp.join("list.json"), list.to_string()).unwrap();
    std::fs::write(tmp.join("export.json"), exp.to_string()).unwrap();
    let script = bin.join("opencode");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\n/usr/bin/env > \"{d}/env.$1\"\n[ \"$(pwd -P)\" = \"{ws}\" ] || {{ echo '[]'; exit 0; }}\ncase \"$1\" in\n  session) cat \"{d}/list.json\";;\n  export) [ \"$2\" = ses_1 ] && cat \"{d}/export.json\";;\nesac\n",
            ws = ws.display(),
            d = tmp.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

fn attempt_records(harness: AgentHarness, q: Option<OpencodeQuery>, since: i64) -> AttemptRecords {
    AttemptRecords {
        harness,
        session_id: None,
        config_dir: None,
        home: None,
        omp_home: None,
        since_ms: since,
        now: || 0,
        opencode: q.map(Arc::new),
    }
}

/// #2159 실물에서 Rust 러너 opencode lane 턴이 멈춘 자리 — 조회가 이어져 있으면 「끝났다」를 알아 재촉(`nudge_or_expire`)으로 간다.
#[test]
fn silent_opencode_turn_is_seen_ended_through_the_query() {
    use crate::turn_end::EndState;
    use crate::turn_probe_state::{TurnStateCtx, TurnStateNote, TurnStateProbe, probe_turn_state};
    let tmp = Tmp::new("oc");
    let ws = tmp.0.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let started = 1_700_000_000_000;
    let bin = fake_opencode(&tmp.0, &ws, started);
    let parent = parent_with_keys(&format!("{}:/usr/bin:/bin", bin.display()));
    let q = opencode_query(
        AgentHarness::Opencode,
        &parent,
        &tmp.0,
        Some(&tmp.0.join("oc")),
        &ws,
    )
    .unwrap();

    let ctx = TurnStateCtx {
        harness: AgentHarness::Opencode,
        turn_started_at_ms: started,
        lane_nudged_at_ms: 0,
        opencode_quiet_ms: OPENCODE_QUIET_MS,
    };
    let quiet_since = started + 5_000;
    let mut end = EndState {
        last_data_at_ms: quiet_since,
        ..EndState::default()
    };
    let mut now = || quiet_since + OPENCODE_QUIET_MS;

    // 조회 없음(이 PR 전) — 모른다. 끝을 못 알아 재촉까지 가지 않는다.
    let mut none = attempt_records(AgentHarness::Opencode, None, started);
    probe_turn_state(
        &mut end,
        &mut TurnStateProbe::default(),
        &ctx,
        &EndConfig::new(60_000),
        &mut now,
        &|| false,
        &mut none,
    );
    assert!(!end.finished);

    // 조회 있음 — 끝났다.
    let mut recs = attempt_records(AgentHarness::Opencode, Some(q), started);
    let note = probe_turn_state(
        &mut end,
        &mut TurnStateProbe::default(),
        &ctx,
        &EndConfig::new(60_000),
        &mut now,
        &|| false,
        &mut recs,
    );
    assert_eq!(note, TurnStateNote::OpencodeEnded);
    assert!(end.finished);

    // 조회 자식이 받은 env — 열쇠 없음(되돌려 부모 env 를 통째로 주면 빨강).
    for which in ["session", "export"] {
        let got = std::fs::read_to_string(tmp.0.join(format!("env.{which}"))).unwrap();
        for k in [
            "HARKROOM_RUNNER_SECRET",
            "HARKROOM_TURN_BRIDGE_KEY",
            "HARKROOM_RUNNER_SOCKET",
            "OPENAI_API_KEY",
        ] {
            assert!(
                !got.contains(&format!("{k}=")),
                "{which} 조회에 {k} 가 갔다"
            );
        }
        assert!(!got.contains("-x\n"), "{which} 조회에 열쇠 값이 갔다");
        assert!(got.contains(&format!(
            "XDG_DATA_HOME={}",
            tmp.0.join("oc/data").display()
        )));
    }
}

/// 짓개가 멘션 설정의 조회 자리를 시도 기록에 넘긴다(빠뜨리면 `opencode: None` 으로 돌아가 다시 멈춘다).
#[test]
fn probe_make_records_carry_the_query() {
    let link = NoLink;
    let client = HarkroomMcpClient::new(&link, "t");
    let mut c = config(&client, LiveSlot::default());
    let q = OpencodeQuery {
        command: "opencode".into(),
        env: Env::new(),
        cwd: "/ws".into(),
    };
    c.harness = AgentHarness::Opencode;
    c.opencode = Some(Arc::new(q));
    let r = records_of(&c, &ctx("a", 1, 10));
    assert_eq!(
        r.opencode.as_deref().map(|q| q.cwd.clone()),
        Some("/ws".into())
    );
    assert!(r.state_view().opencode.is_some());
}
