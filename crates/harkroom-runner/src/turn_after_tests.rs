use super::*;

#[derive(Default)]
struct Fake {
    last: Option<String>,
    silent: SilentSaid,
    off: Option<String>,
    promise_err: bool,
    fail_post: bool,
    calls: Vec<String>,
    logs: Vec<String>,
}

impl AfterIo for Fake {
    fn last_said(&mut self) -> Option<String> {
        self.calls.push("last_said".into());
        self.last.clone()
    }
    fn silent_said(&mut self) -> SilentSaid {
        self.calls.push("silent_said".into());
        self.silent.clone()
    }
    fn off_anchor(&mut self) -> Option<String> {
        self.calls.push("off_anchor".into());
        self.off.clone()
    }
    fn report_promise(&mut self) -> Result<(), String> {
        self.calls.push("report_promise".into());
        if self.promise_err {
            Err("읽기 실패".into())
        } else {
            Ok(())
        }
    }
    fn post(&mut self, c: &str, body: &str, a: Option<&str>) -> Result<(), String> {
        self.calls.push(format!("post {c} {a:?} {body}"));
        if self.fail_post {
            Err("발화 실패".into())
        } else {
            Ok(())
        }
    }
    fn progress(&mut self, c: &str, body: &str, a: Option<&str>) -> Result<(), String> {
        self.calls.push(format!("progress {c} {a:?} {body}"));
        Ok(())
    }
    fn react(&mut self, c: &str, m: &str, e: &str) -> Result<(), String> {
        self.calls.push(format!("react {c} {m} {e}"));
        Ok(())
    }
    fn fail(&mut self, c: &str, body: &str, a: Option<&str>, o: &FailOpts) -> Result<(), String> {
        self.calls.push(format!(
            "fail {c} {a:?} retry={} mention={:?} {body}",
            o.retryable, o.mention_id
        ));
        Ok(())
    }
    fn log(&mut self, line: &str) {
        self.logs.push(line.into());
    }
}

const SECRETS: &[String] = &[];

fn facts(caller: NudgeCaller) -> AfterFacts<'static> {
    AfterFacts {
        key: "k",
        channel_id: "c",
        anchor: Some("root"),
        mention_id: "men",
        caller,
        proxy_head: "",
        record_proxy: false,
        wake_reason: "",
        background_wait_ms: 120_000,
        pat: "hk_pat_secret",
        secrets: SECRETS,
    }
}

fn plan(silent: SilentPath) -> AfterTurnPlan {
    AfterTurnPlan {
        silent,
        post_count: 0,
        check_report_promise: false,
        watch_missed: false,
        delegation_report_missed: false,
    }
}

#[test]
fn nothing_touches_no_io() {
    let mut io = Fake::default();
    let mut p = plan(SilentPath::Nothing);
    p.post_count = 1;
    apply_after_turn(&p, &facts(NudgeCaller::Human), &mut io).unwrap();
    assert!(io.calls.is_empty());
    assert!(io.logs.is_empty());
}

#[test]
fn duplicate_posts_only_logged() {
    let mut io = Fake::default();
    let mut p = plan(SilentPath::Nothing);
    p.post_count = 2;
    apply_after_turn(&p, &facts(NudgeCaller::Human), &mut io).unwrap();
    assert!(io.calls.is_empty());
    assert_eq!(io.logs.len(), 1);
    assert!(io.logs[0].contains("2건"));
}

#[test]
fn background_cut_posts_notice_with_masked_last_said() {
    let mut io = Fake {
        last: Some("토큰 hk_pat_secret 남김".into()),
        ..Fake::default()
    };
    apply_after_turn(
        &plan(SilentPath::BackgroundCut { count: 2 }),
        &facts(NudgeCaller::Human),
        &mut io,
    )
    .unwrap();
    assert_eq!(io.calls.len(), 2);
    assert!(io.calls[1].starts_with("post c Some(\"root\") 하위 에이전트 2개가 2분"));
    assert!(!io.calls[1].contains("hk_pat_secret"));
}

#[test]
fn silent_turn_human_posts_and_reads_off_anchor() {
    let mut io = Fake::default();
    apply_after_turn(
        &plan(SilentPath::SilentTurn),
        &facts(NudgeCaller::Human),
        &mut io,
    )
    .unwrap();
    assert_eq!(io.calls[0], "silent_said");
    assert_eq!(io.calls[1], "off_anchor");
    assert!(io.calls[2].starts_with("post c Some(\"root\") 답을 남기지 못하고"));
}

#[test]
fn silent_turn_off_anchor_wins() {
    let mut io = Fake {
        off: Some("다른 스레드에 답했다".into()),
        ..Fake::default()
    };
    apply_after_turn(
        &plan(SilentPath::SilentTurn),
        &facts(NudgeCaller::Human),
        &mut io,
    )
    .unwrap();
    assert_eq!(io.calls[2], "post c Some(\"root\") 다른 스레드에 답했다");
}

#[test]
fn silent_turn_wake_reacts_on_mention() {
    let mut io = Fake::default();
    apply_after_turn(
        &plan(SilentPath::SilentTurn),
        &facts(NudgeCaller::Wake),
        &mut io,
    )
    .unwrap();
    assert_eq!(io.calls[2], "react c men ✅");
    assert_eq!(io.logs.len(), 1);
}

#[test]
fn silent_turn_delegated_fails_retryable_with_mention() {
    let mut io = Fake::default();
    apply_after_turn(
        &plan(SilentPath::SilentTurn),
        &facts(NudgeCaller::Delegated),
        &mut io,
    )
    .unwrap();
    assert!(io.calls[2].starts_with("fail c Some(\"root\") retry=true mention=Some(\"men\")"));
}

#[test]
fn wake_ack_reacts_and_wake_progress_posts_progress() {
    let mut io = Fake::default();
    apply_after_turn(
        &plan(SilentPath::WakeAck),
        &facts(NudgeCaller::Wake),
        &mut io,
    )
    .unwrap();
    assert_eq!(io.calls, vec!["last_said", "react c men ✅"]);

    let mut io = Fake::default();
    apply_after_turn(
        &plan(SilentPath::WakeProgress),
        &facts(NudgeCaller::Wake),
        &mut io,
    )
    .unwrap();
    assert_eq!(io.calls[0], "last_said");
    assert!(io.calls[1].starts_with("progress c Some(\"root\") (예약된 확인 턴이"));
}

#[test]
fn independent_checks_run_in_order_after_silent_path() {
    let mut io = Fake::default();
    let mut p = plan(SilentPath::WakeAck);
    p.check_report_promise = true;
    p.watch_missed = true;
    p.delegation_report_missed = true;
    let mut f = facts(NudgeCaller::Wake);
    f.wake_reason = "@forge 에게 hk_pat_secret";
    apply_after_turn(&p, &f, &mut io).unwrap();
    assert_eq!(io.calls[1], "react c men ✅");
    assert_eq!(io.calls[2], "report_promise");
    assert!(io.calls[3].starts_with("fail c Some(\"root\") retry=false mention=None 감시 예약"));
    assert!(io.calls[3].contains("＠forge"));
    assert!(!io.calls[3].contains("@forge"));
    assert!(!io.calls[3].contains("hk_pat_secret"));
    assert_eq!(
        io.calls[4],
        format!(
            "fail c Some(\"root\") retry=true mention=Some(\"men\") {DELEGATION_REPORT_MISSED_NOTICE}"
        )
    );
}

#[test]
fn first_error_stops_the_rest() {
    let mut io = Fake {
        fail_post: true,
        ..Fake::default()
    };
    let mut p = plan(SilentPath::BackgroundCut { count: 1 });
    p.check_report_promise = true;
    p.delegation_report_missed = true;
    assert_eq!(
        apply_after_turn(&p, &facts(NudgeCaller::Human), &mut io),
        Err("발화 실패".into())
    );
    assert_eq!(io.calls.len(), 2);

    let mut io = Fake {
        promise_err: true,
        ..Fake::default()
    };
    let mut p = plan(SilentPath::Nothing);
    p.check_report_promise = true;
    p.delegation_report_missed = true;
    assert!(apply_after_turn(&p, &facts(NudgeCaller::Human), &mut io).is_err());
    assert_eq!(io.calls, vec!["report_promise"]);
}

#[test]
fn clip_body_cuts_utf16_units_without_splitting_pairs() {
    let short = "가나다";
    assert_eq!(clip_body(short), short);
    let long = "a".repeat(BODY_LIMIT + 5);
    assert_eq!(clip_body(&long).len(), BODY_LIMIT);
    // 서로게이트 쌍(2단위)이 경계에 걸리면 통째로 뺀다.
    let edge = format!("{}😀", "a".repeat(BODY_LIMIT - 1));
    assert_eq!(clip_body(&edge), "a".repeat(BODY_LIMIT - 1));
    let fits = format!("{}😀", "a".repeat(BODY_LIMIT - 2));
    assert_eq!(clip_body(&fits), fits);
}
