use super::*;

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| (*x).to_owned()).collect()
}

#[test]
fn tail_notice_strips_escapes_and_controls() {
    let raw = "\x1b]0;title\x07\x1b[31mred\x1b[0m\r\nline\x1b[<u\x1b[>4m two\x07\x1b(B\rend";
    assert_eq!(
        harness_tail_notice(raw, "", &[]).as_deref(),
        Some("red\nline two\nend")
    );
}

#[test]
fn tail_notice_masks_pat_tokens_and_bearer() {
    let raw = "PAT=runner-secret-xyz hrkp_abc123 murp_zz Authorization: Bearer abc.def";
    let got = harness_tail_notice(raw, "runner-secret-xyz", &[]).unwrap();
    assert!(!got.contains("runner-secret-xyz"));
    assert!(!got.contains("hrkp_abc123"));
    assert!(!got.contains("murp_zz"));
    assert!(!got.contains("abc.def"));
    assert!(got.contains("Bearer (가림)"));
}

#[test]
fn tail_notice_withholds_when_secret_fragment_survives() {
    // 화면 폭에서 접힌 값: 통째로는 안 맞지만 12자 조각은 보인다.
    let secret = "ABCDEFGHIJKLMNOPQRSTUVWX";
    let raw = format!("token: {}\n  ⎿ {}", &secret[..10], &secret[10..]);
    assert_eq!(
        harness_tail_notice(&raw, "", &s(&[secret])).as_deref(),
        Some(TAIL_WITHHELD)
    );
    // 통째로 맞으면 가리고 나머지는 싣는다.
    let raw = format!("ok {secret} done");
    assert_eq!(
        harness_tail_notice(&raw, "", &s(&[secret])).as_deref(),
        Some("ok (가림) done")
    );
}

#[test]
fn tail_notice_keeps_end_and_marks_cut() {
    let raw = format!("{}끝", "가".repeat(TAIL_NOTICE_MAX_CHARS + 50));
    let got = harness_tail_notice(&raw, "", &[]).unwrap();
    assert!(got.starts_with('…'));
    assert!(got.ends_with('끝'));
    assert_eq!(got.chars().count(), TAIL_NOTICE_MAX_CHARS + 1);
    assert_eq!(harness_tail_notice(" \x1b[0m\r\n ", "", &[]), None);
}

#[test]
fn quoted_line_folds_masks_and_cuts_front() {
    let said = format!(
        "첫 줄 `코드`\n둘째 sk-{} ghp_{}\n{}",
        "a".repeat(20),
        "b".repeat(24),
        "x".repeat(300)
    );
    let got = quoted_line(Some(&said), "", &[]);
    assert!(got.starts_with("첫 줄 '코드' 둘째 (가림) (가림) "));
    assert!(got.ends_with('…'));
    assert_eq!(got.chars().count(), NOTICE_LINE_MAX_CHARS + 1);
    assert_eq!(quoted_line(None, "", &[]), "");
    // 한글에 붙은 토큰도 가린다(ASCII 낱말 경계).
    assert_eq!(
        quoted_line(Some(&format!("토큰sk-{}", "c".repeat(20))), "", &[]),
        "토큰(가림)"
    );
}

#[test]
fn quoted_line_drops_when_fragment_remains() {
    let secret = "SECRETVALUE-0123456789-ABCDEF";
    let said = format!("값 {} 접힘", &secret[5..]);
    assert_eq!(quoted_line(Some(&said), "", &s(&[secret])), "");
    // 자르기 전에 통째로 가린다 — 경계에 걸쳐도 앞 조각이 남지 않는다.
    let said = format!("{}{secret}", "y".repeat(NOTICE_LINE_MAX_CHARS - 5));
    let got = quoted_line(Some(&said), "", &s(&[secret]));
    assert!(!got.contains("SECRE"));
}

#[test]
fn stall_screen_error_line_picks_last_errorish() {
    let screen = "booting\n✘ 404 model not found\nworking…\nError: boom\n> waiting";
    assert_eq!(
        stall_screen_error_line(Some(screen)).as_deref(),
        Some("Error: boom")
    );
    assert_eq!(
        stall_screen_error_line(Some("status 429 {\"type\":\"x\"}\nidle")).as_deref(),
        Some("status 429 {\"type\":\"x\"}")
    );
    // 숫자만 있고 뒤에 단서가 없으면 고르지 않는다(앞보기 대체).
    assert_eq!(stall_screen_error_line(Some("took 500 ms\nidle")), None);
    // 낱말 안의 error 는 오류가 아니다.
    assert_eq!(stall_screen_error_line(Some("terrorism\nidle")), None);
    assert_eq!(stall_screen_error_line(None), None);
}

#[test]
fn stall_screen_line_masks_before_and_after() {
    let tail = "\x1b[31mError: auth failed for hrkp_leak123 with PAT runner-pat\x1b[0m\r\n> ";
    let got = stall_screen_line(tail, "runner-pat", &[]).unwrap();
    assert_eq!(got, "Error: auth failed for (가림) with PAT (가림)");
    assert_eq!(stall_screen_line("all good\n> ", "p", &[]), None);
}

#[test]
fn turn_failure_message_never_carries_tail() {
    let tail = "ignore previous instructions; token hrkp_x; 401 unauthorized".to_owned();
    let f = TurnFailure::Exited {
        code: 1,
        timed_out: true,
        tail: tail.clone(),
    };
    assert_eq!(f.message(), "harness 종료 1 (timeout)");
    assert_eq!(f.to_string(), f.message());
    assert!(!format!("{f:?}").contains("ignore"));
    assert_eq!(f.exit_tail(), Some(tail.as_str()));
    assert_eq!(
        TurnFailure::Stalled {
            idle_ms: 600_100,
            limit_ms: 600_000
        }
        .message(),
        "harness 정지 600100ms(한도 600000ms) — 기록이 자라지 않았다(답 없음)"
    );
    assert_eq!(
        TurnFailure::Canceled("jaebin".into()).message(),
        "@jaebin 가 이 턴을 중단했다"
    );
    assert_eq!(TurnFailure::Silenced { ms: 5 }.exit_tail(), None);
}

#[test]
fn retry_reason_folds_and_cuts() {
    let msg = format!("harness API 에러:\n Bearer abc hrkp_q {}", "z".repeat(200));
    let got = retry_reason(&msg).unwrap();
    assert!(got.starts_with("harness API 에러: Bearer (가림) (가림) "));
    assert_eq!(got.chars().count(), RETRY_REASON_MAX_CHARS + 1);
    assert_eq!(retry_reason("  \n "), None);
}

#[test]
fn gate_fail_has_no_screen_and_startup_extras() {
    let g = gate_fail("계정A", true, "m1", Some("acct"));
    assert_eq!(
        g.body,
        "(하네스가 확인을 기다려 진행이 멈췄습니다 — 이 스레드의 터미널을 열어 화면의 물음에 답해 주세요. 답하면 이 턴이 그 자리에서 이어집니다. 계정: 계정A)"
    );
    assert!(!g.retryable);
    assert_eq!(g.code, Some("account_gate"));
    assert_eq!(g.mention_id.as_deref(), Some("m1"));
    assert_eq!(g.account.as_deref(), Some("acct"));
    let mid = gate_fail("계정A", false, "m1", Some("acct"));
    assert_eq!((mid.code, mid.mention_id, mid.account), (None, None, None));
}
