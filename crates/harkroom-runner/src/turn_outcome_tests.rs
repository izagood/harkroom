use super::*;
use crate::adapter::AgentHarness;
use crate::mention_run::TurnError;
use crate::pty::PromptNotDelivered;
use crate::pty_proc::ExecutableNotFound;
use crate::thread_model::{AxisSource, TurnModelSource};
use crate::turn_probe_records::SpawnBlocked;

const PAT: &str = "hk_pat_secret_value_55";

fn facts<'a>(end: &'a EndState, live: &'a LiveTurn, tm: Option<&'a TurnModel>) -> OutcomeFacts<'a> {
    OutcomeFacts {
        end,
        live,
        thread_unreadable: false,
        turn_timeout_ms: 600_000,
        harness_stall_ms: 600_000,
        stall: StallInputs {
            watch_now: None,
            screen_tail: "",
            harness: AgentHarness::ClaudeCode,
            signal: None,
        },
        recorded_after: None,
        turn_model: tm,
        pat: PAT,
        secrets: &[],
        stop_requested_at: Some("2026-11-13T06:50:00Z".into()),
    }
}

fn ran(code: i32, tail: &str) -> Attempted<Result<TurnResult, PtyTurnError>> {
    Attempted::Ran(Ok(TurnResult {
        exit_code: code,
        timed_out: false,
        tail: tail.into(),
    }))
}

#[test]
fn clean_exit_is_ok_with_stop_time() {
    let (end, live) = (EndState::default(), LiveTurn::default());
    let ok = attempt_outcome(ran(0, ""), &facts(&end, &live, None)).unwrap();
    assert_eq!(
        ok.stop_requested_at.as_deref(),
        Some("2026-11-13T06:50:00Z")
    );
}

/// 실패 문장엔 꼬리가 없고, 꼬리는 판정 재료로만 남는다.
#[test]
fn nonzero_exit_fails_without_tail_in_message() {
    let (end, live) = (EndState::default(), LiveTurn::default());
    let e = attempt_outcome(
        ran(1, &format!("human typed {PAT}")),
        &facts(&end, &live, None),
    )
    .unwrap_err();
    assert_eq!(e.message, "harness 종료 1");
    assert!(e.tail.contains("human typed"));
    assert!(!format!("{e:?}").contains(PAT));
}

/// 관문이 막은 시도 — 사람의 [중단] 은 그 사람으로, `operator` 중단은 사람 중단이 아니다(종료 143).
#[test]
fn blocked_reads_live_cancel_and_drops_operator() {
    let end = EndState::default();
    let live = LiveTurn::default();
    live.cancel("human-1");
    let e = attempt_outcome(
        Attempted::Blocked(SpawnBlocked::Canceled),
        &facts(&end, &live, None),
    )
    .unwrap_err();
    assert!(
        e.message.contains("human-1") && e.message.contains("중단"),
        "{}",
        e.message
    );
    let live = LiveTurn::default();
    live.cancel("operator");
    let e = attempt_outcome(
        Attempted::Blocked(SpawnBlocked::Canceled),
        &facts(&end, &live, None),
    )
    .unwrap_err();
    assert_eq!(e.message, "harness 종료 143");
}

/// 펜스를 지금 값으로 — 임대를 잃은 뒤 막힌 시도는 FencedOut 문장과 표지.
#[test]
fn blocked_after_fence_loss_marks_fenced_out() {
    let end = EndState::default();
    let live = LiveTurn::default();
    live.fence_lost();
    let e = attempt_outcome(
        Attempted::Blocked(SpawnBlocked::FencedOut),
        &facts(&end, &live, None),
    )
    .unwrap_err();
    assert!(e.message.contains("임대"), "{}", e.message);
    assert!(e.marks.fenced_out);
}

#[test]
fn not_delivered_feeds_account_axis() {
    let (end, live) = (EndState::default(), LiveTurn::default());
    let p = PromptNotDelivered {
        waited_ms: 90_000,
        tail: "Allow?".into(),
        kind: NotDeliveredKind::Waiting,
    };
    let e = attempt_outcome(
        Attempted::Ran(Err(PtyTurnError::NotDelivered(p))),
        &facts(&end, &live, None),
    )
    .unwrap_err();
    assert_eq!(e.not_delivered, Some(NotDelivered::Waiting));
    assert_eq!(
        e.attempt_end(),
        crate::account_failover::AttemptEnd::Waiting
    );
    assert!(
        !e.message.contains("Allow?"),
        "꼬리는 문장에 없다: {}",
        e.message
    );
}

#[test]
fn missing_executable_is_marked_without_path() {
    let (end, live) = (EndState::default(), LiveTurn::default());
    let nf = ExecutableNotFound {
        command: "claude".into(),
        path: Some("/home/x/bin".into()),
    };
    let e = attempt_outcome(
        Attempted::Ran(Err(PtyTurnError::NotFound(nf))),
        &facts(&end, &live, None),
    )
    .unwrap_err();
    assert!(e.executable_missing);
    assert_eq!(e.message, EXECUTABLE_MISSING);
}

#[test]
fn setup_failures_fold_by_step() {
    let (end, live) = (EndState::default(), LiveTurn::default());
    let e = attempt_outcome(
        Attempted::SetupFailed {
            step: LaunchStep::LaneKeys,
            code: "operator_unreachable".into(),
        },
        &facts(&end, &live, None),
    )
    .unwrap_err();
    assert!(matches!(e.into_turn_end(), TurnEnd::ProviderLane { .. }));
    let e = attempt_outcome(
        Attempted::SetupFailed {
            step: LaunchStep::TurnKeys,
            code: "turn_keys".into(),
        },
        &facts(&end, &live, None),
    )
    .unwrap_err();
    assert!(e.lane_code.is_none());
    assert!(e.message.contains("턴 자격"), "{}", e.message);
}

/// 끝까지: 스레드 지정 모델 + 모델을 말하는 API 오류(PAT 섞임) → 모델 거절, 실패 글엔 가린 줄만.
#[test]
fn api_error_on_thread_model_folds_to_masked_rejection() {
    let end = EndState {
        api_error: Some(format!("400 invalid model opus key {PAT}")),
        ..EndState::default()
    };
    let live = LiveTurn::default();
    let tm = TurnModel {
        model: Some("opus".into()),
        effort: None,
        source: TurnModelSource {
            model: AxisSource::Thread,
            effort: AxisSource::Agent,
        },
    };
    let e = attempt_outcome(ran(1, ""), &facts(&end, &live, Some(&tm))).unwrap_err();
    assert!(!e.message.contains(PAT), "{}", e.message);
    match e.into_turn_end() {
        TurnEnd::ThreadModelRejected { api_error, .. } => {
            assert!(!api_error.contains(PAT), "{api_error}")
        }
        other => panic!("{other:?}"),
    }
}
