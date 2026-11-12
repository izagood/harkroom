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
    // 예약 이름이 아니고 겹치지 않으므로 값은 argv 에서 빠지고 이름만 `env_vars` 로(security #1945 낮음 2).
    let servers = vec![("github".to_string(), e.clone())];
    let plan = plan_codex_mcp_env(&servers);
    assert_eq!(
        codex_mcp_flags("github", &e, &plan),
        [
            "-c",
            "mcp_servers.github.transport=\"stdio\"",
            "-c",
            "mcp_servers.github.command=\"gh-mcp\"",
            "-c",
            "mcp_servers.github.args=[\"serve\"]",
            "-c",
            "mcp_servers.github.env_vars=[\"GH_TOKEN\"]",
        ]
    );
    assert_eq!(
        codex_mcp_env(&servers),
        [("GH_TOKEN".to_string(), "x".to_string())]
    );
    // 빈 계획(옮김 없음)이면 지금처럼 인라인 표.
    assert_eq!(
        codex_mcp_flags("github", &e, &CodexMcpEnvPlan::default())[7],
        "mcp_servers.github.env={ \"GH_TOKEN\" = \"x\" }"
    );
    let no_env = McpServerEntry::Stdio {
        command: "c".into(),
        args: vec![],
        env: None,
    };
    assert_eq!(
        codex_mcp_flags("n", &no_env, &CodexMcpEnvPlan::default())[5],
        "mcp_servers.n.args=[]"
    );
    assert_eq!(
        codex_mcp_flags("n", &no_env, &CodexMcpEnvPlan::default()).len(),
        6
    );
}

#[test]
fn bearer_goes_to_env_not_argv() {
    let e = http(&[("Authorization", "Bearer SECRET-1"), ("X-Team", "t")]);
    let flags = codex_mcp_flags("slack-work", &e, &CodexMcpEnvPlan::default());
    assert!(!flags.join(" ").contains("SECRET-1"));
    assert!(flags.contains(&"mcp_servers.slack-work.transport=\"streamable_http\"".to_string()));
    assert!(
        flags.contains(
            &"mcp_servers.slack-work.bearer_token_env_var=\"HARKROOM_MCP_BEARER_SLACK_WORK\""
                .to_string()
        )
    );
    assert!(flags.contains(
        &"mcp_servers.slack-work.env_http_headers={ \"X-Team\" = \"HARKROOM_MCP_HDR_SLACK_WORK_0\" }"
            .to_string()
    ));
    assert!(!flags.iter().any(|f| f.contains(".http_headers=")));
    let servers = vec![("slack-work".to_string(), e)];
    assert_eq!(
        codex_mcp_env(&servers),
        [
            (
                "HARKROOM_MCP_BEARER_SLACK_WORK".to_string(),
                "SECRET-1".to_string()
            ),
            ("HARKROOM_MCP_HDR_SLACK_WORK_0".to_string(), "t".to_string()),
        ]
    );
}

#[test]
fn header_values_never_reach_argv() {
    let e = http(&[
        ("X-Api-Key", "HDR-SECRET"),
        ("Authorization", "Basic BASIC-SECRET"),
    ]);
    let flags = codex_mcp_flags("vendor", &e, &CodexMcpEnvPlan::default());
    let joined = flags.join(" ");
    assert!(!joined.contains("HDR-SECRET"));
    assert!(!joined.contains("BASIC-SECRET"));
    assert!(flags.contains(
        &"mcp_servers.vendor.env_http_headers={ \"X-Api-Key\" = \"HARKROOM_MCP_HDR_VENDOR_0\", \"Authorization\" = \"HARKROOM_MCP_HDR_VENDOR_1\" }"
            .to_string()
    ));
    let env = codex_mcp_env(&[("vendor".to_string(), e)]);
    assert_eq!(
        env,
        [
            (
                "HARKROOM_MCP_HDR_VENDOR_0".to_string(),
                "HDR-SECRET".to_string()
            ),
            (
                "HARKROOM_MCP_HDR_VENDOR_1".to_string(),
                "Basic BASIC-SECRET".to_string()
            ),
        ]
    );
    // 모든 이름이 셸 거르기 패턴 안에 든다.
    assert!(env.iter().all(|(k, _)| k.starts_with("HARKROOM_MCP_")));
    // stdio 는 비밀 env 를 만들지 않는다(env 는 아직 argv — B3e-6 남은 것).
    let s = McpServerEntry::Stdio {
        command: "c".into(),
        args: vec![],
        env: None,
    };
    assert!(codex_mcp_env(&[("s".to_string(), s)]).is_empty());
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
        codex_mcp_flags("s", &e, &CodexMcpEnvPlan::default()),
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
    let a = codex_lane_args("http://127.0.0.1:9", &[]);
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
        "shell_environment_policy.exclude=[\"HARKROOM_LANE_API_KEY\",\"HARKROOM_LANE_BASE_URL\",\"HARKROOM_TURN_BRIDGE_KEY\",\"HARKROOM_MCP_*\"]"
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

fn stdio(env: &[(&str, &str)]) -> McpServerEntry {
    McpServerEntry::Stdio {
        command: "srv".into(),
        args: vec![],
        env: Some(
            env.iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        ),
    }
}

/// security #1945 낮음 2 조건 ①②: 예약 이름·문법 밖·서버끼리 다른 값은 옮기지 않는다. 같은 값이면 한 번 옮긴다.
#[test]
fn stdio_env_plan_keeps_reserved_and_conflicting_names_in_argv() {
    for r in [
        "PATH",
        "home",
        "USER",
        "SHELL",
        "TMPDIR",
        "NODE_OPTIONS",
        "LD_PRELOAD",
        "DYLD_X",
        "CODEX_HOME",
        "OPENAI_API_KEY",
        "HARKROOM_X",
        "RUST_LOG",
    ] {
        assert!(is_reserved_mcp_env(r), "{r}");
    }
    assert!(!is_reserved_mcp_env("GH_TOKEN"));
    let servers = vec![
        (
            "a".to_string(),
            stdio(&[
                ("API_TOKEN", "a1"),
                ("SHARED", "same"),
                ("PATH", "/evil"),
                ("bad-name", "z"),
            ]),
        ),
        (
            "b".to_string(),
            stdio(&[("API_TOKEN", "b1"), ("SHARED", "same"), ("ONLY_B", "ob")]),
        ),
    ];
    let plan = plan_codex_mcp_env(&servers);
    assert_eq!(plan.moved_names(), ["ONLY_B", "SHARED"]);
    // 조건 ④: argv 에 남는 서버 이름만.
    assert_eq!(plan.argv_servers, ["a", "b"]);
    let fa = codex_mcp_flags("a", &servers[0].1, &plan);
    assert!(
        fa.contains(&"mcp_servers.a.env_vars=[\"SHARED\"]".to_string()),
        "{fa:?}"
    );
    let inline = fa
        .iter()
        .find(|x| x.starts_with("mcp_servers.a.env="))
        .unwrap();
    assert!(inline.contains("API_TOKEN") && inline.contains("PATH") && inline.contains("bad-name"));
    assert!(!inline.contains("SHARED"));
    let fb = codex_mcp_flags("b", &servers[1].1, &plan);
    assert!(
        fb.contains(&"mcp_servers.b.env_vars=[\"ONLY_B\",\"SHARED\"]".to_string())
            || fb.contains(&"mcp_servers.b.env_vars=[\"SHARED\",\"ONLY_B\"]".to_string()),
        "{fb:?}"
    );
    // 옮긴 값만 자식 env 로 — 예약·충돌 값은 env 에 싣지 않는다(codex 자신의 env 를 덮지 않음).
    let env = codex_mcp_env(&servers);
    assert_eq!(
        env,
        [
            ("ONLY_B".to_string(), "ob".to_string()),
            ("SHARED".to_string(), "same".to_string())
        ]
    );
}

/// 조건 ③: 옮긴 이름은 lane 의 `exclude` 에도 이름 그대로(뒤의 `-c` 가 앞 것을 덮는다).
#[test]
fn lane_exclude_carries_moved_names() {
    let a = codex_lane_args("http://127.0.0.1:9", &["SHARED".to_string()]);
    assert_eq!(
        a.last().unwrap(),
        "shell_environment_policy.exclude=[\"HARKROOM_LANE_API_KEY\",\"HARKROOM_LANE_BASE_URL\",\"HARKROOM_TURN_BRIDGE_KEY\",\"HARKROOM_MCP_*\",\"SHARED\"]"
    );
}
