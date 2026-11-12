use super::*;

fn fail(
    account: Option<&str>,
    kind: AccountFailureKind,
    resets_at: Option<&str>,
) -> AccountFailure {
    AccountFailure {
        account: account.map(str::to_string),
        kind,
        resets_at: resets_at.map(str::to_string),
    }
}

#[test]
fn fixed_notices_match_canon() {
    assert_eq!(fail_body_text(&FailBody::GaveUp), FAILURE_NOTICE);
    assert_eq!(fail_body_text(&FailBody::LeaseLost), LEASE_LOST_NOTICE);
    assert_eq!(
        fail_body_text(&FailBody::SessionConflict),
        "(하네스 세션 상태가 어긋나 답할 수 없었습니다 — 운영자가 러너 로그를 확인해야 합니다)"
    );
}

#[test]
fn quota_with_and_without_reset() {
    assert_eq!(
        fail_body_text(&FailBody::Quota { resets_at: None }),
        "(사용량 한도에 걸렸습니다 — 한도가 풀린 뒤 다시 불러 주세요)"
    );
    assert_eq!(
        fail_body_text(&FailBody::Quota {
            resets_at: Some("11pm".into())
        }),
        "(사용량 한도에 걸렸습니다 — 11pm 에 풀립니다. 그 뒤에 다시 불러 주세요)"
    );
}

#[test]
fn provider_lane_splits_on_recallable_codes() {
    let r = provider_lane_notice("no_lease");
    assert!(r.starts_with("(이 멘션의 턴 임대가 없어"));
    assert!(r.contains("잃었습니다. 설정은 고칠 것이 없습니다."));
    assert!(r.ends_with("까닭: no_lease)"));
    assert!(provider_lane_recallable("lease_invalid"));
    let n = provider_lane_notice("secret_missing");
    assert!(n.starts_with("(API 키 연결을 준비하지 못해"));
    assert!(n.contains("않습니다. 데스크톱의"));
    assert!(n.ends_with("까닭: secret_missing)"));
    assert!(!provider_lane_recallable(""));
}

#[test]
fn thread_model_rejected_joins_value_and_folds_reason() {
    let t = thread_model_rejected_notice(Some("opus"), Some("high"), "bad\n  model\tname");
    assert!(t.contains("모델 opus · high 을"));
    assert!(t.ends_with("하네스: bad model name)"));
    let d = thread_model_rejected_notice(None, Some(""), &"x".repeat(300));
    assert!(d.contains("모델 설정 모델 을"));
    assert!(d.ends_with(&format!("하네스: {})", "x".repeat(160))));
}

#[test]
fn retry_notice_uses_max_attempts() {
    assert_eq!(
        fail_body_text(&FailBody::Retry {
            tried: 1,
            reason: Some("harness 정지".into())
        }),
        "(답하지 못하고 끝나 다시 시도합니다 — 1/3회째, 원인: harness 정지)"
    );
    assert_eq!(
        retry_notice(2, 3, None),
        "(답하지 못하고 끝나 다시 시도합니다 — 2/3회째)"
    );
}

#[test]
fn stall_rounds_minutes_and_branches_on_screen() {
    // 89_999ms → 1.49분 → 1, 90_000 → 1.5 → 2(정본 Math.round).
    assert!(stall_notice(89_999, None, Some("idle")).contains("1분 뒤에"));
    assert!(stall_notice(90_000, None, Some("idle")).contains("2분 뒤에"));
    assert!(
        stall_notice(600_000, Some("✘ 404"), Some("gate"))
            .ends_with("다시 불러 주세요. 화면의 마지막 오류 줄: \"✘ 404\")")
    );
    assert!(
        stall_notice(600_000, None, Some("stuck"))
            .contains("시도하지 않습니다. 이 스레드의 터미널을 열어 화면을 확인해 주세요.)")
    );
    let old = stall_notice(600_000, Some(""), None);
    assert_eq!(
        old,
        "(하네스가 10분 동안 아무것도 하지 않아 접었습니다 — 다시 시도하지 않습니다: 같은 자리에 다시 서기 때문입니다. 이 스레드의 터미널을 열어 화면을 확인해 주세요 — 확인을 기다리는 물음이 서 있을 수 있습니다.)"
    );
}

#[test]
fn account_trail_appends_kinds_and_gate_hint() {
    assert_eq!(with_account_trail("본문", &[]), "본문");
    assert_eq!(account_trail_reason(&[]), None);
    let trail = [
        fail(Some("pool-alice"), AccountFailureKind::Gate, None),
        fail(Some("pool-bob"), AccountFailureKind::Quota, Some("11pm")),
        fail(None, AccountFailureKind::Credential, None),
        fail(Some("pool-dana"), AccountFailureKind::Timeout, None),
    ];
    let t = with_account_trail("본문", &trail);
    let lines: Vec<&str> = t.lines().collect();
    assert_eq!(lines[0], "본문");
    assert_eq!(lines[1], "계정별 이유:");
    assert_eq!(
        lines[2],
        "- 계정 1: 설정 확인 화면에서 사람의 선택을 기다림"
    );
    assert_eq!(lines[3], "- 계정 2: 사용량 한도(11pm 에 풀림)");
    assert_eq!(lines[4], "- (기본 계정): 로그인이 풀림");
    assert_eq!(lines[5], "- 계정 4: 입력창이 뜨지 않음(시간 초과)");
    assert!(lines[6].starts_with("설정 확인 화면에 선 계정은"));
    assert_eq!(
        account_trail_reason(&trail[1..2]).as_deref(),
        Some("계정 1: 사용량 한도(11pm 에 풀림)")
    );
    // 계정 이름(계정 풀 폴더 이름)은 서버로 가는 본문·reason 에 싣지 않는다(#1039).
    let reason = account_trail_reason(&trail).unwrap();
    for name in ["pool-alice", "pool-bob", "pool-dana"] {
        assert!(!t.contains(name), "{t}");
        assert!(!reason.contains(name), "{reason}");
    }
    assert!(reason.starts_with("계정 1: 설정 확인 화면"), "{reason}");
    let no_gate = with_account_trail("x", &trail[1..]);
    assert!(!no_gate.contains("설정 확인 화면에 선 계정은"));
}
