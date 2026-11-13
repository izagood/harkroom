//! [`outcome_source`] 재료 — 종료 뒤 기록 API 오류를 그 시도의 계정 폴더·세션에서 읽는지.
use super::*;
use crate::mention_parts::LoopCtx;

fn cfg() -> OutcomeConfig {
    OutcomeConfig {
        harness: AgentHarness::ClaudeCode,
        home: None,
        turn_timeout_ms: 60_000,
        harness_stall_ms: 600_000,
        turn_model: None,
        stop_requested_at: None,
    }
}

fn transcript(dir: &std::path::Path, session: &str, api_error: Option<&str>) {
    transcript_at(dir, session, api_error, "2026-11-13T12:00:00.000Z");
}

fn transcript_at(dir: &std::path::Path, session: &str, api_error: Option<&str>, at: &str) {
    let p = dir.join("projects").join("p");
    std::fs::create_dir_all(&p).unwrap();
    let mut body = String::from("{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n");
    if let Some(t) = api_error {
        body.push_str(
            &serde_json::json!({"type":"assistant","isApiErrorMessage":true,"timestamp":at,
                "message":{"role":"assistant","content":t}})
            .to_string(),
        );
        body.push('\n');
    }
    std::fs::write(p.join(format!("{session}.jsonl")), body).unwrap();
}

fn octx(dir: &std::path::Path, session: &str) -> OutcomeCtx {
    OutcomeCtx {
        ctx: LoopCtx {
            session_id: Some(session.into()),
            claude_config_dir: Some(dir.to_path_buf()),
            ..LoopCtx::default()
        },
        ..OutcomeCtx::default()
    }
}

/// 같은 세션 id 여도 a2 의 판정 재료는 a2 계정 폴더의 기록에서 온다(a1 폴더의 한도 줄을 집지 않는다).
#[test]
fn recorded_api_error_is_read_from_this_attempts_account_folder() {
    let root = std::env::temp_dir().join(format!("hk-osrc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let (d1, d2) = (root.join("a1"), root.join("a2"));
    transcript(&d1, "sess", Some("API Error: usage limit"));
    transcript(&d2, "sess", None);
    let c = cfg();
    assert_eq!(
        recorded_after(&c, &octx(&d1, "sess")).as_deref(),
        Some("API Error: usage limit")
    );
    assert_eq!(
        recorded_after(&c, &octx(&d2, "sess")),
        None,
        "a2 는 a2 폴더만 본다"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn no_session_means_no_recorded_error() {
    let c = cfg();
    assert_eq!(recorded_after(&c, &OutcomeCtx::default()), None);
}

/// 세션을 이어 쓰는 기록에 **지난 턴**의 한도 줄이 남아 있어도 이번 시도 사실로 집지 않는다 — 시도 시작 뒤 줄만(node 와 같이).
#[test]
fn recorded_api_error_before_this_attempt_is_ignored() {
    let root = std::env::temp_dir().join(format!("hk-osrc-since-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let d = root.join("a");
    // 2026-11-13T12:00:00Z = 1794571200000 ms
    transcript_at(
        &d,
        "sess",
        Some("API Error: old limit"),
        "2026-11-13T12:00:00.000Z",
    );
    let c = cfg();
    let mut o = octx(&d, "sess");
    o.ctx.turn_started_at_ms = 1_794_571_200_000 + 60_000; // 이번 시도는 1분 뒤 시작
    assert_eq!(recorded_after(&c, &o), None, "지난 턴의 줄");
    o.ctx.turn_started_at_ms = 1_794_571_200_000 - 60_000; // 시도 시작 뒤 줄이면 읽는다
    assert_eq!(
        recorded_after(&c, &o).as_deref(),
        Some("API Error: old limit")
    );
    let _ = std::fs::remove_dir_all(&root);
}
