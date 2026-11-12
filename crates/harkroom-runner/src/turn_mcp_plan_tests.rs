//! 정본 `mentionTurn.ts` 1571~1606·1681~1701 의 조립 판정. 정본 시험은 mentionTurn 통째 시험에 섞여 있어 판정마다 따로 세웠다.

use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

use super::*;
use crate::opencode_home::{OPENCODE_APP, lane_opencode_bash_table};
use crate::turn_env::RUNNER_TURN_KEY_BRIDGE_ENV;

const CH: &str = "0b9c2a6e-1d2f-4c3b-8a7e-5f6d4c3b2a10";

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "hk-turn-mcp-plan-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// 오퍼레이터가 쓴 기본 MCP 설정(stdio harkroom 항목).
fn source(dir: &TempDir) -> PathBuf {
    let p = dir.path().join("mcp.json");
    fs::write(
        &p,
        json!({ "mcpServers": { "harkroom": { "command": "/bin/harkroom-operator", "args": ["mcp"], "env": { "A": "1" } } } })
            .to_string(),
    )
    .unwrap();
    p
}

fn runner_env() -> BTreeMap<String, String> {
    BTreeMap::from([("HARKROOM_RUNNER_SECRET".into(), "sec-1".into())])
}

fn read(p: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
}

fn input<'a>(
    harness: AgentHarness,
    can_register: bool,
    provider_env: Option<&'a BTreeMap<String, String>>,
    dir: &'a TempDir,
    src: &'a Path,
    env: &'a BTreeMap<String, String>,
) -> TurnMcpInput<'a> {
    TurnMcpInput {
        harness,
        can_register_turn_keys: can_register,
        provider_env,
        state_dir: dir.path(),
        mcp_config_path: src,
        turn_id: "turn-1",
        runner_env: env,
    }
}

// ── turn_mcp_plan ──

#[test]
fn claude_turn_key_goes_to_its_own_mcp_config() {
    let dir = TempDir::new("claude");
    let src = source(&dir);
    let env = runner_env();
    let plan = turn_mcp_plan(&input(
        AgentHarness::ClaudeCode,
        true,
        None,
        &dir,
        &src,
        &env,
    ))
    .unwrap();
    let keys = plan.turn_keys.as_ref().expect("열쇠를 낸다");
    assert_eq!(
        plan.mcp_config_path,
        dir.path().join("turn-mcp").join("turn-1.json")
    );
    let doc = read(&plan.mcp_config_path);
    let h = &doc["mcpServers"]["harkroom"];
    assert_eq!(h["env"][RUNNER_TURN_KEY_BRIDGE_ENV], json!(keys.bridge));
    assert_eq!(h["env"]["A"], json!("1"), "있던 env 칸은 지킨다");
    assert!(
        h.get("alwaysLoad").is_none(),
        "lane 이 아니면 alwaysLoad 를 달지 않는다"
    );
    assert!(plan.opencode_turn_config.is_none() && plan.owned_turn_config.is_none());
}

#[test]
fn claude_lane_turn_key_config_sets_always_load() {
    let dir = TempDir::new("claude-lane");
    let src = source(&dir);
    let env = runner_env();
    let lane = BTreeMap::from([("ANTHROPIC_BASE_URL".into(), "https://gw".into())]);
    let plan = turn_mcp_plan(&input(
        AgentHarness::ClaudeCode,
        true,
        Some(&lane),
        &dir,
        &src,
        &env,
    ))
    .unwrap();
    assert_eq!(
        read(&plan.mcp_config_path)["mcpServers"]["harkroom"]["alwaysLoad"],
        json!(true)
    );
}

#[test]
fn lane_turn_without_turn_keys_uses_lane_mcp_config() {
    let dir = TempDir::new("lane-nokey");
    let src = source(&dir);
    let env = runner_env();
    let lane = BTreeMap::from([("ANTHROPIC_BASE_URL".into(), "https://gw".into())]);
    let plan = turn_mcp_plan(&input(
        AgentHarness::ClaudeCode,
        false,
        Some(&lane),
        &dir,
        &src,
        &env,
    ))
    .unwrap();
    assert!(plan.turn_keys.is_none());
    assert_eq!(plan.mcp_config_path, dir.path().join("lane-mcp.json"));
    let h = &read(&plan.mcp_config_path)["mcpServers"]["harkroom"];
    assert_eq!(h["env"]["HARKROOM_RUNNER_SECRET"], json!("sec-1"));
    assert!(h["env"].get(RUNNER_TURN_KEY_BRIDGE_ENV).is_none());
}

#[test]
fn no_register_path_no_lane_keeps_default_and_writes_nothing() {
    let dir = TempDir::new("plain");
    let src = source(&dir);
    let env = runner_env();
    let plan = turn_mcp_plan(&input(
        AgentHarness::ClaudeCode,
        false,
        None,
        &dir,
        &src,
        &env,
    ))
    .unwrap();
    assert!(plan.turn_keys.is_none());
    assert_eq!(plan.mcp_config_path, src);
    assert!(!dir.path().join("turn-mcp").exists());
    assert!(!dir.path().join("lane-mcp.json").exists());
}

#[test]
fn codex_env_var_delivery_issues_keys_without_config_file() {
    let dir = TempDir::new("codex");
    let src = source(&dir);
    let env = runner_env();
    let plan = turn_mcp_plan(&input(AgentHarness::Codex, true, None, &dir, &src, &env)).unwrap();
    assert!(
        plan.turn_keys.is_some(),
        "env 로 넘기는 하네스도 열쇠는 낸다"
    );
    assert_eq!(plan.mcp_config_path, src);
    assert!(plan.opencode_turn_config.is_none());
    assert!(!dir.path().join("turn-mcp").exists());
}

#[test]
fn harness_without_delivery_gets_no_keys() {
    let dir = TempDir::new("kilo");
    let src = source(&dir);
    let env = runner_env();
    for h in [AgentHarness::Kilo, AgentHarness::Pi, AgentHarness::Omp] {
        let plan = turn_mcp_plan(&input(h, true, None, &dir, &src, &env)).unwrap();
        assert!(plan.turn_keys.is_none(), "{h:?}");
        assert_eq!(plan.mcp_config_path, src);
    }
}

#[test]
fn opencode_turn_config_is_owned_when_not_lane() {
    let dir = TempDir::new("oc");
    let src = source(&dir);
    let env = runner_env();
    let plan = turn_mcp_plan(&input(AgentHarness::Opencode, true, None, &dir, &src, &env)).unwrap();
    let keys = plan.turn_keys.as_ref().unwrap();
    let file = plan.opencode_turn_config.clone().expect("턴 설정을 쓴다");
    assert_eq!(
        plan.owned_turn_config.as_ref(),
        Some(&file),
        "새로 만든 파일은 이 턴이 치운다"
    );
    let doc = read(&file);
    assert_eq!(
        doc["mcp"]["harkroom"]["environment"][RUNNER_TURN_KEY_BRIDGE_ENV],
        json!(keys.bridge)
    );
    assert_eq!(plan.mcp_config_path, src);
}

#[test]
fn opencode_lane_turn_config_is_lane_file_and_not_owned() {
    let dir = TempDir::new("oc-lane");
    let src = source(&dir);
    let env = runner_env();
    let lane_file = dir.path().join("lane-turn.json");
    fs::write(
        &lane_file,
        json!({ "model": "harkroom-lane/m" }).to_string(),
    )
    .unwrap();
    let lane = BTreeMap::from([("OPENCODE_CONFIG".into(), lane_file.display().to_string())]);
    let plan = turn_mcp_plan(&input(
        AgentHarness::Opencode,
        true,
        Some(&lane),
        &dir,
        &src,
        &env,
    ))
    .unwrap();
    assert_eq!(plan.opencode_turn_config.as_ref(), Some(&lane_file));
    assert!(
        plan.owned_turn_config.is_none(),
        "lane 턴 파일은 lane 이 치운다"
    );
    let doc = read(&lane_file);
    assert_eq!(
        doc["model"],
        json!("harkroom-lane/m"),
        "lane 턴 파일 칸은 지킨다"
    );
    assert!(doc["mcp"]["harkroom"]["environment"][RUNNER_TURN_KEY_BRIDGE_ENV].is_string());
}

#[test]
fn bad_turn_id_fails_before_writing() {
    let dir = TempDir::new("badid");
    let src = source(&dir);
    let env = runner_env();
    let mut i = input(AgentHarness::ClaudeCode, true, None, &dir, &src, &env);
    i.turn_id = "../x";
    assert!(matches!(
        turn_mcp_plan(&i),
        Err(LaneFileError::BadName { .. })
    ));
    assert!(!dir.path().join("x.json").exists());
}

#[test]
fn plan_debug_redacts_turn_keys() {
    let dir = TempDir::new("dbg");
    let src = source(&dir);
    let env = runner_env();
    let plan = turn_mcp_plan(&input(
        AgentHarness::ClaudeCode,
        true,
        None,
        &dir,
        &src,
        &env,
    ))
    .unwrap();
    let keys = plan.turn_keys.as_ref().unwrap();
    let dbg = format!("{plan:?}");
    assert!(!dbg.contains(&keys.bridge) && !dbg.contains(&keys.shell));
}

// ── opencode lane 에이전트 ──

#[test]
fn lane_agent_only_for_xdg_auto_lane_turns() {
    use MentionPermission::{Auto, Readonly};
    let want = Some(format!("harkroom-lane-{CH}"));
    assert_eq!(
        opencode_lane_agent_for(true, AgentHarness::Opencode, Auto, CH),
        want
    );
    assert_eq!(
        opencode_lane_agent_for(true, AgentHarness::Kilo, Auto, CH),
        want
    );
    assert_eq!(
        opencode_lane_agent_for(true, AgentHarness::Opencode, Readonly, CH),
        None
    );
    assert_eq!(
        opencode_lane_agent_for(false, AgentHarness::Opencode, Auto, CH),
        None
    );
    assert_eq!(
        opencode_lane_agent_for(true, AgentHarness::ClaudeCode, Auto, CH),
        None
    );
    assert_eq!(
        opencode_lane_agent_for(true, AgentHarness::Opencode, Auto, "../x"),
        None
    );
}

fn write_oc_config(home: &Path, bash: Value, mode: &str) {
    let file = opencode_config_file(home, &OPENCODE_APP);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    let doc = json!({ "agent": { format!("harkroom-lane-{CH}"): { "mode": mode, "permission": { "bash": bash } } } });
    fs::write(file, doc.to_string()).unwrap();
}

#[test]
fn lane_agent_verified_when_table_matches() {
    let dir = TempDir::new("oc-ok");
    let rules = ["Bash(git status)", "Bash(ls:*)"];
    write_oc_config(
        dir.path(),
        Value::Object(lane_opencode_bash_table(&rules)),
        "primary",
    );
    assert!(opencode_lane_agent_verified(dir.path(), CH, &rules, &OPENCODE_APP).is_ok());
}

#[test]
fn lane_agent_mismatch_or_missing_is_lane_setup() {
    let dir = TempDir::new("oc-bad");
    let lane_setup = Err(ProviderLaneError::new("lane_setup"));
    // 파일이 없다.
    assert_eq!(
        opencode_lane_agent_verified(dir.path(), CH, &["Bash(git status)"], &OPENCODE_APP),
        lane_setup
    );
    // 규칙을 거뒀는데 칸이 옛 규칙을 들고 있다.
    let old = ["Bash(git status)", "Bash(rm x)"];
    write_oc_config(
        dir.path(),
        Value::Object(lane_opencode_bash_table(&old)),
        "primary",
    );
    assert_eq!(
        opencode_lane_agent_verified(dir.path(), CH, &["Bash(git status)"], &OPENCODE_APP),
        lane_setup
    );
    // primary 가 아니다.
    let now = ["Bash(git status)"];
    write_oc_config(
        dir.path(),
        Value::Object(lane_opencode_bash_table(&now)),
        "subagent",
    );
    assert_eq!(
        opencode_lane_agent_verified(dir.path(), CH, &now, &OPENCODE_APP),
        lane_setup
    );
    // 해석할 수 없는 본문.
    fs::write(
        opencode_config_file(dir.path(), &OPENCODE_APP),
        "{ not json",
    )
    .unwrap();
    assert_eq!(
        opencode_lane_agent_verified(dir.path(), CH, &now, &OPENCODE_APP),
        lane_setup
    );
}

// ── 읽기 전용 도구 목록 ──

fn never(_: &[&'static str]) -> Option<BTreeMap<String, Vec<String>>> {
    panic!("묻지 않아야 한다")
}

#[test]
fn readonly_tools_none_for_auto_or_other_harness() {
    assert_eq!(
        turn_readonly_tools("k", AgentHarness::Pi, MentionPermission::Auto, never),
        None
    );
    assert_eq!(
        turn_readonly_tools(
            "k",
            AgentHarness::ClaudeCode,
            MentionPermission::Readonly,
            never
        ),
        None
    );
}

#[test]
fn omp_readonly_uses_glob_without_asking() {
    let got =
        turn_readonly_tools("k", AgentHarness::Omp, MentionPermission::Readonly, never).unwrap();
    assert_eq!(
        got,
        omp_readonly_tool_list(&readonly_tools_for(AgentHarness::Omp).unwrap())
    );
}

#[test]
fn pi_readonly_lists_discovered_tools() {
    let asked = Cell::new(false);
    let got = turn_readonly_tools("k", AgentHarness::Pi, MentionPermission::Readonly, |args| {
        asked.set(true);
        assert_eq!(args, ["mcp", "list", "--json"]);
        Some(BTreeMap::from([(
            "harkroom".into(),
            vec!["message.post".into(), "memory.get".into()],
        )]))
    })
    .unwrap();
    assert!(asked.get());
    assert_eq!(
        got,
        "read,grep,find,ls,mcp__harkroom__message_post,mcp__harkroom__memory_get"
    );
}

#[test]
fn pi_readonly_falls_back_to_builtins_when_discovery_fails_or_empty() {
    let none =
        turn_readonly_tools("k", AgentHarness::Pi, MentionPermission::Readonly, |_| None).unwrap();
    assert_eq!(none, "read,grep,find,ls");
    let empty = turn_readonly_tools("k", AgentHarness::Pi, MentionPermission::Readonly, |_| {
        Some(BTreeMap::from([("harkroom".into(), vec![])]))
    })
    .unwrap();
    assert_eq!(empty, "read,grep,find,ls");
    let other = turn_readonly_tools("k", AgentHarness::Pi, MentionPermission::Readonly, |_| {
        Some(BTreeMap::from([("avcs".into(), vec!["x".into()])]))
    })
    .unwrap();
    assert_eq!(other, "read,grep,find,ls", "다른 서버 도구는 열지 않는다");
}
