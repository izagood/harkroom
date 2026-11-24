use super::*;

const SINCE: i64 = 1_800_000_000_000;

fn at(offset_s: i64) -> String {
    // SINCE = 2027-01-15T08:00:00Z
    format!(
        "2027-01-15T08:{:02}:{:02}.000Z",
        offset_s / 60,
        offset_s % 60
    )
}

fn rec(id: &str, ts: &str, usage: &str) -> String {
    format!(
        r#"{{"type":"assistant","timestamp":"{ts}","message":{{"id":"{id}","model":"model-a","usage":{usage}}}}}"#
    )
}

#[test]
fn since_matches_the_fixture_clock() {
    assert_eq!(parse_iso_offset_ms(&at(0)), Some(SINCE));
}

#[test]
fn sums_several_messages() {
    let lines = [
        rec(
            "m1",
            &at(1),
            r#"{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":7}"#,
        ),
        r#"{"type":"user","timestamp":"2027-01-15T08:00:02.000Z","message":{"content":"has \"usage\" word"}}"#.to_owned(),
        rec(
            "m2",
            &at(3),
            r#"{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}"#,
        ),
    ];
    let t = sum_claude_usage(&lines, SINCE).unwrap();
    assert_eq!(
        t,
        TurnTokens {
            input: 11,
            output: 7,
            cache_read: 103,
            cache_write: 11,
            messages: 2,
            model: Some("model-a".into()),
        }
    );
}

#[test]
fn same_message_id_counts_once_with_the_last_usage() {
    // 같은 응답이 내용 조각마다 적힌다 — 마지막 줄의 수만 센다.
    let lines = [
        rec("m1", &at(1), r#"{"input_tokens":10,"output_tokens":1}"#),
        rec("m1", &at(1), r#"{"input_tokens":10,"output_tokens":9}"#),
        rec("m2", &at(2), r#"{"input_tokens":1,"output_tokens":1}"#),
    ];
    let t = sum_claude_usage(&lines, SINCE).unwrap();
    assert_eq!((t.input, t.output, t.messages), (11, 10, 2));
}

#[test]
fn missing_cache_fields_are_zero_and_broken_lines_are_skipped() {
    let lines = [
        r#"{"type":"assistant","usage": broken"#.to_owned(),
        String::new(),
        rec("m1", &at(1), r#"{"input_tokens":4,"output_tokens":6}"#),
        // usage 가 객체가 아니거나 수가 음수·문자열이면 그 칸은 0.
        rec("m2", &at(2), r#""none""#),
        rec("m3", &at(3), r#"{"input_tokens":-5,"output_tokens":"x"}"#),
    ];
    let t = sum_claude_usage(&lines, SINCE).unwrap();
    assert_eq!(
        (t.input, t.output, t.cache_read, t.cache_write, t.messages),
        (4, 6, 0, 0, 2)
    );
}

#[test]
fn earlier_turns_and_untimed_records_are_not_counted() {
    let lines = [
        rec(
            "old",
            "2027-01-15T07:59:59.000Z",
            r#"{"input_tokens":999,"output_tokens":999}"#,
        ),
        r#"{"type":"assistant","message":{"id":"x","usage":{"input_tokens":5,"output_tokens":5}}}"#
            .to_owned(),
    ];
    // 하나도 못 세면 「모름」이다 — 0 이 아니다.
    assert_eq!(sum_claude_usage(&lines, SINCE), None);
    assert_eq!(sum_claude_usage(Vec::<String>::new(), SINCE), None);
}

#[test]
fn model_id_is_kept_verbatim_but_clipped_and_synthetic_is_ignored() {
    let long = "m".repeat(200);
    let lines = [
        format!(
            r#"{{"type":"assistant","timestamp":"{}","message":{{"id":"a","model":"{long}","usage":{{"input_tokens":1}}}}}}"#,
            at(1)
        ),
        format!(
            r#"{{"type":"assistant","timestamp":"{}","message":{{"id":"b","model":"<synthetic>","usage":{{"input_tokens":0}}}}}}"#,
            at(2)
        ),
    ];
    let t = sum_claude_usage(&lines, SINCE).unwrap();
    assert_eq!(t.model.unwrap().chars().count(), MODEL_ID_MAX_CHARS);
}

#[test]
fn reads_a_file_and_refuses_other_harnesses_and_missing_files() {
    let dir = std::env::temp_dir().join(format!("turn-tokens-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("s.jsonl");
    std::fs::write(
        &path,
        format!(
            "{}\nnot json \"usage\"\n{}\n",
            rec("m1", &at(1), r#"{"input_tokens":2,"output_tokens":3}"#),
            rec("m2", &at(2), r#"{"input_tokens":5,"output_tokens":7}"#),
        ),
    )
    .unwrap();
    let t = read_turn_tokens(AgentHarness::ClaudeCode, Some(&path), SINCE).unwrap();
    assert_eq!((t.input, t.output, t.messages), (7, 10, 2));
    assert_eq!(
        read_turn_tokens(AgentHarness::Codex, Some(&path), SINCE),
        None
    );
    assert_eq!(
        read_turn_tokens(AgentHarness::ClaudeCode, None, SINCE),
        None
    );
    assert_eq!(
        read_turn_tokens(
            AgentHarness::ClaudeCode,
            Some(&dir.join("none.jsonl")),
            SINCE
        ),
        None
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn activity_body_carries_numbers_and_names_only() {
    let t = TurnTokens {
        input: 1,
        output: 2,
        cache_read: 3,
        cache_write: 4,
        messages: 5,
        model: None,
    };
    let b = activity_body(AgentHarness::ClaudeCode, &t, 900);
    assert_eq!(
        b,
        json!({ "tokens": {
            "harness": "claude-code", "input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 4,
            "messages": 5, "durationMs": 900
        }})
    );
    let with = activity_body(
        AgentHarness::ClaudeCode,
        &TurnTokens {
            model: Some("model-a".into()),
            ..t
        },
        1,
    );
    assert_eq!(with["tokens"]["model"], "model-a");
}
