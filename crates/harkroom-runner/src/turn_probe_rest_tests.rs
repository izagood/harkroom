//! 재촉·회수 시계·정지 처리·탐침 주기 시험.

use super::*;
use crate::harness_records::RecordedTurnEnd;
use crate::turn_end::{EndAction, StallVerdict};
use std::time::Instant;

#[derive(Default)]
struct FakeNudge {
    now: i64,
    lane: bool,
    exited: bool,
    said: Option<String>,
    caller: Option<NudgeCaller>,
    off_anchor: bool,
    written: Vec<Vec<u8>>,
    submits: usize,
    rearms: usize,
}

impl NudgeIo for FakeNudge {
    fn now_ms(&self) -> i64 {
        self.now
    }
    fn lane_tui_turn(&self) -> bool {
        self.lane
    }
    fn exited(&self) -> bool {
        self.exited
    }
    fn read_said(&mut self) -> Option<String> {
        self.said.clone()
    }
    fn caller(&self) -> NudgeCaller {
        self.caller.unwrap_or(NudgeCaller::Human)
    }
    fn answered_off_anchor(&mut self) -> bool {
        self.off_anchor
    }
    fn write_pty(&mut self, bytes: &[u8]) -> bool {
        self.written.push(bytes.to_vec());
        true
    }
    fn submit_later(&mut self, _delay: Duration) {
        self.submits += 1;
    }
    fn rearm_screen_watch(&mut self) {
        self.rearms += 1;
    }
    fn log(&mut self, _line: &str) {}
}

fn finished_end() -> EndState {
    EndState {
        has_controls: true,
        finished: true,
        pending: Some(0),
        ..EndState::default()
    }
}

fn target() -> NudgeTarget {
    NudgeTarget {
        channel_id: "c1".into(),
        thread_root_id: Some("t1".into()),
    }
}

#[test]
fn lane_turn_finished_silently_is_nudged_once_with_bracketed_paste() {
    let mut end = finished_end();
    let mut probe = ProbeState::default();
    let mut io = FakeNudge {
        now: 1_000,
        lane: true,
        ..FakeNudge::default()
    };
    nudge_or_expire(&mut end, &mut probe, &mut io, &target(), LANE_NUDGE_WAIT_MS);
    assert_eq!(probe.lane_nudged_at_ms, 1_000);
    assert!(!end.finished && end.tail.is_none() && end.last_life_ms == 1_000);
    assert_eq!(io.written.len(), 1);
    let w = &io.written[0];
    assert!(w.starts_with(b"\x1b[200~") && w.ends_with(b"\x1b[201~"));
    assert_eq!(io.submits, 1);
    assert_eq!(io.rearms, 1);
    // 두 번째 주기는 다시 재촉하지 않는다.
    end.finished = true;
    io.now = 2_000;
    nudge_or_expire(&mut end, &mut probe, &mut io, &target(), LANE_NUDGE_WAIT_MS);
    assert_eq!(io.written.len(), 1);
}

#[test]
fn nudge_expires_after_wait() {
    let mut end = EndState {
        has_controls: true,
        ..EndState::default()
    };
    let mut probe = ProbeState {
        lane_nudged_at_ms: 1_000,
        ..ProbeState::default()
    };
    let mut io = FakeNudge {
        now: 1_000 + LANE_NUDGE_WAIT_MS - 1,
        lane: true,
        ..FakeNudge::default()
    };
    nudge_or_expire(&mut end, &mut probe, &mut io, &target(), LANE_NUDGE_WAIT_MS);
    assert!(!end.finished);
    io.now = 1_000 + LANE_NUDGE_WAIT_MS;
    nudge_or_expire(&mut end, &mut probe, &mut io, &target(), LANE_NUDGE_WAIT_MS);
    assert!(end.finished && end.pending == Some(0));
}

#[test]
fn no_nudge_outside_lane_with_viewers_pending_or_off_anchor_answer() {
    let cases: Vec<(EndState, FakeNudge)> = vec![
        (finished_end(), FakeNudge::default()), // lane 이 아님
        (
            EndState {
                viewers: 1,
                ..finished_end()
            },
            FakeNudge {
                lane: true,
                ..FakeNudge::default()
            },
        ),
        (
            EndState {
                pending: Some(2),
                ..finished_end()
            },
            FakeNudge {
                lane: true,
                ..FakeNudge::default()
            },
        ),
        (
            finished_end(),
            FakeNudge {
                lane: true,
                off_anchor: true,
                ..FakeNudge::default()
            },
        ),
        (
            finished_end(),
            FakeNudge {
                lane: true,
                caller: Some(NudgeCaller::Wake),
                ..FakeNudge::default()
            },
        ),
    ];
    for (mut end, mut io) in cases {
        let mut probe = ProbeState::default();
        nudge_or_expire(&mut end, &mut probe, &mut io, &target(), LANE_NUDGE_WAIT_MS);
        assert!(io.written.is_empty());
        assert_eq!(probe.lane_nudged_at_ms, 0);
    }
}

struct Built {
    rest: TurnProbeRest<FakeNudge>,
    end: Arc<Mutex<EndState>>,
    terms: Arc<Mutex<usize>>,
    enters: Arc<Mutex<usize>>,
}

fn built(end: EndState) -> Built {
    let terms = Arc::new(Mutex::new(0usize));
    let enters = Arc::new(Mutex::new(0usize));
    let t = terms.clone();
    let e = enters.clone();
    let end = Arc::new(Mutex::new(end));
    let slot = end.clone();
    Built {
        end,
        rest: TurnProbeRest {
            nudge: FakeNudge::default(),
            nudge_target: target(),
            nudge_wait_ms: LANE_NUDGE_WAIT_MS,
            on_reclaim: Arc::new(move || slot.lock().unwrap().on_reclaim_timer()),
            ended: Arc::new(AtomicBool::new(false)),
            terminate: Arc::new(move || *t.lock().unwrap() += 1),
            write_pty: Box::new(move |b| {
                if b == b"\r" {
                    *e.lock().unwrap() += 1;
                }
                true
            }),
            reads_transcript: true,
            transcript_mtime_ms: Box::new(|| Some(42)),
            reclaim_timer: None,
        },
        terms,
        enters,
    }
}

fn wait_until(f: impl Fn() -> bool) {
    let start = Instant::now();
    while !f() && start.elapsed() < Duration::from_secs(2) {
        std::thread::yield_now();
    }
}

#[test]
fn armed_reclaim_clock_terminates_live_turn_only() {
    let b = built(EndState {
        has_controls: true,
        ..EndState::default()
    });
    let mut rest = b.rest;
    rest.apply_end_action(EndAction::Arm { grace_ms: 10 });
    wait_until(|| *b.terms.lock().unwrap() > 0);
    assert_eq!(*b.terms.lock().unwrap(), 1);
    assert!(b.end.lock().unwrap().reclaimed);

    // 끝난 턴이면 시계가 울려도 SIGTERM 을 보내지 않는다.
    let b2 = built(EndState {
        has_controls: true,
        ..EndState::default()
    });
    let mut rest2 = b2.rest;
    rest2.apply_end_action(EndAction::Arm { grace_ms: 20 });
    rest2.ended.store(true, Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(*b2.terms.lock().unwrap(), 0);

    // Disarm 은 시계를 끊고, ReclaimNow 는 바로 보낸다.
    let b3 = built(EndState::default());
    let mut rest3 = b3.rest;
    rest3.apply_end_action(EndAction::Arm { grace_ms: 30 });
    rest3.apply_end_action(EndAction::Disarm);
    assert!(rest3.reclaim_timer.is_none());
    rest3.apply_end_action(EndAction::ReclaimNow { kill: true });
    assert_eq!(*b3.terms.lock().unwrap(), 1);

    // 시계를 쥔 값이 떨어지면(시도 끝·패닉 풀림) 시계도 멈춘다.
    let b4 = built(EndState {
        has_controls: true,
        ..EndState::default()
    });
    let mut rest4 = b4.rest;
    rest4.apply_end_action(EndAction::Arm { grace_ms: 20 });
    drop(rest4);
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(*b4.terms.lock().unwrap(), 0);
    assert!(!b4.end.lock().unwrap().reclaimed);
}

#[test]
fn stall_probe_and_verdicts() {
    let b = built(EndState::default());
    let mut rest = b.rest;
    let p = rest.stall_probe(&EndState::default(), 7);
    assert_eq!(
        (
            p.reads_transcript,
            p.transcript_mtime_ms,
            p.looks_unsent,
            p.now_ms
        ),
        (true, Some(42), false, 7)
    );
    rest.apply_stall(StallVerdict::PressEnter);
    assert_eq!(*b.enters.lock().unwrap(), 1);
    rest.apply_stall(StallVerdict::Stalled {
        idle_ms: 1,
        kill: true,
    });
    assert_eq!(*b.terms.lock().unwrap(), 1);
    // 끝난 턴에는 Enter·SIGTERM 을 보내지 않는다.
    rest.ended.store(true, Ordering::SeqCst);
    rest.apply_stall(StallVerdict::PressEnter);
    rest.apply_stall(StallVerdict::Stalled {
        idle_ms: 1,
        kill: true,
    });
    assert_eq!(
        (*b.enters.lock().unwrap(), *b.terms.lock().unwrap()),
        (1, 1)
    );
}

// ---- 탐침 주기 ----

#[derive(Default)]
struct CountIo {
    reads: usize,
    posts: usize,
}

impl ProbeIo for CountIo {
    fn now_ms(&self) -> i64 {
        0
    }
    fn exited(&self) -> bool {
        false
    }
    fn read_spoke(&mut self) -> Result<bool, String> {
        self.reads += 1;
        Ok(false)
    }
    fn log_unreadable(&mut self, _reason: &str) {}
    fn probe_denials(&mut self, _end: &mut EndState) {
        self.posts += 1;
    }
    fn probe_mac_permission(&mut self, _end: &mut EndState) {}
    fn probe_mcp_auth(&mut self, _end: &mut EndState) {}
    fn probe_api_error(&mut self, _end: &mut EndState) -> bool {
        false
    }
    fn probe_turn_state(&mut self, _end: &mut EndState) {}
    fn screen_idle_ended(&mut self, _now_ms: i64) -> Option<bool> {
        None
    }
    fn read_recorded_end(&mut self, _since_ms: i64) -> Option<RecordedTurnEnd> {
        None
    }
    fn screen_answer(&mut self) -> Option<String> {
        None
    }
    fn log_screen_ended(&mut self) {}
    fn nudge_or_expire(&mut self, _end: &mut EndState, _probe: &mut ProbeState) {}
    fn apply_end_action(&mut self, _action: EndAction) {}
    fn stall_probe(&mut self, _end: &EndState, now_ms: i64) -> StallProbe {
        StallProbe {
            reads_transcript: false,
            transcript_mtime_ms: None,
            looks_unsent: false,
            now_ms,
        }
    }
    fn apply_stall(&mut self, _verdict: StallVerdict) {}
}

fn fence(lost: bool, losts: Arc<Mutex<usize>>) -> FenceCheck {
    FenceCheck {
        listening: Arc::new(AtomicBool::new(true)),
        lost: Box::new(move || lost),
        on_lost: Box::new(move |_end| *losts.lock().unwrap() += 1),
    }
}

#[test]
fn tick_checks_fence_before_probing_and_posts_nothing_when_fenced() {
    let end = Mutex::new(EndState {
        has_controls: true,
        ..EndState::default()
    });
    let ended = AtomicBool::new(false);
    let losts = Arc::new(Mutex::new(0usize));
    let mut f = fence(true, losts.clone());
    let mut probe = ProbeState::default();
    let mut io = CountIo::default();
    let out = probe_tick(
        &end,
        &ended,
        &mut f,
        &mut probe,
        &EndConfig::new(1_800_000),
        &mut io,
    );
    assert_eq!(out, TickOutcome::Fenced);
    assert_eq!(*losts.lock().unwrap(), 1);
    assert_eq!(
        (io.reads, io.posts),
        (0, 0),
        "임대를 잃은 주기는 발화 읽기·통지를 하지 않는다"
    );
}

#[test]
fn tick_stops_when_ended_and_probes_otherwise() {
    let end = Mutex::new(EndState {
        has_controls: true,
        ..EndState::default()
    });
    let losts = Arc::new(Mutex::new(0usize));
    let mut probe = ProbeState::default();

    let ended = AtomicBool::new(true);
    let mut io = CountIo::default();
    let out = probe_tick(
        &end,
        &ended,
        &mut fence(true, losts.clone()),
        &mut probe,
        &EndConfig::new(1_800_000),
        &mut io,
    );
    assert_eq!(out, TickOutcome::Ended);
    assert_eq!(
        (io.reads, *losts.lock().unwrap()),
        (0, 0),
        "끝난 턴은 펜스도 탐침도 보지 않는다"
    );

    let live = AtomicBool::new(false);
    let mut io2 = CountIo::default();
    let out2 = probe_tick(
        &end,
        &live,
        &mut fence(false, losts.clone()),
        &mut probe,
        &EndConfig::new(1_800_000),
        &mut io2,
    );
    assert_eq!(out2, TickOutcome::Again);
    assert_eq!((io2.reads, io2.posts), (1, 1));

    // 펜스를 듣지 않으면(이미 잃은 펜스는 표지만 — spawn_gate 가 띄우기 전에 막는다) 임대를 묻지 않는다.
    let mut f = fence(true, losts.clone());
    f.listening.store(false, Ordering::SeqCst);
    let mut io3 = CountIo::default();
    let out3 = probe_tick(
        &end,
        &live,
        &mut f,
        &mut probe,
        &EndConfig::new(1_800_000),
        &mut io3,
    );
    assert_eq!(out3, TickOutcome::Again);
    assert_eq!(*losts.lock().unwrap(), 0);
}

/// 탐침 주기는 주기마다 돌고, 펜스를 잃으면 스스로 멈춘다.
#[test]
fn probe_loop_runs_until_fenced() {
    struct Shared(Arc<Mutex<usize>>);
    impl ProbeIo for Shared {
        fn now_ms(&self) -> i64 {
            0
        }
        fn exited(&self) -> bool {
            false
        }
        fn read_spoke(&mut self) -> Result<bool, String> {
            *self.0.lock().unwrap() += 1;
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
                reads_transcript: false,
                transcript_mtime_ms: None,
                looks_unsent: false,
                now_ms,
            }
        }
        fn apply_stall(&mut self, _v: StallVerdict) {}
    }
    let reads = Arc::new(Mutex::new(0usize));
    let lose = Arc::new(AtomicBool::new(false));
    let l = lose.clone();
    let losts = Arc::new(Mutex::new(0usize));
    let ls = losts.clone();
    let fence = FenceCheck {
        listening: Arc::new(AtomicBool::new(true)),
        lost: Box::new(move || l.load(Ordering::SeqCst)),
        on_lost: Box::new(move |_e| *ls.lock().unwrap() += 1),
    };
    let _t = start_probe_loop(
        Duration::from_millis(5),
        Arc::new(Mutex::new(EndState {
            has_controls: true,
            ..EndState::default()
        })),
        Arc::new(AtomicBool::new(false)),
        fence,
        ProbeState::default(),
        EndConfig::new(1_800_000),
        Shared(reads.clone()),
    );
    wait_until(|| *reads.lock().unwrap() >= 2);
    lose.store(true, Ordering::SeqCst);
    wait_until(|| *losts.lock().unwrap() >= 1);
    let after = *reads.lock().unwrap();
    std::thread::sleep(Duration::from_millis(40));
    assert_eq!(*losts.lock().unwrap(), 1, "펜스를 잃으면 한 번 접고 멈춘다");
    assert_eq!(*reads.lock().unwrap(), after, "멈춘 뒤에는 탐침하지 않는다");
}
