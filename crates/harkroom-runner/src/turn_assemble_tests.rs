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

#[derive(Default)]
struct Rec {
    injected: u32,
    output: Vec<u8>,
    gates: Vec<String>,
}

impl PromptHooks for Rec {
    fn gate_signal(&mut self) -> u64 {
        7
    }
    fn wait_for_ready(&mut self) -> bool {
        false
    }
}

impl PtyTurnSink for Rec {
    fn on_output(&mut self, frame: &[u8]) {
        self.output.extend_from_slice(frame);
    }
    fn on_injected(&mut self) {
        self.injected += 1;
    }
    fn on_turn_gate(&mut self, screen: &str) {
        self.gates.push(screen.into());
    }
}

/// 주입 순간에만 `delivered` 가 선다(정본 `onInjected → onPromptDelivered`) · 나머지 갈래는 안쪽 sink 로 그대로 간다.
#[test]
fn delivered_sink_sets_flag_on_injection_and_forwards() {
    let mut inner = Rec::default();
    let mut delivered = false;
    {
        let mut s = DeliveredSink {
            inner: &mut inner,
            delivered: &mut delivered,
        };
        s.on_output(b"ready");
        s.on_turn_gate("gate");
        assert_eq!(s.gate_signal(), 7);
        assert!(!s.wait_for_ready());
        assert!(!*s.delivered, "출력·관문만으로는 서지 않는다");
        s.on_injected();
    }
    assert!(delivered);
    assert_eq!(inner.injected, 1);
    assert_eq!(inner.output, b"ready");
    assert_eq!(inner.gates, ["gate"]);
}

/// 명령 조립 실패는 띄우지 않고 종류만 담은 `Spawn` 오류다.
#[test]
fn spawn_pty_turn_folds_command_error() {
    let t = tmp("spawnerr");
    let env = BTreeMap::new();
    let mut base = TurnCommandOptions::new(
        AgentHarness::ClaudeCode,
        TurnMode::Mention,
        MentionPermission::Auto,
        "/bin/harkroom-operator",
    );
    base.session_id = None;
    let mut sink = Rec::default();
    let r = spawn_pty_turn(
        &base,
        PtyTurnArgs {
            lane_env: &LaneEnv::new(),
            keys: None,
            mcp_config_path: "/m.json",
            parent_env: &env,
            home: &t.0,
        },
        PtyTurnOptions::at(std::env::temp_dir()),
        &mut sink,
    );
    match r {
        Err(PtyTurnError::Spawn(e)) => assert!(e.to_string().starts_with("명령 조립 실패")),
        other => panic!("{other:?}"),
    }
    assert_eq!(sink.injected, 0);
}

/// lane 턴의 자식 env 전체(⑦, L3c-3d2): 부모 env 는 lane 허용 목록만 남고(ssh 소켓·codex 홈·부모의 키 같은 것은 빠진다),
/// claude 고정 env(하위 프로세스 env 걷기)가 서고, claude 폴더는 그 시도의 lane 전용 폴더다. 같은 부모로 lane 아닌 턴은
/// 부모 값을 그대로 물려받고 고정 env 가 없다 — 둘의 차이가 lane 여부에서만 온다.
#[test]
fn lane_turn_child_env_is_lane_allow_list_plus_lane_dir() {
    let mut base = TurnCommandOptions::new(
        AgentHarness::ClaudeCode,
        TurnMode::Mention,
        MentionPermission::Auto,
        "/op",
    );
    base.session_id = Some("11111111-2222-4333-8444-555555555555");
    let lane_dir = Path::new("/state/claude-provider-lane");
    base.claude_config_dir = Some(lane_dir);
    let lane: LaneEnv = [
        (
            "ANTHROPIC_BASE_URL".to_string(),
            "https://gw.example".to_string(),
        ),
        (
            "ANTHROPIC_AUTH_TOKEN".to_string(),
            "tok-lane-88".to_string(),
        ),
    ]
    .into();
    let parent: BTreeMap<String, String> = [
        ("PATH", "/usr/bin"),
        ("HOME", "/h"),
        ("SSH_AUTH_SOCK", "/tmp/ssh.sock"),
        ("CODEX_HOME", "/h/.codex"),
        ("ANTHROPIC_API_KEY", "parent-key-88"),
        ("CLAUDE_CONFIG_DIR", "/h/.claude"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    for k in ["SSH_AUTH_SOCK", "CODEX_HOME"] {
        assert!(
            !crate::turn_env::lane_env_allowed(k),
            "{k} 가 lane 허용 목록에 들어갔다"
        );
    }
    let env_of = |lane: &LaneEnv| -> BTreeMap<String, String> {
        pty_turn_plan(&base, lane, None, "/m.json", &parent, Path::new("/h"))
            .unwrap()
            .env
            .into_iter()
            .collect()
    };

    let on = env_of(&lane);
    assert_eq!(
        on.get("ANTHROPIC_AUTH_TOKEN").map(String::as_str),
        Some("tok-lane-88")
    );
    assert_eq!(
        on.get("ANTHROPIC_BASE_URL").map(String::as_str),
        Some("https://gw.example")
    );
    assert_eq!(
        on.get("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB")
            .map(String::as_str),
        Some("1")
    );
    assert_eq!(
        on.get("CLAUDE_CONFIG_DIR").map(String::as_str),
        Some("/state/claude-provider-lane"),
        "기본 로그인 폴더가 lane 턴에 남았다"
    );
    for k in ["SSH_AUTH_SOCK", "CODEX_HOME", "ANTHROPIC_API_KEY"] {
        assert!(!on.contains_key(k), "lane 턴에 부모 {k}");
    }
    assert!(on.values().all(|v| v != "parent-key-88"));
    assert_eq!(on.get("PATH").map(String::as_str), Some("/usr/bin"));

    let off = env_of(&LaneEnv::new());
    assert_eq!(
        off.get("SSH_AUTH_SOCK").map(String::as_str),
        Some("/tmp/ssh.sock")
    );
    assert!(!off.contains_key("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"));
    assert!(!off.contains_key("ANTHROPIC_AUTH_TOKEN"));
}
