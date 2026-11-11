//! 정본 `packages/agent/test/ompHome.test.ts` 의 홈 경우를 옮긴 것 + Rust 쪽에서 좁힌 자리.
//! 턴 조립(`buildTurnCommand`)·판 관문(`ompLaneVersionOk`)·준비 화면은 이 모듈 몫이 아니다(B3d·adapter).
use super::*;
use crate::adapter::{AgentHarness, adapter};
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicU64, Ordering};

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn tmpdir() -> Tmp {
    static N: AtomicU64 = AtomicU64::new(0);
    let d = std::env::temp_dir().join(format!(
        "hk-omp-home-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    Tmp(fs::canonicalize(&d).unwrap())
}
fn mode(p: &Path) -> u32 {
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}
fn path_env() -> Option<String> {
    std::env::var("PATH").ok()
}
fn mcp(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => unreachable!(),
    }
}
fn thread(root: &Path) -> OmpThreadDirs {
    let home = root.join("omp-home");
    ensure_omp_home(&home, &Map::new()).unwrap();
    ensure_omp_thread(&home, "x", path_env().as_deref()).unwrap()
}
fn models(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}
fn lane<'a>(base_url: &'a str, key_path: &'a str, m: &'a [String]) -> OmpLane<'a> {
    OmpLane {
        base_url,
        key_path,
        models: m,
    }
}

#[test]
fn overlay_blocks_outside_sources_and_keeps_native() {
    for id in [
        "claude",
        "codex",
        "gemini",
        "opencode",
        "cursor",
        "agents-md",
        "mcp-json",
    ] {
        assert!(OMP_OVERLAY.contains(&format!("  - {id}\n")), "{id}");
    }
    assert!(!OMP_OVERLAY.lines().any(|l| l.trim() == "- native"));
    assert!(OMP_OVERLAY.contains("tools:\n  xdev: false"));
    assert!(OMP_OVERLAY.contains("startup:\n  setupWizard: false\n  checkUpdate: false"));
    assert!(OMP_OVERLAY.contains("paste:\n  largeMenuThreshold: 0"));
    assert!(OMP_OVERLAY.ends_with('\n'));
}

#[test]
fn thread_dirs_are_stable_and_distinct() {
    let h = Path::new("/s/omp");
    assert_eq!(omp_thread_dirs(h, "a"), omp_thread_dirs(h, "a"));
    assert_ne!(omp_thread_dirs(h, "a").cwd, omp_thread_dirs(h, "b").cwd);
    assert!(omp_thread_dirs(h, "a").cwd.starts_with("/s/omp/cwd/"));
    // 해시는 pi lane 과 같은 sha256 앞 24자다.
    let t = omp_thread_dirs(h, "a");
    assert_eq!(
        t.cwd,
        PathBuf::from(format!("/s/omp/cwd/{}/cwd", thread_hash("a")))
    );
    assert_eq!(
        t.leftovers,
        PathBuf::from(format!("/s/omp/leftovers/{}", thread_hash("a")))
    );
    assert!(!t.leftovers.to_string_lossy().contains("/cwd/"));
}

#[test]
fn ensure_thread_git_inits_and_copies_shared_files_0600() {
    let root = tmpdir();
    let home = root.0.join("omp-home");
    ensure_omp_home(
        &home,
        &mcp(json!({ "harkroom": { "command": "/bin/op", "args": ["mcp-bridge"] } })),
    )
    .unwrap();
    let t = ensure_omp_thread(&home, "thread-1", path_env().as_deref()).unwrap();
    assert_eq!(list_names(&t.cwd), vec![".git".to_string()]);
    assert_eq!(
        fs::read_to_string(t.agent_dir.join("config.yml")).unwrap(),
        OMP_OVERLAY
    );
    let m: Value =
        serde_json::from_str(&fs::read_to_string(t.agent_dir.join("mcp.json")).unwrap()).unwrap();
    assert_eq!(
        m,
        json!({ "mcpServers": { "harkroom": { "command": "/bin/op", "args": ["mcp-bridge"] } } })
    );
    assert_eq!(mode(&t.agent_dir.join("mcp.json")), 0o600);
    assert_eq!(mode(&omp_dirs(&home).overlay), 0o600);
    for d in [&t.cwd, &t.agent_dir, &omp_dirs(&home).sessions_dir] {
        assert_eq!(mode(d), 0o700);
    }
    assert!(omp_cwd_violations(&t.cwd, &root.0).unwrap().is_empty());
    // 멱등 — 두 번째는 git init 을 다시 하지 않고 같은 자리를 돌려준다.
    assert_eq!(
        ensure_omp_thread(&home, "thread-1", path_env().as_deref()).unwrap(),
        t
    );
}

#[test]
fn ensure_thread_without_git_on_path_fails_without_path_in_display() {
    let root = tmpdir();
    let home = root.0.join("omp-home");
    ensure_omp_home(&home, &Map::new()).unwrap();
    let e = ensure_omp_thread(&home, "y", Some("/nonexistent")).unwrap_err();
    assert!(matches!(e, OmpHomeError::GitInit { .. }));
    assert!(!e.to_string().contains(&*root.0.to_string_lossy()));
    assert!(e.local_detail().contains(&*root.0.to_string_lossy()));
}

#[test]
fn cwd_violations_catch_cwd_files_and_parent_config_names() {
    let root = tmpdir();
    let t = thread(&root.0);
    fs::write(t.cwd.join("AGENTS.md"), "planted").unwrap();
    fs::write(t.cwd.join("made-by-model.txt"), "x").unwrap();
    fs::create_dir(root.0.join(".omp")).unwrap();
    fs::write(root.0.join(".env"), "K=V").unwrap();
    let found = omp_cwd_violations(&t.cwd, &root.0).unwrap();
    for p in [
        t.cwd.join("AGENTS.md"),
        t.cwd.join("made-by-model.txt"),
        root.0.join(".omp"),
        root.0.join(".env"),
    ] {
        assert!(found.contains(&p), "{}", p.display());
    }
    let e = omp_cwd_violations(Path::new("/elsewhere/cwd"), &root.0).unwrap_err();
    assert!(matches!(e, OmpHomeError::CwdOutsideStop { .. }));
    assert!(e.local_detail().contains("안에 없다"));
    assert!(!e.to_string().contains("/elsewhere"));
    // `<stop>x` 처럼 앞글자만 같은 형제 폴더는 안이 아니다.
    let sibling = PathBuf::from(format!("{}x/a/cwd", root.0.display()));
    assert!(omp_cwd_violations(&sibling, &root.0).is_err());
}

#[test]
fn sweep_moves_everything_but_git_and_keeps_content() {
    let root = tmpdir();
    let t = thread(&root.0);
    fs::write(t.cwd.join("made-by-model.txt"), "x").unwrap();
    fs::create_dir_all(t.cwd.join(".hidden").join("deep")).unwrap();
    fs::write(t.cwd.join(".hidden").join("deep").join("a"), "y").unwrap();
    let moved = sweep_omp_thread_cwd(&t, None).unwrap();
    assert_eq!(moved.len(), 2);
    assert_eq!(list_names(&t.cwd), vec![".git".to_string()]);
    assert!(omp_cwd_violations(&t.cwd, &root.0).unwrap().is_empty());
    let dest = moved[0].parent().unwrap().to_path_buf();
    assert_eq!(dest.parent().unwrap(), t.leftovers);
    assert_eq!(
        fs::read_to_string(dest.join("made-by-model.txt")).unwrap(),
        "x"
    );
    assert_eq!(
        fs::read_to_string(dest.join(".hidden").join("deep").join("a")).unwrap(),
        "y"
    );
    for d in [
        &dest,
        &t.leftovers,
        &t.leftovers.parent().unwrap().to_path_buf(),
    ] {
        assert_eq!(mode(d), 0o700, "{}", d.display());
    }
    assert!(!format!("{}/", t.cwd.display()).starts_with(&format!("{}/", t.leftovers.display())));
}

#[test]
fn sweep_with_nothing_makes_no_dir() {
    let root = tmpdir();
    let t = thread(&root.0);
    assert!(sweep_omp_thread_cwd(&t, None).unwrap().is_empty());
    assert!(fs::symlink_metadata(&t.leftovers).is_err());
}

#[test]
fn sweep_twice_does_not_overwrite_and_unmovable_is_caught() {
    let root = tmpdir();
    let t = thread(&root.0);
    fs::write(t.cwd.join("a.txt"), "1").unwrap();
    sweep_omp_thread_cwd(&t, Some(0)).unwrap();
    fs::write(t.cwd.join("a.txt"), "2").unwrap();
    sweep_omp_thread_cwd(&t, Some(0)).unwrap();
    assert_eq!(list_names(&t.leftovers).len(), 2);
    fs::write(t.cwd.join("b.txt"), "3").unwrap();
    fs::write(root.0.join("blocker"), "not a directory").unwrap();
    let blocked = OmpThreadDirs {
        leftovers: root.0.join("blocker").join("x"),
        ..t.clone()
    };
    assert!(sweep_omp_thread_cwd(&blocked, None).is_err());
    assert_eq!(
        omp_cwd_violations(&t.cwd, &root.0).unwrap(),
        vec![t.cwd.join("b.txt")]
    );
}

#[test]
fn session_header_written_0600_once() {
    let dir = tmpdir();
    let at = parse_iso_utc_ms("2026-10-24T10:00:00Z").unwrap() as u128;
    let p = write_omp_session_header(&dir.0, "sid-1", Path::new("/s/cwd"), Some(at)).unwrap();
    assert!(
        p.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("2026-10-24T10-00-00-000Z_sid-1")
    );
    let text = fs::read_to_string(&p).unwrap();
    let line: Value = serde_json::from_str(text.trim()).unwrap();
    assert_eq!(line["type"], "session");
    assert_eq!(line["version"], 3);
    assert_eq!(line["id"], "sid-1");
    assert_eq!(line["cwd"], "/s/cwd");
    assert_eq!(line["timestamp"], "2026-10-24T10:00:00.000Z");
    assert_eq!(mode(&p), 0o600);
    fs::write(&p, format!("{}\n{{\"type\":\"message\"}}\n", text.trim())).unwrap();
    assert_eq!(
        write_omp_session_header(&dir.0, "sid-1", Path::new("/s/cwd"), None).unwrap(),
        p
    );
    assert_eq!(
        fs::read_to_string(&p)
            .unwrap()
            .split('\n')
            .filter(|l| !l.is_empty())
            .count(),
        2
    );
}

#[test]
fn session_id_shape_is_enforced() {
    let dir = tmpdir();
    for bad in ["", "../x", "a/b", "a.b", "a b"] {
        assert!(matches!(
            write_omp_session_header(&dir.0, bad, Path::new("/c"), None),
            Err(OmpHomeError::SessionId)
        ));
        assert!(omp_session_file(&dir.0, bad).is_none());
    }
    assert!(omp_session_id_ok(&new_omp_session_id()));
}

#[test]
fn session_file_found_by_id() {
    let home = tmpdir();
    write_omp_session_header(
        &omp_dirs(&home.0).sessions_dir,
        "sid-2",
        Path::new("/c"),
        None,
    )
    .unwrap();
    assert!(
        omp_session_file(&home.0, "sid-2")
            .unwrap()
            .to_string_lossy()
            .ends_with("_sid-2.jsonl")
    );
    assert!(omp_session_file(&home.0, "nope").is_none());
}

#[test]
fn recorded_api_error_reads_last_after_since() {
    let home = tmpdir();
    let p = write_omp_session_header(
        &omp_dirs(&home.0).sessions_dir,
        "sid-3",
        Path::new("/c"),
        None,
    )
    .unwrap();
    let row = |ts: &str, msg: &str| {
        json!({ "type": "message", "timestamp": ts,
                "message": { "role": "assistant", "stopReason": "error", "errorMessage": msg } })
        .to_string()
    };
    let user_echo = json!({ "type": "message", "timestamp": "2026-10-25T00:00:09.000Z",
        "message": { "role": "user", "stopReason": "error", "errorMessage": "fake" } })
    .to_string();
    let mut body = fs::read_to_string(&p).unwrap();
    for l in [
        row("2026-10-25T00:00:01.000Z", "old"),
        row("2026-10-25T00:00:05.000Z", "404 first"),
        "{not json \"stopReason\":\"error\"".to_string(),
        row("not-a-time", "bad time"),
        user_echo,
        row("2026-10-25T00:00:07.5Z", "404 last"),
    ] {
        body.push_str(&l);
        body.push('\n');
    }
    fs::write(&p, body).unwrap();
    let since = parse_iso_utc_ms("2026-10-25T00:00:02.000Z").unwrap();
    assert_eq!(
        read_omp_recorded_api_error(&home.0, Some("sid-3"), since).as_deref(),
        Some("404 last")
    );
    let late = parse_iso_utc_ms("2026-10-25T00:00:08.000Z").unwrap();
    assert_eq!(
        read_omp_recorded_api_error(&home.0, Some("sid-3"), late),
        None
    );
    assert_eq!(read_omp_recorded_api_error(&home.0, None, 0), None);
    assert_eq!(read_omp_recorded_api_error(&home.0, Some("nope"), 0), None);
}

#[test]
fn recorded_api_error_is_capped() {
    let home = tmpdir();
    let p = write_omp_session_header(
        &omp_dirs(&home.0).sessions_dir,
        "sid-4",
        Path::new("/c"),
        None,
    )
    .unwrap();
    let long = "가".repeat(3000);
    let line = json!({ "type": "message", "timestamp": "2030-01-01T00:00:00Z",
        "message": { "role": "assistant", "stopReason": "error", "errorMessage": long } });
    fs::write(&p, format!("{line}\n")).unwrap();
    let got = read_omp_recorded_api_error(&home.0, Some("sid-4"), 0).unwrap();
    assert!(got.len() <= RECORDED_ERROR_MAX_BYTES);
    assert!(got.chars().all(|c| c == '가'));
}

#[test]
fn iso_parse_matches_iso_utc() {
    for ms in [0u128, 1_761_300_000_123, 951_782_400_000, 4_102_444_800_999] {
        assert_eq!(parse_iso_utc_ms(&iso_utc(ms)), Some(ms as i64));
    }
    for bad in [
        "2026-10-25T00:00:00+09:00",
        "2026-10-25 00:00:00Z",
        "2026-13-01T00:00:00Z",
        "2026-10-25T00:00:00.Z",
        "",
    ] {
        assert_eq!(parse_iso_utc_ms(bad), None, "{bad}");
    }
}

#[test]
fn readonly_list_is_builtins_plus_single_underscore_glob() {
    let spec = adapter(AgentHarness::Omp).unwrap().readonly_tools.unwrap();
    let list = omp_readonly_tool_list(&spec);
    assert_eq!(list, "read,grep,glob,mcp__harkroom_*");
    assert!(!list.contains("mcp__*"));
    let odd = ReadonlyTools {
        builtins: &["read"],
        mcp_servers: &["a-b.c"],
        list: None,
    };
    assert_eq!(omp_readonly_tool_list(&odd), "read,mcp__a_b_c_*");
}

#[test]
fn to_omp_mcp_drops_unknown_shapes() {
    let out = to_omp_mcp(&mcp(json!({
        "a": { "command": "x" },
        "b": { "type": "http", "url": "https://h" },
        "c": {},
        "d": { "url": "https://s", "type": "sse", "headers": { "X": "1" } },
        "e": { "url": "https://n" },
    })));
    assert_eq!(
        Value::Object(out),
        json!({
            "a": { "command": "x" },
            "b": { "type": "http", "url": "https://h" },
            "d": { "type": "sse", "url": "https://s", "headers": { "X": "1" } },
            "e": { "type": "http", "url": "https://n" },
        })
    );
}

#[test]
fn lane_models_yml_points_key_by_path_and_rejects_odd_input() {
    let m = models(&["Org/model-1"]);
    let yml = omp_lane_models_yml(&lane("https://gw.example", "/s/lease/key", &m)).unwrap();
    assert!(yml.contains("baseUrl: \"https://gw.example/v1\""));
    assert!(yml.contains("apiKey: \"!cat '/s/lease/key'\""));
    assert!(yml.contains("api: openai-completions"));
    assert!(yml.contains("auth: apiKey"));
    assert!(yml.contains("      - id: \"Org/model-1\""));
    assert!(yml.starts_with(&format!("providers:\n  {OMP_LANE_PROVIDER}:\n")));
    let one = models(&["m"]);
    let spaced = "/Users/u/Library/Application Support/app/turn-secrets/k";
    assert!(
        omp_lane_models_yml(&lane("https://g", spaced, &one))
            .unwrap()
            .contains(&format!("apiKey: \"!cat '{spaced}'\""))
    );
    for (url, key, mm, want) in [
        ("https://g", "/k'; id; '", &one, LaneConfigError::KeyPath),
        ("http://gw.example", "/k", &one, LaneConfigError::BaseUrl),
        ("https://g", "/k; rm -rf /", &one, LaneConfigError::KeyPath),
        ("https://g", "k", &one, LaneConfigError::KeyPath),
        (
            "https://g",
            "/k",
            &models(&["m\"\n"]),
            LaneConfigError::ModelName,
        ),
    ] {
        assert_eq!(
            omp_lane_models_yml(&lane(url, key, mm)),
            Err(want),
            "{url} {key}"
        );
    }
    for ok in [
        "http://127.0.0.1:8080",
        "http://localhost:1",
        "http://[::1]:9",
    ] {
        assert!(omp_lane_models_yml(&lane(ok, "/k", &one)).is_ok(), "{ok}");
    }
}

#[test]
fn write_lane_models_is_0600_and_replaces_links() {
    let dir = tmpdir();
    let one = models(&["m"]);
    let target = dir.0.join("elsewhere.yml");
    fs::write(&target, "keep").unwrap();
    std::os::unix::fs::symlink(&target, dir.0.join("models.yml")).unwrap();
    let p = write_omp_lane_models(&dir.0, &lane("https://g", "/k", &one)).unwrap();
    assert_eq!(mode(&p), 0o600);
    assert!(!fs::symlink_metadata(&p).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
    let e = write_omp_lane_models(&dir.0, &lane("http://g", "/k", &one)).unwrap_err();
    assert_eq!(
        e.to_string(),
        "omp lane models.yml: https 또는 로컬 주소만 받는다"
    );
    // 거절되면 앞 파일을 건드리지 않는다.
    assert!(fs::read_to_string(&p).unwrap().contains("https://g/v1"));
}

#[test]
fn binary_check_rejects_unpinned_hash_and_unknown_platform() {
    let dir = tmpdir();
    let bin = dir.0.join("omp");
    fs::write(&bin, "#!/bin/sh\necho omp/18.12.6\n").unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("/nonexistent:{}", dir.0.display());
    assert_eq!(find_omp_binary(Some(&path)), Some(bin.clone()));
    assert!(!omp_binary_ok(&bin, "darwin-arm64"));
    assert!(!omp_binary_ok(&bin, "plan9-mips"));
    assert!(!omp_binary_ok(&dir.0, "darwin-arm64"));
    assert_eq!(find_omp_binary(Some("/nonexistent")), None);
    assert_eq!(find_omp_binary(None), None);
    assert!(
        OMP_BINARY_SHA256
            .iter()
            .any(|(_, p, _)| *p == "darwin-arm64")
    );
    assert!(platform_key().contains('-'));
}

#[test]
fn unverified_notice_has_no_path() {
    let n = omp_unverified_binary_notice();
    assert!(n.contains("18.12.6"));
    assert!(!n.contains('/'));
}
