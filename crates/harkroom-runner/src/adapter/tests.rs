use super::*;

const RUNNABLE: [AgentHarness; 6] = [
    AgentHarness::ClaudeCode,
    AgentHarness::Codex,
    AgentHarness::Opencode,
    AgentHarness::Kilo,
    AgentHarness::Pi,
    AgentHarness::Omp,
];

#[test]
fn wire_names_round_trip() {
    for h in AgentHarness::ALL {
        assert_eq!(AgentHarness::parse(h.as_str()), Some(h));
    }
    assert_eq!(AgentHarness::parse("claude"), None);
}

#[test]
fn table_is_complete_and_self_consistent() {
    for h in RUNNABLE {
        let a = adapter_for(h).unwrap();
        assert_eq!(a.harness, h);
        // T0: 본선은 두 모드 다 TUI, 멘션 권한 두 갈래를 다 옮긴다.
        assert_eq!(a.execution_mention, ExecutionModel::Tui);
        assert_eq!(a.execution_interactive, ExecutionModel::Tui);
        assert_eq!(a.supported_mention_permissions, AUTO_READONLY);
        assert!(std::ptr::eq(a.screen.gate, &*DEFAULT_GATE_PATTERN));
    }
    let Err(err) = adapter_for(AgentHarness::Gemini) else {
        panic!("gemini has no adapter")
    };
    assert!(err.to_string().contains("gemini"));
}

#[test]
fn commands_match_source() {
    let got: Vec<_> = RUNNABLE
        .iter()
        .map(|h| harness_command(*h).unwrap())
        .collect();
    assert_eq!(got, ["claude", "codex", "opencode", "kilo", "pi", "omp"]);
}

#[test]
fn ready_patterns_judge_real_screens() {
    let ready = |h| injection_facts_for(h).unwrap().ready_pattern;
    assert!(ready(AgentHarness::ClaudeCode).is_match("\u{276f}\u{a0}"));
    assert!(!ready(AgentHarness::ClaudeCode).is_match("\u{276f} 1. Yes"));
    assert!(ready(AgentHarness::Codex).is_match("Ask Codex to do anything"));
    assert!(ready(AgentHarness::Opencode).is_match("  ctrl+p commands"));
    assert!(ready(AgentHarness::Kilo).is_match("Ask anything..."));
    assert!(ready(AgentHarness::Pi).is_match("0.0%/200k (auto)"));
    assert!(ready(AgentHarness::Pi).is_match("12.5%/1M"));
    assert!(!ready(AgentHarness::Pi).is_match("12.5%/1Mb"));
    assert!(ready(AgentHarness::Omp).is_match("3% · ctx 200K"));
    assert!(!ready(AgentHarness::Omp).is_match("3%\n200K"));
}

#[test]
fn busy_and_unsent_hints() {
    let busy = |h| screen_idle_facts_for(h).unwrap().busy;
    assert!(screen_idle_facts_for(AgentHarness::ClaudeCode).is_none());
    assert!(screen_idle_facts_for(AgentHarness::Gemini).is_none());
    assert!(busy(AgentHarness::Codex).is_match("Working (3s • esc to interrupt)"));
    assert!(busy(AgentHarness::Opencode).is_match("esc interrupt"));
    assert!(busy(AgentHarness::Pi).is_match("──── \u{280b} Working"));
    assert!(busy(AgentHarness::Omp).is_match("Working…"));
    assert!(busy(AgentHarness::Omp).is_match("\u{2819} 12s > esc"));

    let unsent = |h| injection_facts_for(h).unwrap().unsent_hint;
    assert!(
        unsent(AgentHarness::Codex)
            .unwrap()
            .is_match("tab to queue message")
    );
    let claude = unsent(AgentHarness::ClaudeCode).unwrap();
    assert!(claude.is_match("\u{276f} [Pasted text #1 +40 lines]"));
    assert!(!claude.is_match("\u{276f} [Pasted text #1]\n\u{276f}\u{a0}"));
    assert!(unsent(AgentHarness::Opencode).is_none());
}

#[test]
fn ready_min_ms_only_where_measured() {
    let ms = |h| injection_facts_for(h).unwrap().ready_min_ms;
    assert_eq!(ms(AgentHarness::Codex), Some(2_500));
    assert_eq!(ms(AgentHarness::Pi), Some(1_000));
    assert_eq!(ms(AgentHarness::Omp), Some(1_000));
    assert_eq!(ms(AgentHarness::ClaudeCode), None);
    assert_eq!(ms(AgentHarness::Opencode), None);
}

#[test]
fn gate_for_unsupported_never_matches() {
    let g = screen_gate_for(AgentHarness::Gemini);
    assert!(!g.is_match("Do you want to proceed?"));
    assert!(!g.is_match(""));
    assert!(screen_gate_for(AgentHarness::Codex).is_match("Do you want to proceed?"));
}

#[test]
fn index_lookups_match_source() {
    use AgentHarness::*;
    assert!(reads_session_transcript(ClaudeCode));
    assert!(!reads_session_transcript(Codex));
    assert!(!reads_session_transcript(Opencode));
    assert!(!reads_session_transcript(Gemini));

    assert!(!prefixes_system_prompt(ClaudeCode).unwrap());
    assert!(prefixes_system_prompt(Codex).unwrap());
    assert!(prefixes_system_prompt(Kilo).unwrap());
    assert!(!prefixes_system_prompt(Pi).unwrap());

    assert_eq!(file_memory_dir_under_config(ClaudeCode), Some("projects"));
    assert_eq!(file_memory_dir_under_config(Codex), None);
    assert!(supports_review_fork(ClaudeCode) && !supports_review_fork(Codex));
    assert!(has_account_pool(ClaudeCode).unwrap() && !has_account_pool(Codex).unwrap());
    assert!(discovers_session_id_after_turn(Codex).unwrap());
    assert!(!discovers_session_id_after_turn(Omp).unwrap());
    assert!(waits_for_mcp_before_prompt(ClaudeCode).unwrap());
    assert!(!waits_for_mcp_before_prompt(Codex).unwrap());

    assert_eq!(command_rules_of(Codex), Some(CommandRules::CodexExecpolicy));
    assert_eq!(command_rules_of(ClaudeCode), None);
    assert_eq!(
        turn_key_delivery_of(ClaudeCode),
        Some(TurnKeyDelivery::McpConfigEnv)
    );
    assert_eq!(turn_key_delivery_of(Codex), Some(TurnKeyDelivery::EnvVars));
    assert_eq!(
        turn_key_delivery_of(Opencode),
        Some(TurnKeyDelivery::TurnConfigEnv)
    );
    assert_eq!(turn_key_delivery_of(Kilo), None);
    assert_eq!(turn_key_delivery_of(Gemini), None);

    assert_eq!(
        last_said_record_of(Codex),
        Some(LastSaidRecord::CodexRollout)
    );
    assert_eq!(
        last_said_record_of(Opencode),
        Some(LastSaidRecord::OpencodeExport)
    );
    assert_eq!(last_said_record_of(Kilo), None);
    assert_eq!(turn_end_record_of(Omp), Some(TurnEndRecord::OmpSession));
    assert_eq!(turn_end_record_of(Pi), None);

    assert!(uses_xdg_home(Opencode) && uses_xdg_home(Kilo) && !uses_xdg_home(Pi));
    assert!(uses_pi_home(Pi) && !uses_pi_home(Omp));
    assert!(uses_omp_home(Omp) && !uses_omp_home(Pi));
    assert!(!uses_pi_home(Gemini) && !uses_omp_home(Gemini) && !uses_xdg_home(Gemini));

    assert!(reads_builtin_skills(ClaudeCode, false));
    assert!(!reads_builtin_skills(ClaudeCode, true));
    assert!(reads_builtin_skills(Codex, false));
    assert!(!reads_builtin_skills(Opencode, false));
    assert!(!reads_builtin_skills(Gemini, false));

    assert_eq!(
        readonly_tools_for(Pi).unwrap().list,
        Some(&["mcp", "list", "--json"][..])
    );
    assert_eq!(readonly_tools_for(Omp).unwrap().list, None);
    assert_eq!(readonly_tools_for(ClaudeCode), None);
}

#[test]
fn xdg_apps_in_table_order_and_distinct() {
    let apps = all_xdg_apps();
    let dirs: Vec<_> = apps.iter().map(|a| a.dir).collect();
    assert_eq!(dirs, ["opencode", "kilo"]);
    assert_eq!(apps[0].config_file, "opencode.jsonc");
    assert_eq!(apps[1].user_config_files, ["kilo.jsonc", "kilo.json"]);
}

#[test]
fn trust_ledgers() {
    let t = |h| adapter_for(h).unwrap().trust;
    assert_eq!(t(AgentHarness::ClaudeCode).unwrap().file, ".claude.json");
    assert_eq!(t(AgentHarness::Codex).unwrap().root, TrustRoot::CodexHome);
    for h in [
        AgentHarness::Opencode,
        AgentHarness::Kilo,
        AgentHarness::Pi,
        AgentHarness::Omp,
    ] {
        assert!(t(h).is_none());
    }
}
