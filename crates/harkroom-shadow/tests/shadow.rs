//! 녹화 재생 비교 — 하네스 fixture 로 지은 녹화에서 맞는 표지는 맞다고, 틀린 표지는 틀리다고 하는지.
use harkroom_shadow::*;
use serde_json::json;
use std::path::PathBuf;

fn fx(name: &str) -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(root.join("../../packages/agent/test/fixtures").join(name)).unwrap()
}

fn paint(text: &str) -> String {
    format!("\x1b[2J\x1b[H{}", text.replace('\n', "\r\n"))
}

/// (출력 조각, 그 조각 뒤 표지로 적을 TS 판정) 들로 녹화 글을 짓는다. 표지는 일부러 한 줄 늦게 적는다(비동기 흉내).
fn cast(harness: &str, steps: &[(&str, Option<&str>)]) -> String {
    let mut out = vec![json!({"version":2,"width":120,"height":40,"timestamp":0}).to_string()];
    let mut bytes = 0usize;
    let mut pending: Option<String> = None;
    for (i, (chunk, state)) in steps.iter().enumerate() {
        bytes += chunk.len();
        out.push(json!([i as f64, "o", chunk]).to_string());
        if let Some(p) = pending.take() {
            out.push(p);
        }
        if let Some(s) = state {
            let m = json!({"kind":"screen","harness":harness,"state":s,"bytes":bytes}).to_string();
            pending = Some(json!([i as f64, "m", m]).to_string());
        }
    }
    if let Some(p) = pending {
        out.push(p);
    }
    out.join("\n")
}

#[test]
fn matching_marks_are_counted_by_state() {
    let busy = paint(&fx("codex-tui-busy.txt"));
    let ended = paint(&fx("codex-tui-ended.txt"));
    let text = cast(
        "codex",
        &[(&busy, Some("busy")), ("", None), (&ended, Some("idle"))],
    );
    let r = compare(&parse_cast(&text).unwrap());
    assert_eq!(r.samples, 2);
    assert_eq!(r.matched, 2, "{:?}", r.mismatches);
    assert_eq!(r.by_state["busy"], (1, 1));
    assert_eq!(r.by_state["idle"], (1, 1));
    assert_eq!(r.busy_stream_bytes, ended.len());
}

#[test]
fn a_wrong_mark_is_reported_without_screen_text() {
    let busy = paint(&fx("codex-tui-busy.txt"));
    let text = cast("codex", &[(&busy, Some("idle"))]);
    let r = compare(&parse_cast(&text).unwrap());
    assert_eq!(r.matched, 0);
    assert_eq!(
        r.mismatches,
        vec![Mismatch {
            bytes: busy.len(),
            ts: "idle".into(),
            rust: "busy".into()
        }]
    );
    let s = summarize(&[r]).to_string();
    assert!(!s.contains("codex-tui"), "집계에 화면 글이 없어야 한다");
    assert!(s.contains("\"ts=idle rust=busy\":1"));
}

#[test]
fn multibyte_output_is_counted_in_utf8_bytes() {
    let busy = paint(&fx("codex-tui-busy.txt"));
    let pre = "가나다";
    let text = cast("codex", &[(pre, None), (&busy, Some("busy"))]);
    let c = parse_cast(&text).unwrap();
    assert_eq!(c.marks[0].bytes, pre.len() + busy.len());
    assert_eq!(compare(&c).matched, 1);
}

#[test]
fn marks_past_a_truncated_recording_are_not_compared() {
    let mut text = cast("codex", &[("x", None)]);
    let m = json!({"kind":"screen","harness":"codex","state":"busy","bytes":99}).to_string();
    text.push_str(&format!("\n{}", json!([1.0, "m", m])));
    let r = compare(&parse_cast(&text).unwrap());
    assert_eq!((r.samples, r.beyond_end), (0, 1));
}

#[test]
fn resize_applies_at_its_byte_offset_and_bad_lines_are_counted() {
    let busy = paint(&fx("codex-tui-busy.txt"));
    let mut lines: Vec<String> = cast("codex", &[(&busy, Some("busy"))])
        .lines()
        .map(String::from)
        .collect();
    lines.insert(1, json!([0.0, "r", "100x30"]).to_string());
    lines.push("not json".into());
    let c = parse_cast(&lines.join("\n")).unwrap();
    assert_eq!(c.resizes, vec![(0, 100, 30)]);
    assert_eq!(c.bad_lines, 1);
    assert_eq!(compare(&c).samples, 1);
}

#[test]
fn not_a_v2_cast_is_refused() {
    assert!(parse_cast("{\"version\":1}").is_err());
    assert!(parse_cast("").is_err());
}
