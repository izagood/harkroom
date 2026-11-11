use super::*;

const OP: &str = "/Applications/Harkroom.app/Contents/MacOS/harkroom-operator";

#[test]
fn readonly_rules_are_single_tokens() {
    assert_eq!(READONLY_ALLOW.len(), 25);
    assert_eq!(READONLY_ALLOW[0], "ToolSearch");
    assert_eq!(READONLY_ALLOW[1], "mcp__harkroom__message_post");
    assert_eq!(READONLY_RULES.len(), 6);
    assert_eq!(READONLY_RULES[0], "--disallowedTools");
    assert_eq!(READONLY_RULES[1], "Bash,WebFetch,WebSearch");
    assert_eq!(READONLY_RULES[3], READONLY_ALLOW.join(","));
    assert_eq!(READONLY_RULES[5], "ToolSearch,Read,Grep,Glob");
    // 상태를 바꾸는 도구는 열지 않는다.
    for t in [
        "grant_delegate",
        "permission_request",
        "secret_mount",
        "message_delegate",
        "skill_propose",
    ] {
        assert!(!READONLY_ALLOW.iter().any(|a| a.ends_with(t)), "{t}");
    }
}

#[test]
fn lane_base_allow_has_no_bare_write_or_read() {
    for bare in ["Edit", "Write", "Read", "Bash", "WebFetch"] {
        assert!(!LANE_BASE_ALLOW.contains(&bare), "{bare}");
    }
}

#[test]
fn config_settings_deny() {
    assert_eq!(
        config_settings_deny_rules(None),
        vec![
            "Edit(~/.claude/settings.json)",
            "Edit(~/.claude/settings.local.json)"
        ]
    );
    assert_eq!(
        config_settings_deny_rules(Some("/Users/x/.cfg//")),
        vec![
            "Edit(//Users/x/.cfg/settings.json)",
            "Edit(//Users/x/.cfg/settings.local.json)"
        ]
    );
}

#[test]
fn safe_tool_allows_keeps_canonical_only() {
    let kept = safe_tool_allows(&[
        "Bash(git status)",
        "Bash(*)",
        "WebFetch(domain:example.com)",
        "",
        "Bash(rm -rf /)",
    ]);
    assert!(kept.contains(&"Bash(git status)".to_string()));
    assert!(!kept.contains(&"Bash(*)".to_string()));
    assert!(!kept.contains(&String::new()));
    for k in &kept {
        assert!(matches!(validate_tool_rule(k), ToolRuleVerdict::Ok { rule, .. } if &rule == k));
    }
}

#[test]
fn lane_hook_rules_roundtrip_shape() {
    let enc = encode_lane_hook_rules(&["Bash(git status)", "bad rule", "WebFetch", "Bash(a\nb)"]);
    assert!(
        enc.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    );
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(enc)
        .unwrap();
    // TS `/s` 와 같이 괄호 안 개행은 꼴로 받는다(오퍼레이터가 다시 판정한다).
    assert_eq!(
        String::from_utf8(raw).unwrap(),
        r#"["Bash(git status)","WebFetch","Bash(a\nb)"]"#
    );
    assert_eq!(encode_lane_hook_rules::<&str>(&[]), "W10");
}

#[test]
fn command_hook_settings_matches_ts() {
    assert_eq!(
        command_hook_settings(OP).unwrap(),
        format!(
            r#"{{"hooks":{{"PreToolUse":[{{"matcher":"Bash","hooks":[{{"type":"command","command":"\"{OP}\" hook pretool","timeout":15}}]}}]}}}}"#
        )
    );
}

#[test]
fn lane_hook_settings_matches_ts() {
    let enc = encode_lane_hook_rules(&["Bash(git status)"]);
    assert_eq!(
        lane_hook_settings(OP, &["Bash(git status)"]).unwrap(),
        format!(
            r#"{{"hooks":{{"PreToolUse":[{{"matcher":"*","hooks":[{{"type":"command","command":"\"{OP}\" hook pretool --lane {enc} || exit 2","timeout":15}}]}}]}}}}"#
        )
    );
}

#[test]
fn unsafe_operator_path_refused_without_value() {
    for bad in [
        "",
        "/a/$HOME/op",
        "/a/`id`/op",
        "/a\"/op",
        "/a\\op",
        "/a\nop",
        "/a\rop",
        "/a\0op",
    ] {
        assert_eq!(
            command_hook_settings(bad),
            Err(TurnRulesError::UnsafeOperatorPath),
            "{bad:?}"
        );
        assert!(lane_hook_settings::<&str>(bad, &[]).is_err());
        assert!(settings_args(None, bad, Some(1), false).is_err());
        assert!(settings_args(None, bad, None, true).is_err());
    }
    // 공백·한글 경로는 받는다(큰따옴표 안).
    assert!(command_hook_settings("/Users/a b/앱/harkroom-operator").is_ok());
    let e = command_hook_settings("/x/$SECRET").unwrap_err().to_string();
    assert!(!e.contains("SECRET"));
}

#[test]
fn post_tool_since_clamped() {
    let v = post_tool_hook_entry("/op", -5).unwrap();
    assert_eq!(v["hooks"][0]["command"], "\"/op\" hook posttool --since 0");
    let v = post_tool_hook_entry("/op", 42).unwrap();
    assert_eq!(v["hooks"][0]["command"], "\"/op\" hook posttool --since 42");
}

#[test]
fn settings_args_cases() {
    // 아무것도 없으면 빈 배열, 앞 설정만 있으면 그대로.
    assert!(settings_args(None, "/op", None, false).unwrap().is_empty());
    assert_eq!(
        settings_args(Some("{\"a\":1}"), "/op", None, false).unwrap(),
        vec!["--settings", "{\"a\":1}"]
    );

    // 새 글 hook 만.
    let pre = command_hook_settings("/op").unwrap();
    let out = settings_args(Some(&pre), "/op", Some(7), false).unwrap();
    assert_eq!(out[0], "--settings");
    assert_eq!(
        out[1],
        r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"\"/op\" hook pretool","timeout":15}]}],"PostToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"\"/op\" hook posttool --since 7","timeout":15}]}]}}"#
    );

    // 물음 hook 만(앞 설정 없음).
    let out = settings_args(None, "/op", None, true).unwrap();
    assert_eq!(
        out[1],
        r#"{"hooks":{"PermissionRequest":[{"matcher":"*","hooks":[{"type":"command","command":"\"/op\" hook permission","timeout":15}]}],"Notification":[{"matcher":"*","hooks":[{"type":"command","command":"\"/op\" hook notify","timeout":15}]}]}}"#
    );

    // 둘 다 — 순서 PreToolUse·PostToolUse·PermissionRequest·Notification, 다른 키 자리 유지.
    let out = settings_args(
        Some(r#"{"x":1,"hooks":{"PreToolUse":[]},"y":2}"#),
        "/op",
        Some(0),
        true,
    )
    .unwrap();
    let v: Value = serde_json::from_str(&out[1]).unwrap();
    let top: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    assert_eq!(top, vec!["x", "hooks", "y"]);
    let hooks: Vec<_> = v["hooks"].as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        hooks,
        vec![
            "PreToolUse",
            "PostToolUse",
            "PermissionRequest",
            "Notification"
        ]
    );
}

#[test]
fn bad_pre_settings_refused() {
    assert_eq!(
        settings_args(Some("[1]"), "/op", Some(1), false),
        Err(TurnRulesError::BadPreSettings)
    );
    assert_eq!(
        settings_args(Some("nope"), "/op", None, true),
        Err(TurnRulesError::BadPreSettings)
    );
}
