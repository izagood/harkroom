use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;

use super::*;

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "herr-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_session(cfg: &Path, id: &str, lines: &[String]) {
    let dir = cfg.join("projects").join("-x-proj");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(format!("{id}.jsonl")), lines.join("\n")).unwrap();
}

fn dirs(cfg: &Path) -> TranscriptDirs<'_> {
    TranscriptDirs {
        config_dir: Some(cfg),
        home: None,
    }
}

fn api_err(ts: &str, text: &str) -> String {
    json!({"isApiErrorMessage": true, "timestamp": ts, "message": {"content": [{"type": "text", "text": text}]}})
        .to_string()
}

#[test]
fn text_of_string_array_and_empty() {
    assert_eq!(
        text_of(&json!({"message": {"content": "  hi "}})).as_deref(),
        Some("hi")
    );
    assert_eq!(
        text_of(&json!({"message": {"content": [{"text": "a"}, {"x": 1}, {"text": "b"}]}}))
            .as_deref(),
        Some("ab")
    );
    assert_eq!(text_of(&json!({"message": {"content": "   "}})), None);
    assert_eq!(text_of(&json!({"message": {"content": 3}})), None);
    assert_eq!(text_of(&json!({})), None);
}

#[test]
fn last_api_error_picks_last_and_skips_broken_lines() {
    let t = TempDir::new();
    write_session(
        &t.0,
        "s1",
        &[
            api_err("2026-09-09T10:00:00.000Z", "first"),
            "{broken isApiErrorMessage".into(),
            json!({"isApiErrorMessage": false, "message": {"content": "no"}}).to_string(),
            api_err("2026-09-09T10:05:00.000Z", "second"),
        ],
    );
    let got = read_last_api_error(AgentHarness::ClaudeCode, Some("s1"), dirs(&t.0), None);
    assert_eq!(
        got,
        Some(HarnessApiError {
            text: "second".into()
        })
    );
}

#[test]
fn last_api_error_since_skips_older_and_untimed() {
    let t = TempDir::new();
    write_session(
        &t.0,
        "s1",
        &[
            api_err("2026-09-09T10:00:00.000Z", "old"),
            json!({"isApiErrorMessage": true, "message": {"content": "untimed"}}).to_string(),
        ],
    );
    let since = parse_iso_offset_ms("2026-09-09T10:01:00.000Z");
    assert_eq!(
        read_last_api_error(AgentHarness::ClaudeCode, Some("s1"), dirs(&t.0), since),
        None
    );
    let since_old = parse_iso_offset_ms("2026-09-09T10:00:00.000Z");
    assert_eq!(
        read_last_api_error(AgentHarness::ClaudeCode, Some("s1"), dirs(&t.0), since_old)
            .map(|e| e.text),
        Some("old".into())
    );
}

#[test]
fn unreadable_cases_are_none() {
    let t = TempDir::new();
    write_session(&t.0, "s1", &[api_err("2026-09-09T10:00:00.000Z", "x")]);
    // 기록을 읽지 않는 하네스·세션 없음·파일 없음·경로 낱말
    assert_eq!(
        read_last_api_error(AgentHarness::Codex, Some("s1"), dirs(&t.0), None),
        None
    );
    assert_eq!(
        read_last_api_error(AgentHarness::ClaudeCode, None, dirs(&t.0), None),
        None
    );
    assert_eq!(
        read_last_api_error(AgentHarness::ClaudeCode, Some(""), dirs(&t.0), None),
        None
    );
    assert_eq!(
        read_last_api_error(AgentHarness::ClaudeCode, Some("nope"), dirs(&t.0), None),
        None
    );
    assert_eq!(
        read_last_api_error(AgentHarness::ClaudeCode, Some("../s1"), dirs(&t.0), None),
        None
    );
}

#[test]
fn mtime_present_and_absent() {
    let t = TempDir::new();
    write_session(&t.0, "s1", &["{}".into()]);
    let ms = session_transcript_mtime_ms(AgentHarness::ClaudeCode, Some("s1"), dirs(&t.0));
    assert!(ms.is_some_and(|v| v > 0));
    assert_eq!(
        session_transcript_mtime_ms(AgentHarness::ClaudeCode, Some("s2"), dirs(&t.0)),
        None
    );
    assert_eq!(
        session_transcript_mtime_ms(AgentHarness::Codex, Some("s1"), dirs(&t.0)),
        None
    );
}

const C: AgentHarness = AgentHarness::ClaudeCode;

fn ms(s: &str) -> Option<i64> {
    parse_iso_offset_ms(s)
}

fn asst(ts: &str, stop: &str, text: &str) -> String {
    json!({"type": "assistant", "timestamp": ts, "message": {"stop_reason": stop, "content": [{"type": "text", "text": text}]}})
        .to_string()
}

fn user(ts: &str) -> String {
    json!({"type": "user", "timestamp": ts, "message": {"content": "hi"}}).to_string()
}

fn tool_use(ts: &str, id: &str, name: &str, input: serde_json::Value) -> String {
    json!({"type": "assistant", "timestamp": ts, "message": {"stop_reason": "tool_use", "content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}})
        .to_string()
}

fn tool_result(ts: &str, id: &str, content: serde_json::Value) -> String {
    json!({"type": "user", "timestamp": ts, "message": {"content": [{"type": "tool_result", "tool_use_id": id, "content": content}]}})
        .to_string()
}

#[test]
fn turn_state_ended_working_and_unknown() {
    let t = TempDir::new();
    write_session(
        &t.0,
        "s1",
        &[
            user("2026-09-30T10:00:00Z"),
            asst("2026-09-30T10:00:05Z", "end_turn", "done"),
            json!({"type": "system", "subtype": "turn_duration", "timestamp": "2026-09-30T10:00:06Z"}).to_string(),
            json!({"type": "assistant", "isSidechain": true, "timestamp": "2026-09-30T10:00:07Z", "message": {"stop_reason": "tool_use"}}).to_string(),
        ],
    );
    let st = |since| read_transcript_turn_state(C, Some("s1"), dirs(&t.0), since);
    assert_eq!(st(None), Some(TranscriptTurnState::Ended));
    assert_eq!(
        st(ms("2026-09-30T10:00:00Z")),
        Some(TranscriptTurnState::Ended)
    );
    // 되살린 세션: 앞 턴의 end_turn 은 이 턴의 끝이 아니다
    assert_eq!(
        st(ms("2026-09-30T11:00:00Z")),
        Some(TranscriptTurnState::Working)
    );

    write_session(
        &t.0,
        "s2",
        &[
            user("2026-09-30T10:00:00Z"),
            tool_use(
                "2026-09-30T10:00:01Z",
                "t1",
                "Bash",
                json!({"command": "sleep 99"}),
            ),
        ],
    );
    assert_eq!(
        read_transcript_turn_state(C, Some("s2"), dirs(&t.0), None),
        Some(TranscriptTurnState::Working)
    );
    // API 에러 레코드는 끝이 아니다
    write_session(
        &t.0,
        "s3",
        &[json!({"type": "assistant", "isApiErrorMessage": true, "message": {"stop_reason": "end_turn"}}).to_string()],
    );
    assert_eq!(
        read_transcript_turn_state(C, Some("s3"), dirs(&t.0), None),
        Some(TranscriptTurnState::Working)
    );
    write_session(&t.0, "s4", &[json!({"type": "system"}).to_string()]);
    assert_eq!(
        read_transcript_turn_state(C, Some("s4"), dirs(&t.0), None),
        None
    );
    assert_eq!(
        read_transcript_turn_state(AgentHarness::Codex, Some("s1"), dirs(&t.0), None),
        None
    );
}

#[test]
fn pending_background_counts_and_unknown() {
    let t = TempDir::new();
    let dur = |ts: &str, a: serde_json::Value, w: serde_json::Value| {
        json!({"type": "system", "subtype": "turn_duration", "timestamp": ts, "pendingBackgroundAgentCount": a, "pendingWorkflowCount": w})
            .to_string()
    };
    write_session(
        &t.0,
        "s1",
        &[
            asst("2026-10-02T10:00:00Z", "end_turn", "x"),
            dur("2026-10-02T10:00:01Z", json!(2), json!(1)),
            json!({"type": "last-prompt"}).to_string(),
        ],
    );
    let pb = |id, since| read_transcript_pending_background(C, Some(id), dirs(&t.0), since);
    assert_eq!(pb("s1", None), Some(3.0));
    assert_eq!(pb("s1", ms("2026-10-02T11:00:00Z")), None);
    write_session(
        &t.0,
        "s2",
        &[dur("2026-10-02T10:00:01Z", json!(-1), json!("2"))],
    );
    assert_eq!(pb("s2", None), Some(0.0));
    // turn_duration 보다 대화가 뒤에 있다 — 아직 모른다
    write_session(
        &t.0,
        "s3",
        &[
            dur("2026-10-02T10:00:01Z", json!(1), json!(0)),
            user("2026-10-02T10:00:02Z"),
        ],
    );
    assert_eq!(pb("s3", None), None);
}

#[test]
fn tail_drops_cut_first_line() {
    let t = TempDir::new();
    let pad = "x".repeat(usize::try_from(TAIL_BYTES).unwrap());
    write_session(
        &t.0,
        "s1",
        &[
            format!("{{\"pad\":\"{pad}\"}}"),
            user("2026-09-30T10:00:00Z"),
        ],
    );
    let tail = read_transcript_tail("s1", dirs(&t.0)).unwrap();
    assert_eq!(tail, user("2026-09-30T10:00:00Z"));
    write_session(&t.0, "s2", &["a".into(), "b".into()]);
    assert_eq!(
        read_transcript_tail("s2", dirs(&t.0)).as_deref(),
        Some("a\nb")
    );
    assert_eq!(read_transcript_tail("s9", dirs(&t.0)), None);
}

#[test]
fn records_since_filters() {
    let text = [
        user("2026-09-30T10:00:00Z"),
        json!({"type": "user", "isSidechain": true, "timestamp": "2026-09-30T10:00:01Z"})
            .to_string(),
        json!({"type": "system", "timestamp": "2026-09-30T10:00:02Z"}).to_string(),
        "{bad".into(),
        asst("2026-09-30T10:00:03Z", "end_turn", "x"),
        json!({"type": "assistant"}).to_string(),
    ]
    .join("\n");
    assert_eq!(records_since(&text, None).len(), 3);
    assert_eq!(records_since(&text, ms("2026-09-30T10:00:01Z")).len(), 1);
}

#[test]
fn last_assistant_text_only_end_turn() {
    let t = TempDir::new();
    write_session(
        &t.0,
        "s1",
        &[
            asst("2026-09-30T10:00:00Z", "end_turn", "old reason"),
            asst(
                "2026-09-30T10:01:00Z",
                "end_turn",
                "  새 소식이 없어서 쓰지 않았어 ",
            ),
            asst("2026-09-30T10:01:01Z", "tool_use", "mumble"),
        ],
    );
    let said = |since| read_last_assistant_text(C, Some("s1"), dirs(&t.0), since);
    assert_eq!(said(None).as_deref(), Some("새 소식이 없어서 쓰지 않았어"));
    assert_eq!(said(ms("2026-09-30T10:02:00Z")), None);
}

#[test]
fn permission_denials_pair_and_reason() {
    let t = TempDir::new();
    let deny = |r: &str| format!("{DENIAL_HEAD} Reason: {r}. If you need this, ask.");
    write_session(
        &t.0,
        "s1",
        &[
            tool_use(
                "2026-09-30T09:00:00Z",
                "t1",
                "Bash",
                json!({"command": "gh pr merge 1"}),
            ),
            tool_result(
                "2026-09-30T10:00:00Z",
                "t1",
                json!(deny("[Merge Without Review]")),
            ),
            tool_use(
                "2026-09-30T10:00:01Z",
                "t2",
                "mcp__h__read",
                json!({"id": 1}),
            ),
            tool_result(
                "2026-09-30T10:00:02Z",
                "t2",
                json!([{"type": "text", "text": DENIAL_HEAD}]),
            ),
            tool_result("2026-09-30T10:00:03Z", "t9", json!(deny("multi\nline"))),
            tool_result("2026-09-30T10:00:04Z", "t1", json!("ok")),
            // 어시스턴트가 말 속에 인용한 것은 걸리지 않는다
            asst("2026-09-30T10:00:05Z", "end_turn", DENIAL_HEAD),
        ],
    );
    let got = read_permission_denials(C, Some("s1"), dirs(&t.0), None);
    assert_eq!(
        got,
        vec![
            PermissionDenial {
                tool_use_id: "t1".into(),
                tool: "Bash".into(),
                input: "gh pr merge 1".into(),
                reason: "[Merge Without Review]".into()
            },
            PermissionDenial {
                tool_use_id: "t2".into(),
                tool: "mcp__h__read".into(),
                input: "{\"id\":1}".into(),
                reason: "(이유 없음)".into()
            },
            PermissionDenial {
                tool_use_id: "t9".into(),
                tool: "?".into(),
                input: String::new(),
                reason: "multi\nline".into()
            },
        ]
    );
    // 짝은 since 앞이어도 모으고, 결과만 since 로 거른다
    let since = read_permission_denials(C, Some("s1"), dirs(&t.0), ms("2026-09-30T10:00:00Z"));
    assert_eq!(since.len(), 3);
    assert_eq!(since[0].tool, "Bash");
    assert_eq!(
        read_permission_denials(C, Some("s1"), dirs(&t.0), ms("2026-09-30T10:00:01Z")).len(),
        2
    );
    assert!(read_permission_denials(AgentHarness::Codex, Some("s1"), dirs(&t.0), None).is_empty());
}

#[test]
fn mac_permission_waits_states_and_order() {
    let t = TempDir::new();
    let osa = |app: &str| json!({"command": format!("osascript -e 'tell application \"{app}\" to activate'")});
    write_session(
        &t.0,
        "s1",
        &[
            tool_use("2026-10-15T10:00:00Z", "w1", "Bash", osa("Google Chrome")),
            tool_use("2026-10-15T10:00:01Z", "d1", "Bash", osa("Finder")),
            tool_result(
                "2026-10-15T10:00:02Z",
                "d1",
                json!("execution error: Not authorized to send Apple events to Finder. (-1743)"),
            ),
            tool_use(
                "2026-10-15T10:00:03Z",
                "x1",
                "Bash",
                json!({"command": "echo osascript"}),
            ),
            tool_use(
                "2026-10-15T10:00:04Z",
                "n1",
                "Bash",
                json!({"command": "ls"}),
            ),
            tool_use(
                "2026-10-15T10:00:05Z",
                "o1",
                "Bash",
                json!({"command": "foo;osascript -e 1"}),
            ),
            tool_result(
                "2026-10-15T10:00:06Z",
                "o1",
                json!([{"type": "text", "text": "Command did not complete within its 120s timeout and was moved to the background"}]),
            ),
            tool_use(
                "2026-10-15T10:00:07Z",
                "f1",
                "Bash",
                json!({"command": "osascript x"}),
            ),
            tool_result("2026-10-15T10:00:08Z", "f1", json!("fine")),
        ],
    );
    let now = ms("2026-10-15T10:00:20Z").unwrap();
    let got = read_mac_permission_waits(
        C,
        Some("s1"),
        dirs(&t.0),
        None,
        now,
        MAC_PERMISSION_PENDING_MS,
    );
    let brief: Vec<_> = got
        .iter()
        .map(|w| (w.tool_use_id.as_str(), w.state, w.target.as_deref()))
        .collect();
    assert_eq!(
        brief,
        vec![
            ("d1", MacPermissionState::Denied, Some("Finder")),
            ("o1", MacPermissionState::Timeout, None),
            ("w1", MacPermissionState::Waiting, Some("Google Chrome")),
            ("x1", MacPermissionState::Waiting, None),
        ]
    );
    // 15초가 안 지났으면 기다림이 아니다
    let early = ms("2026-10-15T10:00:10Z").unwrap();
    assert_eq!(
        read_mac_permission_waits(
            C,
            Some("s1"),
            dirs(&t.0),
            None,
            early,
            MAC_PERMISSION_PENDING_MS
        )
        .len(),
        2
    );
    // since 뒤의 것만
    let since = read_mac_permission_waits(
        C,
        Some("s1"),
        dirs(&t.0),
        ms("2026-10-15T10:00:03Z"),
        now,
        MAC_PERMISSION_PENDING_MS,
    );
    assert_eq!(
        since
            .iter()
            .map(|w| w.tool_use_id.as_str())
            .collect::<Vec<_>>(),
        vec!["o1", "x1"]
    );
}

#[test]
fn mcp_auth_rejections_by_error_code() {
    let t = TempDir::new();
    let att = |ts: &str, side: bool, failed: serde_json::Value| {
        json!({"type": "attachment", "isSidechain": side, "timestamp": ts, "attachment": {"failedMcpServers": failed}})
            .to_string()
    };
    write_session(
        &t.0,
        "s1",
        &[
            att("2026-10-01T03:00:00Z", false, json!([{"name": "slack", "errorCode": "AUTH_HEADER_REJECTED"}])),
            att("2026-10-01T03:00:01Z", false, json!([
                {"name": "linear", "errorCode": "CONNECTION_CLOSED", "error": "AUTH_HEADER_REJECTED"},
                {"name": "slack", "errorCode": "AUTH_HEADER_REJECTED"},
                {"name": "", "errorCode": "AUTH_HEADER_REJECTED"},
                {"name": "notion", "errorCode": "AUTH_HEADER_REJECTED"}
            ])),
            att("2026-10-01T03:00:02Z", true, json!([{"name": "side", "errorCode": "AUTH_HEADER_REJECTED"}])),
            json!({"type": "user", "timestamp": "2026-10-01T03:00:03Z", "message": {"content": "AUTH_HEADER_REJECTED"}}).to_string(),
        ],
    );
    assert_eq!(
        read_mcp_auth_rejections(C, Some("s1"), dirs(&t.0), None),
        vec!["slack".to_owned(), "notion".to_owned()]
    );
    assert_eq!(
        read_mcp_auth_rejections(C, Some("s1"), dirs(&t.0), ms("2026-10-01T03:00:01Z")),
        vec!["slack".to_owned(), "notion".to_owned()]
    );
    assert!(
        read_mcp_auth_rejections(C, Some("s1"), dirs(&t.0), ms("2026-10-01T04:00:00Z")).is_empty()
    );
}

#[test]
fn grew_since_needs_timed_user_line() {
    let t = TempDir::new();
    write_session(
        &t.0,
        "s1",
        &[
            user("2026-10-09T10:00:00Z"),
            json!({"type": "user", "isMeta": true, "timestamp": "2026-10-09T11:00:00Z"})
                .to_string(),
            json!({"type": "user", "isSidechain": true, "timestamp": "2026-10-09T11:00:00Z"})
                .to_string(),
            json!({"type": "user"}).to_string(),
            json!({"type": "ai-title", "timestamp": "2026-10-09T11:00:00Z"}).to_string(),
        ],
    );
    let since = ms("2026-10-09T10:30:00Z").unwrap();
    assert!(!session_transcript_grew_since(
        C,
        Some("s1"),
        since,
        dirs(&t.0)
    ));
    assert!(session_transcript_grew_since(
        C,
        Some("s1"),
        ms("2026-10-09T10:00:00Z").unwrap(),
        dirs(&t.0)
    ));
    // 판정 불가는 참, 파일 없음은 거짓
    assert!(session_transcript_grew_since(
        AgentHarness::Codex,
        Some("s1"),
        since,
        dirs(&t.0)
    ));
    assert!(session_transcript_grew_since(C, None, since, dirs(&t.0)));
    assert!(!session_transcript_grew_since(
        C,
        Some("s9"),
        since,
        dirs(&t.0)
    ));
}
