//! `tests/prompt_turn_golden.json` 은 정본 `buildTurnPrompt` 를 `TZ=Asia/Seoul` tsx 로 돌려 뽑은 입력·출력 쌍이다.
use super::*;

static GOLDEN: &str = include_str!("../tests/prompt_turn_golden.json");

fn opt_str<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

fn run_case(input: &Value) -> TurnPrompt {
    let handles: HashMap<String, String> = input["handles"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
        .collect();
    let messages = input["messages"].as_array().unwrap().clone();
    let bundled: Option<Vec<String>> = input
        .get("bundledIds")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|v| v.as_str().unwrap().to_owned()).collect());
    let wake = input.get("wake").map(|w| TurnWake {
        reason: opt_str(w, "reason").unwrap().to_owned(),
        report_to: w.get("reportTo").cloned(),
        watch: w.get("watch").and_then(Value::as_bool).unwrap_or(false),
        written: w.get("written").map(|wr| WakeWritten {
            by: opt_str(wr, "by").map(str::to_owned),
            text: opt_str(wr, "text").unwrap().to_owned(),
        }),
        already_reported: opt_str(w, "alreadyReported").map(str::to_owned),
    });
    let arr = |k: &str| input.get(k).and_then(Value::as_array).map(Vec::as_slice);
    let i = TurnPromptInput {
        messages: &messages,
        last_fed_seq: input["lastFedSeq"].as_i64().unwrap(),
        me_id: opt_str(input, "meId").unwrap(),
        handles: &handles,
        channel_id: opt_str(input, "channelId").unwrap(),
        thread_root_id: opt_str(input, "threadRootId"),
        now: input
            .get("nowMs")
            .and_then(Value::as_i64)
            .map(|now_ms| TurnClock {
                now_ms,
                time_zone: "Asia/Seoul".to_owned(),
                utc_offset_minutes: 540,
            }),
        wake,
        watch_origin: input.get("watchOrigin"),
        canceled_wakes: arr("canceledWakes"),
        started_in: input.get("startedIn"),
        team: input.get("team"),
        delegation: input.get("delegation"),
        delegation_followup: input.get("delegationFollowup"),
        delegation_update: input.get("delegationUpdate"),
        delegations: arr("delegations"),
        delegated_by: input.get("delegatedBy"),
        edited_mention: input.get("editedMention"),
        fresh_wake: input
            .get("freshWake")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        unseen_own_after_seq: input.get("unseenOwnAfterSeq").and_then(Value::as_i64),
        bundled_ids: bundled.as_deref(),
        mention_id: opt_str(input, "mentionId"),
        gap_after_seq: input.get("gapAfterSeq").and_then(Value::as_i64),
        after_cancel_by: opt_str(input, "afterCancelBy"),
    };
    build_turn_prompt(&i)
}

#[test]
fn matches_ts_golden_cases() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let cases = golden.as_object().unwrap();
    assert!(cases.len() >= 12);
    for (name, case) in cases {
        let got = run_case(&case["input"]);
        let want = &case["expected"];
        assert_eq!(
            got.fed_seq,
            want["fedSeq"].as_i64().unwrap(),
            "fedSeq: {name}"
        );
        assert_eq!(
            got.prompt,
            want["prompt"].as_str().unwrap(),
            "prompt: {name}"
        );
    }
}

#[test]
fn golden_covers_each_branch() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let p = |k: &str| golden[k]["expected"]["prompt"].as_str().unwrap().to_owned();
    assert!(p("empty_self_only").is_empty());
    assert!(p("first_turn_context").contains("<thread-context>"));
    assert!(p("first_turn_context").contains("attachment.fetch"));
    assert!(p("stale_with_later").contains("그 뒤에 네 글이 있다"));
    assert!(p("mention_out_of_range").contains("위 범위 밖이라"));
    assert!(p("wake_full").contains("채널 최상위(없음)"));
    assert!(p("team_delegation").contains("수정으로 추가된 멘션"));
    assert!(p("bundled_budget_gap").contains("같이 처리할 앞 부름 2개"));
    assert!(p("bundled_budget_gap").contains("이상 생략"));
    assert!(!p("under_budget_unseen_own").contains("생략"));
}
