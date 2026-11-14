//! [`watch_loop_fn`] — 루프가 부를 때마다 그 시도의 자리·목록으로 탐침을 짓는지, 펜스·턴 끝이 그 자리 값으로 가는지.
use std::sync::Mutex;
use std::sync::atomic::Ordering;

use super::*;
use crate::harness_records::RecordedTurnEnd;
use crate::mention_parts::{LoopCtx, run_beside};
use crate::turn_end::{EndAction, EndState, StallProbe, StallVerdict};

/// 받은 자리에만 적고, 정한 주기에 PTY 가 죽은 것으로 답하는 탐침.
struct Io {
    watch: Watch,
    cycles: u32,
    exit_at: u32,
}

impl ProbeIo for Io {
    fn now_ms(&self) -> i64 {
        1_000
    }
    fn exited(&self) -> bool {
        self.cycles >= self.exit_at
    }
    fn read_spoke(&mut self) -> Result<bool, String> {
        self.cycles += 1;
        self.watch.lock().unwrap().end.stalled_idle_ms += 1;
        Ok(false)
    }
    fn log_unreadable(&mut self, _r: &str) {}
    fn probe_denials(&mut self, _e: &mut EndState) {}
    fn probe_mac_permission(&mut self, _e: &mut EndState) {}
    fn probe_mcp_auth(&mut self, _e: &mut EndState) {}
    fn probe_api_error(&mut self, _e: &mut EndState) -> bool {
        false
    }
    fn probe_turn_state(&mut self, _e: &mut EndState) {}
    fn screen_idle_ended(&mut self, _n: i64) -> Option<bool> {
        None
    }
    fn read_recorded_end(&mut self, _s: i64) -> Option<RecordedTurnEnd> {
        None
    }
    fn screen_answer(&mut self) -> Option<String> {
        None
    }
    fn log_screen_ended(&mut self) {}
    fn nudge_or_expire(&mut self, _e: &mut EndState, _p: &mut ProbeState) {}
    fn apply_end_action(&mut self, _a: EndAction) {}
    fn stall_probe(&mut self, _e: &EndState, now_ms: i64) -> StallProbe {
        StallProbe {
            reads_transcript: true,
            transcript_mtime_ms: None,
            looks_unsent: false,
            now_ms,
        }
    }
    fn apply_stall(&mut self, _v: StallVerdict) {}
}

fn notice(tag: &str) -> NoticeSecrets {
    NoticeSecrets {
        pat: format!("pat-{tag}"),
        mounted: vec![format!("mounted-{tag}")],
        lease_dir: None,
    }
}

#[test]
fn each_run_builds_from_that_attempts_watch_and_notice() {
    let seen: Mutex<Vec<(Watch, String)>> = Mutex::default();
    let lf = watch_loop_fn(
        Box::new(|w: &Watch, n: &NoticeSecrets, _c: &LoopCtx| {
            seen.lock().unwrap().push((w.clone(), n.mounted[0].clone()));
            LoopParts {
                io: Io {
                    watch: w.clone(),
                    cycles: 0,
                    exit_at: 2,
                },
                probe: ProbeState::default(),
                ended: None,
                fence: None,
            }
        }),
        EndConfig::new(60_000),
        Duration::from_millis(1),
    );
    let (a1, a2) = (Watch::default(), Watch::default());
    let wait = || std::thread::sleep(Duration::from_millis(30));
    run_beside(&a1, &notice("a1"), &LoopCtx::default(), Some(&lf), wait);
    run_beside(&a2, &notice("a2"), &LoopCtx::default(), Some(&lf), wait);

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert!(Arc::ptr_eq(&seen[0].0, &a1) && seen[0].1 == "mounted-a1");
    assert!(
        Arc::ptr_eq(&seen[1].0, &a2) && seen[1].1 == "mounted-a2",
        "두 번째 시도는 두 번째 자리·목록으로 짓는다"
    );
    // 탐침이 PTY 종료를 본 결과(되쓰기)가 각 시도의 자리에 남는다 — 루프가 그 자리로 돌았다.
    assert!(a1.lock().unwrap().end.exited, "a1 루프는 a1 자리로 돌았다");
    assert!(a2.lock().unwrap().end.exited, "a2 루프는 a2 자리로 돌았다");
}

#[test]
fn lost_fence_from_make_stops_on_that_attempts_slot() {
    let lf = watch_loop_fn(
        Box::new(|w: &Watch, _n: &NoticeSecrets, _c: &LoopCtx| LoopParts {
            io: Io {
                watch: w.clone(),
                cycles: 0,
                exit_at: u32::MAX,
            },
            probe: ProbeState::default(),
            ended: None,
            fence: Some(FenceCheck {
                listening: Arc::new(AtomicBool::new(true)),
                lost: Box::new(|| true),
                on_lost: crate::turn_watch::fence_reclaim(),
            }),
        }),
        EndConfig::new(60_000),
        Duration::from_millis(1),
    );
    let a = Watch::default();
    a.lock().unwrap().end.has_controls = true;
    let stop = AtomicBool::new(false);
    lf(&a, &notice("a"), &LoopCtx::default(), &stop);
    let w = a.lock().unwrap();
    assert!(w.end.reclaimed, "그 시도 자리에 거둠");
    assert_eq!(w.end.stalled_idle_ms, 0, "탐침은 돌지 않았다");
    assert!(!stop.load(Ordering::SeqCst));
}

#[test]
fn ended_turn_from_make_stops_without_probing() {
    let lf = watch_loop_fn(
        Box::new(|w: &Watch, _n: &NoticeSecrets, _c: &LoopCtx| LoopParts {
            io: Io {
                watch: w.clone(),
                cycles: 0,
                exit_at: u32::MAX,
            },
            probe: ProbeState::default(),
            ended: Some(Arc::new(AtomicBool::new(true))),
            fence: None,
        }),
        EndConfig::new(60_000),
        Duration::from_millis(1),
    );
    let a = Watch::default();
    lf(
        &a,
        &notice("a"),
        &LoopCtx::default(),
        &AtomicBool::new(false),
    );
    assert_eq!(a.lock().unwrap().end.stalled_idle_ms, 0);
}
