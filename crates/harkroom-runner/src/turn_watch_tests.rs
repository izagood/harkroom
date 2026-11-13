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
