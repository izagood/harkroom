use super::*;
use crate::mention_turn_parts::StallScreen;
use crate::thread_model::{AxisSource, TurnModel, TurnModelSource};

fn marks(api: Option<&str>) -> FailureMarks {
    FailureMarks {
        harness_api_error: api.map(str::to_string),
        ..FailureMarks::default()
    }
}

fn err(api: Option<&str>) -> AttemptError {
    AttemptError {
        message: "턴이 실패했다".into(),
        marks: marks(api),
        ..AttemptError::default()
    }
}

#[test]
fn quota_text_with_reset_stops_at_line_end_or_esc() {
    assert_eq!(
        quota_from_text("You've hit your session limit · resets 4:10pm (Asia/Seoul)\x1b[0m"),
        Some(Some("4:10pm (Asia/Seoul)".to_string()))
    );
    assert_eq!(quota_from_text("You’ve hit your usage limit"), Some(None));
    assert_eq!(quota_from_text("hit a wall"), None);
}

/// 정본 2026-09-16: 한도·자격증명은 하네스 기록의 API 오류 줄만 본다 — 화면 꼬리(사람 글이 에코됨)는 보지 않는다.
#[test]
fn quota_and_credential_ignore_tail() {
    let mut e = err(None);
    e.tail = "You've hit your session limit · authentication_error · Not logged in".into();
    assert!(e.account_failure().is_none());
    assert_eq!(e.attempt_end(), AttemptEnd::OtherErr);
    assert!(matches!(e.into_turn_end(), TurnEnd::Other { .. }));
}

#[test]
fn credential_patterns_match_without_whitespace() {
    for s in [
        "Could not resolve authentication method",
        "invalid x-api-\nkey",
        "authentication_error",
        "Failed to authenticate: token",
        "OAuth session expired and could not be refreshed",
        "Not logged in · Please run /login",
    ] {
        assert!(harness_credential(&marks(Some(s))), "{s}");
    }
    assert!(!harness_credential(&marks(Some("overloaded_error"))));
    let e = err(Some("Not logged in"));
    assert_eq!(e.attempt_end(), AttemptEnd::Credential);
    assert_eq!(
        e.account_failure().unwrap().kind,
        AccountFailureKind::Credential
    );
}

#[test]
fn quota_folds_with_reset_and_api_line() {
    let e = err(Some("You've hit your session limit · resets 10:50pm"));
    assert_eq!(e.account_failure().unwrap().kind, AccountFailureKind::Quota);
    match e.into_turn_end() {
        TurnEnd::Quota {
            resets_at,
            api_line,
        } => {
            assert_eq!(resets_at.as_deref(), Some("10:50pm"));
            assert!(api_line.is_some());
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn not_delivered_maps_to_gate_or_timeout() {
    let mut e = err(None);
    e.not_delivered = Some(NotDelivered::Waiting);
    assert_eq!(e.account_failure().unwrap().kind, AccountFailureKind::Gate);
    assert_eq!(e.attempt_end(), AttemptEnd::Waiting);
    e.not_delivered = Some(NotDelivered::Timeout);
    assert_eq!(
        e.account_failure().unwrap().kind,
        AccountFailureKind::Timeout
    );
    assert_eq!(e.attempt_end(), AttemptEnd::OtherErr);
}

#[test]
fn session_conflict_from_tail_even_when_front_cut() {
    let mut e = err(None);
    e.tail = "…42d8-0000 is already\n in use.".into();
    assert!(matches!(e.into_turn_end(), TurnEnd::SessionConflict { .. }));
}

#[test]
fn lane_code_folds_to_provider_lane() {
    let mut e = err(None);
    e.lane_code = Some("operator_unreachable".into());
    match e.into_turn_end() {
        TurnEnd::ProviderLane { code, recallable } => {
            assert_eq!(code, "operator_unreachable");
            assert_eq!(recallable, provider_lane_recallable("operator_unreachable"));
        }
        other => panic!("{other:?}"),
    }
}

fn thread_model() -> TurnModel {
    TurnModel {
        model: Some("opus".into()),
        effort: Some("max".into()),
        source: TurnModelSource {
            model: AxisSource::Thread,
            effort: AxisSource::Thread,
        },
    }
}

/// 스레드 지정으로 돌았고 API 오류가 모델·effort 를 말할 때만 거절 — 일시 장애는 아니다.
#[test]
fn thread_model_rejected_needs_both_facts() {
    let mut e = err(Some("invalid model: opus"));
    e.marks.thread_model = Some(thread_model());
    e.marks.harness_api_error_shown = Some("invalid model: opus".into());
    match e.into_turn_end() {
        TurnEnd::ThreadModelRejected { model, effort, .. } => {
            assert_eq!(
                (model.as_deref(), effort.as_deref()),
                (Some("opus"), Some("max"))
            );
        }
        other => panic!("{other:?}"),
    }
    let mut e = err(Some("overloaded_error"));
    e.marks.thread_model = Some(thread_model());
    assert!(matches!(e.into_turn_end(), TurnEnd::Other { .. }));
    let e = err(Some("invalid model: opus"));
    assert!(
        matches!(e.into_turn_end(), TurnEnd::Other { .. }),
        "지정 없이 돈 턴"
    );
    // `models` 같은 다른 낱말은 `model` 이 아니다(정본 `\bmodel\b`).
    let mut e = err(Some("rate limit on models endpoint"));
    e.marks.thread_model = Some(thread_model());
    assert!(matches!(e.into_turn_end(), TurnEnd::Other { .. }));
}

#[test]
fn stall_folds_with_screen() {
    let mut e = err(None);
    e.marks.stalled_ms = Some(600_000);
    e.marks.stalled_screen = Some(StallScreen::Gate);
    e.marks.stalled_screen_line = Some("> Allow?".into());
    match e.into_turn_end() {
        TurnEnd::Stall {
            stall_ms,
            screen,
            screen_line,
        } => {
            assert_eq!(stall_ms, 600_000);
            assert_eq!(screen.as_deref(), Some("gate"));
            assert_eq!(screen_line.as_deref(), Some("> Allow?"));
        }
        other => panic!("{other:?}"),
    }
}

/// 순서: 한도가 세션 충돌·lane·정지보다 먼저.
#[test]
fn quota_wins_over_everything() {
    let mut e = err(Some("You've hit your session limit"));
    e.tail = "is already in use".into();
    e.lane_code = Some("lane_unset".into());
    e.marks.stalled_ms = Some(1);
    assert!(matches!(e.into_turn_end(), TurnEnd::Quota { .. }));
}

#[test]
fn debug_hides_tail_and_api_line() {
    let mut e = err(Some("401 key sk-secret-1"));
    e.tail = "human wrote secret-tail-2".into();
    let d = format!("{e:?}");
    assert!(
        !d.contains("sk-secret-1") && !d.contains("secret-tail-2"),
        "{d}"
    );
}

/// #2028 security 낮음: API 오류에 PAT·토큰 꼴이 있으면 모델 거절 실패 글에 안 실린다.
#[test]
fn thread_model_rejection_notice_carries_masked_api_error_only() {
    use crate::turn_end::EndState;
    use crate::turn_failure::{ExitFacts, FailFacts, StallInputs, failure_marks};
    let pat = "hk_pat_secret_value_42";
    let token = format!("ghp_{}", "b".repeat(36));
    let raw = format!("400 invalid model opus (key {pat} {token})");
    let end = EndState {
        api_error: Some(raw.clone()),
        ..EndState::default()
    };
    let f = FailFacts {
        exit: ExitFacts {
            exit_code: 1,
            timed_out: false,
            tail: "",
        },
        end: &end,
        canceled_by: None,
        fenced_out: false,
        thread_unreadable: false,
        turn_timeout_ms: 1,
        harness_stall_ms: 1,
    };
    let stall = StallInputs {
        watch_now: None,
        screen_tail: "",
        harness: crate::adapter::AgentHarness::ClaudeCode,
        signal: None,
    };
    let tm = thread_model();
    let mut e = err(None);
    e.marks = failure_marks(&f, &stall, None, Some(&tm), pat, &[]);
    let TurnEnd::ThreadModelRejected {
        model,
        effort,
        api_error,
    } = e.into_turn_end()
    else {
        panic!("모델 거절이어야 한다");
    };
    let notice = crate::fail_text::thread_model_rejected_notice(
        model.as_deref(),
        effort.as_deref(),
        &api_error,
    );
    assert!(notice.contains("invalid model"), "{notice}");
    assert!(
        !notice.contains(pat) && !notice.contains(&token),
        "{notice}"
    );
}
