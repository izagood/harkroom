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

/// 정본 `trustViaAdapter`(security 낮음 5): 장부 자리·형식은 어댑터 표가 정한다 — 하네스 이름으로 갈리지 않는다.
#[test]
fn trust_target_comes_from_adapter_table() {
    use crate::adapter::AgentHarness as H;
    let home = Path::new("/h");
    let codex = Path::new("/c");
    let cfg = Path::new("/acct");
    assert_eq!(
        trust_target(H::ClaudeCode, Some(cfg), codex, home).unwrap(),
        Some(TrustTarget::ClaudeJson(PathBuf::from("/acct/.claude.json")))
    );
    // 계정 설정 폴더가 없으면(기본 로그인) claude 가 실제로 읽는 사람의 `<home>/.claude.json`(T2).
    assert_eq!(
        trust_target(H::ClaudeCode, None, codex, home).unwrap(),
        Some(TrustTarget::PersonClaudeJson(PathBuf::from(
            "/h/.claude.json"
        )))
    );
    assert_eq!(
        trust_target(H::Codex, Some(cfg), codex, home).unwrap(),
        Some(TrustTarget::CodexToml(PathBuf::from("/c/config.toml")))
    );
    // 신뢰 관문이 없는 하네스는 아무것도 쓰지 않는다.
    for h in [H::Opencode, H::Kilo, H::Pi, H::Omp] {
        assert_eq!(
            trust_target(h, Some(cfg), codex, home).unwrap(),
            None,
            "{h:?}"
        );
    }
    // 어댑터가 없는 하네스는 거절(정본 `adapterFor` throw).
    assert!(trust_target(H::Gemini, Some(cfg), codex, home).is_err());
}

/// 어댑터 경로로 실제 장부에 적힌다 — claude 는 계정 설정 폴더의 `.claude.json`, codex 는 홈의 `config.toml`.
#[test]
fn ensure_via_adapter_writes_the_selected_ledger() {
    use crate::adapter::AgentHarness as H;
    let d = tmp("via-adapter");
    let cfg = d.join("acct");
    let codex = d.join("codex");
    fs::create_dir_all(&cfg).unwrap();
    fs::create_dir_all(&codex).unwrap();
    ensure_workspace_trusted_via_adapter(H::ClaudeCode, "/w/x", Some(&cfg), &codex, &d);
    let doc: Value =
        serde_json::from_str(&fs::read_to_string(cfg.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(
        doc["projects"]["/w/x"]["hasTrustDialogAccepted"],
        Value::Bool(true)
    );
    ensure_workspace_trusted_via_adapter(H::Codex, "/w/x", Some(&cfg), &codex, &d);
    assert!(
        fs::read_to_string(codex.join("config.toml"))
            .unwrap()
            .contains("[projects.\"/w/x\"]")
    );
    // 관문 없는 하네스·어댑터 없는 하네스는 아무 파일도 만들지 않는다(어댑터 없음은 로그만).
    let empty = d.join("empty");
    fs::create_dir_all(&empty).unwrap();
    ensure_workspace_trusted_via_adapter(H::Opencode, "/w/x", Some(&empty), &empty, &empty);
    ensure_workspace_trusted_via_adapter(H::Gemini, "/w/x", Some(&empty), &empty, &empty);
    assert_eq!(fs::read_dir(&empty).unwrap().count(), 0);
    let _ = fs::remove_dir_all(&d);
}

// ── T2: 기본 로그인 = 사람의 실제 파일 ──────────────────────────────────────────

const PERSON_DOC: &str = r#"{
  "numStartups": 7,
  "zKey": {"b": 1, "a": 2},
  "mcpServers": {"m": {"command": "x"}},
  "projects": {"/old": {"allowedTools": ["Bash"], "hasTrustDialogAccepted": true}},
  "aKey": "last"
}"#;

/// 기본 로그인: 어댑터 길이 `<home>/.claude.json` 에 그 폴더 한 칸만 더한다. 그 칸을 빼면 나머지는 키 순서까지 같다.
/// `<home>/.claude/.claude.json` 은 만들지 않는다.
#[test]
fn person_trust_adds_only_this_workspace() {
    use crate::adapter::AgentHarness as H;
    let d = tmp("person");
    let file = d.join(".claude.json");
    fs::write(&file, PERSON_DOC).unwrap();
    ensure_workspace_trusted_via_adapter(H::ClaudeCode, "/w/new", None, &d.join("codex"), &d);
    let after = json(&file);
    assert_eq!(
        after["projects"]["/w/new"],
        serde_json::json!({"hasTrustDialogAccepted": true})
    );
    let mut stripped = after.clone();
    stripped["projects"]
        .as_object_mut()
        .unwrap()
        .remove("/w/new");
    let before: Value = serde_json::from_str(PERSON_DOC).unwrap();
    assert_eq!(
        serde_json::to_string(&stripped).unwrap(),
        serde_json::to_string(&before).unwrap(),
        "다른 키·값·순서는 그대로"
    );
    assert!(!d.join(".claude").join(".claude.json").exists());
    // 이미 있으면 다시 쓰지 않는다
    let m1 = fs::metadata(&file).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    ensure_workspace_trusted_via_adapter(H::ClaudeCode, "/w/new", None, &d.join("codex"), &d);
    assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), m1);
    // 임시 파일이 남지 않는다
    assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
    let _ = fs::remove_dir_all(&d);
}

/// 깨진 파일·객체 아닌 문서는 바이트 그대로 남는다(빈 문서 위에 쓰지 않는다).
#[test]
fn person_trust_leaves_broken_file() {
    let d = tmp("person-broken");
    let file = d.join(".claude.json");
    for body in [r#"{"numStartups": 7, "projects": {"#, "[1,2]", ""] {
        fs::write(&file, body).unwrap();
        assert!(trust_for_claude_person("/w/new", &file).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), body);
    }
    let _ = fs::remove_dir_all(&d);
}

/// 링크면 쓰지 않는다 — 링크는 링크로, 너머의 파일은 그대로.
#[test]
fn person_trust_skips_symlink() {
    let d = tmp("person-link");
    let real = d.join("real.json");
    fs::write(&real, PERSON_DOC).unwrap();
    let file = d.join(".claude.json");
    std::os::unix::fs::symlink(&real, &file).unwrap();
    assert!(trust_for_claude_person("/w/new", &file).is_err());
    assert!(
        fs::symlink_metadata(&file)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read_to_string(&real).unwrap(), PERSON_DOC);
    let _ = fs::remove_dir_all(&d);
}

/// 읽은 뒤 하네스가 고치면(크기·mtime 바뀜) 다시 읽고 그 위에 고친다 — 하네스의 쓰기를 잃지 않는다.
/// 매번 고치면 쓰지 않고 그만둔다.
#[test]
fn person_edit_rereads_when_harness_writes_meanwhile() {
    let d = tmp("person-race");
    let file = d.join(".claude.json");
    fs::write(&file, r#"{"a": 1}"#).unwrap();
    let mut first = true;
    let r = edit_person_json(&file, |doc| {
        if first {
            first = false;
            fs::write(&file, r#"{"a": 1, "harness": "wrote"}"#).unwrap();
        }
        doc.insert("mine".into(), Value::Bool(true));
        true
    })
    .unwrap();
    assert_eq!(r, PersonEdit::Written);
    let v = json(&file);
    assert_eq!(v["harness"], "wrote", "하네스의 쓰기가 남는다");
    assert_eq!(v["mine"], true);

    let mut n = 0;
    let r = edit_person_json(&file, |doc| {
        n += 1;
        fs::write(&file, format!(r#"{{"a": 1, "n": "{}"}}"#, "x".repeat(n))).unwrap();
        doc.insert("mine2".into(), Value::Bool(true));
        true
    })
    .unwrap();
    assert!(matches!(r, PersonEdit::Skipped(_)));
    assert!(json(&file).get("mine2").is_none());
    assert_eq!(
        fs::read_dir(&d).unwrap().count(),
        1,
        "임시 파일이 남지 않는다"
    );
    let _ = fs::remove_dir_all(&d);
}

/// 기본 로그인 bypass: 사람의 `settings.json` 이 링크·깨짐이면 쓰지 않는다. 풀 계정 길은 그대로.
#[test]
fn person_bypass_is_strict() {
    let d = tmp("person-bypass");
    let home = d.join("home");
    fs::create_dir_all(home.join(".claude")).unwrap();
    let settings = home.join(".claude").join("settings.json");
    fs::write(&settings, r#"{"theme": "dark", "#).unwrap();
    ensure_dangerous_mode_accepted("claude-code", None, &home);
    assert_eq!(
        fs::read_to_string(&settings).unwrap(),
        r#"{"theme": "dark", "#
    );
    fs::remove_file(&settings).unwrap();
    let real = d.join("real-settings.json");
    fs::write(&real, r#"{"theme": "dark"}"#).unwrap();
    std::os::unix::fs::symlink(&real, &settings).unwrap();
    ensure_dangerous_mode_accepted("claude-code", None, &home);
    assert_eq!(fs::read_to_string(&real).unwrap(), r#"{"theme": "dark"}"#);
    assert!(
        fs::symlink_metadata(&settings)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    let _ = fs::remove_dir_all(&d);
}
