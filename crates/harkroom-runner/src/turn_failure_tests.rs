use super::*;
use crate::thread_model::{AxisSource, TurnModelSource};

const PAT: &str = "hrk_pat_ABCDEFGHIJKLMNOPQRSTUV";

fn facts<'a>(end: &'a EndState, tail: &'a str) -> FailFacts<'a> {
    FailFacts {
        exit: ExitFacts {
            exit_code: 143,
            timed_out: false,
            tail,
        },
        end,
        canceled_by: None,
        fenced_out: false,
        thread_unreadable: false,
        turn_timeout_ms: 1_000,
        harness_stall_ms: 600_000,
    }
}

fn stall_in(tail: &str) -> StallInputs<'_> {
    StallInputs {
        watch_now: None,
        screen_tail: tail,
        harness: AgentHarness::ClaudeCode,
        signal: None,
    }
}

#[test]
fn reclaimed_after_speaking_or_finishing_is_success() {
    let mut end = EndState {
        reclaimed: true,
        spoke: true,
        ..EndState::default()
    };
    let exit = ExitFacts {
        exit_code: 143,
        timed_out: false,
        tail: "",
    };
    assert!(ended_by_reclaim(&end));
    assert!(!turn_failed(&exit, &end));
    end.spoke = false;
    end.finished = true;
    assert!(!turn_failed(&exit, &end), "말없이 end_turn 한 턴도 정상");
    end.finished = false;
    assert!(turn_failed(&exit, &end), "답도 끝도 없이 거둔 143 은 실패");
}

#[test]
fn reclaim_with_silence_stall_or_api_error_stays_failure() {
    let base = EndState {
        reclaimed: true,
        spoke: true,
        ..EndState::default()
    };
    let exit = ExitFacts {
        exit_code: 0,
        timed_out: false,
        tail: "",
    };
    for end in [
        EndState {
            silenced: true,
            ..base.clone()
        },
        EndState {
            stalled: true,
            ..base.clone()
        },
        EndState {
            api_error: Some("429".into()),
            ..base.clone()
        },
        EndState {
            recorded_api_error: Some("x".into()),
            ..base.clone()
        },
    ] {
        assert!(!ended_by_reclaim(&end));
        assert!(turn_failed(&exit, &end));
    }
}

#[test]
fn clean_exit_is_not_failure() {
    let end = EndState::default();
    let exit = ExitFacts {
        exit_code: 0,
        timed_out: false,
        tail: "",
    };
    assert!(!turn_failed(&exit, &end));
    let exit = ExitFacts {
        exit_code: 0,
        timed_out: true,
        tail: "",
    };
    assert!(turn_failed(&exit, &end));
}

#[test]
fn pick_failure_follows_canon_priority() {
    let end = EndState {
        api_error: Some("boom".into()),
        recorded_api_error: Some("rec".into()),
        stalled: true,
        stalled_idle_ms: 5,
        silenced: true,
        ..EndState::default()
    };
    let mut f = facts(&end, "tail");
    f.canceled_by = Some("jaebin");
    f.fenced_out = true;
    assert_eq!(
        pick_failure(&f, PAT, &[]),
        TurnFailure::Canceled("jaebin".into())
    );
    f.canceled_by = None;
    assert_eq!(pick_failure(&f, PAT, &[]), TurnFailure::FencedOut);
    f.fenced_out = false;
    assert_eq!(
        pick_failure(&f, PAT, &[]),
        TurnFailure::ApiError("boom".into())
    );

    let end = EndState {
        recorded_api_error: Some("rec".into()),
        stalled: true,
        stalled_idle_ms: 5,
        silenced: true,
        ..EndState::default()
    };
    let f = facts(&end, "tail");
    assert_eq!(
        pick_failure(&f, PAT, &[]),
        TurnFailure::RecordedApiError("rec".into())
    );

    // 정지는 무발화보다 먼저.
    let end = EndState {
        stalled: true,
        stalled_idle_ms: 5,
        silenced: true,
        ..EndState::default()
    };
    let f = facts(&end, "tail");
    assert_eq!(
        pick_failure(&f, PAT, &[]),
        TurnFailure::Stalled {
            idle_ms: 5,
            limit_ms: 600_000
        }
    );

    let end = EndState {
        silenced: true,
        ..EndState::default()
    };
    let mut f = facts(&end, "tail");
    f.thread_unreadable = true;
    assert_eq!(
        pick_failure(&f, PAT, &[]),
        TurnFailure::SilenceUnknown { ms: 2_000 }
    );
    f.thread_unreadable = false;
    assert_eq!(
        pick_failure(&f, PAT, &[]),
        TurnFailure::Silenced { ms: 1_000 }
    );

    let end = EndState::default();
    let f = facts(&end, "raw tail");
    let got = pick_failure(&f, PAT, &[]);
    assert_eq!(got.message(), "harness 종료 143");
    assert_eq!(got.exit_tail(), Some("raw tail"), "꼬리는 판정 재료로만");
}

#[test]
fn api_error_in_message_is_masked() {
    let secret = "s3cr3t-VALUE-0123456789".to_string();
    let end = EndState {
        api_error: Some(format!("401 {PAT} {secret} @jaebin\nsecond")),
        ..EndState::default()
    };
    let f = facts(&end, "");
    let msg = pick_failure(&f, PAT, std::slice::from_ref(&secret)).message();
    assert!(!msg.contains(PAT), "{msg}");
    assert!(!msg.contains(&secret), "{msg}");
    assert!(!msg.contains('\n'), "{msg}");

    // 다 가려지면 자리표시 문구.
    let end = EndState {
        api_error: Some(PAT.into()),
        ..EndState::default()
    };
    let f = facts(&end, "");
    let msg = pick_failure(&f, PAT, &[]).message();
    assert!(!msg.contains(PAT), "{msg}");
}

#[test]
fn marks_prefer_in_turn_api_error_and_keep_raw_for_judgement() {
    let end = EndState {
        api_error: Some("in-turn 429".into()),
        ..EndState::default()
    };
    let f = facts(&end, "");
    let m = failure_marks(&f, &stall_in(""), Some("old record"), None, PAT, &[]);
    assert_eq!(m.harness_api_error.as_deref(), Some("in-turn 429"));
    assert_eq!(m.stalled_ms, None);
    assert_eq!(m.stalled_screen, None);

    let end = EndState::default();
    let f = facts(&end, "");
    let m = failure_marks(&f, &stall_in(""), Some("old record"), None, PAT, &[]);
    assert_eq!(m.harness_api_error.as_deref(), Some("old record"));
}

#[test]
fn marks_debug_hides_api_error_text() {
    let m = FailureMarks {
        harness_api_error: Some(format!("leak {PAT}")),
        ..FailureMarks::default()
    };
    let d = format!("{m:?}");
    assert!(!d.contains(PAT), "{d}");
    assert!(!d.contains("leak"), "{d}");
}

#[test]
fn stall_marks_use_measured_ms_with_limit_floor_and_masked_line() {
    let tail = format!("working\nError: 401 unauthorized {PAT}\n");
    let end = EndState {
        stalled: true,
        stalled_idle_ms: 612_000,
        ..EndState::default()
    };
    let mut f = facts(&end, &tail);
    f.fenced_out = true;
    let m = failure_marks(&f, &stall_in("plain screen"), None, None, PAT, &[]);
    assert_eq!(m.stalled_ms, Some(612_000));
    assert_eq!(m.stalled_screen, Some(StallScreen::Stuck));
    assert!(m.fenced_out);
    let line = m.stalled_screen_line.expect("오류 줄");
    assert!(line.contains("unauthorized"), "{line}");
    assert!(!line.contains(PAT), "{line}");

    // 잰 값이 없으면 한도가 바닥값.
    let end = EndState {
        stalled: true,
        stalled_idle_ms: 0,
        ..EndState::default()
    };
    let f = facts(&end, "");
    let m = failure_marks(&f, &stall_in(""), None, None, PAT, &[]);
    assert_eq!(m.stalled_ms, Some(600_000));
    assert_eq!(m.stalled_screen_line, None);

    // 감시가 idle 을 말하면 그대로.
    let s = StallInputs {
        watch_now: Some("idle"),
        ..stall_in("")
    };
    assert_eq!(
        failure_marks(&f, &s, None, None, PAT, &[]).stalled_screen,
        Some(StallScreen::Idle)
    );
}

#[test]
fn thread_model_mark_only_when_thread_axis() {
    let end = EndState::default();
    let f = facts(&end, "");
    let agent = TurnModel {
        model: Some("m".into()),
        effort: None,
        source: TurnModelSource {
            model: AxisSource::Agent,
            effort: AxisSource::Agent,
        },
    };
    assert_eq!(
        failure_marks(&f, &stall_in(""), None, Some(&agent), PAT, &[]).thread_model,
        None
    );
    let thread = TurnModel {
        source: TurnModelSource {
            model: AxisSource::Thread,
            effort: AxisSource::Agent,
        },
        ..agent
    };
    assert_eq!(
        failure_marks(&f, &stall_in(""), None, Some(&thread), PAT, &[]).thread_model,
        Some(thread)
    );
}

#[test]
fn failed_cursor_advances_only_on_facts() {
    assert_eq!(
        failed_turn_cursor(false, 9, 0, true, false),
        FailedCursor {
            last_fed_seq: None,
            turns_run: 0
        }
    );
    assert_eq!(
        failed_turn_cursor(true, 9, 0, true, true),
        FailedCursor {
            last_fed_seq: Some(9),
            turns_run: 1
        }
    );
    // 세션 id 가 없으면(codex 발견 실패) 실재 관측도 없다.
    assert_eq!(failed_turn_cursor(false, 9, 0, false, true).turns_run, 0);
    // 이미 돈 세션은 그대로.
    assert_eq!(failed_turn_cursor(false, 9, 3, true, false).turns_run, 3);
}
