//! [`mention_watch_loop`] — 감시 루프의 펜스가 `MentionSlots::open` 으로 연 **그 멘션 슬롯**을 따르는지.
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use harkroom_proto::p1::RunnerLinkResponse;

use super::*;
use crate::link::LinkRequest;
use crate::mention_parts::LoopCtx;
use crate::turn_attempt_account::MentionSlots;
use crate::turn_attempt_live::LiveTurn;
use crate::turn_probe_records::NoticeSecrets;
use crate::turn_watch::Watch;

struct NoLink;
impl RunnerLink for &NoLink {
    fn request(&self, _req: LinkRequest) -> RunnerLinkResponse {
        panic!("펜스에 걸린 주기는 탐침(서버 읽기)을 돌지 않는다")
    }
}

fn no_report(_s: &[String], _t: i64) {}

fn inputs<'a>(client: &'a HarkroomMcpClient<&'a NoLink>) -> MentionWatchInputs<'a, &'a NoLink> {
    MentionWatchInputs {
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
        clock: || 1,
        probe_ms: Duration::from_millis(1),
    }
}

#[test]
fn fence_follows_the_opened_mention_slot_only() {
    let link = NoLink;
    let client = HarkroomMcpClient::new(&link, "t");
    let slots = MentionSlots::default();
    let m1 = slots.open("m1");
    let m2 = slots.open("m2");
    let lf = mention_watch_loop(inputs(&client), m1.slot());

    // 두 멘션에 시도가 하나씩 걸렸다. m2 만 임대를 잃는다 → m1 루프는 펜스에 걸리지 않는다.
    let (l1, l2) = (Arc::new(LiveTurn::default()), Arc::new(LiveTurn::default()));
    m1.slot().bind(Some(l1));
    m2.slot().bind(Some(l2));
    assert!(slots.fence_lost("m2"));
    assert!(
        !m1.slot().fenced_out(),
        "다른 멘션의 임대 잃음은 m1 슬롯에 닿지 않는다"
    );

    // 이제 m1 이 임대를 잃는다 → m1 루프는 그 자리에 거둠을 적고 멈춘다(서버 읽기 없이).
    assert!(slots.fence_lost("m1"));
    let w = Watch::default();
    w.lock().unwrap().end.has_controls = true;
    let ctx = LoopCtx::default();
    lf(&w, &NoticeSecrets::default(), &ctx, &AtomicBool::new(false));
    assert!(w.lock().unwrap().end.reclaimed, "m1 자리에 거둠");
}
