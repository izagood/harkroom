use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;

use super::*;

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "hrec-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        Self(fs::canonicalize(&p).unwrap())
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const ID: &str = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001";
const T0: i64 = 1_790_000_000_000; // 2026-09-21T…Z

fn iso(ms: i64) -> String {
    // 시험 시각은 T0 근처 초 단위만 쓴다.
    let secs = (ms - T0) / 1000;
    format!("2026-09-21T14:13:{:02}.000Z", 20 + secs)
}

fn jl(lines: &[serde_json::Value]) -> String {
    lines
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

fn assistant(at: i64, text: &str) -> serde_json::Value {
    json!({"type":"response_item","timestamp":iso(at),"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}})
}

#[test]
fn iso_helper_matches_t0() {
    assert_eq!(parse_iso_offset_ms(&iso(T0)), Some(T0));
}

#[test]
fn codex_last_said_reads_final_assistant_text() {
    let text = jl(&[
        json!({"type":"response_item","timestamp":iso(T0+1000),"payload":{"type":"message","role":"user","content":[]}}),
        assistant(T0 + 2000, "  끝말입니다  "),
        json!({"type":"event_msg","timestamp":iso(T0+3000),"payload":{"type":"task_complete"}}),
        json!("not an object line"),
    ]);
    assert_eq!(
        last_said_from_codex_rollout(&text, T0).as_deref(),
        Some("끝말입니다")
    );
}

#[test]
fn codex_last_said_none_after_tool_call_or_before_since() {
    let after_call = jl(&[
        assistant(T0 + 1000, "혼잣말"),
        json!({"type":"response_item","timestamp":iso(T0+2000),"payload":{"type":"function_call"}}),
    ]);
    assert_eq!(last_said_from_codex_rollout(&after_call, T0), None);
    let old = jl(&[assistant(T0 - 5000, "앞 턴")]);
    assert_eq!(last_said_from_codex_rollout(&old, T0), None);
    let empty = jl(&[assistant(T0 + 1000, "   ")]);
    assert_eq!(last_said_from_codex_rollout(&empty, T0), None);
}

#[test]
fn codex_turn_end_markers() {
    let ev =
        |at: i64, k: &str| json!({"type":"event_msg","timestamp":iso(at),"payload":{"type":k}});
    let working = jl(&[
        ev(T0 + 1000, "task_started"),
        ev(T0 + 2000, "agent_message"),
    ]);
    assert_eq!(
        turn_end_from_codex_rollout(&working, T0),
        Some(RecordedTurnEnd::Working)
    );
    let done = jl(&[
        ev(T0 + 1000, "task_started"),
        ev(T0 + 2000, "task_complete"),
    ]);
    assert_eq!(
        turn_end_from_codex_rollout(&done, T0),
        Some(RecordedTurnEnd::Ended)
    );
    let aborted = jl(&[ev(T0 + 2000, "turn_aborted")]);
    assert_eq!(
        turn_end_from_codex_rollout(&aborted, T0),
        Some(RecordedTurnEnd::Ended)
    );
    // 되살린 세션의 앞 턴 끝은 이 턴의 것이 아니다.
    let stale = jl(&[ev(T0 - 1000, "task_complete")]);
    assert_eq!(turn_end_from_codex_rollout(&stale, T0), None);
    // 잘린 첫 줄(반쪽 JSON)은 건너뛴다.
    let cut = format!(
        "{{\"type\":\"event_m\n{}",
        jl(&[ev(T0 + 1000, "task_complete")])
    );
    assert_eq!(
        turn_end_from_codex_rollout(&cut, T0),
        Some(RecordedTurnEnd::Ended)
    );
}

#[test]
fn omp_turn_end() {
    let m = |at: i64, msg: serde_json::Value| json!({"type":"message","timestamp":iso(at),"message":msg});
    let tool = jl(&[m(
        T0 + 1000,
        json!({"role":"assistant","stopReason":"toolUse"}),
    )]);
    assert_eq!(
        turn_end_from_omp_session(&tool, T0),
        Some(RecordedTurnEnd::Working)
    );
    let result = jl(&[m(T0 + 1000, json!({"role":"toolResult"}))]);
    assert_eq!(
        turn_end_from_omp_session(&result, T0),
        Some(RecordedTurnEnd::Working)
    );
    let stop = jl(&[m(
        T0 + 1000,
        json!({"role":"assistant","stopReason":"stop"}),
    )]);
    assert_eq!(
        turn_end_from_omp_session(&stop, T0),
        Some(RecordedTurnEnd::Ended)
    );
    let no_reason = jl(&[m(T0 + 1000, json!({"role":"assistant"}))]);
    assert_eq!(turn_end_from_omp_session(&no_reason, T0), None);
    let stale = jl(&[m(
        T0 - 1000,
        json!({"role":"assistant","stopReason":"stop"}),
    )]);
    assert_eq!(turn_end_from_omp_session(&stale, T0), None);
}

fn export(info: serde_json::Value, parts: serde_json::Value) -> String {
    json!({"info":{},"messages":[{"info":{"role":"user"}},{"info":info,"parts":parts}]}).to_string()
}

#[test]
fn opencode_export_state_and_last_said() {
    let t = T0 as f64;
    let done = export(
        json!({"role":"assistant","time":{"created":t+1.0,"completed":t+2.0},"finish":"stop"}),
        json!([{"type":"text","text":"답"},{"type":"reasoning","text":"속"},{"type":"text","text":"둘째"}]),
    );
    assert_eq!(
        opencode_turn_state_from_export(&done, T0),
        Some(RecordedTurnEnd::Ended)
    );
    assert_eq!(
        last_said_from_opencode_export(&done, T0).as_deref(),
        Some("답\n둘째")
    );

    let calls = export(
        json!({"role":"assistant","time":{"created":t+1.0,"completed":t+2.0},"finish":"tool-calls"}),
        json!([{"type":"text","text":"x"}]),
    );
    assert_eq!(
        opencode_turn_state_from_export(&calls, T0),
        Some(RecordedTurnEnd::Working)
    );
    assert_eq!(last_said_from_opencode_export(&calls, T0), None);

    let running = export(
        json!({"role":"assistant","time":{"created":t+1.0},"finish":"stop"}),
        json!([]),
    );
    assert_eq!(
        opencode_turn_state_from_export(&running, T0),
        Some(RecordedTurnEnd::Working)
    );

    let stale = export(
        json!({"role":"assistant","time":{"created":t-10.0,"completed":t-5.0},"finish":"stop"}),
        json!([{"type":"text","text":"앞 턴"}]),
    );
    assert_eq!(
        opencode_turn_state_from_export(&stale, T0),
        Some(RecordedTurnEnd::Working)
    );
    assert_eq!(last_said_from_opencode_export(&stale, T0), None);

    assert_eq!(
        opencode_turn_state_from_export("{\"messages\":[]}", T0),
        None
    );
    assert_eq!(opencode_turn_state_from_export("not json", T0), None);
    assert_eq!(
        opencode_turn_state_from_export("{\"messages\":[{}]}", T0),
        None
    );
}

fn write_rollout(
    dir: &Path,
    name: &str,
    first: serde_json::Value,
    rest: &[serde_json::Value],
) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    let p = dir.join(name);
    let mut all = vec![first];
    all.extend_from_slice(rest);
    fs::write(&p, jl(&all)).unwrap();
    p
}

#[test]
fn codex_session_find_by_cwd_and_file_lookup() {
    let tmp = TempDir::new();
    let sessions = tmp.0.join("sessions");
    let ws = tmp.0.join("ws");
    let other = tmp.0.join("other");
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(&other).unwrap();
    let day = sessions.join("2026").join("11").join("12");
    let other_id = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0002";
    write_rollout(
        &day,
        &format!("rollout-2026-11-12T10-00-00-{other_id}.jsonl"),
        json!({"type":"session_meta","payload":{"id":other_id,"cwd":other.to_string_lossy()}}),
        &[],
    );
    let mine = write_rollout(
        &day,
        &format!("rollout-2026-11-12T10-00-01-{ID}.jsonl"),
        // `/./` 가 섞여도 실경로로 맞춘다.
        json!({"type":"session_meta","payload":{"id":ID,"cwd":format!("{}/./ws", tmp.0.display())}}),
        &[json!({"type":"event_msg","timestamp":iso(T0+1000),"payload":{"type":"task_complete"}})],
    );
    // 이름이 맞지 않는 파일은 훑지 않는다.
    fs::write(day.join("notes.jsonl"), "x").unwrap();

    assert_eq!(
        find_codex_session_id(&sessions, &ws, 0).as_deref(),
        Some(ID)
    );
    assert_eq!(
        find_codex_session_id(&sessions, &tmp.0.join("nope"), 0),
        None
    );
    // since 가 파일 시각보다 한참 뒤면 찾지 않는다.
    assert_eq!(find_codex_session_id(&sessions, &ws, i64::MAX / 2), None);
    assert_eq!(codex_rollout_file_for(&sessions, ID), Some(mine.clone()));
    assert_eq!(codex_rollout_file_for(&sessions, "../x"), None);
    assert_eq!(find_codex_session_id(&tmp.0.join("missing"), &ws, 0), None);

    // 파일명이 payload.id 와 다르면 파일명을 믿는다.
    let alt = tmp.0.join("alt");
    let ws2 = tmp.0.join("ws2");
    fs::create_dir_all(&ws2).unwrap();
    write_rollout(
        &alt,
        &format!("rollout-x-{ID}.jsonl"),
        json!({"type":"session_meta","payload":{"id":"other","cwd":ws2.to_string_lossy()}}),
        &[],
    );
    assert_eq!(find_codex_session_id(&alt, &ws2, 0).as_deref(), Some(ID));

    // read_harness_turn_end: 세션 id 없이 cwd 로 찾아 꼬리를 읽는다.
    let opts = HarnessTurnEndOpts {
        session_id: None,
        cwd: &ws,
        since_ms: T0,
        codex_sessions_dir: &sessions,
        omp_home: None,
    };
    assert_eq!(
        read_harness_turn_end(AgentHarness::Codex, &opts),
        Some(RecordedTurnEnd::Ended)
    );
    // 기록을 안 쓰는 하네스는 묻지 않는다.
    assert_eq!(read_harness_turn_end(AgentHarness::ClaudeCode, &opts), None);
    let _ = mine;
}

#[test]
fn opencode_pick_session_by_directory_and_time() {
    let tmp = TempDir::new();
    let ws = tmp.0.join("ws");
    fs::create_dir_all(&ws).unwrap();
    let rows = json!([
        {"id":"ses_old","directory":ws.to_string_lossy(),"created":(T0-10_000) as f64},
        {"id":"ses_a","directory":ws.to_string_lossy(),"created":(T0+1000) as f64},
        {"id":"ses_b","directory":format!("{}/./ws", tmp.0.display()),"updated":(T0+2000) as f64},
        {"id":"ses_other","directory":tmp.0.to_string_lossy(),"created":(T0+9000) as f64},
        {"directory":ws.to_string_lossy()},
    ])
    .to_string();
    assert_eq!(
        pick_opencode_session(&rows, &ws, T0).as_deref(),
        Some("ses_b")
    );
    assert_eq!(pick_opencode_session("{}", &ws, T0), None);
    assert_eq!(pick_opencode_session("[]", &ws, T0), None);
}

#[test]
fn opencode_commands_run_in_workspace() {
    let tmp = TempDir::new();
    let ws = tmp.0.join("ws");
    fs::create_dir_all(&ws).unwrap();
    let t = T0 + 1000;
    let list = json!([{"id":"ses_1","directory":ws.to_string_lossy(),"created":t}]).to_string();
    let exp = export(
        json!({"role":"assistant","time":{"created":t,"completed":t+1},"finish":"stop"}),
        json!([{"type":"text","text":"끝"}]),
    );
    fs::write(tmp.0.join("list.json"), list).unwrap();
    fs::write(tmp.0.join("export.json"), exp).unwrap();
    // 목록은 cwd 가 워크스페이스일 때만 낸다(정본 머리말의 프로젝트 단위 목록).
    let script = tmp.0.join("opencode");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\n[ \"$(pwd -P)\" = \"{ws}\" ] || {{ echo '[]'; exit 0; }}\ncase \"$1\" in\n  session) cat \"{d}/list.json\";;\n  export) [ \"$2\" = ses_1 ] && cat \"{d}/export.json\";;\nesac\n",
            ws = ws.display(),
            d = tmp.0.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    let env: Env = [("PATH".to_string(), "/usr/bin:/bin".to_string())]
        .into_iter()
        .collect();
    let call = OpencodeCall {
        command: &script,
        env: &env,
        cwd: &ws,
    };

    assert_eq!(find_opencode_session_id(call, T0).as_deref(), Some("ses_1"));
    assert_eq!(
        read_opencode_turn_state(call, None, T0),
        Some(RecordedTurnEnd::Ended)
    );
    assert_eq!(read_opencode_turn_state(call, Some("ses_x"), T0), None);
    let opts = HarnessLastSaidOpts {
        session_id: None,
        since_ms: T0,
        codex_sessions_dir: &tmp.0,
        opencode: call,
    };
    assert_eq!(
        read_harness_last_said(AgentHarness::Opencode, &opts).as_deref(),
        Some("끝")
    );

    // 명령을 못 부르면 None(던지지 않는다).
    let missing = tmp.0.join("no-such-opencode");
    let bad = OpencodeCall {
        command: &missing,
        env: &env,
        cwd: &ws,
    };
    assert_eq!(find_opencode_session_id(bad, T0), None);
}

#[test]
fn codex_last_said_via_session_file() {
    let tmp = TempDir::new();
    let sessions = tmp.0.join("s");
    write_rollout(
        &sessions,
        &format!("rollout-x-{ID}.jsonl"),
        json!({"type":"session_meta","payload":{"id":ID,"cwd":"/x"}}),
        &[assistant(T0 + 1000, "원문 끝말")],
    );
    let env = Env::new();
    let call = OpencodeCall {
        command: Path::new("/nonexistent"),
        env: &env,
        cwd: &tmp.0,
    };
    let mut opts = HarnessLastSaidOpts {
        session_id: Some(ID),
        since_ms: T0,
        codex_sessions_dir: &sessions,
        opencode: call,
    };
    assert_eq!(
        read_harness_last_said(AgentHarness::Codex, &opts).as_deref(),
        Some("원문 끝말")
    );
    opts.session_id = None;
    assert_eq!(read_harness_last_said(AgentHarness::Codex, &opts), None);
}

#[test]
fn omp_turn_end_via_session_file() {
    let tmp = TempDir::new();
    let opts = HarnessTurnEndOpts {
        session_id: Some(ID),
        cwd: &tmp.0,
        since_ms: T0,
        codex_sessions_dir: &tmp.0,
        omp_home: None,
    };
    // omp 홈이 없으면 모른다.
    assert_eq!(read_harness_turn_end(AgentHarness::Omp, &opts), None);
}

/// security #1991 낮음: `export <id>` 에 들어갈 id 는 opencode 세션 꼴만 받는다(`-` 로 시작하는 값은 플래그로 읽힌다).
#[test]
fn opencode_session_id_shape_is_checked_before_argv() {
    for ok in ["ses_1", "ses_abc_DEF9", &format!("ses_{}", "a".repeat(124))] {
        assert!(is_opencode_session_id(ok), "{ok}");
    }
    for bad in [
        "",
        "ses_",
        "-h",
        "--help",
        "ses-1",
        "ses_a b",
        "ses_a/../b",
        "SES_1",
        &format!("ses_{}", "a".repeat(125)),
    ] {
        assert!(!is_opencode_session_id(bad), "{bad}");
    }
}
