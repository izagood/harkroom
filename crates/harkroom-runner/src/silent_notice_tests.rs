use super::*;

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| (*x).to_owned()).collect()
}

fn input<'a>(caller: NudgeCaller, secrets: &'a [String]) -> SilentTurnInput<'a> {
    SilentTurnInput {
        caller,
        last_said: None,
        off_anchor: None,
        pat: "",
        secrets,
        screen_answer: None,
        proxy_head: "",
        record_answer: None,
        screen_ended: false,
        record_proxy: false,
    }
}

const LONG: &str = "이 답은 충분히 길어서 답 꼴로 읽힌다. 표도 멘션도 없지만 길이 하한(120자)을 넘으면 끝말이 아니라 답으로 본다. 그래서 기록 대리 게시가 켜진 턴이면 러너가 이 말을 인용으로 싸서 스레드에 대신 올린다. 여기까지 쓰면 120자를 넉넉히 넘는다.";

#[test]
fn off_anchor_wins_and_wake_reacts() {
    let none: Vec<String> = vec![];
    let mut i = input(NudgeCaller::Human, &none);
    i.off_anchor = Some("답은 저기 올렸다");
    assert_eq!(
        silent_turn_notice(&i),
        SilentTurnNotice::Post {
            body: "답은 저기 올렸다".into(),
            proxied: false
        }
    );
    let i = input(NudgeCaller::Wake, &none);
    assert_eq!(
        silent_turn_notice(&i),
        SilentTurnNotice::React {
            emoji: SILENT_ACK_EMOJI
        }
    );
}

#[test]
fn agent_call_without_screen_end_reacts_unless_record_proxy_has_answer() {
    let none: Vec<String> = vec![];
    let mut i = input(NudgeCaller::Agent, &none);
    i.last_said = Some("확인했습니다");
    i.record_proxy = true;
    assert_eq!(
        silent_turn_notice(&i),
        SilentTurnNotice::React {
            emoji: SILENT_ACK_EMOJI
        }
    );
    i.last_said = Some(LONG);
    i.proxy_head = "@alice\n\n";
    match silent_turn_notice(&i) {
        SilentTurnNotice::Post {
            body,
            proxied: true,
        } => {
            assert!(body.starts_with("@alice\n\n> 이 답은"));
            assert!(body.ends_with(PROXY_RECORD_TAIL));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn agent_call_screen_ended_without_answer_posts_fixed_line() {
    let none: Vec<String> = vec![];
    let mut i = input(NudgeCaller::Agent, &none);
    i.screen_ended = true;
    assert_eq!(
        silent_turn_notice(&i),
        SilentTurnNotice::Post {
            body: AGENT_CALL_NO_ANSWER.into(),
            proxied: false
        }
    );
    i.screen_answer = Some("첫 줄\n@bob 둘째 줄");
    match silent_turn_notice(&i) {
        SilentTurnNotice::Post {
            body,
            proxied: true,
        } => {
            assert!(body.starts_with("> 첫 줄\n> @bob 둘째 줄"));
            assert!(body.ends_with(PROXY_SCREEN_TAIL));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn record_answer_beats_screen_answer() {
    let none: Vec<String> = vec![];
    let mut i = input(NudgeCaller::Human, &none);
    i.screen_answer = Some("화면");
    i.record_answer = Some("기록");
    match silent_turn_notice(&i) {
        SilentTurnNotice::Post {
            body,
            proxied: true,
        } => assert!(body.starts_with("> 기록")),
        other => panic!("{other:?}"),
    }
}

#[test]
fn delegated_fails_and_human_falls_back_to_quote() {
    let none: Vec<String> = vec![];
    let mut i = input(NudgeCaller::Delegated, &none);
    i.last_said = Some("멈췄다");
    assert_eq!(
        silent_turn_notice(&i),
        SilentTurnNotice::Fail {
            body: "넘겨받은 일에 답을 남기지 못하고 끝났습니다. 마지막 말: \"멈췄다\" — 다시 넘기면 이어서 합니다.".into()
        }
    );
    let i = input(NudgeCaller::Human, &none);
    assert_eq!(
        silent_turn_notice(&i),
        SilentTurnNotice::Post {
            body: "답을 남기지 못하고 끝났습니다 — 다시 부르면 이어서 합니다.".into(),
            proxied: false
        }
    );
}

#[test]
fn delegation_outcome_quotes_on_its_own_line() {
    let none: Vec<String> = vec![];
    let mut i = input(NudgeCaller::DelegationOutcome, &none);
    i.last_said = Some("결말 확인");
    assert_eq!(
        silent_turn_notice(&i),
        SilentTurnNotice::Post {
            body: "넘긴 일의 결말을 확인한 턴이 글 없이 끝났습니다 — 마지막 말:\n> 결말 확인"
                .into(),
            proxied: false
        }
    );
}

#[test]
fn secret_fragment_withholds_proxy() {
    let secrets = s(&["abcdefghijklmnopqrstuvwxyz"]);
    // 화면이 줄바꿈으로 값을 갈랐다 — 통째 가림으로는 못 찾고 12자 조각으로 잡는다.
    assert_eq!(
        proxy_answer_body(Some("값 abcdefghijklm\nnopqrstuvwxyz"), "", &secrets, 0),
        ""
    );
    assert_eq!(
        proxy_record_answer_body("값 abcdefghijklmnop", "", &secrets, 0),
        ""
    );
    // PAT 도 조각으로 본다(화면 답).
    assert_eq!(
        proxy_answer_body(
            Some("hrkp_0123456789\nabcdef"),
            "hrkp_0123456789abcdef",
            &[],
            0
        ),
        ""
    );
}

#[test]
fn record_proxy_masks_tokens_and_keeps_blank_lines() {
    let body = proxy_record_answer_body("첫 줄 ghp_ABCDEFGHIJKLMNOPQRSTUVWX\n\n끝", "", &[], 0);
    assert!(body.starts_with("> 첫 줄 (가림)\n>\n> 끝"), "{body}");
}

#[test]
fn long_answer_keeps_head_and_tail_within_body_limit() {
    let mut lines: Vec<String> = vec!["| 머리 | 칸 |".into()];
    for n in 0..400 {
        lines.push(format!("| 줄 {n} | 값값값값값값값값값값값값값값값값값 |"));
    }
    lines.push(String::new());
    lines.push("끝말: 위 표가 결과다.".into());
    let text = lines.join("\n");
    let head = "@carol\n\n";
    let body = proxy_record_answer_body(&text, "", &[], head.encode_utf16().count());
    let full = format!("{head}{body}");
    assert!(full.encode_utf16().count() <= BODY_LIMIT);
    assert!(body.starts_with("> | 머리 | 칸 |"));
    assert!(body.contains("줄 생략 …"));
    assert!(body.contains("> 끝말: 위 표가 결과다."));
    assert!(body.ends_with(PROXY_RECORD_TAIL));
}

#[test]
fn fit_counts_utf16_units_and_never_splits_a_char() {
    // 이모지(2칸)만 든 한 줄이 칸을 혼자 넘는다 — 글자 가운데에서 자르지 않고 칸을 넘지 않는다.
    let line = format!("> {}", "😀".repeat(5_000));
    let out = fit_quoted_lines(std::slice::from_ref(&line), 100);
    assert!(units(&out) <= 100, "{}", units(&out));
    assert!(out.contains("일부 생략"));
    assert_eq!(keep_head_units("a😀b", 2), "a");
    assert_eq!(keep_tail_units("a😀b", 2), "b");
    assert_eq!(keep_tail_units("a😀b", 3), "😀b");
    assert_eq!(keep_head_units("abc", 0), "");
}

#[test]
fn background_cut_and_silent_wake_lines() {
    assert_eq!(
        background_cut_notice(2, 10_000, None, "", &[]),
        "하위 에이전트 2개가 1분 안에 끝나지 않아 턴을 거뒀습니다 — 그 작업은 끊겼습니다. 다시 부르면 이어서 합니다."
    );
    assert_eq!(
        background_cut_notice(1, 150_000, Some("기다리는 중"), "", &[]),
        "하위 에이전트 1개가 3분 안에 끝나지 않아 턴을 거뒀습니다 — 그 작업은 끊겼습니다. 마지막 말: \"기다리는 중\" 다시 부르면 이어서 합니다."
    );
    assert_eq!(
        silent_wake_notice(None, "", &[]),
        "(예약된 확인 턴이 발화 없이 끝났습니다)"
    );
    assert_eq!(
        silent_wake_notice(Some("새 소식 없음"), "", &[]),
        "(예약된 확인 턴이 발화 없이 끝났습니다 — 하네스의 마지막 말: \"새 소식 없음\")"
    );
}
