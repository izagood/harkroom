use serde_json::json;

use super::*;

fn row(
    id: &str,
    author: &str,
    seq: i64,
    kind: &str,
    root: Option<&str>,
    turn: Option<&str>,
) -> Value {
    let mut m =
        json!({ "id": id, "authorId": author, "seq": seq, "kind": kind, "threadRootId": root });
    if let Some(t) = turn {
        m["meta"] = json!({ "turnId": t });
    }
    m
}

/// 쪽 단위로 돌려주는 가짜 서버 — `since` 뒤 가장 오래된 `limit` 개.
#[derive(Default)]
struct FakeIo {
    thread: Vec<Value>,
    channel: Option<Vec<Value>>,
    reads: usize,
    fails: Vec<(String, String, String, FailOpts)>,
}

impl ReportIo for FakeIo {
    fn read_thread(
        &mut self,
        _: &str,
        _: &str,
        since: i64,
        limit: u32,
    ) -> Result<Vec<Value>, String> {
        self.reads += 1;
        Ok(self
            .thread
            .iter()
            .filter(|m| seq(m) > since)
            .take(limit as usize)
            .cloned()
            .collect())
    }
    fn read_channel_since(&mut self, _: &str, _: i64, _: u32) -> Result<Vec<Value>, String> {
        self.channel.clone().ok_or_else(|| "boom".to_string())
    }
    fn fail(&mut self, c: &str, body: &str, root: &str, opts: &FailOpts) -> Result<(), String> {
        self.fails
            .push((c.into(), body.into(), root.into(), opts.clone()));
        Ok(())
    }
}

fn report_to(channel: &str) -> WakeReportTo {
    WakeReportTo {
        channel_id: channel.into(),
        thread_root_id: "rt".into(),
    }
}

fn promise<'a>(r: &'a WakeReportTo) -> ReportPromise<'a> {
    ReportPromise {
        me_id: "me",
        report_to: r,
        base_seq: 10,
        scheduled_turn_id: Some("sched"),
        reason: "CI 확인",
        anchor: "anc",
        anchor_channel_id: "c1",
        pat: "",
        secrets: &[],
    }
}

#[test]
fn off_anchor_posts_takes_only_this_turns_utterances_elsewhere() {
    let msgs = vec![
        row("a", "me", 11, "text", Some("anc"), Some("t")), // 앵커 안
        row("b", "me", 12, "text", Some("other"), Some("t")), // 잡힘
        row("c", "me", 13, "progress", Some("other"), Some("t")),
        row("d", "me", 14, "text", Some("other"), Some("t2")), // 남의 턴
        row("e", "me", 15, "text", Some("other"), None),       // 턴 모름 → 안 잡음
        row("f", "you", 16, "text", Some("other"), Some("t")),
        row("g", "me", 9, "text", Some("other"), Some("t")), // 기준선 앞
        row("anc", "me", 17, "text", None, Some("t")),       // 앵커 루트 자신
    ];
    let got: Vec<&str> = off_anchor_posts(&msgs, "me", Some("anc"), 10, Some("t"))
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(got, vec!["b"]);
    assert!(off_anchor_posts(&msgs, "me", Some("anc"), 10, None).is_empty());
}

#[test]
fn top_level_anchor_counts_only_thread_replies_as_elsewhere() {
    let msgs = vec![
        row("x", "me", 11, "text", None, Some("t")),
        row("y", "me", 12, "text", Some("r1"), Some("t")),
    ];
    let got = off_anchor_posts(&msgs, "me", None, 10, Some("t"));
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["id"], "y");
}

#[test]
fn off_anchor_notice_links_each_thread_once() {
    let a = row("b", "me", 12, "text", Some("r1"), Some("t"));
    let b = row("c", "me", 13, "text", Some("r1"), Some("t"));
    let c = row("r2", "me", 14, "text", None, Some("t"));
    assert_eq!(off_anchor_notice(&[]), None);
    assert_eq!(
        off_anchor_notice(&[&a, &b, &c]).unwrap(),
        "이 요청의 답은 다른 스레드에 올렸습니다: harkroom://message/r1 · harkroom://message/r2"
    );
}

#[test]
fn report_missed_notice_drops_reason_when_null() {
    let with = report_missed_notice(Some("사유X"), "anc", "", &[]);
    assert!(with.contains("사유: 사유X"));
    assert!(
        with.ends_with("그 턴은 harkroom://message/anc 스레드에서 돌았다. 결과는 그쪽을 본다.")
    );
    let without = report_missed_notice(None, "anc", "", &[]);
    assert!(!without.contains("사유"));
    assert!(
        without.starts_with(
            "이 스레드에 보고하기로 한 예약이 깨어났지만 여기에 아무 말 없이 끝났다.\n"
        )
    );
}

#[test]
fn progress_counts_as_report_but_wake_and_scheduler_turn_do_not() {
    let r = report_to("c1");
    let mut io = FakeIo {
        thread: vec![
            row("w", "me", 11, "wake", Some("rt"), Some("t")),
            row("s", "me", 12, "text", Some("rt"), Some("sched")),
            row("p", "me", 13, "progress", Some("rt"), Some("t")),
        ],
        ..FakeIo::default()
    };
    assert_eq!(
        report_promise_check(&mut io, &promise(&r)).unwrap(),
        OwnReport::Found("p".into())
    );
    assert!(io.fails.is_empty());
}

#[test]
fn missing_report_fails_in_report_thread_and_hides_reason_across_channels() {
    for (channel, shows_reason) in [("c1", true), ("c2", false)] {
        let r = report_to(channel);
        let mut io = FakeIo {
            thread: vec![row("s", "me", 12, "text", Some("rt"), Some("sched"))],
            ..FakeIo::default()
        };
        assert_eq!(
            report_promise_check(&mut io, &promise(&r)).unwrap(),
            OwnReport::Missing
        );
        let (c, body, root, opts) = &io.fails[0];
        assert_eq!((c.as_str(), root.as_str()), (channel, "rt"));
        assert_eq!(body.contains("CI 확인"), shows_reason);
        assert!(!opts.retryable);
        assert_eq!(
            opts.what.as_deref(),
            Some("약속한 스레드에 보고하지 않고 깨움 턴이 끝났다")
        );
    }
}

#[test]
fn reads_past_the_window_and_gives_up_when_too_busy() {
    let r = report_to("c1");
    // 첫 쪽(200)은 남의 글, 둘째 쪽에 내 보고.
    let mut thread: Vec<Value> = (0..200)
        .map(|i| row(&format!("o{i}"), "you", 11 + i, "text", Some("rt"), None))
        .collect();
    thread.push(row("mine", "me", 211, "text", Some("rt"), Some("t")));
    let mut io = FakeIo {
        thread,
        ..FakeIo::default()
    };
    assert_eq!(
        own_report_since(&mut io, "me", &r, 10, None).unwrap(),
        OwnReport::Found("mine".into())
    );
    assert_eq!(io.reads, 2);

    let busy: Vec<Value> = (0..(REPORT_CHECK_PAGE as i64 * REPORT_CHECK_MAX_PAGES as i64 + 5))
        .map(|i| row(&format!("o{i}"), "you", 11 + i, "text", Some("rt"), None))
        .collect();
    let mut io = FakeIo {
        thread: busy,
        ..FakeIo::default()
    };
    assert_eq!(
        report_promise_check(&mut io, &promise(&r)).unwrap(),
        OwnReport::TooBusy
    );
    assert_eq!(io.reads, REPORT_CHECK_MAX_PAGES);
    assert!(io.fails.is_empty(), "다 못 읽었으면 경고하지 않는다");
}

#[test]
fn off_anchor_evidence_swallows_read_errors() {
    let mut io = FakeIo {
        channel: None,
        ..FakeIo::default()
    };
    assert_eq!(
        off_anchor_evidence(&mut io, "k", "me", "c1", Some("anc"), 10, "t"),
        None
    );
    let mut io = FakeIo {
        channel: Some(vec![row("b", "me", 12, "text", Some("r1"), Some("t"))]),
        ..FakeIo::default()
    };
    assert_eq!(
        off_anchor_evidence(&mut io, "k", "me", "c1", Some("anc"), 10, "t").as_deref(),
        Some("이 요청의 답은 다른 스레드에 올렸습니다: harkroom://message/r1")
    );
}

/// #2005 security 낮음: 사유는 가리고, 사유의 `@x` 는 멘션 꼴이 아니다(전각 ＠).
#[test]
fn report_missed_reason_is_masked_and_mentions_defused() {
    let secret = "MOUNTEDsecretVALUE0123456789".to_string();
    let pat = "hrkp_runnerpat_abcdefghijklmnop";
    let n = report_missed_notice(
        Some(&format!(
            "@task_manager 에게 알릴 것 {pat} {secret}\n둘째 줄"
        )),
        "anc",
        pat,
        std::slice::from_ref(&secret),
    );
    let reason_line = n.lines().next().unwrap();
    assert!(!reason_line.contains('@'), "{reason_line}");
    assert!(reason_line.contains("＠task_manager"), "{reason_line}");
    assert!(!n.contains(pat) && !n.contains(&secret), "{n}");
    assert_eq!(n.lines().count(), 2, "사유는 한 줄로");
}
