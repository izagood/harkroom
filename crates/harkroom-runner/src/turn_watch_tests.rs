use std::cell::Cell;

use super::*;
use crate::harness_records::RecordedTurnEnd;
use crate::turn_end::{EndAction, StallProbe, StallVerdict};

/// 주기를 세다가 정해진 주기에 PTY 가 죽은 것으로 답하는 탐침.
struct Io {
    cycles: Cell<u32>,
    exit_at: u32,
}

impl ProbeIo for Io {
    fn now_ms(&self) -> i64 {
        1_000
    }
    fn exited(&self) -> bool {
        self.cycles.get() >= self.exit_at
    }
    fn read_spoke(&mut self) -> Result<bool, String> {
        self.cycles.set(self.cycles.get() + 1);
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

#[derive(Default)]
struct Rec {
    out: Vec<u8>,
}
impl PromptHooks for Rec {}
impl PtyTurnSink for Rec {
    fn on_output(&mut self, frame: &[u8]) {
        self.out.extend_from_slice(frame);
    }
}

/// 출력은 끝 상태의 시각만 바꾸고 화면 꼬리는 감시 자리 안에만 쥔다(`Debug` 는 길이만) · 안쪽 sink 로도 간다.
#[test]
fn sink_records_time_and_keeps_screen_inside() {
    let watch: Watch = Arc::default();
    let mut inner = Rec::default();
    let now = || 42_i64;
    {
        let mut s = WatchSink {
            inner: &mut inner,
            watch: Arc::clone(&watch),
            now_ms: &now,
            stop_on_spawn: None,
        };
        s.on_output(b"working... token sk-live-zzzzzzzzzzzzzzzzzzzzzzzz\n");
    }
    let w = watch.lock().unwrap();
    assert_eq!(w.end.last_data_at_ms, 42);
    assert_eq!(inner.out.len(), 50);
    let dbg = format!("{w:?}");
    assert!(!dbg.contains("sk-live"), "{dbg}");
    assert!(dbg.contains("screen_len"));
}

/// security: 화면 줄은 `NoticeSecrets` 의 `quoted_line` 만 거쳐 나간다 — 마운트한 비밀·PAT 는 가려지고, 다 가려지면 없다.
#[test]
fn screen_line_goes_out_only_through_quoted_line() {
    let watch: Watch = Arc::default();
    let mut inner = Rec::default();
    let now = || 1_i64;
    let secret = "s3cr3t-mounted-value-0123456789";
    let pat = "hk_pat_secret_value_12";
    {
        let mut s = WatchSink {
            inner: &mut inner,
            watch: Arc::clone(&watch),
            now_ms: &now,
            stop_on_spawn: None,
        };
        s.on_output(b"\x1b[32mstarting\x1b[0m\n");
        s.on_output(format!("done with {secret} and {pat}\n").as_bytes());
    }
    let secrets = NoticeSecrets {
        pat: pat.into(),
        mounted: vec![secret.into()],
    };
    let w = watch.lock().unwrap();
    let line = w.screen_line_for_post(&secrets).unwrap();
    assert!(line.contains("done with"), "{line}");
    assert!(!line.contains(secret) && !line.contains(pat), "{line}");
    assert!(!line.contains('\x1b'), "ANSI 는 벗긴다");
}

/// 화면 꼬리는 상한(4KB) 안에서만 쥔다.
#[test]
fn screen_tail_is_bounded() {
    let watch: Watch = Arc::default();
    let mut inner = Rec::default();
    let now = || 1_i64;
    let mut s = WatchSink {
        inner: &mut inner,
        watch: Arc::clone(&watch),
        now_ms: &now,
        stop_on_spawn: None,
    };
    for _ in 0..100 {
        s.on_output(&[b'x'; 100]);
    }
    assert!(watch.lock().unwrap().screen.len() <= SCREEN_TAIL_MAX);
}

/// 루프: 주기마다 탐침을 돌고 PTY 가 죽으면(`Stop`) 끝난다 · 멈춤 신호면 곧 끝난다.
#[test]
fn watch_loop_runs_until_stop() {
    let watch: Watch = Arc::new(Mutex::new(WatchState {
        end: EndState {
            has_controls: true,
            ..EndState::default()
        },
        ..WatchState::default()
    }));
    let mut probe = ProbeState::default();
    let cfg = EndConfig::new(60_000);
    let mut io = Io {
        cycles: Cell::new(0),
        exit_at: 3,
    };
    let stop = AtomicBool::new(false);
    let n = run_watch(
        &watch,
        &mut probe,
        &cfg,
        &mut io,
        Duration::from_millis(1),
        &stop,
    );
    assert_eq!(n, 3, "셋째 주기 안에서 PTY 종료를 보고 멈춘다");
    assert!(watch.lock().unwrap().end.exited);

    let stop = AtomicBool::new(true);
    let mut io = Io {
        cycles: Cell::new(0),
        exit_at: 99,
    };
    assert_eq!(
        run_watch(
            &watch,
            &mut probe,
            &cfg,
            &mut io,
            Duration::from_millis(1),
            &stop
        ),
        0
    );
}

/// 탐침 IO 가 도는 동안 감시 자리를 다른 쪽(sink·통지 글 짓기)이 잠글 수 있다.
struct BusyIo {
    watch: Watch,
    secrets: NoticeSecrets,
    posted: Vec<Option<String>>,
    sink_wrote: bool,
}

impl ProbeIo for BusyIo {
    fn now_ms(&self) -> i64 {
        1_000
    }
    fn exited(&self) -> bool {
        self.posted.len() >= 2
    }
    fn read_spoke(&mut self) -> Result<bool, String> {
        // 통지 글을 짓듯 화면 줄을 꺼낸다 — 루프가 잠금을 쥐고 있었으면 여기서 막힌다(try_lock 실패).
        let line = self
            .watch
            .try_lock()
            .expect("탐침 IO 중에는 감시 잠금이 풀려 있다")
            .screen_line_for_post(&self.secrets);
        self.posted.push(line);
        // 그사이 PTY 출력이 들어온다(sink 가 시각을 적는다).
        self.watch.lock().unwrap().end.last_data_at_ms = 777;
        self.sink_wrote = true;
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

/// security nit: 탐침이 글을 짓는 주기에 출력이 계속 들어와도 막히지 않는다 — 탐침 IO 는 잠금 밖에서 돌고, 그사이 sink 가
/// 적은 출력 시각은 주기가 끝나 돌려놓을 때 지워지지 않는다.
#[test]
fn probe_io_runs_outside_the_watch_lock() {
    let watch: Watch = Arc::new(Mutex::new(WatchState {
        end: EndState {
            has_controls: true,
            ..EndState::default()
        },
        screen: b"line one\nhello there\n".to_vec(),
        thread_unreadable: false,
        controls: None,
    }));
    let mut io = BusyIo {
        watch: Arc::clone(&watch),
        secrets: NoticeSecrets::default(),
        posted: vec![],
        sink_wrote: false,
    };
    let mut probe = ProbeState::default();
    let cfg = EndConfig::new(60_000);
    let stop = AtomicBool::new(false);
    let n = run_watch(
        &watch,
        &mut probe,
        &cfg,
        &mut io,
        Duration::from_millis(1),
        &stop,
    );
    assert!(n >= 1);
    assert_eq!(
        io.posted.first().cloned().flatten().as_deref(),
        Some("hello there")
    );
    assert!(io.sink_wrote);
    assert_eq!(
        watch.lock().unwrap().end.last_data_at_ms,
        777,
        "sink 가 적은 시각이 남는다"
    );
}

/// 탐침이 잠금 밖에서 도는 사이 회수 시계가 감시 자리에 「거뒀다」를 적는다.
struct ClockFiresIo {
    watch: Watch,
    fired: bool,
}

impl ProbeIo for ClockFiresIo {
    fn now_ms(&self) -> i64 {
        1_000
    }
    fn exited(&self) -> bool {
        false
    }
    fn read_spoke(&mut self) -> Result<bool, String> {
        if !self.fired {
            self.fired = true;
            // 실물 시계 닫개 그대로 — 잠금 밖이라 막히지 않는다.
            assert!(
                reclaim_on_watch(&self.watch)(),
                "손잡이가 있으면 SIGTERM 을 보내라고 한다"
            );
        }
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
            transcript_mtime_ms: Some(now_ms),
            looks_unsent: false,
            now_ms,
        }
    }
    fn apply_stall(&mut self, _v: StallVerdict) {}
}

/// security 조건(#2068 검토): 탐침이 잠금 밖에 있는 사이 시계가 거두면, 되쓴 뒤에도 거둔 채이고 감시 루프가 멈춘다.
/// 되쓰기에서 `reclaimed` 지키기를 빼면 이 시험은 끝없이 돈다(멈춤 신호 없이 `exited` 도 안 선다).
#[test]
fn clock_reclaim_during_probe_survives_write_back_and_stops_the_loop() {
    let watch: Watch = Arc::new(Mutex::new(WatchState {
        end: EndState {
            has_controls: true,
            reclaim_armed: true,
            reclaim_grace_ms: 5_000,
            ..EndState::default()
        },
        ..WatchState::default()
    }));
    let mut io = ClockFiresIo {
        watch: Arc::clone(&watch),
        fired: false,
    };
    let mut probe = ProbeState::default();
    let cfg = EndConfig::new(60_000);
    let stop = AtomicBool::new(false);
    let watchdog = Arc::new(AtomicBool::new(false));
    let n = std::thread::scope(|sc| {
        let wd = Arc::clone(&watchdog);
        let st = &stop;
        sc.spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            if !wd.load(Ordering::SeqCst) {
                st.store(true, Ordering::SeqCst);
            }
        });
        let n = run_watch(
            &watch,
            &mut probe,
            &cfg,
            &mut io,
            Duration::from_millis(1),
            &stop,
        );
        watchdog.store(true, Ordering::SeqCst);
        n
    });
    assert!(!stop.load(Ordering::SeqCst), "멈춤 신호 없이 스스로 멈춘다");
    assert_eq!(n, 1, "시계가 거둔 주기에서 멈춘다");
    let w = watch.lock().unwrap();
    assert!(w.end.reclaimed, "사본 되쓰기가 「거뒀다」를 덮지 않는다");
    assert!(!w.end.reclaim_armed, "울린 시계는 서 있지 않다");
}

/// 한 번 서면 안 내려가는 표지는 되쓰기에서 OR 로 지킨다 — 탐침이 새로 시계를 세웠으면 그 시계는 서 있다.
#[test]
fn write_back_keeps_sticky_flags_and_a_fresh_arm() {
    let before = EndState {
        has_controls: true,
        ..EndState::default()
    };
    let mut slot = EndState {
        stalled: true,
        exited: true,
        reclaimed: true,
        last_data_at_ms: 9,
        ..before.clone()
    };
    let snap = EndState {
        reclaim_armed: true,
        reclaim_grace_ms: 1_000,
        last_data_at_ms: 3,
        ..before.clone()
    };
    write_back(&mut slot, &before, snap);
    assert!(slot.stalled && slot.exited && slot.reclaimed);
    assert_eq!(slot.last_data_at_ms, 9);
    assert!(slot.reclaim_armed, "탐침이 이번 주기에 새로 세운 시계");
}

fn fence(lost: bool) -> FenceCheck {
    FenceCheck {
        listening: Arc::new(AtomicBool::new(true)),
        lost: Box::new(move || lost),
        on_lost: fence_reclaim(),
    }
}

#[test]
fn lost_fence_reclaims_on_the_slot_and_stops_before_probing() {
    let watch = Watch::default();
    lock(&watch).end.has_controls = true;
    let (tx, rx) = std::sync::mpsc::channel();
    let w2 = watch.clone();
    std::thread::spawn(move || {
        let mut io = Io {
            cycles: Cell::new(0),
            exit_at: u32::MAX,
        };
        let stop = AtomicBool::new(false);
        let mut f = fence(true);
        let kills = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let (k, w3) = (kills.clone(), w2.clone());
        // 실물 SIGTERM 처럼 손잡이를 꺼내려 같은 자리를 잠근다 — 잠금 안에서 불리면 여기서 멈춘다.
        let terminate: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let _g = lock(&w3);
            k.fetch_add(1, Ordering::SeqCst);
        });
        let n = run_watch_guarded(
            &w2,
            &mut ProbeState::default(),
            &EndConfig::new(60_000),
            &mut io,
            Duration::from_millis(1),
            WatchStops {
                stop: &stop,
                ended: None,
                fence: Some(&mut f),
                terminate: Some(terminate),
            },
        );
        tx.send((n, io.cycles.get(), kills.load(Ordering::SeqCst)))
            .unwrap();
    });
    let (n, probed, kills) = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("펜스 접기가 잠금 안에서 SIGTERM 을 불러 멈췄다");
    assert_eq!(n, 0, "펜스에 걸린 주기는 세지 않는다");
    assert_eq!(
        probed, 0,
        "임대를 잃은 턴은 탐침(발화 읽기·통지)을 돌지 않는다"
    );
    assert_eq!(kills, 1);
    assert!(lock(&watch).end.reclaimed, "자리 값에 거둠이 남는다");
}

#[test]
fn ended_turn_stops_the_loop_without_probing() {
    let watch = Watch::default();
    let mut io = Io {
        cycles: Cell::new(0),
        exit_at: u32::MAX,
    };
    let stop = AtomicBool::new(false);
    let ended = AtomicBool::new(true);
    let n = run_watch_guarded(
        &watch,
        &mut ProbeState::default(),
        &EndConfig::new(60_000),
        &mut io,
        Duration::from_millis(1),
        WatchStops {
            stop: &stop,
            ended: Some(&ended),
            fence: None,
            terminate: None,
        },
    );
    assert_eq!((n, io.cycles.get()), (0, 0));
}

#[test]
fn held_fence_keeps_probing() {
    let watch = Watch::default();
    let mut io = Io {
        cycles: Cell::new(0),
        exit_at: 3,
    };
    let stop = AtomicBool::new(false);
    let mut f = fence(false);
    let n = run_watch_guarded(
        &watch,
        &mut ProbeState::default(),
        &EndConfig::new(60_000),
        &mut io,
        Duration::from_millis(1),
        WatchStops {
            stop: &stop,
            ended: None,
            fence: Some(&mut f),
            terminate: None,
        },
    );
    assert!(n >= 3, "임대를 쥐고 있으면 탐침을 돈다: {n}");
    assert!(!lock(&watch).end.reclaimed);
}

#[test]
fn write_on_watch_needs_a_live_pty() {
    let watch = Watch::default();
    let mut write = write_on_watch(&watch);
    assert!(!write(b"\r"), "띄우기 전에는 넣지 않는다");
    lock(&watch).end.exited = true;
    assert!(!write(b"\r"));
    // 띄우기 전 SIGTERM 은 아무것도 하지 않는다(패닉 없음).
    terminate_on_watch(&watch)();
}

/// security ②-2 nit: 띄우는 중(손잡이 없음) 임대를 잃으면 감시 루프의 펜스 확인은 거두지 못하고 끝난다(`reclaim()` 이 false) —
/// 그 신호는 다시 오지 않으므로 띄운 **바로 그 순간**(`on_spawn`) 접어야 한다(정본 `onSpawn` 의 `canceledBy || fencedOut`).
#[test]
fn fence_lost_while_spawning_folds_right_after_spawn() {
    use crate::pty_turn::{PtyPlan, PtyTurnOptions, run_pty_turn};

    let watch = Watch::default();
    let lost = Arc::new(AtomicBool::new(true));
    let l = lost.clone();
    let mut f = FenceCheck {
        listening: Arc::new(AtomicBool::new(true)),
        lost: Box::new(move || l.load(Ordering::SeqCst)),
        on_lost: fence_reclaim(),
    };
    let mut io = Io {
        cycles: Cell::new(0),
        exit_at: u32::MAX,
    };
    run_watch_guarded(
        &watch,
        &mut ProbeState::default(),
        &EndConfig::new(60_000),
        &mut io,
        Duration::from_millis(1),
        WatchStops {
            stop: &AtomicBool::new(false),
            ended: None,
            fence: Some(&mut f),
            terminate: None,
        },
    );
    assert!(
        !lock(&watch).end.reclaimed,
        "손잡이가 없어 루프는 거두지 못하고 끝났다"
    );

    // 이제 PTY 가 뜬다 — 띄운 순간 접혀야 한다.
    let plan = PtyPlan {
        command: "/bin/sleep".into(),
        args: vec!["30".into()],
        env: vec![("PATH".into(), "/usr/bin:/bin".into())],
        stdin_file: None,
    };
    let l = lost.clone();
    let stop = move || l.load(Ordering::SeqCst);
    let mut rec = Rec::default();
    let now = || 1;
    let mut sink = WatchSink {
        inner: &mut rec,
        watch: watch.clone(),
        now_ms: &now,
        stop_on_spawn: Some(&stop),
    };
    let t = std::time::Instant::now();
    run_pty_turn(
        &plan,
        PtyTurnOptions {
            timeout_ms: 20_000,
            ..PtyTurnOptions::default()
        },
        &mut sink,
    )
    .expect("turn");
    assert!(
        t.elapsed() < Duration::from_secs(10),
        "띄운 직후 SIGTERM — 30초 sleep 이 끝나기를 기다리지 않았다: {:?}",
        t.elapsed()
    );
    assert!(lock(&watch).end.reclaimed, "자리 값에 거둠");
}
