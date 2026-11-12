use super::*;

#[derive(Default)]
struct Fake {
    state: Option<Tail>,
    pending: Option<u32>,
    mtime: Option<i64>,
    opencode: Option<Tail>,
    state_since: Vec<i64>,
    pending_since: Vec<i64>,
    opencode_since: Vec<i64>,
    mtime_reads: usize,
}

impl TurnStateRecords for Fake {
    fn turn_state(&mut self, since_ms: i64) -> Option<Tail> {
        self.state_since.push(since_ms);
        self.state
    }
    fn pending_background(&mut self, since_ms: i64) -> Option<u32> {
        self.pending_since.push(since_ms);
        self.pending
    }
    fn transcript_mtime_ms(&mut self) -> Option<i64> {
        self.mtime_reads += 1;
        self.mtime
    }
    fn opencode_turn_state(&mut self, since_ms: i64) -> Option<Tail> {
        self.opencode_since.push(since_ms);
        self.opencode
    }
}

fn ctx(harness: AgentHarness) -> TurnStateCtx {
    TurnStateCtx {
        harness,
        turn_started_at_ms: 1_000,
        lane_nudged_at_ms: 0,
        opencode_quiet_ms: OPENCODE_QUIET_MS,
    }
}

fn cfg() -> EndConfig {
    EndConfig::new(30 * 60_000)
}

fn run(
    end: &mut EndState,
    p: &mut TurnStateProbe,
    c: &TurnStateCtx,
    now: i64,
    f: &mut Fake,
) -> TurnStateNote {
    probe_turn_state(end, p, c, &cfg(), &mut || now, &|| false, f)
}

#[test]
fn claude_ended_reads_pending_from_turn_start() {
    let mut end = EndState::default();
    let mut f = Fake {
        state: Some(Tail::Ended),
        pending: Some(2),
        ..Fake::default()
    };
    let mut c = ctx(AgentHarness::ClaudeCode);
    c.lane_nudged_at_ms = 5_000;
    let n = run(&mut end, &mut TurnStateProbe::default(), &c, 9_000, &mut f);
    assert_eq!(n, TurnStateNote::Quiet);
    assert!(end.finished);
    assert_eq!(end.tail, Some(Tail::Ended));
    assert_eq!(end.pending, Some(2));
    // 꼬리는 재촉 뒤부터, 자식 작업은 턴 시작부터(정본).
    assert_eq!(f.state_since, vec![5_000]);
    assert_eq!(f.pending_since, vec![1_000]);
}

#[test]
fn working_clears_pending_and_does_not_read_it() {
    let mut end = EndState {
        finished: true,
        pending: Some(3),
        ..EndState::default()
    };
    let mut f = Fake {
        state: Some(Tail::Working),
        ..Fake::default()
    };
    run(
        &mut end,
        &mut TurnStateProbe::default(),
        &ctx(AgentHarness::ClaudeCode),
        9_000,
        &mut f,
    );
    assert!(!end.finished);
    assert_eq!(end.pending, None);
    assert!(f.pending_since.is_empty());
    // 말하지 않았으면 발화 뒤 바닥을 재지 않는다.
    assert_eq!(f.mtime_reads, 0);
}

#[test]
fn unreadable_tail_is_unknown_not_ended() {
    let mut end = EndState {
        finished: true,
        ..EndState::default()
    };
    let mut f = Fake::default();
    run(
        &mut end,
        &mut TurnStateProbe::default(),
        &ctx(AgentHarness::ClaudeCode),
        9_000,
        &mut f,
    );
    assert!(!end.finished);
    assert_eq!(end.tail, None);
}

#[test]
fn spoke_and_working_past_stall_limit_counts_as_ended() {
    let limit = cfg().stall_ms;
    let mut end = EndState {
        spoke: true,
        last_life_ms: 100,
        last_data_at_ms: 200,
        ..EndState::default()
    };
    let mut f = Fake {
        state: Some(Tail::Working),
        mtime: Some(300),
        ..Fake::default()
    };
    let n = run(
        &mut end,
        &mut TurnStateProbe::default(),
        &ctx(AgentHarness::ClaudeCode),
        300 + limit,
        &mut f,
    );
    assert_eq!(n, TurnStateNote::SpokeStallEnded { limit_ms: limit });
    assert!(end.finished);
    // 기록이 자란 것은 생존 증거로 민다.
    assert_eq!(end.last_life_ms, 300);
}

#[test]
fn spoke_and_working_within_limit_stays_working() {
    let limit = cfg().stall_ms;
    let mut end = EndState {
        spoke: true,
        last_life_ms: 100,
        ..EndState::default()
    };
    let mut f = Fake {
        state: Some(Tail::Working),
        mtime: Some(500),
        ..Fake::default()
    };
    let n = run(
        &mut end,
        &mut TurnStateProbe::default(),
        &ctx(AgentHarness::ClaudeCode),
        500 + limit - 1,
        &mut f,
    );
    assert_eq!(n, TurnStateNote::Quiet);
    assert!(!end.finished);
}

#[test]
fn no_life_baseline_never_folds() {
    let mut end = EndState {
        spoke: true,
        ..EndState::default()
    };
    let mut f = Fake {
        state: Some(Tail::Working),
        ..Fake::default()
    };
    run(
        &mut end,
        &mut TurnStateProbe::default(),
        &ctx(AgentHarness::ClaudeCode),
        i64::MAX / 2,
        &mut f,
    );
    assert!(!end.finished);
}

#[test]
fn stall_limit_zero_disables_spoke_floor() {
    let mut c = cfg();
    c.stall_ms = 0;
    let mut end = EndState {
        spoke: true,
        last_life_ms: 1,
        ..EndState::default()
    };
    let mut f = Fake {
        state: Some(Tail::Working),
        ..Fake::default()
    };
    probe_turn_state(
        &mut end,
        &mut TurnStateProbe::default(),
        &ctx(AgentHarness::ClaudeCode),
        &c,
        &mut || 10_000_000,
        &|| false,
        &mut f,
    );
    assert!(!end.finished);
}

#[test]
fn exit_during_read_keeps_previous_state() {
    let mut end = EndState {
        finished: true,
        pending: Some(1),
        ..EndState::default()
    };
    let mut f = Fake {
        state: Some(Tail::Working),
        ..Fake::default()
    };
    probe_turn_state(
        &mut end,
        &mut TurnStateProbe::default(),
        &ctx(AgentHarness::ClaudeCode),
        &cfg(),
        &mut || 9_000,
        &|| true,
        &mut f,
    );
    assert!(end.exited);
    assert!(end.finished);
    assert_eq!(end.pending, Some(1));
}

#[test]
fn opencode_asks_only_when_screen_quiet_and_spaced() {
    let c = ctx(AgentHarness::Opencode);
    assert!(uses_xdg_home(AgentHarness::Opencode));
    let mut p = TurnStateProbe::default();
    let mut f = Fake {
        opencode: Some(Tail::Working),
        ..Fake::default()
    };
    // 화면을 아직 못 봤다.
    let mut end = EndState::default();
    assert_eq!(
        run(&mut end, &mut p, &c, 100_000, &mut f),
        TurnStateNote::OpencodeSkipped
    );
    // 화면이 방금 흘렀다.
    end.last_data_at_ms = 90_000;
    assert_eq!(
        run(&mut end, &mut p, &c, 100_000, &mut f),
        TurnStateNote::OpencodeSkipped
    );
    // 조용하다 — 묻는다.
    end.last_data_at_ms = 50_000;
    assert_eq!(
        run(&mut end, &mut p, &c, 100_000, &mut f),
        TurnStateNote::Quiet
    );
    assert_eq!(p.opencode_asked_at_ms, 100_000);
    // 방금 물었다 — 간격 안이면 다시 안 묻는다.
    assert_eq!(
        run(
            &mut end,
            &mut p,
            &c,
            100_000 + OPENCODE_QUIET_MS - 1,
            &mut f
        ),
        TurnStateNote::OpencodeSkipped
    );
    assert_eq!(f.opencode_since, vec![1_000]);
    // 기록 읽개는 opencode 에 쓰지 않는다.
    assert!(f.state_since.is_empty());
}

#[test]
fn opencode_ended_sets_finished_with_unknown_pending() {
    let mut c = ctx(AgentHarness::Opencode);
    c.lane_nudged_at_ms = 7_000;
    let mut end = EndState {
        last_data_at_ms: 1,
        pending: Some(4),
        ..EndState::default()
    };
    let mut f = Fake {
        opencode: Some(Tail::Ended),
        ..Fake::default()
    };
    let n = run(
        &mut end,
        &mut TurnStateProbe::default(),
        &c,
        100_000,
        &mut f,
    );
    assert_eq!(n, TurnStateNote::OpencodeEnded);
    assert!(end.finished);
    assert_eq!(end.pending, None);
    assert_eq!(f.opencode_since, vec![7_000]);
}

#[test]
fn pending_count_rounds_up_and_rejects_garbage() {
    assert_eq!(pending_count(0.0), Some(0));
    assert_eq!(pending_count(2.0), Some(2));
    assert_eq!(pending_count(1.2), Some(2));
    assert_eq!(pending_count(-1.0), None);
    assert_eq!(pending_count(f64::NAN), None);
    assert_eq!(pending_count(f64::INFINITY), None);
    assert_eq!(pending_count(1e12), Some(u32::MAX));
}
