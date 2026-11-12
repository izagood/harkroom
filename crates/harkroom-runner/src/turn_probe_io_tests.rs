//! ProbeIo 실구현 1/2 시험 — 가짜 읽개로 위임과 SIGTERM 가드를 붙잡는다.

use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;

use serde_json::json;

use super::*;
use crate::harness_errors::{MacPermissionWait, PermissionDenial};
use crate::turn_end::Tail;

#[derive(Default)]
struct Rec {
    api: Option<String>,
    mcp: Vec<String>,
}
impl ProbeRecords for Rec {
    fn denials(&mut self) -> Vec<PermissionDenial> {
        Vec::new()
    }
    fn mac_waits(&mut self) -> Vec<MacPermissionWait> {
        Vec::new()
    }
    fn mcp_auth_rejections(&mut self) -> Vec<String> {
        self.mcp.clone()
    }
    fn recorded_api_error(&mut self) -> Option<String> {
        None
    }
    fn api_error(&mut self) -> Option<String> {
        self.api.clone()
    }
}

#[derive(Default)]
struct Sink {
    logs: Vec<String>,
    reported: Vec<Vec<String>>,
}
impl ProbeSink for Sink {
    fn progress(&mut self, _body: &str) -> Result<(), String> {
        Ok(())
    }
    fn report_mcp_auth_rejected(&mut self, servers: &[String]) {
        self.reported.push(servers.to_vec());
    }
    fn log(&mut self, line: &str) {
        self.logs.push(line.to_owned());
    }
}

#[derive(Default)]
struct States {
    tail: Option<Tail>,
    since: Vec<i64>,
}
impl TurnStateRecords for States {
    fn turn_state(&mut self, since_ms: i64) -> Option<Tail> {
        self.since.push(since_ms);
        self.tail
    }
    fn pending_background(&mut self, _since_ms: i64) -> Option<u32> {
        Some(0)
    }
    fn transcript_mtime_ms(&mut self) -> Option<i64> {
        None
    }
    fn opencode_turn_state(&mut self, _since_ms: i64) -> Option<Tail> {
        None
    }
}

#[derive(Default)]
struct Rest {
    nudged_to: i64,
    actions: Vec<EndAction>,
}
impl ProbeRest for Rest {
    fn nudge_or_expire(&mut self, _end: &mut EndState, probe: &mut ProbeState) {
        if self.nudged_to != 0 {
            probe.lane_nudged_at_ms = self.nudged_to;
        }
    }
    fn apply_end_action(&mut self, action: EndAction) {
        self.actions.push(action);
    }
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

fn now() -> i64 {
    1_000_000
}

type Io = TurnProbeIo<Rec, Sink, States, Rest>;

fn io(thread: Result<Vec<Value>, String>, kills: Arc<AtomicUsize>) -> Io {
    let thread = Mutex::new(Some(thread));
    TurnProbeIo {
        clock: now,
        exited: Arc::new(AtomicBool::new(false)),
        ended: Arc::new(AtomicBool::new(false)),
        read_thread: Box::new(move || {
            thread
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| Ok(Vec::new()))
        }),
        spoke_key: SpokeKey {
            me_id: "me".into(),
            since_seq: 10,
            turn_id: Some("t1".into()),
        },
        records: Rec::default(),
        record_state: RecordProbeState::default(),
        sink: Sink::default(),
        secrets: NoticeSecrets::default(),
        turn_state_records: States::default(),
        turn_state_probe: TurnStateProbe::default(),
        harness: AgentHarness::ClaudeCode,
        turn_started_at_ms: 500,
        opencode_quiet_ms: 20_000,
        lane_nudged_at_ms: 0,
        cfg: EndConfig::new(600_000),
        read_recorded_end: Box::new(|_| None),
        terminate: Arc::new(move || {
            kills.fetch_add(1, Ordering::SeqCst);
        }),
        rest: Rest::default(),
    }
}

fn post(author: &str, seq: i64, turn: &str, kind: Option<&str>) -> Value {
    let mut m = json!({ "authorId": author, "seq": seq, "meta": { "turnId": turn } });
    if let Some(k) = kind {
        m["kind"] = json!(k);
    }
    m
}

#[test]
fn read_spoke_counts_only_own_posts_after_start_seq() {
    let k = Arc::new(AtomicUsize::new(0));
    let thread = vec![
        post("me", 5, "t1", None),
        post("other", 11, "t1", None),
        post("me", 12, "t1", Some("progress")),
    ];
    assert_eq!(io(Ok(thread.clone()), k.clone()).read_spoke(), Ok(false));
    let mut spoke = thread;
    spoke.push(post("me", 13, "t1", None));
    assert_eq!(io(Ok(spoke), k).read_spoke(), Ok(true));
}

#[test]
fn read_spoke_passes_read_failure_through() {
    let k = Arc::new(AtomicUsize::new(0));
    assert_eq!(
        io(Err("503".into()), k).read_spoke(),
        Err("503".to_string())
    );
}

#[test]
fn api_error_sends_sigterm_once_and_stops_cycle() {
    let k = Arc::new(AtomicUsize::new(0));
    let mut i = io(Ok(Vec::new()), k.clone());
    i.records.api = Some("429 rate limited".into());
    let mut end = EndState {
        has_controls: true,
        ..EndState::default()
    };
    assert!(i.probe_api_error(&mut end));
    assert_eq!(k.load(Ordering::SeqCst), 1);
}

#[test]
fn api_error_after_turn_ended_sends_no_signal() {
    let k = Arc::new(AtomicUsize::new(0));
    let mut i = io(Ok(Vec::new()), k.clone());
    i.records.api = Some("429 rate limited".into());
    i.ended.store(true, Ordering::SeqCst);
    let mut end = EndState {
        has_controls: true,
        ..EndState::default()
    };
    assert!(i.probe_api_error(&mut end));
    assert_eq!(
        k.load(Ordering::SeqCst),
        0,
        "끝난 턴에는 신호를 보내지 않는다"
    );
}

#[test]
fn no_api_error_keeps_cycle_going() {
    let k = Arc::new(AtomicUsize::new(0));
    let mut i = io(Ok(Vec::new()), k.clone());
    let mut end = EndState::default();
    assert!(!i.probe_api_error(&mut end));
    assert_eq!(k.load(Ordering::SeqCst), 0);
}

#[test]
fn mcp_auth_rejection_reaches_sink() {
    let k = Arc::new(AtomicUsize::new(0));
    let mut i = io(Ok(Vec::new()), k);
    i.records.mcp = vec!["linear".into()];
    let mut end = EndState::default();
    i.probe_mcp_auth(&mut end);
    assert_eq!(i.sink.reported, vec![vec!["linear".to_string()]]);
}

#[test]
fn turn_state_reads_since_nudge_after_nudge() {
    let k = Arc::new(AtomicUsize::new(0));
    let mut i = io(Ok(Vec::new()), k);
    i.turn_state_records.tail = Some(Tail::Ended);
    let mut end = EndState::default();
    i.probe_turn_state(&mut end);
    assert!(end.finished);
    assert_eq!(end.pending, Some(0));
    // 재촉이 서면 그 뒤 기록만 본다 — ProbeState 의 값이 사본으로 옮겨 온다.
    i.rest.nudged_to = 9_000;
    let mut probe = ProbeState::default();
    i.nudge_or_expire(&mut end, &mut probe);
    assert_eq!(i.lane_nudged_at_ms, 9_000);
    i.probe_turn_state(&mut end);
    assert_eq!(i.turn_state_records.since, vec![500, 9_000]);
}

#[test]
fn screen_is_not_watched_yet() {
    let k = Arc::new(AtomicUsize::new(0));
    let mut i = io(Ok(Vec::new()), k);
    assert_eq!(i.screen_idle_ended(now()), None);
    assert_eq!(i.screen_answer(), None);
}

#[test]
fn exited_follows_shared_flag() {
    let k = Arc::new(AtomicUsize::new(0));
    let i = io(Ok(Vec::new()), k);
    assert!(!i.exited());
    i.exited.store(true, Ordering::SeqCst);
    assert!(i.exited());
}
