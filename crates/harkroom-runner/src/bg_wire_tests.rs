use super::*;
use crate::bg_executor::bg_executor_args;
use std::collections::BTreeMap;

fn tmp() -> PathBuf {
    let d = std::env::temp_dir().join(format!("bg-wire-{}", random_uuid()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn cfg(dir: &Path) -> MakerConfig {
    let mcp = dir.join("mcp.json");
    std::fs::write(
        &mcp,
        r#"{"mcpServers":{"harkroom":{"command":"op","args":["mcp"]},"other":{"command":"x"}}}"#,
    )
    .unwrap();
    MakerConfig {
        operator_bin: "/opt/op".into(),
        command_hook: true,
        post_tool_hook: true,
        chrome_host: true,
        state_dir: dir.to_path_buf(),
        mcp_config_path: mcp,
        runner_env: BTreeMap::new(),
        parent_env: BTreeMap::from([("PATH".to_string(), "/usr/bin".to_string())]),
        pat: String::new(),
        home: dir.to_path_buf(),
        turn_timeout_ms: 1000,
        harness_stall_ms: 1000,
        workspace_base_dir: dir.to_path_buf(),
        me_id: "me".into(),
        claim_holder: "h".into(),
        can_register_turn_keys: true,
        pty_record_dir: None,
        codex: None,
        opencode: None,
        pi: None,
        omp: None,
    }
}

/// 실물 조립이 실행기의 argv 검사를 지나고, 회차에는 harkroom MCP 와 허용 도구만 남는다.
#[test]
fn real_plan_passes_the_executor_checks() {
    let dir = tmp();
    let c = cfg(&dir);
    let cwd = dir.join("bg").join("j");
    std::fs::create_dir_all(&cwd).unwrap();
    let mcp = mcp_plan(&c, "t-1", &cwd).unwrap();
    let job = BgJob {
        id: "11111111-1111-1111-1111-111111111111".into(),
        kind: "cleanup".into(),
        day: "2026-11-25".into(),
        input: serde_json::Map::new(),
    };
    let def = serde_json::json!({"model": "opus", "effort": "low"});
    let acct = dir.join("acct");
    let p = command(&c, &def, &job, "sid", "t-1", &cwd, Some(&acct), &mcp).unwrap();
    let args = bg_executor_args(&p.args, "sid").unwrap();
    let at = |f: &str| {
        args.iter()
            .position(|a| a == f)
            .map(|i| args[i + 1].clone())
    };
    assert_eq!(at("--tools").as_deref(), Some("ToolSearch"));
    assert_eq!(at("--permission-mode").as_deref(), Some("dontAsk"));
    assert_eq!(at("--model").as_deref(), Some("opus"));
    assert!(!args.iter().any(|a| a == "--settings" || a == "--chrome"));
    let written = std::fs::read_to_string(at("--mcp-config").unwrap()).unwrap();
    let v: Value = serde_json::from_str(&written).unwrap();
    let names: Vec<&String> = v["mcpServers"].as_object().unwrap().keys().collect();
    assert_eq!(names, ["harkroom"]);
    assert!(written.contains(&mcp.turn_keys.as_ref().unwrap().bridge));
    assert_eq!(
        p.env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
        acct.to_str()
    );
    assert!(p.env.values().any(|v| v == &format!("bg:{}", job.id)));
    // 열쇠가 든 설정은 턴 끝에 지운다.
    let path = mcp.mcp_config_path.clone();
    assert_eq!(TurnFiles::of(&mcp, &c.state_dir, "t-1").remove_now(), 1);
    assert!(!path.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn sweep_leaves_recent_dirs() {
    let dir = tmp();
    std::fs::create_dir_all(dir.join(BG_DIR).join("a")).unwrap();
    let now = SystemTime::now();
    assert_eq!(sweep_bg_dirs(&dir, now), 0);
    assert_eq!(sweep_bg_dirs(&dir, now + BG_TIMEOUT * 3), 1);
    let _ = std::fs::remove_dir_all(&dir);
}
