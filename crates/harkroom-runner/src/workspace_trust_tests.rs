use super::*;
use std::os::unix::fs::PermissionsExt;

fn tmp(name: &str) -> PathBuf {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let d = std::env::temp_dir().join(format!(
        "hk-trust-{name}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn claude_trust_written_once_and_keeps_other_state() {
    let d = tmp("claude");
    let p = d.join("cfg/.claude.json");
    trust_for_claude("/w/a", &p).unwrap();
    assert_eq!(
        json(&p)["projects"]["/w/a"]["hasTrustDialogAccepted"],
        Value::Bool(true)
    );
    assert_eq!(
        fs::metadata(&p).unwrap().permissions().mode() & 0o777,
        0o600
    );
    // 하네스가 담은 상태는 남고, 키 순서도 그대로
    fs::write(
        &p,
        r#"{"numStartups":3,"projects":{"/w/b":{"cost":1}},"theme":"dark"}"#,
    )
    .unwrap();
    trust_for_claude("/w/b", &p).unwrap();
    let text = fs::read_to_string(&p).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["numStartups"], 3);
    assert_eq!(v["projects"]["/w/b"]["cost"], 1);
    assert_eq!(v["projects"]["/w/b"]["hasTrustDialogAccepted"], true);
    assert!(text.find("numStartups").unwrap() < text.find("projects").unwrap());
    assert!(text.find("projects").unwrap() < text.find("theme").unwrap());
    // 이미 적혔으면 쓰지 않는다(파일을 바꿔 둔 글자가 그대로)
    let marker = r#"{"projects":{"/w/c":{"hasTrustDialogAccepted":true}},"x":   1}"#;
    fs::write(&p, marker).unwrap();
    trust_for_claude("/w/c", &p).unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), marker);
    // 깨진 파일은 최소 문서로 시작
    fs::write(&p, "{").unwrap();
    trust_for_claude("/w/d", &p).unwrap();
    assert_eq!(json(&p)["projects"]["/w/d"]["hasTrustDialogAccepted"], true);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn codex_trust_appends_once() {
    let d = tmp("codex");
    let p = d.join("home/config.toml");
    trust_for_codex("/w/a", &p).unwrap();
    assert_eq!(
        fs::read_to_string(&p).unwrap(),
        "\n[projects.\"/w/a\"]\ntrust_level = \"trusted\"\n"
    );
    trust_for_codex("/w/a", &p).unwrap();
    fs::write(&p, "model = \"x\"").unwrap();
    trust_for_codex("/w/b", &p).unwrap();
    assert_eq!(
        fs::read_to_string(&p).unwrap(),
        "model = \"x\"\n\n[projects.\"/w/b\"]\ntrust_level = \"trusted\"\n"
    );
    assert_eq!(
        fs::metadata(&p).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn codex_config_edits_are_serialized() {
    let d = tmp("race");
    let p = d.join("config.toml");
    let handles: Vec<_> = (0..16)
        .map(|i| {
            let p = p.clone();
            std::thread::spawn(move || trust_for_codex(&format!("/w/{i}"), &p).unwrap())
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    let text = fs::read_to_string(&p).unwrap();
    for i in 0..16 {
        assert!(
            text.contains(&format!("[projects.\"/w/{i}\"]")),
            "{i} 가 사라졌다"
        );
    }
    // 임시 파일이 남지 않는다
    assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
    // 같은 글이면 쓰지 않는다
    edit_codex_config(&p, |t| Some(t.to_string())).unwrap();
    edit_codex_config(&p, |_| None).unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), text);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn dangerous_mode_written_once() {
    let d = tmp("danger");
    accept_dangerous_mode_for_claude(&d).unwrap();
    assert_eq!(
        json(&d.join("settings.json"))["skipDangerousModePermissionPrompt"],
        true
    );
    let marker = r#"{"skipDangerousModePermissionPrompt":true,"theme":  "x"}"#;
    fs::write(d.join("settings.json"), marker).unwrap();
    accept_dangerous_mode_for_claude(&d).unwrap();
    assert_eq!(fs::read_to_string(d.join("settings.json")).unwrap(), marker);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn scrub_keeps_only_allowlist() {
    let d = tmp("scrub");
    fs::write(
        d.join("settings.json"),
        r#"{"theme":"dark","hooks":{"x":1},"statusLine":{"command":"sh"},"env":{"NODE_OPTIONS":"-r x"},"enabledPlugins":{}}"#,
    )
    .unwrap();
    fs::write(
        d.join("settings.local.json"),
        r#"{"permissions":{"allow":["Bash(*)"]}}"#,
    )
    .unwrap();
    let mut removed = scrub_account_permission_settings(&d).unwrap();
    removed.sort();
    assert_eq!(removed.len(), 4, "{removed:?}");
    assert!(removed.iter().all(|r| r.contains("settings")));
    let v = json(&d.join("settings.json"));
    assert_eq!(
        v.as_object().unwrap().keys().cloned().collect::<Vec<_>>(),
        vec!["theme", "enabledPlugins"]
    );
    assert_eq!(json(&d.join("settings.local.json")), serde_json::json!({}));
    // 다시 걸으면 할 일 없음
    assert!(scrub_account_permission_settings(&d).unwrap().is_empty());
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn scrub_does_not_follow_links_or_fix_broken() {
    let d = tmp("scrublink");
    let human = d.join("human-settings.json");
    let original = r#"{"hooks":{"keep":"me"}}"#;
    fs::write(&human, original).unwrap();
    let pool = d.join("pool");
    fs::create_dir_all(&pool).unwrap();
    std::os::unix::fs::symlink(&human, pool.join("settings.json")).unwrap();
    fs::write(pool.join("settings.local.json"), "{broken").unwrap();
    assert!(scrub_account_permission_settings(&pool).unwrap().is_empty());
    assert_eq!(fs::read_to_string(&human).unwrap(), original);
    assert_eq!(
        fs::read_to_string(pool.join("settings.local.json")).unwrap(),
        "{broken"
    );
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn ensure_dangerous_mode_scrubs_pool_only() {
    let d = tmp("ensure");
    let home = d.join("home");
    fs::create_dir_all(home.join(".claude")).unwrap();
    fs::write(home.join(".claude/settings.json"), r#"{"hooks":{"x":1}}"#).unwrap();
    // 시스템 기본: bypass 만 적고 사람 설정의 hooks 는 남긴다
    ensure_dangerous_mode_accepted("claude-code", None, &home);
    let v = json(&home.join(".claude/settings.json"));
    assert_eq!(v["skipDangerousModePermissionPrompt"], true);
    assert_eq!(v["hooks"]["x"], 1);
    // 풀 계정: 걷는다
    let pool = d.join("pool");
    fs::create_dir_all(&pool).unwrap();
    fs::write(pool.join("settings.json"), r#"{"hooks":{"x":1}}"#).unwrap();
    ensure_dangerous_mode_accepted("claude-code", Some(&pool), &home);
    assert_eq!(
        json(&pool.join("settings.json")),
        serde_json::json!({"skipDangerousModePermissionPrompt": true})
    );
    // codex 는 아무것도 안 한다
    let other = d.join("other");
    ensure_dangerous_mode_accepted("codex", Some(&other), &home);
    assert!(!other.exists());
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn ensure_workspace_trusted_dispatches_and_swallows() {
    let d = tmp("dispatch");
    ensure_workspace_trusted("/w", None);
    ensure_workspace_trusted("/w", Some(&TrustTarget::ClaudeJson(d.join(".claude.json"))));
    ensure_workspace_trusted("/w", Some(&TrustTarget::CodexToml(d.join("config.toml"))));
    assert_eq!(
        json(&d.join(".claude.json"))["projects"]["/w"]["hasTrustDialogAccepted"],
        true
    );
    assert!(
        fs::read_to_string(d.join("config.toml"))
            .unwrap()
            .contains("[projects.\"/w\"]")
    );
    // 쓸 수 없는 자리(부모가 파일) — 던지지 않는다
    fs::write(d.join("file"), "x").unwrap();
    ensure_workspace_trusted(
        "/w",
        Some(&TrustTarget::CodexToml(d.join("file/config.toml"))),
    );
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn codex_trust_refuses_toml_breaking_paths() {
    let d = std::env::temp_dir().join(format!("hr-trust-toml-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    let p = d.join("config.toml");
    for bad in ["/w/a\"]\n[x]", "/w/a\\b", "/w/a\nb", "/w/a\rb", "/w/\u{0}"] {
        let e = trust_for_codex(bad, &p).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::InvalidInput);
        assert!(!e.to_string().contains("/w/"));
    }
    assert!(!p.exists());
    trust_for_codex("/w/한글 폴더", &p).unwrap();
    assert!(
        fs::read_to_string(&p)
            .unwrap()
            .contains("[projects.\"/w/한글 폴더\"]")
    );
}
