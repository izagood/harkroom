//! 정본 `packages/agent/test/piHome.test.ts` 의 경우를 옮긴 것 + Rust 쪽에서 좁힌 자리.
use super::*;
use crate::adapter::{AgentHarness, adapter};

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn tmpdir() -> Tmp {
    static N: AtomicU64 = AtomicU64::new(0);
    let d = std::env::temp_dir().join(format!(
        "hk-pi-home-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    Tmp(fs::canonicalize(&d).unwrap())
}

fn pi_spec() -> ReadonlyTools {
    adapter(AgentHarness::Pi).unwrap().readonly_tools.unwrap()
}

fn bridge() -> Map<String, Value> {
    json!({"harkroom": {"type": "stdio", "command": "/opt/harkroom/harkroom-operator", "args": ["mcp-bridge"]}})
        .as_object()
        .unwrap()
        .clone()
}

fn disc(v: Value) -> BTreeMap<String, Vec<String>> {
    serde_json::from_value(v).unwrap()
}

#[test]
fn readonly_list_uses_exact_mcp_names_and_no_star() {
    let list = readonly_tool_list(
        &pi_spec(),
        Some(&disc(json!({"harkroom": ["message.post", "message.read"]}))),
    );
    assert_eq!(
        list.split(',').collect::<Vec<_>>(),
        [
            "read",
            "grep",
            "find",
            "ls",
            "mcp__harkroom__message_post",
            "mcp__harkroom__message_read"
        ]
    );
    assert!(!list.contains('*'));
}

#[test]
fn readonly_list_excludes_other_servers_and_write_builtins() {
    let list = readonly_tool_list(
        &pi_spec(),
        Some(&disc(
            json!({"harkroom": ["message.post"], "avcs": ["avcs_sync_push"], "gmail": ["send"]}),
        )),
    );
    let names: Vec<&str> = list.split(',').collect();
    for banned in ["bash", "edit", "write"] {
        assert!(!names.contains(&banned));
    }
    assert!(
        !names
            .iter()
            .any(|t| t.starts_with("mcp__avcs__") || t.starts_with("mcp__gmail__"))
    );
}

#[test]
fn readonly_list_without_discovery_is_builtins_only() {
    assert_eq!(readonly_tool_list(&pi_spec(), None), "read,grep,find,ls");
}

#[test]
fn tool_name_rule() {
    assert_eq!(
        pi_tool_name("harkroom", "message.post"),
        "mcp__harkroom__message_post"
    );
    assert_eq!(pi_tool_name("my-srv", "a.b-c"), "mcp__my_srv__a_b_c");
    // BMP 밖 글자는 정본 정규식처럼 UTF-16 단위 둘 → `__`.
    assert_eq!(pi_tool_name("s", "a😀"), "mcp__s__a__");
}

#[test]
fn parse_mcp_list() {
    let out =
        r#"{"servers":[{"name":"harkroom","tools":["message.post",3]},{"name":1,"tools":[]}]}"#;
    assert_eq!(
        parse_pi_mcp_list(out),
        Some(disc(json!({"harkroom": ["message.post"]})))
    );
    assert_eq!(parse_pi_mcp_list("not json"), None);
    assert_eq!(parse_pi_mcp_list(r#"{"servers":{}}"#), None);
}

#[test]
fn session_file_by_id() {
    let t = tmpdir();
    let home = t.0.join("pi");
    let dir = pi_sessions_dir(&home);
    fs::create_dir_all(&dir).unwrap();
    let id = "0199a0b1-aaaa";
    for n in [
        format!("2026-10-01T10-40-00-000Z_{id}.jsonl"),
        format!("2026-10-01T10-42-41-940Z_{id}.jsonl"),
        "2026-10-01T10-43-00-000Z_other.jsonl".to_string(),
    ] {
        fs::write(dir.join(n), "").unwrap();
    }
    assert_eq!(
        pi_session_file(&home, id),
        Some(dir.join(format!("2026-10-01T10-42-41-940Z_{id}.jsonl")))
    );
    assert_eq!(pi_session_file(&home, "missing"), None);
    assert_eq!(pi_session_file(&t.0.join("nope"), id), None);
}

fn fixture(t: &Tmp) -> (PathBuf, PathBuf) {
    let source = t.0.join("user-pi");
    fs::create_dir_all(&source).unwrap();
    fs::write(
        source.join("auth.json"),
        r#"{"x":{"type":"api_key","key":"k"}}"#,
    )
    .unwrap();
    fs::write(
        source.join("models.json"),
        r#"{"providers":{"gw":{"baseUrl":"https://gw.example/v1"}}}"#,
    )
    .unwrap();
    fs::write(
        source.join("settings.json"),
        json!({"defaultProvider":"gw","defaultModel":"m1","packages":["npm:some-extension"],"defaultTools":["+bash"]})
            .to_string(),
    )
    .unwrap();
    fs::write(
        source.join("mcp.json"),
        r#"{"mcpServers":{"gmail":{"command":"gmail-mcp"}}}"#,
    )
    .unwrap();
    (t.0.join("runner-pi"), source)
}

fn mode(p: &Path) -> u32 {
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}

#[test]
fn links_login_inherits_only_provider_model_and_writes_our_mcp() {
    let t = tmpdir();
    let (home, source) = fixture(&t);
    ensure_pi_home(&home, &bridge(), &source, false).unwrap();
    for f in LINKED_FILES {
        assert!(is_symlink(&home.join(f)));
        assert_eq!(fs::read_link(home.join(f)).unwrap(), source.join(f));
    }
    let settings: Value =
        serde_json::from_str(&fs::read_to_string(home.join("settings.json")).unwrap()).unwrap();
    assert_eq!(
        settings,
        json!({"defaultProvider":"gw","defaultModel":"m1"})
    );
    let mcp: Value =
        serde_json::from_str(&fs::read_to_string(home.join("mcp.json")).unwrap()).unwrap();
    assert_eq!(
        mcp,
        json!({"mcpServers":{"harkroom":{"command":"/opt/harkroom/harkroom-operator","args":["mcp-bridge"],"exposure":"direct"}}})
    );
    assert_eq!(mode(&home), 0o700);
    assert_eq!(mode(&pi_sessions_dir(&home)), 0o700);
    assert_eq!(mode(&home.join("settings.json")), 0o600);
    assert_eq!(mode(&home.join("mcp.json")), 0o600);
}

#[test]
fn idempotent() {
    let t = tmpdir();
    let (home, source) = fixture(&t);
    ensure_pi_home(&home, &bridge(), &source, false).unwrap();
    ensure_pi_home(&home, &bridge(), &source, false).unwrap();
    assert_eq!(
        fs::read_link(home.join("auth.json")).unwrap(),
        source.join("auth.json")
    );
}

#[test]
fn works_without_user_files() {
    let t = tmpdir();
    let home = t.0.join("r");
    ensure_pi_home(&home, &bridge(), &t.0.join("absent"), false).unwrap();
    assert!(fs::symlink_metadata(home.join("auth.json")).is_err());
    assert_eq!(
        fs::read_to_string(home.join("settings.json")).unwrap(),
        "{}\n"
    );
}

#[test]
fn remote_mcp_keeps_url_and_headers_and_drops_unknown() {
    let servers = json!({
        "s": {"type": "http", "url": "https://mcp.example/x", "headers": {"A": "b"}},
        "bad": {"type": "weird"}
    });
    assert_eq!(
        Value::Object(to_pi_mcp(servers.as_object().unwrap())),
        json!({"s": {"url": "https://mcp.example/x", "exposure": "direct", "headers": {"A": "b"}}})
    );
}

#[test]
fn existing_regular_file_is_kept_and_wrong_link_fails_without_path_in_display() {
    let t = tmpdir();
    let (home, source) = fixture(&t);
    fs::create_dir_all(&home).unwrap();
    // 러너 전용 auth.json(일반 파일)은 보존한다.
    fs::write(home.join("auth.json"), "mine").unwrap();
    // 엉뚱한 곳을 가리키는 models.json 링크는 실패.
    symlink(t.0.join("elsewhere.json"), home.join("models.json")).unwrap();
    let err = ensure_pi_home(&home, &bridge(), &source, false).unwrap_err();
    assert!(matches!(
        err,
        PiHomeError::UnexpectedLink {
            file: "models.json",
            ..
        }
    ));
    let shown = err.to_string();
    assert!(
        !shown.contains(&t.0.to_string_lossy().to_string()),
        "{shown}"
    );
    assert!(err.local_detail().contains("elsewhere.json"));
    assert_eq!(fs::read_to_string(home.join("auth.json")).unwrap(), "mine");
}

#[test]
fn lane_inherits_nothing_and_only_unlinks() {
    let t = tmpdir();
    let (home, source) = fixture(&t);
    ensure_pi_home(&home, &bridge(), &source, false).unwrap();
    ensure_pi_home(&home, &bridge(), &source, true).unwrap();
    for f in LINKED_FILES {
        assert!(fs::symlink_metadata(home.join(f)).is_err(), "{f}");
        // 사람 파일은 그대로.
        assert!(source.join(f).is_file());
    }
    assert_eq!(
        fs::read_to_string(home.join("settings.json")).unwrap(),
        "{}\n"
    );
}

#[test]
fn settings_slot_symlink_is_replaced_not_followed() {
    let t = tmpdir();
    let (home, source) = fixture(&t);
    fs::create_dir_all(&home).unwrap();
    let victim = t.0.join("victim.json");
    fs::write(&victim, "keep").unwrap();
    symlink(&victim, home.join("settings.json")).unwrap();
    ensure_pi_home(&home, &bridge(), &source, false).unwrap();
    assert_eq!(fs::read_to_string(&victim).unwrap(), "keep");
    assert!(!is_symlink(&home.join("settings.json")));
    assert_eq!(mode(&home.join("settings.json")), 0o600);
}

#[test]
fn lane_login_present_rules() {
    let t = tmpdir();
    let home = t.0.join("lane");
    fs::create_dir_all(&home).unwrap();
    assert!(!pi_lane_login_present(&home));
    fs::write(home.join("auth.json"), "{}").unwrap();
    assert!(!pi_lane_login_present(&home));
    fs::write(home.join("auth.json"), r#"{"x":{}}"#).unwrap();
    assert!(pi_lane_login_present(&home));
    fs::write(home.join("auth.json"), "not json").unwrap();
    assert!(pi_lane_login_present(&home));
    fs::remove_file(home.join("auth.json")).unwrap();
    symlink(t.0.join("nowhere"), home.join("auth.json")).unwrap();
    assert!(pi_lane_login_present(&home));
}

#[test]
fn list_tools_runs_with_given_env_only_and_parses() {
    let t = tmpdir();
    let script = t.0.join("fake-pi.sh");
    fs::write(
        &script,
        "#!/bin/sh\nif [ -n \"$LEAK\" ]; then exit 3; fi\necho '{\"servers\":[{\"name\":\"harkroom\",\"tools\":[\"message.post\"]}]}'\n",
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    let mut env = Env::new();
    env.insert("PATH".into(), "/usr/bin:/bin".into());
    let got = list_pi_mcp_tools(
        &script,
        &["mcp".into(), "list".into(), "--json".into()],
        &env,
        &t.0,
    );
    assert_eq!(got, Some(disc(json!({"harkroom": ["message.post"]}))));
    // 실패(종료 코드 ≠ 0)는 None.
    env.insert("LEAK".into(), "1".into());
    assert_eq!(list_pi_mcp_tools(&script, &[], &env, &t.0), None);
}
