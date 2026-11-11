//! 정본 `packages/agent/test/opencodeHome.test.ts` 의 순수 함수 경우를 옮겼다.

use super::*;
use serde_json::json;

const CH: &str = "0f8b2a4c-1d3e-4f5a-9b6c-7d8e9f0a1b2c";

#[test]
fn mcp_stdio_goes_local_with_command_array() {
    let s = json!({ "harkroom": { "type": "stdio", "command": "/opt/harkroom/harkroom-operator", "args": ["mcp-bridge"] } });
    let got = to_opencode_mcp(s.as_object().unwrap());
    assert_eq!(
        Value::Object(got),
        json!({ "harkroom": { "type": "local", "command": ["/opt/harkroom/harkroom-operator", "mcp-bridge"], "enabled": true } })
    );
}

#[test]
fn mcp_env_becomes_environment_remote_keeps_headers_unknown_dropped() {
    let s = json!({
        "x": { "type": "stdio", "command": "x", "args": [], "env": { "K": "v" } },
        "y": { "type": "http", "url": "https://e/mcp", "headers": { "A": "b" } },
        "bad": {}
    });
    let got = to_opencode_mcp(s.as_object().unwrap());
    assert_eq!(got["x"]["environment"], json!({ "K": "v" }));
    assert_eq!(
        got["y"],
        json!({ "type": "remote", "url": "https://e/mcp", "enabled": true, "headers": { "A": "b" } })
    );
    assert!(!got.contains_key("bad"));
}

#[test]
fn strip_jsonc_keeps_urls_and_drops_comments_and_trailing_commas() {
    let v: Value = serde_json::from_str(&strip_jsonc(
        "{\"u\":\"https://a.example/v1\", // x\n \"b\":[1,2,],}",
    ))
    .unwrap();
    assert_eq!(v, json!({ "u": "https://a.example/v1", "b": [1, 2] }));
    let v: Value = serde_json::from_str(&strip_jsonc("{/* a */\"s\":\"q\\\"/*x*/\"}")).unwrap();
    assert_eq!(v, json!({ "s": "q\"/*x*/" }));
    // 닫히지 않은 문자열·주석에서 넘치지 않는다.
    assert_eq!(strip_jsonc("\"abc\\"), "\"abc\\");
    assert_eq!(strip_jsonc("a/*b"), "a");
}

#[test]
fn provider_lane_model_id_grammar() {
    assert_eq!(
        provider_lane_model_id(Some("harkroom-lane/example-model")).as_deref(),
        Some("example-model")
    );
    assert_eq!(
        provider_lane_model_id(Some("harkroom-lane/{env:HARKROOM_PROVIDER_TOKEN}")),
        None
    );
    assert_eq!(
        provider_lane_model_id(Some("harkroom-lane/ExampleOrg/example-model-2.7")).as_deref(),
        Some("ExampleOrg/example-model-2.7")
    );
    let long = format!("harkroom-lane/{}", "a".repeat(129));
    for bad in [
        "harkroom-lane/a//b",
        "harkroom-lane/a/",
        "harkroom-lane//a",
        "harkroom-lane/a/{file:/etc/passwd}",
        &long,
    ] {
        assert_eq!(provider_lane_model_id(Some(bad)), None, "{bad}");
    }
    assert_eq!(
        provider_lane_model_id(Some(&format!("harkroom-lane/{}", "a".repeat(128))))
            .map(|s| s.len()),
        Some(128)
    );
    assert_eq!(provider_lane_model_id(Some("harkroom-lane/")), None);
    assert_eq!(provider_lane_model_id(None), None);
    assert_eq!(
        provider_lane_model_id(Some("ExampleOrg/example-model")).as_deref(),
        Some("ExampleOrg/example-model")
    );
    assert_eq!(
        provider_lane_model_id(Some("{env:HARKROOM_PROVIDER_TOKEN}")),
        None
    );
}

#[test]
fn lane_run_model_and_missing() {
    assert_eq!(
        lane_run_model(true, true, Some("ExampleOrg/example-model")).as_deref(),
        Some("harkroom-lane/ExampleOrg/example-model")
    );
    assert_eq!(
        lane_run_model(true, true, Some("harkroom-lane/ExampleOrg/example-model")).as_deref(),
        Some("harkroom-lane/ExampleOrg/example-model")
    );
    assert_eq!(
        lane_run_model(true, true, Some("ExampleOrg/{file:/etc/passwd}")),
        None
    );
    assert_eq!(
        lane_run_model(true, false, Some("ExampleOrg/example-model")).as_deref(),
        Some("ExampleOrg/example-model")
    );
    assert_eq!(
        lane_run_model(true, false, Some("harkroom-lane/ExampleOrg/example-model")).as_deref(),
        Some("ExampleOrg/example-model")
    );
    assert_eq!(
        lane_run_model(false, true, Some("harkroom-lane/x")).as_deref(),
        Some("harkroom-lane/x")
    );
    assert!(opencode_lane_model_missing(true, true, Some("")));
    assert!(opencode_lane_model_missing(true, true, None));
    assert!(!opencode_lane_model_missing(true, false, None));
    assert!(!opencode_lane_model_missing(false, true, None));
    assert!(!opencode_lane_model_missing(
        true,
        true,
        Some("ExampleOrg/m")
    ));
}

#[test]
fn bash_table_only_moves_whole_command_rules() {
    let table = lane_opencode_bash_table(&[
        "Bash(gh pr list -R example/repo --limit 5)",
        "Bash(gh run list -R example/repo:*)",
        "Bash(ls *.txt)",
        "Bash(echo a?)",
        "Bash(gh pr list | sh)",
        "Bash(echo ok > f)",
        "Bash(echo $(id))",
        "WebFetch",
        "Bash()",
        "Bash(  git status  )",
    ]);
    assert_eq!(table.keys().next().map(String::as_str), Some("*"));
    assert_eq!(
        Value::Object(table),
        json!({ "*": "deny", "gh pr list -R example/repo --limit 5": "allow", "git status": "allow" })
    );
}

#[test]
fn lane_agent_name_only_lowercase_uuid() {
    assert_eq!(
        opencode_lane_agent_name(CH),
        Some(format!("harkroom-lane-{CH}"))
    );
    for bad in [
        "general".to_string(),
        format!("{CH}x"),
        "../x".to_string(),
        CH.to_uppercase(),
    ] {
        assert_eq!(opencode_lane_agent_name(&bad), None);
    }
}

#[test]
fn skill_permission_and_names() {
    assert_eq!(
        Value::Object(lane_skill_permission(&[] as &[&str])),
        json!({ "*": "deny" })
    );
    assert_eq!(
        Value::Object(lane_skill_permission(&["harkroom-guide", "a*", "", "ok_1"])),
        json!({ "*": "deny", "harkroom-guide": "allow", "ok_1": "allow" })
    );
    assert_eq!(
        skill_name_from_body("---\nname: \"harkroom-guide\"\ndescription: x\n---\nbody").as_deref(),
        Some("harkroom-guide")
    );
    assert_eq!(
        skill_name_from_body("---\r\nname: g\r\n---\r\n").as_deref(),
        Some("g")
    );
    assert_eq!(skill_name_from_body("no frontmatter"), None);
    assert_eq!(runner_skill_names(None), Vec::<String>::new());
}

#[test]
fn lane_permission_order_and_protected_paths() {
    let p = opencode_lane_permission();
    let o = p.as_object().unwrap();
    assert_eq!(o.keys().next().map(String::as_str), Some("*"));
    assert_eq!(o["*"], json!("deny"));
    assert_eq!(o["edit"]["*"], json!("allow"));
    for k in [
        "CLAUDE.md",
        "*/CLAUDE.md",
        ".kilo/*",
        "*/.kilo/*",
        "opencode.jsonc",
        "*/kilo.jsonc",
    ] {
        assert_eq!(o["edit"][k], json!("deny"), "{k}");
    }
    assert_eq!(
        o["edit"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .map(String::as_str),
        Some("*")
    );
    assert_eq!(o["skill"], json!({ "*": "deny" }));
}

#[test]
fn xdg_paths() {
    let home = Path::new("/h");
    assert_eq!(
        source_opencode_config(None, home, &OPENCODE_APP),
        PathBuf::from("/h/.config/opencode/opencode.json")
    );
    assert_eq!(
        source_opencode_config(Some("/x"), home, &OPENCODE_APP),
        PathBuf::from("/x/opencode/opencode.json")
    );
    assert_eq!(
        source_opencode_data(None, home, &OPENCODE_APP),
        PathBuf::from("/h/.local/share/opencode")
    );
    let r = Path::new("/r");
    assert_eq!(
        opencode_config_file(r, &OPENCODE_APP),
        PathBuf::from("/r/config/opencode/opencode.jsonc")
    );
    assert_eq!(opencode_dirs(r).xdg_state_home, PathBuf::from("/r/state"));
    assert_eq!(opencode_lane_home(r), PathBuf::from("/r/lane-home"));
    // 어댑터 표의 opencode 이름표와 같다.
    let a = crate::adapter::adapter_for(crate::adapter::AgentHarness::Opencode)
        .unwrap()
        .xdg_app
        .unwrap();
    assert_eq!(a, OPENCODE_APP);
}

#[test]
fn provider_lane_config_accumulates_and_caps() {
    let prev: Vec<String> = (0..20).map(|i| format!("m{i}")).collect();
    let c = provider_lane_config(Some("harkroom-lane/m3"), &prev);
    let models: Vec<&String> = c["provider"]["harkroom-lane"]["models"]
        .as_object()
        .unwrap()
        .keys()
        .collect();
    assert_eq!(models.len(), PROVIDER_LANE_MODEL_KEEP);
    assert_eq!(models.last().map(|s| s.as_str()), Some("m3"));
    assert_eq!(c["model"], json!("harkroom-lane/m3"));
    assert_eq!(c["enabled_providers"], json!(["harkroom-lane"]));
    assert_eq!(c["autoupdate"], json!(false));
    let none = provider_lane_config(Some("{env:X}"), &[]);
    assert!(!none.contains_key("model"));
    assert!(
        none["provider"]["harkroom-lane"]["models"]
            .as_object()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn previous_lane_reads_validate_again() {
    let name = format!("harkroom-lane-{CH}");
    let text = json!({
        "provider": { "harkroom-lane": { "models": { "ok/m": {}, "{env:X}": {} } } },
        "agent": {
            name.clone(): { "mode": "primary", "permission": { "bash": { "*": "deny", "git status": "allow" } } },
            "harkroom-lane-BAD": { "permission": { "bash": { "*": "deny" } } },
            format!("harkroom-lane-{}", "1".repeat(36)): { "permission": { "bash": { "*": "deny" } } }
        }
    })
    .to_string();
    assert_eq!(previous_lane_models(&text), vec!["ok/m".to_string()]);
    let agents = previous_lane_channel_agents(&text);
    assert_eq!(agents.keys().collect::<Vec<_>>(), vec![&name]);
    assert!(opencode_lane_agent_matches_text(
        &text,
        CH,
        &["Bash(git status)"]
    ));
    assert!(!opencode_lane_agent_matches_text(
        &text,
        CH,
        &["Bash(git log)"]
    ));
    // 모양이 어긋난 칸은 버린다: 맨 앞이 `*` deny 가 아니거나 값이 이상하거나 열쇠에 패턴 글자.
    for bash in [
        json!({ "git status": "allow", "*": "deny" }),
        json!({ "*": "deny", "x": "ask" }),
        json!({ "*": "deny", "ls *": "allow" }),
    ] {
        let t =
            json!({ "agent": { name.clone(): { "permission": { "bash": bash } } } }).to_string();
        assert!(previous_lane_channel_agents(&t).is_empty());
    }
    assert!(previous_lane_models("not json").is_empty());
}
