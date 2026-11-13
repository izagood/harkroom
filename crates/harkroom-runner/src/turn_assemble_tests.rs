use std::fs;

use serde_json::json;

use super::*;
use crate::adapter::{AgentHarness, MentionPermission};
use crate::turn_preset::TurnMode;

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn tmp(tag: &str) -> Tmp {
    let d = std::env::temp_dir().join(format!("hk-assemble-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    Tmp(d)
}

fn source(dir: &Path) -> PathBuf {
    let p = dir.join("mcp.json");
    fs::write(
        &p,
        json!({ "mcpServers": { "harkroom": { "command": "/bin/harkroom-operator", "args": ["mcp"], "env": { "A": "1" } } } })
            .to_string(),
    )
    .unwrap();
    p
}

fn mcp<'a>(
    dir: &'a Path,
    src: &'a Path,
    env: &'a BTreeMap<String, String>,
    can: bool,
) -> TurnMcpInput<'a> {
    TurnMcpInput {
        harness: AgentHarness::ClaudeCode,
        can_register_turn_keys: can,
        provider_env: None,
        state_dir: dir,
        mcp_config_path: src,
        turn_id: "turn-1",
        runner_env: env,
    }
}

/// 열쇠를 맡길 수 있는 claude 턴: 열쇠·턴 MCP 설정·턴 파일·가림 재료가 한 계획에서 나온다.
#[test]
fn assemble_claude_with_keys() {
    let t = tmp("keys");
    let src = source(&t.0);
    let env = BTreeMap::new();
    let lease = t.0.join("lease");
    let a = assemble_attempt(
        &mcp(&t.0, &src, &env, true),
        Some("m1"),
        "pat-1",
        Some(lease.clone()),
    )
    .unwrap();
    let turn = a.turn.as_ref().expect("열쇠");
    assert_eq!(turn.turn_id, "turn-1");
    assert_eq!(turn.cause.as_deref(), Some("m1"));
    assert_eq!(
        a.secrets.turn_key_values,
        vec![turn.keys.bridge.clone(), turn.keys.shell.clone()]
    );
    assert_eq!(a.secrets.lease_dir.as_deref(), Some(lease.as_path()));
    assert_eq!(
        a.launch_plan(true, false),
        LaunchPlan {
            turn_keys: true,
            secrets: true,
            lane_keys: false
        }
    );
    // 턴 MCP 설정(다리 열쇠 든 파일)은 이 시도의 TurnFiles 가 턴 끝에 지운다.
    let cfg = a.plan.mcp_config_path.clone();
    assert!(cfg.exists() && cfg != src);
    let keys = env_turn_keys(&a.plan).unwrap();
    assert_eq!(keys.bridge, turn.keys.bridge);
    drop(a);
    assert!(!cfg.exists(), "TurnFiles 가 지웠다");
    assert!(src.exists(), "기본 설정은 그대로");
}

/// 열쇠를 맡길 길이 없으면 열쇠·열쇠 가림 재료가 없고 기본 설정을 쓴다.
#[test]
fn assemble_without_keys_uses_base_config() {
    let t = tmp("nokeys");
    let src = source(&t.0);
    let env = BTreeMap::new();
    let a = assemble_attempt(&mcp(&t.0, &src, &env, false), Some("m1"), "pat-1", None).unwrap();
    assert!(a.turn.is_none());
    assert!(a.secrets.turn_key_values.is_empty());
    assert_eq!(a.plan.mcp_config_path, src);
    assert!(!a.launch_plan(false, false).turn_keys);
    drop(a);
    assert!(src.exists());
}

/// 띄우기 계획: lane env·턴 열쇠는 자식 env 로만, argv 에는 값이 없고 MCP 설정 경로는 이 시도의 것.
#[test]
fn pty_plan_carries_lane_env_and_keys_in_env_only() {
    let base = TurnCommandOptions::new(
        AgentHarness::ClaudeCode,
        TurnMode::Mention,
        MentionPermission::Auto,
        "/op",
    );
    let mut base = base;
    base.session_id = Some("11111111-2222-4333-8444-555555555555");
    let lane: LaneEnv = [
        (
            "ANTHROPIC_BASE_URL".to_string(),
            "https://gw.example".to_string(),
        ),
        (
            "ANTHROPIC_AUTH_TOKEN".to_string(),
            "tok-lane-77".to_string(),
        ),
    ]
    .into();
    let keys = EnvTurnKeys {
        shell: "shell-key-77".into(),
        bridge: "bridge-key-77".into(),
    };
    let parent: BTreeMap<String, String> = [("PATH".to_string(), "/usr/bin".to_string())].into();
    let p = pty_turn_plan(
        &base,
        &lane,
        Some(&keys),
        "/s/turn-mcp/turn-1.json",
        &parent,
        Path::new("/h"),
    )
    .unwrap();
    let env_vals: Vec<&str> = p.env.iter().map(|(_, v)| v.as_str()).collect();
    assert!(env_vals.contains(&"tok-lane-77"));
    assert!(
        env_vals.contains(&"shell-key-77") || env_vals.contains(&"bridge-key-77"),
        "{:?}",
        p.env.iter().map(|(k, _)| k).collect::<Vec<_>>()
    );
    for v in ["tok-lane-77", "shell-key-77", "bridge-key-77"] {
        assert!(p.args.iter().all(|a| !a.contains(v)), "argv 에 {v}");
    }
    assert!(
        p.args.iter().any(|a| a.contains("/s/turn-mcp/turn-1.json")),
        "{:?}",
        p.args
    );
    // lane 없는 턴은 lane 값을 싣지 않는다.
    let p = pty_turn_plan(
        &base,
        &LaneEnv::new(),
        None,
        "/m.json",
        &parent,
        Path::new("/h"),
    )
    .unwrap();
    assert!(p.env.iter().all(|(k, _)| k != "ANTHROPIC_AUTH_TOKEN"));
}
