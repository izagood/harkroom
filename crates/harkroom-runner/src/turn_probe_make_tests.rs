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
