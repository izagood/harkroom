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
    }
}

fn notice(tag: &str) -> NoticeSecrets {
    NoticeSecrets {
        pat: "pat".into(),
        mounted: vec![format!("mounted-{tag}")],
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
        claude_config_dir: None,
        home: None,
        omp_home: None,
        end_cfg: EndConfig::new(60_000),
        lane_tui: false,
        caller: NudgeCaller::Human,
        report_auth: &no_report,
        slot,
        ended: Arc::new(AtomicBool::new(false)),
        clock: || 1,
    }
}

#[test]
fn a1_context_does_not_stay_in_the_a2_loop() {
    let link = NoLink;
    let client = HarkroomMcpClient::new(&link, "t");
    let cfg = config(&client, LiveSlot::default());
    let make = probe_make(&cfg);
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
    let make = probe_make(&cfg);
    let mut p = make(&Watch::default(), &notice("a"), &ctx("a", 1, 1));
    let live = Arc::new(LiveTurn::default());
    slot.bind(Some(live.clone()));
    let f = p.fence.as_mut().unwrap();
    assert!(!(f.lost)());
    live.fence_lost();
    assert!((f.lost)(), "걸린 시도가 임대를 잃으면 펜스가 잃음을 본다");
}
