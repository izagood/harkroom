use super::*;

#[derive(Default)]
struct Fake {
    now: i64,
    exited_after: Option<&'static str>,
    exited: bool,
    spoke: Option<Result<bool, String>>,
    api_error: bool,
    screen: Option<bool>,
    recorded: Option<RecordedTurnEnd>,
    answer: Option<String>,
    stall: Option<StallProbe>,
    calls: Vec<String>,
    actions: Vec<EndAction>,
    stalls: Vec<StallVerdict>,
    recorded_since: Option<i64>,
}

impl Fake {
    fn hit(&mut self, name: &str) {
        self.calls.push(name.to_owned());
        if self.exited_after == Some(name) {
            self.exited = true;
        }
    }
    fn called(&self, name: &str) -> bool {
        self.calls.iter().any(|c| c == name)
    }
}

impl ProbeIo for Fake {
    fn now_ms(&self) -> i64 {
        self.now
    }
    fn exited(&self) -> bool {
        self.exited
    }
    fn read_spoke(&mut self) -> Result<bool, String> {
        self.hit("read_spoke");
        self.spoke.clone().unwrap_or(Ok(false))
    }
    fn log_unreadable(&mut self, _reason: &str) {
        self.hit("log_unreadable");
    }
    fn probe_denials(&mut self, _end: &mut EndState) {
        self.hit("denials");
    }
    fn probe_mac_permission(&mut self, _end: &mut EndState) {
        self.hit("mac");
    }
    fn probe_mcp_auth(&mut self, _end: &mut EndState) {
        self.hit("mcp_auth");
    }
    fn probe_api_error(&mut self, _end: &mut EndState) -> bool {
        self.hit("api_error");
        self.api_error
    }
    fn probe_turn_state(&mut self, _end: &mut EndState) {
        self.hit("turn_state");
    }
    fn screen_idle_ended(&mut self, _now_ms: i64) -> Option<bool> {
        self.hit("screen");
        self.screen
    }
    fn read_recorded_end(&mut self, since_ms: i64) -> Option<RecordedTurnEnd> {
        self.hit("recorded_end");
        self.recorded_since = Some(since_ms);
        self.recorded
    }
    fn screen_answer(&mut self) -> Option<String> {
        self.hit("screen_answer");
        self.answer.clone()
    }
    fn log_screen_ended(&mut self) {
        self.hit("log_screen_ended");
    }
    fn nudge_or_expire(&mut self, _end: &mut EndState, _probe: &mut ProbeState) {
        self.hit("nudge");
    }
    fn apply_end_action(&mut self, action: EndAction) {
        self.hit("end_action");
        self.actions.push(action);
    }
    fn stall_probe(&mut self, _end: &EndState, now_ms: i64) -> StallProbe {
        self.hit("stall_probe");
        self.stall.unwrap_or(StallProbe {
            reads_transcript: true,
            transcript_mtime_ms: None,
            looks_unsent: false,
            now_ms,
        })
    }
    fn apply_stall(&mut self, verdict: StallVerdict) {
        self.hit("apply_stall");
        self.stalls.push(verdict);
    }
}

fn cfg() -> EndConfig {
    EndConfig::new(30 * 60_000)
}

fn live() -> EndState {
    EndState {
        has_controls: true,
        ..EndState::default()
    }
}

fn run(end: &mut EndState, probe: &mut ProbeState, io: &mut Fake) -> CycleOutcome {
    probe_cycle(end, probe, &cfg(), io)
}

#[test]
fn exited_before_start_does_nothing() {
    let mut end = live();
    end.exited = true;
    let mut io = Fake::default();
    assert_eq!(
        run(&mut end, &mut ProbeState::default(), &mut io),
        CycleOutcome::Stop
    );
    assert!(io.calls.is_empty());
}

#[test]
fn silent_turn_runs_every_probe_in_order() {
    let mut end = live();
    let mut io = Fake {
        now: 1_000,
        ..Fake::default()
    };
    assert_eq!(
        run(&mut end, &mut ProbeState::default(), &mut io),
        CycleOutcome::Again
    );
    assert_eq!(
        io.calls,
        [
            "read_spoke",
            "denials",
            "mac",
            "mcp_auth",
            "api_error",
            "turn_state",
            "screen",
            "nudge",
            "end_action",
            "stall_probe",
        ]
    );
    assert_eq!(io.actions, [EndAction::Disarm]);
}

#[test]
fn spoke_once_is_not_asked_again_and_skips_silent_only_probes() {
    let mut end = live();
    let mut probe = ProbeState::default();
    let mut io = Fake {
        now: 5_000,
        spoke: Some(Ok(true)),
        ..Fake::default()
    };
    // 말했고 꼬리를 모른다 → 끝난 것으로 읽어 고아 유예를 세운다.
    assert_eq!(run(&mut end, &mut probe, &mut io), CycleOutcome::Again);
    assert!(end.spoke);
    assert_eq!(probe.first_spoke_at_ms, Some(5_000));
    assert!(!io.called("api_error") && !io.called("nudge") && !io.called("stall_probe"));
    assert_eq!(io.actions, [EndAction::Arm { grace_ms: 60_000 }]);

    let mut io2 = Fake {
        now: 9_000,
        ..Fake::default()
    };
    run(&mut end, &mut probe, &mut io2);
    assert!(!io2.called("read_spoke"));
    assert_eq!(probe.first_spoke_at_ms, Some(5_000));
}

#[test]
fn unreadable_thread_is_logged_once_and_treated_as_unknown() {
    let mut end = live();
    let mut probe = ProbeState::default();
    let mut io = Fake {
        spoke: Some(Err("link down".into())),
        ..Fake::default()
    };
    assert_eq!(run(&mut end, &mut probe, &mut io), CycleOutcome::Again);
    assert!(probe.thread_unreadable);
    assert!(io.called("log_unreadable"));
    // 모를 때는 API 오류·재촉·정지를 보지 않는다 — 기록 꼬리는 본다.
    assert!(!io.called("api_error") && !io.called("nudge") && !io.called("stall_probe"));
    assert!(io.called("turn_state"));

    let mut io2 = Fake {
        spoke: Some(Err("link down".into())),
        ..Fake::default()
    };
    run(&mut end, &mut probe, &mut io2);
    assert!(!io2.called("log_unreadable"));

    let mut io3 = Fake::default();
    run(&mut end, &mut probe, &mut io3);
    assert!(!probe.thread_unreadable);
}

#[test]
fn api_error_stops_before_turn_state() {
    let mut end = live();
    let mut io = Fake {
        api_error: true,
        ..Fake::default()
    };
    assert_eq!(
        run(&mut end, &mut ProbeState::default(), &mut io),
        CycleOutcome::Stop
    );
    assert!(!io.called("turn_state"));
}

#[test]
fn screen_end_marks_finished_unless_record_says_working() {
    let mut end = live();
    let mut probe = ProbeState {
        turn_started_at_ms: 100,
        ..ProbeState::default()
    };
    let mut io = Fake {
        now: 2_000,
        spoke: Some(Ok(true)),
        screen: Some(true),
        recorded: Some(RecordedTurnEnd::Working),
        ..Fake::default()
    };
    run(&mut end, &mut probe, &mut io);
    assert!(!end.finished && !probe.screen_ended);
    assert_eq!(io.recorded_since, Some(100));

    let mut io = Fake {
        now: 3_000,
        screen: Some(true),
        recorded: None,
        answer: Some("답".into()),
        ..Fake::default()
    };
    run(&mut end, &mut probe, &mut io);
    assert!(end.finished && probe.screen_ended);
    assert_eq!(end.pending, Some(0));
    assert_eq!(probe.screen_said.as_deref(), Some("답"));
    // 끝났고 자식 0 → 유예 0 으로 곧바로 거둔다.
    assert_eq!(io.actions, [EndAction::ReclaimNow { kill: true }]);
}

#[test]
fn after_nudge_screen_answer_is_kept_and_record_read_since_nudge() {
    let mut end = live();
    let mut probe = ProbeState {
        turn_started_at_ms: 100,
        lane_nudged_at_ms: 700,
        screen_said: Some("재촉 전 답".into()),
        ..ProbeState::default()
    };
    let mut io = Fake {
        spoke: Some(Ok(true)),
        screen: Some(true),
        recorded: Some(RecordedTurnEnd::Ended),
        answer: Some("군말".into()),
        ..Fake::default()
    };
    run(&mut end, &mut probe, &mut io);
    assert_eq!(io.recorded_since, Some(700));
    assert!(!io.called("screen_answer"));
    assert_eq!(probe.screen_said.as_deref(), Some("재촉 전 답"));
}

#[test]
fn screen_not_asked_when_finished_or_awaiting_human() {
    for (finished, awaiting) in [(true, false), (false, true)] {
        let mut end = EndState {
            finished,
            awaiting_human: awaiting,
            ..live()
        };
        let mut io = Fake {
            screen: Some(true),
            ..Fake::default()
        };
        run(&mut end, &mut ProbeState::default(), &mut io);
        assert!(!io.called("screen") && !io.called("recorded_end"));
    }
}

#[test]
fn no_screen_watch_never_marks_finished() {
    let mut end = live();
    let mut io = Fake {
        spoke: Some(Ok(true)),
        screen: None,
        ..Fake::default()
    };
    run(&mut end, &mut ProbeState::default(), &mut io);
    assert!(!end.finished && !io.called("recorded_end"));
}

#[test]
fn stall_stops_and_press_enter_continues() {
    let mut end = EndState {
        last_life_ms: 1,
        ..live()
    };
    let mut io = Fake {
        now: 1 + 10 * 60_000,
        stall: Some(StallProbe {
            reads_transcript: true,
            transcript_mtime_ms: None,
            looks_unsent: true,
            now_ms: 1 + 10 * 60_000,
        }),
        ..Fake::default()
    };
    assert_eq!(
        run(&mut end, &mut ProbeState::default(), &mut io),
        CycleOutcome::Again
    );
    assert_eq!(io.stalls, [StallVerdict::PressEnter]);

    let later = end.last_life_ms + 10 * 60_000;
    let mut io = Fake {
        now: later,
        ..Fake::default()
    };
    assert_eq!(
        run(&mut end, &mut ProbeState::default(), &mut io),
        CycleOutcome::Stop
    );
    assert!(end.stalled);
    assert!(matches!(
        io.stalls[..],
        [StallVerdict::Stalled { kill: true, .. }]
    ));
}

#[test]
fn alive_stall_verdict_is_not_applied() {
    let mut end = live();
    let mut io = Fake::default();
    run(&mut end, &mut ProbeState::default(), &mut io);
    assert!(io.called("stall_probe") && !io.called("apply_stall"));
}

#[test]
fn exit_seen_mid_cycle_stops_at_next_check() {
    for (after, last) in [
        ("read_spoke", "read_spoke"),
        ("mcp_auth", "mcp_auth"),
        ("nudge", "nudge"),
    ] {
        let mut end = live();
        let mut io = Fake {
            exited_after: Some(after),
            ..Fake::default()
        };
        assert_eq!(
            run(&mut end, &mut ProbeState::default(), &mut io),
            CycleOutcome::Stop
        );
        assert!(end.exited);
        assert_eq!(io.calls.last().map(String::as_str), Some(last), "{after}");
    }
}

#[test]
fn probe_state_debug_hides_screen_text() {
    let probe = ProbeState {
        screen_said: Some("sk-비밀값 아무개".into()),
        ..ProbeState::default()
    };
    let dbg = format!("{probe:?}");
    assert!(!dbg.contains("sk-비밀값"), "{dbg}");
    assert!(dbg.contains("<가림 10자>"), "{dbg}");
}
