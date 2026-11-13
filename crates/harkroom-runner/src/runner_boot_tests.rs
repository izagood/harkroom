//! [`agent_state_dir`]·[`maker_config`] — 에이전트마다 뿌리가 따로이고, 짓개 설정의 자식 env 에 링크 열쇠·셸 토큰이 없는지.
use super::*;
use crate::config::load_config;
use crate::workspace::resolve_workspace_dir;

fn env(state: &Path) -> Env {
    [
        ("HOME", "/home/u"),
        ("PATH", "/usr/bin"),
        ("HARKROOM_OPERATOR_SOCKET", "/tmp/op.sock"),
        ("HARKROOM_RUNNER_ID", "r1"),
        ("HARKROOM_RUNNER_SECRET", "link-secret-value"),
        ("HARKROOM_OPERATOR_BIN", "/bin/op"),
        ("HARKROOM_MCP_CONFIG", "/tmp/mcp.json"),
        ("GITHUB_TOKEN", "ghp-shell-token"),
        ("HARKROOM_STATE_DIR", state.to_str().unwrap()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

fn root(tag: &str) -> PathBuf {
    let r = std::env::temp_dir().join(format!("hk-boot-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&r);
    std::fs::create_dir_all(&r).unwrap();
    r
}

/// security #2098: 작업 폴더 뿌리는 에이전트마다 따로 — 두 에이전트가 같은 스레드를 맡아도 뿌리와 폴더가 다르다. 한 에이전트의
/// 옛 이름 찾기가 다른 에이전트의 폴더를 집지 않는다.
#[test]
fn two_agents_on_one_thread_get_separate_roots_and_dirs() {
    let base = root("agents");
    let s1 = agent_state_dir(&base, "agent-1", None, &[]);
    let s2 = agent_state_dir(&base, "agent-2", None, &[]);
    let (w1, w2) = (workspace_base_dir(&s1), workspace_base_dir(&s2));
    assert_ne!(w1, w2);
    let never =
        |_c: &str, _a: &[&str], _d: &Path| -> std::io::Result<(i32, String)> { unreachable!() };
    let d1 = resolve_workspace_dir(&w1, "agent-1", "c/t", None, &never).unwrap();
    let d2 = resolve_workspace_dir(&w2, "agent-2", "c/t", None, &never).unwrap();
    assert_ne!(d1, d2);
    assert!(d1.starts_with(&w1) && d2.starts_with(&w2));
    // agent-1 의 폴더가 먼저 있어도 agent-2 는 그것을 집지 않는다(뿌리가 다르다).
    assert_eq!(
        resolve_workspace_dir(&w2, "agent-2", "c/t", None, &never).unwrap(),
        d2
    );
    let _ = std::fs::remove_dir_all(&base);
}

/// 정본 `resolveAgentStateDir`: id 폴더, 옛 `<handle>-<id>` 채택, 예약 이름은 안 고름, 인스턴스는 그 아래.
#[test]
fn agent_state_dir_follows_the_canonical_rules() {
    let b = Path::new("/s");
    assert_eq!(agent_state_dir(b, "id1", None, &[]), b.join("id1"));
    assert_eq!(
        agent_state_dir(b, "id1", None, &["old-id1".into()]),
        b.join("old-id1")
    );
    assert_eq!(
        agent_state_dir(b, "c", None, &["c".into()]),
        b.join("c"),
        "예약 이름은 채택하지 않는다(새로 짓는다)"
    );
    assert_eq!(agent_state_dir(b, "id1", Some("i2"), &[]), b.join("id1/i2"));
}

/// 짓개 설정: 자식 env 는 허용 목록만(링크 열쇠·셸 토큰 없음), 상태·작업 폴더 뿌리는 그 에이전트 것, 가림 바늘은 링크 열쇠.
#[test]
fn maker_config_wires_the_allow_list_and_agent_dirs() {
    let base = root("cfg");
    let e = env(&base);
    let cfg = load_config(&e).unwrap();
    let agent = agent_state_dir(&base, "agent-1", None, &[]);
    let m = maker_config(
        &cfg,
        &e,
        BootFacts {
            harness: AgentHarness::ClaudeCode,
            me_id: "agent-1",
            claim_holder: "holder",
            agent_state: agent.clone(),
            home: PathBuf::from("/home/u"),
        },
    );
    assert_eq!(m.state_dir, agent);
    assert_eq!(m.workspace_base_dir, agent.join("workspaces"));
    assert!(!m.parent_env.contains_key("HARKROOM_RUNNER_SECRET"));
    assert!(!m.parent_env.contains_key("GITHUB_TOKEN"));
    assert!(
        !m.parent_env
            .values()
            .any(|v| v == "link-secret-value" || v == "ghp-shell-token")
    );
    assert_eq!(
        m.parent_env.get("PATH").map(String::as_str),
        Some("/usr/bin")
    );
    assert_eq!(m.pat, "link-secret-value", "가림 바늘");
    let _ = std::fs::remove_dir_all(&base);
}
