use super::*;
use AgentHarness::*;

fn parent(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

const HOME: &str = "/h";

#[test]
fn inherits_parent_and_strips_denylist() {
    let p = parent(&[
        ("PATH", "/usr/bin"),
        ("FOO", "1"),
        ("CLAUDE_CODE_CHILD_SESSION", "1"),
        ("ANTHROPIC_API_KEY", "k"),
    ]);
    let env = child_env(&ChildEnvInput::new(ClaudeCode), &p, Path::new(HOME)).unwrap();
    assert_eq!(env.get("FOO").map(String::as_str), Some("1"));
    assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
    for k in HARNESS_ENV_DENYLIST {
        assert!(!env.contains_key(k), "{k}");
    }
}

#[test]
fn per_turn_names_are_overwritten_or_removed() {
    let p = parent(&[
        (RUNNER_TURN_ID_ENV, "old-turn"),
        (RUNNER_TURN_CAUSE_ENV, "old-cause"),
        (RUNNER_GATE_FILE_ENV, "/old/gate"),
        (CODEX_HOOK_SPEC_ENV, "old-spec"),
        (RUNNER_TURN_KEY_SHELL_ENV, "old-shell"),
        (RUNNER_TURN_KEY_BRIDGE_ENV, "old-bridge"),
    ]);
    let env = child_env(&ChildEnvInput::new(Codex), &p, Path::new(HOME)).unwrap();
    assert_eq!(env[RUNNER_TURN_ID_ENV], "");
    assert_eq!(env[RUNNER_TURN_CAUSE_ENV], "");
    for k in [
        RUNNER_GATE_FILE_ENV,
        CODEX_HOOK_SPEC_ENV,
        RUNNER_TURN_KEY_SHELL_ENV,
        RUNNER_TURN_KEY_BRIDGE_ENV,
    ] {
        assert!(!env.contains_key(k), "{k}");
    }

    let mut i = ChildEnvInput::new(Codex);
    i.turn_id = Some("t1");
    i.cause_message_id = Some("m1");
    i.gate_file = Some(Path::new("/new/gate"));
    i.codex_hook_spec = Some("spec");
    let env = child_env(&i, &p, Path::new(HOME)).unwrap();
    assert_eq!(env[RUNNER_TURN_ID_ENV], "t1");
    assert_eq!(env[RUNNER_TURN_CAUSE_ENV], "m1");
    assert_eq!(env[RUNNER_GATE_FILE_ENV], "/new/gate");
    assert_eq!(env[CODEX_HOOK_SPEC_ENV], "spec");
}

#[test]
fn lane_turn_builds_from_allow_list() {
    let p = parent(&[
        ("PATH", "/usr/bin"),
        ("GITHUB_TOKEN", "g"),
        ("LC_CTYPE", "x"),
        ("XDG_RUNTIME_DIR", "/r"),
        ("HARKROOM_RUNNER_SECRET", "s"),
    ]);
    let lane = BTreeMap::from([
        ("HARKROOM_LANE_API_KEY".to_owned(), "k".to_owned()),
        ("HARKROOM_LANE_BASE_URL".to_owned(), "https://g".to_owned()),
    ]);
    let mut i = ChildEnvInput::new(Codex);
    i.provider_env = Some(&lane);
    let env = child_env(&i, &p, Path::new(HOME)).unwrap();
    assert!(!env.contains_key("GITHUB_TOKEN"));
    assert!(env.contains_key("LC_CTYPE") && env.contains_key("XDG_RUNTIME_DIR"));
    assert_eq!(env["HARKROOM_LANE_API_KEY"], "k");
    // 주소는 argv 조립에만 쓴다.
    assert!(!env.contains_key("HARKROOM_LANE_BASE_URL"));
    assert_eq!(env["HARKROOM_RUNNER_SECRET"], "s");
}

#[test]
fn lane_rejects_unknown_key_and_names_only_the_key() {
    let lane = BTreeMap::from([("OPENAI_API_KEY".to_owned(), "sk-secret".to_owned())]);
    let mut i = ChildEnvInput::new(ClaudeCode);
    i.provider_env = Some(&lane);
    let err = child_env(&i, &BTreeMap::new(), Path::new(HOME)).unwrap_err();
    assert_eq!(
        err,
        ChildEnvError::LaneKeyNotAllowed {
            harness: ClaudeCode,
            key: "OPENAI_API_KEY".into()
        }
    );
    assert!(!err.to_string().contains("sk-secret"));
    let mut g = ChildEnvInput::new(Gemini);
    g.provider_env = Some(&lane);
    assert!(child_env(&g, &BTreeMap::new(), Path::new(HOME)).is_err());
}

#[test]
fn lane_fixed_env_wins_over_parent() {
    let p = parent(&[("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "0")]);
    let lane = BTreeMap::from([("ANTHROPIC_AUTH_TOKEN".to_owned(), "t".to_owned())]);
    let mut i = ChildEnvInput::new(ClaudeCode);
    i.provider_env = Some(&lane);
    let env = child_env(&i, &p, Path::new(HOME)).unwrap();
    assert_eq!(env["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"], "1");
    // 인증 주입 키는 부모에서는 지워도 lane 이 준 값은 얹힌다.
    assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "t");
}

#[test]
fn opencode_lane_sets_xdg_test_home_and_gh() {
    let lane = BTreeMap::from([("OPENCODE_CONFIG".to_owned(), "/t/turn.json".to_owned())]);
    let mut i = ChildEnvInput::new(Opencode);
    i.provider_env = Some(&lane);
    i.opencode_home = Some(Path::new("/oc"));
    i.gh_config_dir = Some(Path::new("/h/.config/gh"));
    let env = child_env(&i, &BTreeMap::new(), Path::new(HOME)).unwrap();
    assert_eq!(env["XDG_CONFIG_HOME"], "/oc/config");
    assert_eq!(env["XDG_DATA_HOME"], "/oc/data");
    assert_eq!(env["XDG_STATE_HOME"], "/oc/state");
    assert_eq!(env["OPENCODE_TEST_HOME"], "/oc/lane-home");
    assert_eq!(env["OPENCODE_DISABLE_PROJECT_CONFIG"], "1");
    assert_eq!(env[GH_CONFIG_DIR_ENV], "/h/.config/gh");
    assert_eq!(env["PATH"], "/h/.opencode/bin");
}

#[test]
fn pi_and_omp_homes() {
    let p = parent(&[
        ("PI_CODING_AGENT_SESSION_DIR", "/x"),
        ("OMP_PROFILE", "p"),
        ("HOME", "/h"),
        ("PATH", "/usr/bin"),
    ]);
    let mut i = ChildEnvInput::new(Pi);
    i.pi_home = Some(Path::new("/pi"));
    let env = child_env(&i, &p, Path::new(HOME)).unwrap();
    assert_eq!(env["PI_CODING_AGENT_DIR"], "/pi");
    assert!(!env.contains_key("PI_CODING_AGENT_SESSION_DIR"));
    assert_eq!(env["PATH"], "/usr/bin:/h/.pi/agent/bin");

    let mut o = ChildEnvInput::new(Omp);
    o.omp_home = Some(Path::new("/omp"));
    let env = child_env(&o, &p, Path::new(HOME)).unwrap();
    assert_eq!(env["HOME"], "/omp/home");
    assert_eq!(env["PI_CODING_AGENT_DIR"], "/omp/agent");
    assert!(!env.contains_key("OMP_PROFILE"));
    // PATH 뒤 자리는 러너의 홈 기준이다(omp 가 옮긴 HOME 이 아니다).
    assert_eq!(env["PATH"], "/usr/bin:/h/.local/bin");
    o.omp_agent_dir = Some(Path::new("/omp/thread/agent"));
    assert_eq!(
        child_env(&o, &p, Path::new(HOME)).unwrap()["PI_CODING_AGENT_DIR"],
        "/omp/thread/agent"
    );
}

#[test]
fn claude_and_codex_homes_absent_when_none() {
    let env = child_env(
        &ChildEnvInput::new(ClaudeCode),
        &BTreeMap::new(),
        Path::new(HOME),
    )
    .unwrap();
    assert!(!env.contains_key("CLAUDE_CONFIG_DIR") && !env.contains_key("CODEX_HOME"));
    assert!(!env.contains_key("PATH"));
    let mut i = ChildEnvInput::new(ClaudeCode);
    i.claude_config_dir = Some(Path::new("/acct"));
    assert_eq!(
        child_env(&i, &BTreeMap::new(), Path::new(HOME)).unwrap()["CLAUDE_CONFIG_DIR"],
        "/acct"
    );
    let mut c = ChildEnvInput::new(Codex);
    c.codex_home = Some(Path::new("/cx"));
    assert_eq!(
        child_env(&c, &BTreeMap::new(), Path::new(HOME)).unwrap()["CODEX_HOME"],
        "/cx"
    );
}

#[test]
fn turn_keys_by_delivery() {
    let p = parent(&[(RUNNER_LINK_SECRET_ENV, "s")]);
    let keys = TurnKeys {
        shell: "sh".into(),
        bridge: "br".into(),
    };
    let mut c = ChildEnvInput::new(Codex);
    c.turn_keys = Some(&keys);
    let env = child_env(&c, &p, Path::new(HOME)).unwrap();
    assert!(!env.contains_key(RUNNER_LINK_SECRET_ENV));
    assert_eq!(env[RUNNER_TURN_KEY_SHELL_ENV], "sh");
    assert_eq!(env[RUNNER_TURN_KEY_BRIDGE_ENV], "br");

    let mut cl = ChildEnvInput::new(ClaudeCode);
    cl.turn_keys = Some(&keys);
    let env = child_env(&cl, &p, Path::new(HOME)).unwrap();
    assert!(!env.contains_key(RUNNER_TURN_KEY_BRIDGE_ENV));

    let mut oc = ChildEnvInput::new(Opencode);
    oc.turn_keys = Some(&keys);
    oc.opencode_turn_config = Some(Path::new("/t/oc.json"));
    let env = child_env(&oc, &p, Path::new(HOME)).unwrap();
    assert_eq!(env["OPENCODE_CONFIG"], "/t/oc.json");
    assert!(!env.contains_key(RUNNER_TURN_KEY_BRIDGE_ENV));

    // 열쇠가 없는 턴은 링크 secret 을 그대로 둔다.
    let env = child_env(&ChildEnvInput::new(Codex), &p, Path::new(HOME)).unwrap();
    assert_eq!(env[RUNNER_LINK_SECRET_ENV], "s");
}

#[test]
fn gh_config_dir_rules() {
    let h = Path::new(HOME);
    let r = |s: &str| vec![s.to_owned()];
    assert_eq!(
        lane_gh_config_dir(Opencode, true, &r("Bash(gh pr view:*)"), None, h),
        Some(PathBuf::from("/h/.config/gh"))
    );
    assert_eq!(
        lane_gh_config_dir(Opencode, true, &r("Bash(gh:*)"), Some("/x"), h),
        Some(PathBuf::from("/x/gh"))
    );
    assert_eq!(
        lane_gh_config_dir(Opencode, true, &r("Bash(gh)"), Some("rel"), h),
        Some(PathBuf::from("/h/.config/gh"))
    );
    assert_eq!(
        lane_gh_config_dir(Opencode, true, &r("Bash(ghx:*)"), None, h),
        None
    );
    assert_eq!(
        lane_gh_config_dir(Opencode, true, &r("Bash(gh:*) x"), None, h),
        None
    );
    assert_eq!(
        lane_gh_config_dir(Opencode, false, &r("Bash(gh:*)"), None, h),
        None
    );
    assert_eq!(
        lane_gh_config_dir(Kilo, true, &r("Bash(gh:*)"), None, h),
        None
    );
}

#[test]
fn harness_path_appends_after() {
    let h = Path::new(HOME);
    assert_eq!(harness_path(ClaudeCode, Some("/a"), h), "/a");
    assert_eq!(harness_path(ClaudeCode, None, h), "");
    assert_eq!(harness_path(Kilo, Some("/a"), h), "/a:/h/.kilo/bin");
    assert_eq!(harness_path(Kilo, None, h), "/h/.kilo/bin");
}
