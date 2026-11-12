use super::*;
use serde_json::json;

fn tmp_dir() -> PathBuf {
    let d = std::env::temp_dir().join(format!("sessions-{}", random_uuid()));
    fs::create_dir_all(&d).unwrap();
    d
}

fn rec() -> SessionRecord {
    SessionRecord {
        workspace_dir: "/w".into(),
        session_id: Some("s1".into()),
        harness: AgentHarness::ClaudeCode,
        last_fed_seq: 7,
        turns_run: 2,
        claude_account: Some("a".into()),
        claude_pool: Some(None),
        unseen_own_after_seq: None,
        canceled_by: None,
    }
}

#[test]
fn reads_ts_written_file_including_old_records() {
    let d = tmp_dir();
    let f = d.join("sessions.json");
    fs::write(
        &f,
        json!({
            "c/t1": { "workspaceDir": "/w1", "sessionId": null, "harness": "codex", "lastFedSeq": 3, "turnsRun": 0 },
            "c/t2": { "workspaceDir": "/w2", "sessionId": "x", "harness": "claude-code", "lastFedSeq": 9, "turnsRun": 1,
                      "claudeAccount": null, "claudePool": null, "unseenOwnAfterSeq": 5, "canceledBy": "jb" },
            "c/bad": { "workspaceDir": "/w3", "sessionId": "x", "harness": "nope", "lastFedSeq": 1, "turnsRun": 1 },
            "c/bad2": { "workspaceDir": "/w3", "sessionId": "x", "harness": "codex", "lastFedSeq": 1, "turnsRun": 1, "claudePool": 3 }
        })
        .to_string(),
    )
    .unwrap();
    let s = SessionStore::new(&f);
    s.load();
    let t1 = s.get("c/t1").unwrap();
    assert_eq!(t1.harness, AgentHarness::Codex);
    assert_eq!(t1.session_id, None);
    assert_eq!(t1.claude_pool, None, "옛 레코드는 풀 칸이 없다");
    let t2 = s.get("c/t2").unwrap();
    assert_eq!(t2.claude_pool, Some(None), "null 은 풀 없음");
    assert_eq!(t2.unseen_own_after_seq, Some(5));
    assert_eq!(t2.canceled_by.as_deref(), Some("jb"));
    assert!(s.get("c/bad").is_none());
    assert!(s.get("c/bad2").is_none());
    assert_eq!(s.entries().len(), 2);
}

#[test]
fn missing_file_is_empty_and_put_writes_private_file() {
    use std::os::unix::fs::PermissionsExt;
    let d = tmp_dir();
    let f = d.join("sub/sessions.json");
    let s = SessionStore::new(&f);
    s.load();
    assert!(s.entries().is_empty());
    s.put("c/t", rec()).unwrap();
    let mode = fs::metadata(&f).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let back: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
    assert_eq!(back["c/t"]["harness"], "claude-code");
    assert_eq!(back["c/t"]["claudePool"], Value::Null);
    assert!(back["c/t"].get("unseenOwnAfterSeq").is_none());
    let again = SessionStore::new(&f);
    again.load();
    assert_eq!(again.get("c/t"), Some(rec()));
    // tmp 파일이 남지 않는다.
    let leftovers = fs::read_dir(f.parent().unwrap()).unwrap().count();
    assert_eq!(leftovers, 1);
}

#[test]
fn old_record_without_pool_stays_without_pool_on_write() {
    let d = tmp_dir();
    let f = d.join("sessions.json");
    let s = SessionStore::new(&f);
    s.put(
        "k",
        SessionRecord {
            claude_pool: None,
            ..rec()
        },
    )
    .unwrap();
    let back: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
    assert!(back["k"].get("claudePool").is_none());
}

#[test]
fn corrupt_or_non_map_file_is_quarantined() {
    for body in ["{not json", "[1,2]"] {
        let d = tmp_dir();
        let f = d.join("sessions.json");
        fs::write(&f, body).unwrap();
        let s = SessionStore::new(&f);
        s.load();
        assert!(s.entries().is_empty());
        assert!(!f.exists());
        let broken = fs::read_dir(&d).unwrap().filter_map(Result::ok).any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("sessions.json.broken-")
        });
        assert!(broken, "{body}: 원본을 보존한다");
    }
}

#[test]
fn delete_removes_and_ignores_unknown() {
    let d = tmp_dir();
    let f = d.join("sessions.json");
    let s = SessionStore::new(&f);
    s.delete("none").unwrap();
    assert!(!f.exists(), "없던 키는 쓰지 않는다");
    s.put("a", rec()).unwrap();
    s.put("b", rec()).unwrap();
    s.delete("a").unwrap();
    let again = SessionStore::new(&f);
    again.load();
    assert!(again.get("a").is_none());
    assert!(again.get("b").is_some());
}
