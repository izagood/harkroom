use super::*;
use AgentHarness::*;
use MentionPermission::*;

fn env0() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("PATH".to_string(), "/usr/bin".to_string()),
        ("ANTHROPIC_API_KEY".to_string(), "x".to_string()),
    ])
}

fn build(o: &TurnCommandOptions<'_>) -> Result<TurnPlan, TurnCommandError> {
    build_turn_command(o, &env0(), Path::new("/h"))
}

fn pos(args: &[String], x: &str) -> usize {
    args.iter()
        .position(|a| a == x)
        .unwrap_or_else(|| panic!("{x} 없음: {args:?}"))
}

#[test]
fn claude_mention_auto_order() {
    let mut o = TurnCommandOptions::new(ClaudeCode, TurnMode::Mention, Auto, "/op");
    o.session_id = Some("sid");
    o.mcp_config_path = "/m.json";
    o.model = Some("opus");
    o.effort = Some("high");
    o.system_prompt = "지시";
    o.system_prompt_file = Some("/sp");
    o.claude_config_dir = Some(Path::new("/cc"));
    let p = build(&o).unwrap();
    assert_eq!(p.command, "claude");
    let a = &p.args;
    assert_eq!(
        &a[..4],
        ["--session-id", "sid", "--permission-mode", "auto"]
    );
    // 세션 → 권한 → 규칙 → chrome → MCP → 모델 → effort → 지시문
    let order = [
        pos(a, "--permission-mode"),
        pos(a, "--disallowedTools"),
        pos(a, "--no-chrome"),
        pos(a, "--mcp-config"),
        pos(a, "--model"),
        pos(a, "--effort"),
        pos(a, "--append-system-prompt-file"),
    ];
    assert!(order.windows(2).all(|w| w[0] < w[1]), "{a:?}");
    assert!(
        !a.iter().any(|x| x == "지시"),
        "지시문 본문이 argv 에 올랐다"
    );
    // 인증 주입 키는 벗긴다.
    assert!(!p.env.contains_key("ANTHROPIC_API_KEY"));
    assert_eq!(p.cwd, None);
}

#[test]
fn claude_resume_and_interactive_has_no_permission() {
    let mut o = TurnCommandOptions::new(ClaudeCode, TurnMode::Interactive, Auto, "/op");
    o.session_id = Some("sid");
    o.is_first_turn = false;
    let a = build(&o).unwrap().args;
    assert_eq!(&a[..2], ["-r", "sid"]);
    assert!(
        !a.iter()
            .any(|x| x == "--permission-mode" || x == "--disallowedTools")
    );
}

#[test]
fn claude_needs_session_and_operator() {
    let o = TurnCommandOptions::new(ClaudeCode, TurnMode::Mention, Auto, "/op");
    assert!(matches!(build(&o), Err(TurnCommandError::Check(_))));
    let mut o = TurnCommandOptions::new(ClaudeCode, TurnMode::Mention, Auto, "");
    o.session_id = Some("sid");
    assert_eq!(build(&o), Err(TurnCommandError::EmptyOperatorBin));
}

#[test]
fn claude_lane_auto_is_dont_ask() {
    let lane = BTreeMap::new();
    let mut o = TurnCommandOptions::new(ClaudeCode, TurnMode::Mention, Auto, "/op");
    o.session_id = Some("sid");
    o.provider_env = Some(&lane);
    let a = build(&o).unwrap().args;
    assert_eq!(a[pos(&a, "--permission-mode") + 1], "dontAsk");
}

#[test]
fn pi_and_omp_readonly_always_get_tools_list() {
    // security(#1943): pi·omp 는 프리셋에 권한 조각이 없다 — 읽기 전용 `--tools` 가 조립에서 빠지면 안 된다.
    for h in [Pi, Omp] {
        let mut o = TurnCommandOptions::new(h, TurnMode::Mention, Readonly, "/op");
        o.session_id = Some("sid");
        o.pi_home = Some(Path::new("/pi"));
        o.omp_home = Some(Path::new("/omp"));
        o.omp_thread = Some(OmpThread {
            cwd: Path::new("/omp/cwd/t"),
            agent_dir: Path::new("/omp/agent"),
        });
        o.workspace_dir = Some(Path::new("/ws"));
        assert_eq!(build(&o), Err(TurnCommandError::ReadonlyToolListMissing(h)));
        o.readonly_tool_list = Some("read,grep");
        let a = build(&o).unwrap().args;
        assert_eq!(a[pos(&a, "--tools") + 1], "read,grep", "{h:?}");
        // auto 턴에는 목록을 붙이지 않는다.
        o.mention_permission = Auto;
        assert!(!build(&o).unwrap().args.iter().any(|x| x == "--tools"));
    }
}

#[test]
fn pi_session_dir_pinned_and_lane_no_context_files() {
    let lane = BTreeMap::new();
    let mut o = TurnCommandOptions::new(Pi, TurnMode::Mention, Auto, "/op");
    o.session_id = Some("sid");
    o.pi_home = Some(Path::new("/pi"));
    let a = build(&o).unwrap().args;
    assert_eq!(a[pos(&a, "--session-dir") + 1], "/pi/sessions");
    assert!(!a.iter().any(|x| x == "--no-context-files"));
    o.provider_env = Some(&lane);
    assert!(
        build(&o)
            .unwrap()
            .args
            .iter()
            .any(|x| x == "--no-context-files")
    );
    o.pi_home = None;
    assert!(matches!(
        build(&o),
        Err(TurnCommandError::MissingHome { .. })
    ));
}

#[test]
fn omp_pins_dirs_and_refuses_cwd_inside_workspace() {
    let mut o = TurnCommandOptions::new(Omp, TurnMode::Mention, Auto, "/op");
    o.session_id = Some("sid");
    o.omp_home = Some(Path::new("/omp"));
    o.omp_thread = Some(OmpThread {
        cwd: Path::new("/omp/cwd/t"),
        agent_dir: Path::new("/omp/agent"),
    });
    o.workspace_dir = Some(Path::new("/ws"));
    let p = build(&o).unwrap();
    let a = &p.args;
    assert_eq!(a[pos(a, "--config") + 1], "/omp/overlay.yml");
    assert_eq!(a[pos(a, "--add-dir") + 1], "/ws");
    assert_eq!(p.cwd.as_deref(), Some(Path::new("/omp/cwd/t")));
    for cwd in ["/ws", "/ws/sub"] {
        o.omp_thread = Some(OmpThread {
            cwd: Path::new(cwd),
            agent_dir: Path::new("/omp/agent"),
        });
        assert_eq!(
            build(&o),
            Err(TurnCommandError::OmpCwdInsideWorkspace),
            "{cwd}"
        );
    }
    // 이름만 겹치는 형제 폴더는 안이 아니다.
    o.omp_thread = Some(OmpThread {
        cwd: Path::new("/ws2"),
        agent_dir: Path::new("/omp/agent"),
    });
    assert!(build(&o).is_ok());
    o.workspace_dir = None;
    assert!(matches!(
        build(&o),
        Err(TurnCommandError::MissingHome { .. })
    ));
}

#[test]
fn codex_exec_first_turn_and_home_required() {
    let mut o = TurnCommandOptions::new(Codex, TurnMode::Mention, Auto, "/op");
    assert!(matches!(
        build(&o),
        Err(TurnCommandError::MissingHome { .. })
    ));
    o.codex_home = Some(Path::new("/cx"));
    let p = build(&o).unwrap();
    assert_eq!(p.command, "codex");
    assert!(
        p.args
            .iter()
            .any(|x| x == "sandbox_mode=\"workspace-write\"")
    );
    assert!(
        p.args
            .iter()
            .any(|x| x.starts_with("mcp_servers.harkroom.command="))
    );
    let lane = BTreeMap::new();
    o.provider_env = Some(&lane);
    assert_eq!(build(&o), Err(TurnCommandError::CodexLanePending));
}

#[test]
fn opencode_lane_agent_and_readonly() {
    let lane = BTreeMap::new();
    let mut o = TurnCommandOptions::new(Kilo, TurnMode::Mention, Auto, "/op");
    o.opencode_home = Some(Path::new("/oc"));
    let p = build(&o).unwrap();
    assert_eq!(p.command, "kilo");
    assert_eq!(p.args, ["--auto"]);
    o.provider_env = Some(&lane);
    o.lane_agent = Some("lane-c1");
    assert_eq!(build(&o).unwrap().args, ["--agent", "lane-c1"]);
    o.lane_agent = None;
    let a = build(&o).unwrap().args;
    assert!(
        !a.iter().any(|x| x == "--auto"),
        "lane auto 에 --auto 가 붙었다"
    );
    o.mention_permission = Readonly;
    let a = build(&o).unwrap().args;
    assert!(!a.iter().any(|x| x == "--auto"));
    o.opencode_home = None;
    assert!(matches!(
        build(&o),
        Err(TurnCommandError::MissingHome { .. })
    ));
}

#[test]
fn turn_keys_need_a_delivery_path() {
    let keys = TurnKeys {
        shell: "s".into(),
        bridge: "b".into(),
    };
    let mut o = TurnCommandOptions::new(Opencode, TurnMode::Mention, Auto, "/op");
    o.opencode_home = Some(Path::new("/oc"));
    o.turn_keys = Some(&keys);
    if turn_key_delivery_of(Opencode) == Some(TurnKeyDelivery::TurnConfigEnv) {
        assert_eq!(
            build(&o),
            Err(TurnCommandError::TurnKeysNeedTurnConfig(Opencode))
        );
    }
    for h in RUNNABLE {
        if turn_key_delivery_of(h).is_none() {
            let mut o = TurnCommandOptions::new(h, TurnMode::Mention, Auto, "/op");
            o.session_id = Some("sid");
            o.turn_keys = Some(&keys);
            o.codex_home = Some(Path::new("/cx"));
            o.opencode_home = Some(Path::new("/oc"));
            o.pi_home = Some(Path::new("/pi"));
            o.omp_home = Some(Path::new("/omp"));
            o.omp_thread = Some(OmpThread {
                cwd: Path::new("/omp/cwd/t"),
                agent_dir: Path::new("/omp/agent"),
            });
            o.workspace_dir = Some(Path::new("/ws"));
            assert_eq!(build(&o), Err(TurnCommandError::TurnKeysNoDelivery(h)));
        }
    }
    // 열쇠 값은 argv 에 오르지 않는다.
    let mut o = TurnCommandOptions::new(Codex, TurnMode::Mention, Auto, "/op");
    o.codex_home = Some(Path::new("/cx"));
    o.turn_keys = Some(&keys);
    if let Ok(p) = build(&o) {
        assert!(!p.args.iter().any(|x| x == "s" || x == "b"));
    }
}

const RUNNABLE: [AgentHarness; 6] = crate::turn_preset::RUNNABLE_HARNESSES;

#[test]
fn command_rule_env_and_stdin_pass_through() {
    let rules = BTreeMap::from([("HARKROOM_RULES".to_string(), "1".to_string())]);
    let mut o = TurnCommandOptions::new(ClaudeCode, TurnMode::Mention, Auto, "/op");
    o.session_id = Some("sid");
    o.command_rule_env = Some(&rules);
    o.stdin_file = Some(Path::new("/in"));
    let p = build(&o).unwrap();
    assert_eq!(p.env.get("HARKROOM_RULES").map(String::as_str), Some("1"));
    assert_eq!(p.stdin_file.as_deref(), Some(Path::new("/in")));
}

#[test]
fn gemini_is_unsupported_and_errors_carry_no_paths() {
    let o = TurnCommandOptions::new(Gemini, TurnMode::Mention, Auto, "/op");
    assert!(matches!(build(&o), Err(TurnCommandError::Check(_))));
    let mut o = TurnCommandOptions::new(Omp, TurnMode::Mention, Auto, "/secret-op");
    o.session_id = Some("sid");
    o.omp_home = Some(Path::new("/secret-omp"));
    o.omp_thread = Some(OmpThread {
        cwd: Path::new("/secret-ws/x"),
        agent_dir: Path::new("/a"),
    });
    o.workspace_dir = Some(Path::new("/secret-ws"));
    let msg = build(&o).unwrap_err().to_string();
    assert!(!msg.contains("secret"), "{msg}");
}
