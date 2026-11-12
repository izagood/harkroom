use super::*;
use std::os::unix::fs::PermissionsExt as _;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("hr-turn-files-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn http(headers: &[(&str, &str)]) -> McpServerEntry {
    McpServerEntry::Http {
        sse: false,
        url: "https://mcp.example.com/mcp".into(),
        headers: headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    }
}

#[test]
fn extra_skips_harkroom_avcs_and_keeps_order() {
    let d = tmp("extra");
    let p = d.join("m.json");
    fs::write(
        &p,
        r#"{"mcpServers":{"harkroom":{"type":"stdio","command":"/op","args":["mcp-bridge"]},"zeta":{"command":"z"},"avcs":{"command":"avcs","args":["mcp"]},"github":{"type":"stdio","command":"gh-mcp","args":["serve"],"env":{"GH_TOKEN":"x"}}}}"#,
    )
    .unwrap();
    let got = read_extra_mcp_servers(&p).unwrap();
    let names: Vec<&str> = got.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, ["zeta", "github"]);
    assert_eq!(
        got[1].1,
        McpServerEntry::Stdio {
            command: "gh-mcp".into(),
            args: vec!["serve".into()],
            env: Some(vec![("GH_TOKEN".into(), "x".into())]),
        }
    );
    assert_eq!(read_mcp_servers(&p).unwrap().len(), 4);
}

#[test]
fn missing_or_broken_file_is_refused_without_path_in_display() {
    let d = tmp("bad");
    let none = d.join("none.json");
    let e = read_extra_mcp_servers(&none).unwrap_err();
    assert!(e.to_string().contains("HARKROOM_MCP_CONFIG"));
    assert!(!e.to_string().contains("none.json"));
    assert!(e.local_detail().contains("none.json"));
    fs::write(d.join("bad.json"), "{").unwrap();
    assert!(read_extra_mcp_servers(&d.join("bad.json")).is_err());
    // 문자열이 아닌 command 는 argv 에 넣기 전에 거절 — 이름만 싣는다.
    fs::write(d.join("odd.json"), r#"{"mcpServers":{"x":{"command":7}}}"#).unwrap();
    let e = read_extra_mcp_servers(&d.join("odd.json")).unwrap_err();
    assert!(matches!(e, TurnFileError::McpEntryInvalid { ref name } if name == "x"));
    // mcpServers 없음은 빈 표(정본 `?? {}`).
    fs::write(d.join("empty.json"), "{}").unwrap();
    assert!(
        read_extra_mcp_servers(&d.join("empty.json"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn stdio_flags_use_toml_inline_table() {
    let e = McpServerEntry::Stdio {
        command: "gh-mcp".into(),
        args: vec!["serve".into()],
        env: Some(vec![("GH_TOKEN".into(), "x".into())]),
    };
    assert_eq!(
        codex_mcp_flags("github", &e),
        [
            "-c",
            "mcp_servers.github.transport=\"stdio\"",
            "-c",
            "mcp_servers.github.command=\"gh-mcp\"",
            "-c",
            "mcp_servers.github.args=[\"serve\"]",
            "-c",
            "mcp_servers.github.env={ \"GH_TOKEN\" = \"x\" }",
        ]
    );
    let no_env = McpServerEntry::Stdio {
        command: "c".into(),
        args: vec![],
        env: None,
    };
    assert_eq!(codex_mcp_flags("n", &no_env)[5], "mcp_servers.n.args=[]");
    assert_eq!(codex_mcp_flags("n", &no_env).len(), 6);
}

#[test]
fn bearer_goes_to_env_not_argv() {
    let e = http(&[("Authorization", "Bearer SECRET-1"), ("X-Team", "t")]);
    let flags = codex_mcp_flags("slack-work", &e);
    assert!(!flags.join(" ").contains("SECRET-1"));
    assert!(flags.contains(&"mcp_servers.slack-work.transport=\"streamable_http\"".to_string()));
    assert!(
        flags.contains(
            &"mcp_servers.slack-work.bearer_token_env_var=\"HARKROOM_MCP_BEARER_SLACK_WORK\""
                .to_string()
        )
    );
    assert!(
        flags.contains(&"mcp_servers.slack-work.http_headers={ \"X-Team\" = \"t\" }".to_string())
    );
    let servers = vec![("slack-work".to_string(), e)];
    assert_eq!(
        codex_bearer_env(&servers),
        [(
            "HARKROOM_MCP_BEARER_SLACK_WORK".to_string(),
            "SECRET-1".to_string()
        )]
    );
}

#[test]
fn bearer_match_follows_js_regex() {
    assert_eq!(bearer_of("bearer  tok"), Some("tok"));
    assert_eq!(bearer_of("BEARER\ttok en"), Some("tok en"));
    assert_eq!(bearer_of("Bearer\ntok"), Some("tok"));
    assert_eq!(bearer_of("Bearer   "), Some(" "));
    assert_eq!(bearer_of("Bearer tok\nx"), None);
    assert_eq!(bearer_of("Bearertok"), None);
    assert_eq!(bearer_of("Basic abc"), None);
    assert_eq!(bearer_of("Bearer"), None);
    // 맞지 않는 Authorization 은 http_headers 로 남는다(정본).
    let (b, rest) = split_bearer(&[("authorization".into(), "Basic abc".into())]);
    assert_eq!(b, None);
    assert_eq!(rest.len(), 1);
    // sse 는 transport sse.
    let e = McpServerEntry::Http {
        sse: true,
        url: "u".into(),
        headers: vec![],
    };
    assert_eq!(
        codex_mcp_flags("s", &e),
        [
            "-c",
            "mcp_servers.s.transport=\"sse\"",
            "-c",
            "mcp_servers.s.url=\"u\""
        ]
    );
}

#[test]
fn lane_args_match_canon() {
    let a = codex_lane_args("http://127.0.0.1:9");
    let flags: Vec<&str> = a.iter().skip(1).step_by(2).map(String::as_str).collect();
    assert!(a.iter().step_by(2).all(|x| x == "-c"));
    assert_eq!(flags[0], "model_provider=\"harkroom-lane\"");
    assert_eq!(
        flags[2],
        "model_providers.harkroom-lane.base_url=\"http://127.0.0.1:9/v1\""
    );
    assert_eq!(
        flags[3],
        "model_providers.harkroom-lane.env_key=\"HARKROOM_LANE_API_KEY\""
    );
    assert!(flags[6].starts_with("developer_instructions=\"이 대화의 답은"));
    assert_eq!(
        flags[11],
        "shell_environment_policy.exclude=[\"HARKROOM_LANE_API_KEY\",\"HARKROOM_LANE_BASE_URL\",\"HARKROOM_TURN_BRIDGE_KEY\"]"
    );
    assert_eq!(flags.len(), 12);
}

#[test]
fn prompt_files_are_0600_even_when_preexisting() {
    let d = tmp("prompt");
    let pre = d.join("system-prompt.txt");
    fs::write(&pre, "old").unwrap();
    fs::set_permissions(&pre, fs::Permissions::from_mode(0o644)).unwrap();
    let p = write_system_prompt_file(&d, "새 지시").unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), "새 지시");
    assert_eq!(
        fs::metadata(&p).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let s = write_prompt_file(&d, "프롬프트").unwrap();
    assert!(s.ends_with("stdin-prompt.txt"));
    assert_eq!(
        fs::metadata(&s).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let gone = d.join("moved-away");
    let e = write_system_prompt_file(&gone, "x").unwrap_err();
    assert!(matches!(e, TurnFileError::StateDirGone { .. }));
    assert!(!e.to_string().contains("moved-away"));
}

#[test]
fn mcp_name_grammar_is_enforced() {
    for ok in ["github", "a", "my-mcp-2", &"a".repeat(64)] {
        assert!(is_valid_mcp_name(ok), "{ok}");
    }
    for bad in [
        "",
        "GitHub",
        "a.b",
        "a=b",
        "a\"b",
        "a b",
        "가",
        &"a".repeat(65),
    ] {
        assert!(!is_valid_mcp_name(bad), "{bad}");
    }
    let d = tmp("names");
    let p = d.join("m.json");
    fs::write(
        &p,
        r#"{"mcpServers":{"harkroom":{"command":"/op"},"x.transport":{"command":"z"}}}"#,
    )
    .unwrap();
    let e = read_extra_mcp_servers(&p).unwrap_err();
    assert!(matches!(e, TurnFileError::McpEntryInvalid { ref name } if name == "x.transport"));
    assert!(!e.to_string().contains("x.transport"));
}

#[test]
fn prompt_file_does_not_follow_symlink() {
    let d = tmp("link");
    let target = d.join("victim.txt");
    fs::write(&target, "keep").unwrap();
    std::os::unix::fs::symlink(&target, d.join("stdin-prompt.txt")).unwrap();
    let p = write_prompt_file(&d, "프롬프트").unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
    let meta = fs::symlink_metadata(&p).unwrap();
    assert!(meta.file_type().is_file());
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    assert_eq!(fs::read_to_string(&p).unwrap(), "프롬프트");
    // 임시 파일이 남지 않는다.
    let left: Vec<_> = fs::read_dir(&d)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(left.is_empty());
}
