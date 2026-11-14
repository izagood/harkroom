//! 정본 `packages/agent/test/providerLane.test.ts` 의 이식. 시험 이름 위 주석이 정본 시험 제목이다.

use std::os::unix::fs::PermissionsExt as _;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;

use super::*;

/// 시험마다 비운 폴더(시스템 임시 폴더 + pid + 일련번호). 끝나면 지운다.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "hk-provider-lane-{tag}-{}-{}",
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

/// 정본 `setup` — `<root>/turn-secrets/lease-1/secret-1` 에 값.
struct Setup {
    root: TempDir,
    secrets_dir: PathBuf,
    path: PathBuf,
}

fn setup(value: &str) -> Setup {
    let root = TempDir::new("lane");
    let dir = root.path().join("turn-secrets").join("lease-1");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("secret-1");
    fs::write(&path, value).unwrap();
    Setup {
        secrets_dir: root.path().join("turn-secrets"),
        path,
        root,
    }
}

fn reply(status: u16, body: Value) -> HttpReply {
    HttpReply {
        status,
        body: body.to_string(),
    }
}

/// 정본 `ok(lane)` — 200 과 `{ lane }`.
fn ok(lane: Value) -> MountFn {
    Box::new(move |_| reply(200, json!({ "lane": lane })))
}

fn lane_at(base_url: &str, path: &Path) -> Value {
    json!({ "baseUrl": base_url, "path": path.to_str().unwrap() })
}

fn deps(mount: MountFn, secrets_dir: &Path) -> ProviderLaneDeps {
    let mut d = ProviderLaneDeps::new(mount);
    d.turn_secrets_dir = Some(secrets_dir.to_path_buf());
    d
}

fn version(v: Option<&str>) -> Option<HarnessVersionFn> {
    let v = v.map(str::to_owned);
    Some(Box::new(move |_| v.clone()))
}

fn code_of(r: Result<BTreeMap<String, String>, LaneFileError>) -> &'static str {
    r.unwrap_err()
        .lane_code()
        .expect("ProviderLaneError 여야 한다")
}

fn keys(env: &BTreeMap<String, String>) -> Vec<&str> {
    env.keys().map(String::as_str).collect()
}

fn read_doc(p: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
}

fn mode(p: &Path) -> u32 {
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}

fn entries(dir: &Path) -> Vec<String> {
    match fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn realpath(p: &Path) -> String {
    fs::canonicalize(p).unwrap().to_str().unwrap().to_owned()
}

// ── providerLane.envFor ──

/// claude 에는 base URL·키 두 개만 — 끝 줄바꿈은 뗀다
#[test]
fn claude_gets_only_base_url_and_key_with_trailing_newline_trimmed() {
    let t = setup("tok-123\n");
    let lane = ProviderLane::new(deps(
        ok(lane_at("https://gateway.example/", &t.path)),
        &t.secrets_dir,
    ));
    let env = lane.env_for("m1", AgentHarness::ClaudeCode).unwrap();
    assert_eq!(
        env,
        BTreeMap::from([
            (
                "ANTHROPIC_BASE_URL".to_owned(),
                "https://gateway.example".to_owned()
            ),
            ("ANTHROPIC_AUTH_TOKEN".to_owned(), "tok-123".to_owned()),
        ])
    );
}

/// opencode 에는 턴 파일 경로(`OPENCODE_CONFIG`) 하나만 — 키 값은 env 에도 턴 파일에도 없다
#[test]
fn opencode_gets_only_turn_file_path_and_key_value_is_nowhere() {
    let t = setup("tok-123\n");
    let state = t.root.path().join("state");
    let lane_turn_dir = state.join("lane-turn");
    let mut d = deps(
        ok(lane_at("https://gateway.example/", &t.path)),
        &t.secrets_dir,
    );
    d.state_dir = Some(state.clone());
    d.harness_version = version(Some("1.18.32"));
    let lane = ProviderLane::new(d);
    let env = lane.env_for("m-1", AgentHarness::Opencode).unwrap();
    assert_eq!(keys(&env), ["OPENCODE_CONFIG"]);
    let file = PathBuf::from(&env["OPENCODE_CONFIG"]);
    assert_eq!(file, lane_turn_dir.join("m-1.json"));
    let text = fs::read_to_string(&file).unwrap();
    assert!(!text.contains("tok-123"));
    assert_eq!(
        read_doc(&file),
        json!({ "provider": { "harkroom-lane": { "options": {
            "baseURL": "https://gateway.example/v1",
            "apiKey": format!("{{file:{}}}", realpath(&t.path)),
        } } } })
    );
    assert_eq!(mode(&file), 0o600);
    assert_eq!(mode(&lane_turn_dir), 0o700);
    // 표에 없는 하네스는 넣을 자리를 모르니 실패한다.
    assert_eq!(
        code_of(lane.env_for("m1", AgentHarness::Gemini)),
        "harness_unsupported"
    );
}

/// kilo 에는 턴 파일 경로(`KILO_CONFIG`) 하나만 — 키 값은 env 에도 턴 파일에도 없고, 끝나면 거둔다
#[test]
fn kilo_gets_only_turn_file_path_and_release_removes_it() {
    let t = setup("tok-123\n");
    let state = t.root.path().join("state");
    let mut d = deps(
        ok(lane_at("https://gateway.example/", &t.path)),
        &t.secrets_dir,
    );
    d.state_dir = Some(state.clone());
    d.harness_version = version(Some("7.8.17"));
    let lane = ProviderLane::new(d);
    let env = lane.env_for("m-2", AgentHarness::Kilo).unwrap();
    assert_eq!(keys(&env), ["KILO_CONFIG"]);
    let file = PathBuf::from(&env["KILO_CONFIG"]);
    assert!(!fs::read_to_string(&file).unwrap().contains("tok-123"));
    assert_eq!(
        read_doc(&file),
        json!({ "provider": { "harkroom-lane": { "options": {
            "baseURL": "https://gateway.example/v1",
            "apiKey": format!("{{file:{}}}", realpath(&t.path)),
        } } } })
    );
    lane.release(&env).unwrap();
    assert!(entries(&state.join("lane-turn")).is_empty());
}

/// kilo 판이 잰 목록(7.8.17) 밖이거나 못 읽어도 막지 않고 경고를 남긴다
#[test]
fn kilo_version_outside_measured_list_warns_without_blocking() {
    let t = setup("tok-123\n");
    let mounted = Arc::new(AtomicUsize::new(0));
    let versions = [
        Some("7.8.18"),
        Some("7.8.1"),
        Some("7.9.0"),
        None,
        Some("kilo 7.8.17"),
        Some("7.8.17-beta"),
        Some("1.18.32"),
    ];
    for v in versions {
        let m = mounted.clone();
        let p = t.path.clone();
        let mut d = deps(
            Box::new(move |_| {
                m.fetch_add(1, Ordering::SeqCst);
                reply(
                    200,
                    json!({ "lane": lane_at("https://gateway.example", &p) }),
                )
            }),
            &t.secrets_dir,
        );
        d.state_dir = Some(t.root.path().join("st"));
        d.harness_version = version(v);
        let lane = ProviderLane::new(d);
        assert_eq!(
            keys(&lane.env_for("m1", AgentHarness::Kilo).unwrap()),
            ["KILO_CONFIG"]
        );
        let notice = lane.take_notice("m1").expect("경고가 있어야 한다");
        assert!(notice.contains("kilo"));
        assert!(notice.contains("7.8.17"));
        assert!(!notice.contains(t.path.to_str().unwrap()));
        assert_eq!(lane.take_notice("m1"), None);
    }
    assert_eq!(mounted.load(Ordering::SeqCst), versions.len());
    assert!(kilo_lane_version_ok(Some("7.8.17\n")));
}

/// lane kilo 고정 env 는 프로젝트 설정·사람 홈 지시·스킬을 끈다(이름은 KILO_*)
#[test]
fn lane_kilo_fixed_env_disables_project_config_home_instructions_and_skills() {
    assert_eq!(
        provider_lane_fixed_env(AgentHarness::Kilo),
        [
            ("KILO_DISABLE_PROJECT_CONFIG", "1"),
            ("KILO_DISABLE_CLAUDE_CODE", "1"),
            ("KILO_DISABLE_EXTERNAL_SKILLS", "1"),
            ("KILO_DISABLE_AUTOUPDATE", "1"),
        ]
    );
}

/// 턴이 끝나면 그 턴 파일을 거두고, 턴 파일 자리 밖 경로는 건드리지 않는다(security L2 n1)
#[test]
fn release_removes_turn_file_and_leaves_paths_outside_turn_dir() {
    let t = setup("tok-123\n");
    let state = t.root.path().join("state");
    let mut d = deps(
        ok(lane_at("https://gateway.example", &t.path)),
        &t.secrets_dir,
    );
    d.state_dir = Some(state.clone());
    d.harness_version = version(Some("1.18.32"));
    let lane = ProviderLane::new(d);
    let env = lane.env_for("m-9", AgentHarness::Opencode).unwrap();
    lane.release(&env).unwrap();
    assert!(entries(&state.join("lane-turn")).is_empty());
    lane.release(&BTreeMap::from([(
        "OPENCODE_CONFIG".to_owned(),
        t.path.to_str().unwrap().to_owned(),
    )]))
    .unwrap();
    assert_eq!(fs::read_to_string(&t.path).unwrap(), "tok-123\n");
    // `..` 로 자리를 벗어나는 경로도 건드리지 않는다.
    let escape = state
        .join("lane-turn")
        .join("..")
        .join("..")
        .join("turn-secrets")
        .join("lease-1")
        .join("secret-1");
    lane.release(&BTreeMap::from([(
        "OPENCODE_CONFIG".to_owned(),
        escape.to_str().unwrap().to_owned(),
    )]))
    .unwrap();
    assert_eq!(fs::read_to_string(&t.path).unwrap(), "tok-123\n");
    lane.release(&BTreeMap::from([(
        "ANTHROPIC_AUTH_TOKEN".to_owned(),
        "x".to_owned(),
    )]))
    .unwrap();
}

/// opencode 판이 잰 목록 밖이거나 못 읽어도 막지 않는다 — 경고에는 판과 잰 판만, 하네스가 낸 글자는 한 줄로 자른다
#[test]
fn opencode_version_outside_measured_list_does_not_block_and_notice_is_one_line() {
    let t = setup("tok-123\n");
    for v in [
        Some("1.18.33"),
        Some("1.19.5"),
        Some("2.0.0"),
        None,
        Some("garbage\nsecond line"),
        Some("1.18.32-beta"),
    ] {
        let mut d = deps(
            ok(lane_at("https://gateway.example", &t.path)),
            &t.secrets_dir,
        );
        d.state_dir = Some(t.root.path().join("st"));
        d.harness_version = version(v);
        let lane = ProviderLane::new(d);
        assert_eq!(
            keys(&lane.env_for("m1", AgentHarness::Opencode).unwrap()),
            ["OPENCODE_CONFIG"]
        );
        let notice = lane.take_notice("m1").unwrap_or_default();
        assert!(notice.contains("opencode"));
        assert!(notice.contains("1.18.32"));
        assert!(!notice.contains("second line"));
        assert!(!notice.contains("gateway.example"));
    }
    assert!(opencode_lane_version_ok(Some("1.18.32\n")));
    assert!(opencode_lane_version_ok(Some("1.19.4")));
}

/// 판은 턴마다 묻고, 같은 (하네스, 판) 경고는 러너마다 한 번만 스레드로 간다
#[test]
fn version_is_asked_every_turn_and_notice_goes_once_per_harness_version() {
    let t = setup("tok-123\n");
    let current = Arc::new(Mutex::new("1.18.32".to_owned()));
    let asked = Arc::new(AtomicUsize::new(0));
    let mut d = deps(
        ok(lane_at("https://gateway.example", &t.path)),
        &t.secrets_dir,
    );
    d.state_dir = Some(t.root.path().join("st"));
    let (c, a) = (current.clone(), asked.clone());
    d.harness_version = Some(Box::new(move |_| {
        a.fetch_add(1, Ordering::SeqCst);
        Some(c.lock().unwrap().clone())
    }));
    let lane = ProviderLane::new(d);
    lane.env_for("m1", AgentHarness::Opencode).unwrap();
    assert_eq!(lane.take_notice("m1"), None);
    *current.lock().unwrap() = "1.19.5".into();
    lane.env_for("m2", AgentHarness::Opencode).unwrap();
    assert!(lane.take_notice("m2").unwrap().contains("1.19.5"));
    lane.env_for("m3", AgentHarness::Opencode).unwrap();
    assert_eq!(lane.take_notice("m3"), None);
    *current.lock().unwrap() = "1.19.6".into();
    lane.env_for("m4", AgentHarness::Opencode).unwrap();
    assert!(lane.take_notice("m4").unwrap().contains("1.19.6"));
    assert_eq!(asked.load(Ordering::SeqCst), 4);
}

/// lane opencode 고정 env 는 자동 업데이트를 끈다
#[test]
fn lane_opencode_fixed_env_disables_autoupdate() {
    let env = provider_lane_fixed_env(AgentHarness::Opencode);
    assert!(env.contains(&("OPENCODE_DISABLE_AUTOUPDATE", "1")));
    assert!(env.contains(&("OPENCODE_DISABLE_PROJECT_CONFIG", "1")));
}

/// 턴 파일 자리가 없으면 opencode lane 은 실패한다
#[test]
fn opencode_lane_fails_without_turn_file_dir() {
    let t = setup("tok-123\n");
    let mut d = deps(
        ok(lane_at("https://gateway.example", &t.path)),
        &t.secrets_dir,
    );
    d.harness_version = version(Some("1.18.32"));
    let lane = ProviderLane::new(d);
    assert_eq!(
        code_of(lane.env_for("m1", AgentHarness::Opencode)),
        "no_turn_secrets_dir"
    );
}

/// 설정이 없다는 답(lane null)은 던진다 — 계정 로그인으로 떨어지지 않는다
#[test]
fn lane_null_answer_fails_with_lane_unset() {
    let t = setup("tok-123\n");
    let lane = ProviderLane::new(deps(ok(Value::Null), &t.secrets_dir));
    assert_eq!(
        code_of(lane.env_for("m1", AgentHarness::ClaudeCode)),
        "lane_unset"
    );
}

/// 오퍼레이터의 거절 코드를 그대로 싣는다
#[test]
fn operator_rejection_code_is_carried() {
    let t = setup("tok-123\n");
    let lane = ProviderLane::new(deps(
        Box::new(|_| reply(409, json!({ "error": { "code": "no_lease" } }))),
        &t.secrets_dir,
    ));
    assert_eq!(
        code_of(lane.env_for("m1", AgentHarness::ClaudeCode)),
        "no_lease"
    );
}

/// 턴 비밀 루트 밖 경로는 읽지 않는다
#[test]
fn path_outside_turn_secrets_root_is_not_read() {
    let t = setup("tok-123\n");
    let outside = t.root.path().join("elsewhere");
    fs::write(&outside, "stolen").unwrap();
    let lane = ProviderLane::new(deps(
        ok(lane_at("https://gateway.example", &outside)),
        &t.secrets_dir,
    ));
    assert_eq!(
        code_of(lane.env_for("m1", AgentHarness::ClaudeCode)),
        "bad_path"
    );
    // 루트 안을 가리키는 링크라도 실제 자리가 밖이면 거절한다(realpath).
    let link = t.secrets_dir.join("lease-1").join("link");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    let lane = ProviderLane::new(deps(
        ok(lane_at("https://gateway.example", &link)),
        &t.secrets_dir,
    ));
    assert_eq!(
        code_of(lane.env_for("m1", AgentHarness::ClaudeCode)),
        "bad_path"
    );
}

/// 평문 http 원격 주소는 받지 않는다
#[test]
fn plain_http_remote_base_url_is_rejected() {
    let t = setup("tok-123\n");
    let lane = ProviderLane::new(deps(
        ok(lane_at("http://gateway.example", &t.path)),
        &t.secrets_dir,
    ));
    assert_eq!(
        code_of(lane.env_for("m1", AgentHarness::ClaudeCode)),
        "bad_base_url"
    );
}

/// 여러 줄 값·키를 모르는 하네스·링크 오류는 던진다
#[test]
fn multiline_value_codex_without_home_and_link_error_fail() {
    let multi = setup("a\nb");
    assert_eq!(
        code_of(
            ProviderLane::new(deps(
                ok(lane_at("https://gateway.example", &multi.path)),
                &multi.secrets_dir
            ))
            .env_for("m1", AgentHarness::ClaudeCode)
        ),
        "bad_value"
    );
    let t = setup("tok-123\n");
    let err = ProviderLane::new(deps(
        ok(lane_at("https://gateway.example", &t.path)),
        &t.secrets_dir,
    ))
    .env_for("m1", AgentHarness::Codex)
    .unwrap_err();
    assert!(matches!(err, LaneFileError::Lane(_)));
    // 링크 끊김(정본의 던짐)은 `status == 0` 이다.
    assert_eq!(
        code_of(
            ProviderLane::new(deps(Box::new(|_| reply(0, Value::Null)), &t.secrets_dir))
                .env_for("m1", AgentHarness::ClaudeCode)
        ),
        "operator_unreachable"
    );
}

// ── ProviderLaneError ──

/// 허용 목록 밖 코드는 unknown 으로 접고, 문장에도 코드만 싣는다
#[test]
fn unknown_codes_fold_to_unknown_and_message_carries_only_code() {
    let e = ProviderLaneError::new("https://gateway.example/x");
    assert_eq!(e.code(), "unknown");
    assert!(!e.to_string().contains("gateway.example"));
    assert_eq!(ProviderLaneError::new("no_lease").code(), "no_lease");
}

// ── providerLane 결과 통지(2a) ──

type Reported = (bool, Option<&'static str>);

/// 성공은 ok, 실패는 접힌 코드로 알린다 — 실패해도 던지는 것은 그대로
#[test]
fn success_reports_ok_and_failure_reports_folded_code() {
    let t = setup("tok-123\n");
    let seen: Arc<Mutex<Vec<Reported>>> = Arc::default();
    let report = |s: &Arc<Mutex<Vec<_>>>| -> Option<ReportFn> {
        let s = s.clone();
        Some(Box::new(move |o, c| s.lock().unwrap().push((o, c))))
    };
    let mut d = deps(
        ok(lane_at("https://gateway.example", &t.path)),
        &t.secrets_dir,
    );
    d.report = report(&seen);
    ProviderLane::new(d)
        .env_for("m1", AgentHarness::ClaudeCode)
        .unwrap();
    let mut d = deps(
        Box::new(|_| reply(502, json!({ "error": { "code": "https://x" } }))),
        &t.secrets_dir,
    );
    d.report = report(&seen);
    let err = ProviderLane::new(d)
        .env_for("m1", AgentHarness::ClaudeCode)
        .unwrap_err();
    assert!(matches!(err, LaneFileError::Lane(_)));
    assert_eq!(
        *seen.lock().unwrap(),
        [(true, None), (false, Some("unknown"))]
    );
}

// ── sweepLaneMcpConfig(L3c-3c) ──

/// 옛 대체 길이 남긴 `lane-mcp.json`(러너 링크 secret 이 든 파일)을 기동 때 지운다 — 없어도 조용하다
#[test]
fn sweep_lane_mcp_config_removes_old_file_and_is_quiet_when_absent() {
    let dir = TempDir::new("lane-mcp-sweep");
    let path = dir.path().join(LANE_MCP_CONFIG_FILE);
    std::fs::write(
        &path,
        r#"{"mcpServers":{"harkroom":{"env":{"HARKROOM_RUNNER_SECRET":"old"}}}}"#,
    )
    .unwrap();
    sweep_lane_mcp_config(dir.path());
    assert!(!path.exists());
    sweep_lane_mcp_config(dir.path());
}

/// env 를 걷는 하네스는 claude 하나다(턴 열쇠 없는 lane 턴을 거절하는 대상)
#[test]
fn only_env_scrubbing_harness_takes_this_path() {
    assert!(lane_scrubs_subprocess_env(AgentHarness::ClaudeCode));
    assert!(!lane_scrubs_subprocess_env(AgentHarness::Opencode));
}

// ── writeOpencodeLaneTurnConfig ──

/// provider 주소·키 파일 참조 말고는 아무 칸도 쓰지 않는다(권한 칸 없음)
#[test]
fn opencode_lane_turn_config_writes_only_provider_fields() {
    let root = TempDir::new("lt");
    let dir = root.path().join("lane-turn");
    let path = write_opencode_lane_turn_config(
        &dir,
        "m1",
        OpencodeLaneTarget {
            base_url: "https://gateway.example",
            key_path: "/secrets/k",
        },
    )
    .unwrap();
    let doc = read_doc(&path);
    let obj_keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(obj_keys(&doc), ["provider"]);
    assert_eq!(obj_keys(&doc["provider"]), ["harkroom-lane"]);
    assert_eq!(obj_keys(&doc["provider"]["harkroom-lane"]), ["options"]);
    assert_eq!(
        doc["provider"]["harkroom-lane"]["options"],
        json!({ "baseURL": "https://gateway.example/v1", "apiKey": "{file:/secrets/k}" })
    );
    // 받는 칸이 주소·키 경로 둘뿐이다 — 다른 것을 넣을 길이 없다(정본 `length === 3`).
    let _: fn(&Path, &str, OpencodeLaneTarget<'_>) -> Result<PathBuf, LaneFileError> =
        write_opencode_lane_turn_config;
}

/// 중괄호·줄바꿈이 섞인 값·상대 경로는 거절한다(opencode 가 본문의 `{env:}`·`{file:}` 를 바꿔 넣는다)
#[test]
fn opencode_lane_turn_config_rejects_braces_newlines_and_relative_paths() {
    let root = TempDir::new("lt");
    let dir = root.path().join("lane-turn");
    let code = |base_url: &str, key_path: &str| {
        write_opencode_lane_turn_config(&dir, "m1", OpencodeLaneTarget { base_url, key_path })
            .unwrap_err()
            .lane_code()
    };
    assert_eq!(
        code("https://g.example/{env:HOME}", "/k"),
        Some("bad_base_url")
    );
    assert_eq!(
        code("https://g.example", "/k}{file:/etc/passwd"),
        Some("bad_path")
    );
    assert_eq!(code("https://g.example", "rel/k"), Some("bad_path"));
    assert!(entries(&dir).is_empty());
}

/// 기동 때 남은 턴 파일을 걷는다
#[test]
fn sweep_removes_leftover_turn_files() {
    let state = TempDir::new("lt");
    let dir = state.path().join("lane-turn");
    write_opencode_lane_turn_config(
        &dir,
        "old",
        OpencodeLaneTarget {
            base_url: "https://g.example",
            key_path: "/k",
        },
    )
    .unwrap();
    sweep_lane_turn_dir(state.path());
    assert!(entries(&dir).is_empty());
    sweep_lane_turn_dir(&state.path().join("missing"));
}

// ── 이식 표의 일관성(정본에는 없는 시험 — 이미 이식된 표와 이 모듈의 이름이 같은지) ──

#[test]
fn env_name_tables_match_reused_turn_env_tables() {
    assert_eq!(
        provider_lane_keys(AgentHarness::Omp),
        Some(&[OMP_LANE_BASE_URL_ENV, OMP_LANE_KEY_FILE_ENV][..])
    );
    assert_eq!(
        provider_lane_keys(AgentHarness::Pi),
        Some(&[PI_LANE_BASE_URL_ENV, PI_LANE_KEY_FILE_ENV][..])
    );
    assert_eq!(
        provider_lane_keys(AgentHarness::Codex),
        Some(&[CODEX_LANE_KEY_ENV, CODEX_LANE_BASE_URL_ENV][..])
    );
    assert_eq!(
        lane_turn_file_env(AgentHarness::Opencode),
        Some("OPENCODE_CONFIG")
    );
    assert_eq!(lane_turn_file_env(AgentHarness::Kilo), Some("KILO_CONFIG"));
    assert_eq!(lane_turn_file_env(AgentHarness::ClaudeCode), None);
}

/// lane claude 폴더 자리에 링크가 놓이면 키를 받기 전에 거절한다(#2129 security 조건) — 진짜 폴더면 그대로 간다
#[test]
fn lane_claude_dir_symlink_is_refused_before_mount() {
    let t = setup("tok-123\n");
    let mounted = Arc::new(AtomicUsize::new(0));
    let lane_with = |claude_dir: PathBuf| {
        let m = mounted.clone();
        let lane = lane_at("https://gateway.example", &t.path);
        let mut d = deps(
            Box::new(move |_| {
                m.fetch_add(1, Ordering::SeqCst);
                reply(200, json!({ "lane": lane }))
            }),
            &t.secrets_dir,
        );
        d.claude_dir = Some(claude_dir);
        ProviderLane::new(d)
    };
    // 링크(너머는 사람의 기본 로그인 폴더 흉내) — 거절, 마운트 0.
    let home = t.root.path().join("fake-home-claude");
    fs::create_dir_all(&home).unwrap();
    let linked = t.root.path().join("claude-provider-lane");
    std::os::unix::fs::symlink(&home, &linked).unwrap();
    assert_eq!(
        code_of(lane_with(linked.clone()).env_for("m1", AgentHarness::ClaudeCode)),
        "harness_login_present"
    );
    assert_eq!(mounted.load(Ordering::SeqCst), 0);
    // 폴더가 아닌 파일도 거절.
    let file = t.root.path().join("lane-file");
    fs::write(&file, "").unwrap();
    assert_eq!(
        code_of(lane_with(file).env_for("m2", AgentHarness::ClaudeCode)),
        "harness_login_present"
    );
    assert_eq!(mounted.load(Ordering::SeqCst), 0);
    // 없으면 0700 으로 만들고 간다.
    let fresh = t.root.path().join("st").join("claude-provider-lane");
    assert!(
        lane_with(fresh.clone())
            .env_for("m3", AgentHarness::ClaudeCode)
            .is_ok()
    );
    assert_eq!(mounted.load(Ordering::SeqCst), 1);
    assert_eq!(mode(&fresh), 0o700);
    assert!(
        !fs::symlink_metadata(&fresh)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}
