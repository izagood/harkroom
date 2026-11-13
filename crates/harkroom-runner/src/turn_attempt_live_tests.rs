use std::sync::Arc;

use serde_json::{Value, json};

use super::*;
use crate::mcp::FailOpts;
use crate::mention_scheduler::WakeReportTo;

/// 관문은 부를 때마다 지금 값을 읽는다 — 다른 스레드가 바꾼 펜스·[중단] 이 다음 부름에 바로 보인다.
#[test]
fn gate_reads_current_fence_and_cancel() {
    let live = Arc::new(LiveTurn::default());
    let gate = {
        let l = Arc::clone(&live);
        move || l.gate()
    };
    assert_eq!(gate(), Ok(()));
    let other = Arc::clone(&live);
    std::thread::spawn(move || other.cancel("human-1"))
        .join()
        .unwrap();
    assert_eq!(gate(), Err(SpawnBlocked::Canceled));
    assert_eq!(live.canceled_by().as_deref(), Some("human-1"));

    let live = Arc::new(LiveTurn::default());
    let l = Arc::clone(&live);
    let gate = move || l.gate();
    assert_eq!(gate(), Ok(()));
    let other = Arc::clone(&live);
    std::thread::spawn(move || other.fence_lost())
        .join()
        .unwrap();
    assert_eq!(gate(), Err(SpawnBlocked::FencedOut));
    assert!(live.fenced_out());
}

/// 처음 [중단] 한 사람이 남는다 · 펜스가 [중단] 보다 먼저 판정된다(정본 순서).
#[test]
fn first_cancel_wins_and_fence_checked_first() {
    let live = LiveTurn::default();
    live.cancel("a");
    live.cancel("b");
    assert_eq!(live.canceled_by().as_deref(), Some("a"));
    live.fence_lost();
    assert_eq!(live.gate(), Err(SpawnBlocked::FencedOut));
}

/// 가짜 보고처·채널.
#[derive(Default)]
struct Io {
    thread: Vec<Value>,
    channel: Vec<Value>,
    fails: Vec<String>,
}

impl ReportIo for &mut Io {
    fn read_thread(
        &mut self,
        _: &str,
        _: &str,
        since: i64,
        limit: u32,
    ) -> Result<Vec<Value>, String> {
        Ok(self
            .thread
            .iter()
            .filter(|m| m["seq"].as_i64().unwrap_or(0) > since)
            .take(limit as usize)
            .cloned()
            .collect())
    }
    fn read_channel_since(&mut self, _: &str, _: i64, _: u32) -> Result<Vec<Value>, String> {
        Ok(self.channel.clone())
    }
    fn fail(&mut self, _: &str, body: &str, _: &str, _: &FailOpts) -> Result<(), String> {
        self.fails.push(body.to_string());
        Ok(())
    }
}

/// 보고처 약속 닫개 — #2006 의 사유 가림(PAT·`@`)이 그대로 든다.
#[test]
fn report_promise_runner_uses_masked_reason() {
    let mut io = Io::default();
    let rt = WakeReportTo {
        channel_id: "c1".into(),
        thread_root_id: "rt".into(),
    };
    let pat = "hk_pat_secret_value_77";
    let reason = format!("@task_manager 에게 {pat}");
    {
        let mut run = report_promise_runner(
            &mut io,
            ReportPromise {
                me_id: "me",
                report_to: &rt,
                base_seq: 10,
                scheduled_turn_id: Some("sched"),
                reason: &reason,
                anchor: "anc",
                anchor_channel_id: "c1",
                pat,
                secrets: &[],
            },
        );
        run().unwrap();
    }
    assert_eq!(io.fails.len(), 1);
    let body = &io.fails[0];
    assert_eq!(
        body,
        &crate::turn_report::report_missed_notice(Some(&reason), "anc", pat, &[]),
        "#2006 함수 그대로"
    );
    assert!(!body.contains('@') && !body.contains(pat), "{body}");
}

/// 앵커 밖 정황 닫개 — #2005 `off_anchor_evidence` 그대로(이 턴의 글만, 링크 문장).
#[test]
fn off_anchor_reader_uses_off_anchor_evidence() {
    let msg = json!({"id":"m9","seq":12,"authorId":"me","kind":"text","threadRootId":"other",
        "channelId":"c1","meta":{"turnId":"t1"}});
    let mut io = Io {
        channel: vec![msg],
        ..Io::default()
    };
    let args = || OffAnchorArgs {
        key: "k",
        me_id: "me",
        channel_id: "c1",
        anchor: Some("anc"),
        turn_start_seq: 10,
        turn_id: "t1",
    };
    let want = {
        let mut io2 = Io {
            channel: io.channel.clone(),
            ..Io::default()
        };
        off_anchor_evidence(&mut &mut io2, "k", "me", "c1", Some("anc"), 10, "t1")
    };
    let got = off_anchor_reader(&mut io, args())();
    assert_eq!(got, want);
    assert!(got.is_some_and(|s| s.contains("harkroom://message/other")));
}
