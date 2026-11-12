//! 정본 `mentionTurn.ts` 1607~1687·1755~1787 의 순서·코드를 붙잡는다.
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

const MODEL: &str = "gpt-5.1";

fn tmp(tag: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let p = std::env::temp_dir().join(format!(
        "hk-env-plan-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    fs::canonicalize(&p).unwrap()
}

struct Fx {
    home: PathBuf,
    ws: PathBuf,
    state: PathBuf,
}

fn fx() -> Fx {
    let home = tmp("home");
    let ws = home.join("ws");
    let state = home.join("state");
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(runner_skills_dir(&state)).unwrap();
    Fx { home, ws, state }
}

fn pre<'a>(f: &'a Fx, h: AgentHarness, lane: bool, model: Option<&'a str>) -> LanePreflight<'a> {
    LanePreflight {
        key: "c:t",
        harness: h,
        provider_lane: lane,
        model,
        workspace_dir: &f.ws,
        state_dir: &f.state,
        home: &f.home,
        turn_pi_home: None,
    }
}

fn code(r: Result<(), ProviderLaneError>) -> Option<&'static str> {
    r.err().map(|e| e.code())
}

#[test]
fn model_fixture_is_valid_lane_id() {
    assert_eq!(provider_lane_model_id(Some(MODEL)).as_deref(), Some(MODEL));
}

#[test]
fn preflight_skips_everything_without_lane() {
    let f = fx();
    fs::create_dir_all(f.ws.join(".claude")).unwrap();
    assert_eq!(
        code(lane_preflight(&pre(
            &f,
            AgentHarness::Opencode,
            false,
            None
        ))),
        None
    );
}

#[test]
fn preflight_bad_model_for_xdg_codex_pi_lanes() {
    let f = fx();
    for h in [
        AgentHarness::Opencode,
        AgentHarness::Kilo,
        AgentHarness::Codex,
        AgentHarness::Pi,
    ] {
        assert_eq!(
            code(lane_preflight(&pre(&f, h, true, None))),
            Some("bad_model"),
            "{h:?}"
        );
        assert_eq!(
            code(lane_preflight(&pre(&f, h, true, Some("  ")))),
            Some("bad_model"),
            "{h:?}"
        );
    }
    // claude lane 은 모델 칸이 비어도 여기서 막지 않는다(정본과 같음).
    assert_eq!(
        code(lane_preflight(&pre(
            &f,
            AgentHarness::ClaudeCode,
            true,
            None
        ))),
        None
    );
}

#[test]
fn preflight_bad_model_wins_over_workspace() {
    let f = fx();
    fs::create_dir_all(f.ws.join(".claude")).unwrap();
    assert_eq!(
        code(lane_preflight(&pre(&f, AgentHarness::Opencode, true, None))),
        Some("bad_model")
    );
}

#[test]
fn preflight_workspace_protected_returns_code_only() {
    let f = fx();
    fs::write(f.ws.join("AGENTS.md"), "x").unwrap();
    let e = lane_preflight(&pre(&f, AgentHarness::Codex, true, Some(MODEL))).unwrap_err();
    assert_eq!(e.code(), "workspace_protected");
    // 서버로 나갈 수 있는 문장에 경로가 없다(security 20:19).
    let shown = e.to_string();
    assert!(!shown.contains("AGENTS.md"), "{shown}");
    assert!(!shown.contains(f.ws.to_str().unwrap()), "{shown}");
}

#[test]
fn preflight_checks_parent_chain() {
    let f = fx();
    let ws = f.home.join("proj").join("ws");
    fs::create_dir_all(&ws).unwrap();
    fs::write(f.home.join("proj").join("CLAUDE.md"), "x").unwrap();
    let mut p = pre(&f, AgentHarness::ClaudeCode, true, Some(MODEL));
    p.workspace_dir = &ws;
    assert_eq!(code(lane_preflight(&p)), Some("workspace_protected"));
}

#[test]
fn preflight_pi_login_after_workspace() {
    let f = fx();
    let pi_home = f.home.join("pi-lane");
    fs::create_dir_all(&pi_home).unwrap();
    fs::write(pi_home.join("auth.json"), r#"{"x":{}}"#).unwrap();
    let mut p = pre(&f, AgentHarness::Pi, true, Some(MODEL));
    p.turn_pi_home = Some(&pi_home);
    assert_eq!(code(lane_preflight(&p)), Some("harness_login_present"));
    // 작업 폴더 검사가 먼저다.
    fs::write(f.ws.join(".mcp.json"), "{}").unwrap();
    assert_eq!(code(lane_preflight(&p)), Some("workspace_protected"));
    // 빈 `{}` 는 로그인이 아니다.
    fs::remove_file(f.ws.join(".mcp.json")).unwrap();
    fs::write(pi_home.join("auth.json"), "{}").unwrap();
    assert_eq!(code(lane_preflight(&p)), None);
}

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn omp_needs_lane_env_and_model() {
    let h = AgentHarness::Omp;
    assert_eq!(
        lane_harness_model(h, None, None, Some(MODEL))
            .unwrap_err()
            .code(),
        "lane_unset"
    );
    let half = env(&[(OMP_LANE_BASE_URL_ENV, "https://gw.example")]);
    assert_eq!(
        lane_harness_model(h, Some(&half), None, Some(MODEL))
            .unwrap_err()
            .code(),
        "lane_unset"
    );
    let empty = env(&[
        (OMP_LANE_BASE_URL_ENV, "https://gw.example"),
        (OMP_LANE_KEY_FILE_ENV, ""),
    ]);
    assert_eq!(
        lane_harness_model(h, Some(&empty), None, Some(MODEL))
            .unwrap_err()
            .code(),
        "lane_unset"
    );
    let full = env(&[
        (OMP_LANE_BASE_URL_ENV, "https://gw.example"),
        (OMP_LANE_KEY_FILE_ENV, "/k"),
    ]);
    assert_eq!(
        lane_harness_model(h, Some(&full), None, None)
            .unwrap_err()
            .code(),
        "bad_model"
    );
    let m = lane_harness_model(h, Some(&full), None, Some(MODEL)).unwrap();
    assert_eq!(
        m,
        LaneHarnessModel::Omp(LaneHomeModel {
            base_url: "https://gw.example".into(),
            key_path: "/k".into(),
            model_id: MODEL.into(),
        })
    );
    assert_eq!(
        m.run_model(true, h, Some(MODEL)),
        Some(format!("{OMP_LANE_PROVIDER}/{MODEL}"))
    );
}

#[test]
fn pi_lane_model_only_on_lane_with_home() {
    let h = AgentHarness::Pi;
    let home = PathBuf::from("/pi");
    // lane 이 아니면 홈에 적을 것이 없고 모델은 원문 그대로.
    let none = lane_harness_model(h, None, Some(&home), Some(MODEL)).unwrap();
    assert_eq!(none, LaneHarnessModel::None);
    assert_eq!(
        none.run_model(false, h, Some(MODEL)).as_deref(),
        Some(MODEL)
    );
    let full = env(&[
        (PI_LANE_BASE_URL_ENV, "https://gw.example"),
        (PI_LANE_KEY_FILE_ENV, "/k"),
    ]);
    assert_eq!(
        lane_harness_model(h, Some(&full), None, Some(MODEL))
            .unwrap_err()
            .code(),
        "lane_unset"
    );
    let m = lane_harness_model(h, Some(&full), Some(&home), Some(MODEL)).unwrap();
    assert!(matches!(m, LaneHarnessModel::Pi(_)));
    assert_eq!(
        m.run_model(true, h, Some(MODEL)),
        Some(format!("{PI_LANE_PROVIDER}/{MODEL}"))
    );
}

#[test]
fn other_harness_run_model_follows_lane_run_model() {
    for (h, lane) in [
        (AgentHarness::ClaudeCode, false),
        (AgentHarness::ClaudeCode, true),
        (AgentHarness::Opencode, true),
        (AgentHarness::Codex, true),
    ] {
        let m =
            lane_harness_model(h, lane.then(BTreeMap::new).as_ref(), None, Some(MODEL)).unwrap();
        assert_eq!(m, LaneHarnessModel::None);
        assert_eq!(
            m.run_model(lane, h, Some(MODEL)),
            lane_run_model(lane, uses_xdg_home(h), Some(MODEL)),
            "{h:?}"
        );
    }
}

#[test]
fn markers_follow_tui_and_hooks() {
    let p = MentionPermission::Auto;
    assert!(TurnMarker::McpReady.wanted(AgentHarness::ClaudeCode, true, p, false));
    assert!(!TurnMarker::McpReady.wanted(AgentHarness::ClaudeCode, false, p, false));
    assert!(!TurnMarker::McpReady.wanted(AgentHarness::Codex, true, p, false));
    assert_eq!(
        TurnMarker::GateSignal.wanted(AgentHarness::ClaudeCode, true, p, false),
        attaches_gate_hook(AgentHarness::ClaudeCode, p, false)
    );
    // API 키 턴에는 관문 hook 이 붙지 않으니 신호 파일도 없다.
    assert!(!TurnMarker::GateSignal.wanted(AgentHarness::ClaudeCode, true, p, true));
    assert!(!TurnMarker::GateSignal.wanted(AgentHarness::ClaudeCode, false, p, false));
}

#[test]
fn marker_file_lives_in_private_state_dir() {
    let state = tmp("state");
    let mut n = 0;
    let mut id = || {
        n += 1;
        format!("id{n}")
    };
    let a = turn_marker_file(&state, TurnMarker::McpReady, "k", &mut id).unwrap();
    let b = turn_marker_file(&state, TurnMarker::GateSignal, "k", &mut id).unwrap();
    assert_eq!(a, state.join("mcp-ready").join("id1"));
    assert_eq!(b, state.join("gate-signal").join("id2"));
    assert!(!a.exists(), "파일은 브릿지가 만든다");
    let mode = fs::metadata(state.join("mcp-ready"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o700);
}

#[test]
fn marker_file_refuses_open_or_linked_dir() {
    let state = tmp("state-open");
    fs::create_dir_all(state.join("mcp-ready")).unwrap();
    fs::set_permissions(state.join("mcp-ready"), fs::Permissions::from_mode(0o755)).unwrap();
    let mut id = || "x".to_string();
    assert_eq!(
        turn_marker_file(&state, TurnMarker::McpReady, "k", &mut id),
        None
    );
    let other = tmp("elsewhere");
    std::os::unix::fs::symlink(&other, state.join("gate-signal")).unwrap();
    assert_eq!(
        turn_marker_file(&state, TurnMarker::GateSignal, "k", &mut id),
        None
    );
}
