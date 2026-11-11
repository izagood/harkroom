//! 정본 `packages/agent/test/piLane.test.ts` 의 lane 경우를 옮긴 것 + Rust 쪽에서 좁힌 자리.
use super::*;
use crate::pi_home::ensure_pi_home;
use serde_json::Map;
use std::os::unix::fs::{PermissionsExt, symlink};
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
        "hk-pi-lane-{}-{}",
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
fn models(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}
fn lane<'a>(base_url: &'a str, key_path: &'a str, m: &'a [String]) -> PiLane<'a> {
    PiLane {
        base_url,
        key_path,
        models: m,
    }
}

#[test]
fn thread_home_is_sha256_prefix_and_stable() {
    // sha256("a") = ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb — node createHash 와 같은 값.
    assert_eq!(thread_hash("a"), "ca978112ca1bbdcafac231b3");
    let root = Path::new("/r");
    assert_eq!(
        pi_lane_thread_home(root, "a"),
        PathBuf::from("/r/threads/ca978112ca1bbdcafac231b3")
    );
    assert_ne!(
        pi_lane_thread_home(root, "a"),
        pi_lane_thread_home(root, "b")
    );
    // 키는 글자 그대로(UTF-8) 해시한다.
    assert_eq!(thread_hash("스레드").len(), 24);
}

#[test]
fn ensure_thread_copies_root_settings_and_mcp_as_600() {
    let t = tmpdir();
    let root = t.0.join("lane");
    let mut servers = Map::new();
    servers.insert(
        "harkroom".into(),
        json!({"command": "op", "args": ["mcp-bridge"]}),
    );
    ensure_pi_home(&root, &servers, &t.0.join("none"), true).unwrap();
    let home = ensure_pi_lane_thread(&root, "a").unwrap();
    assert_eq!(home, pi_lane_thread_home(&root, "a"));
    for name in ["settings.json", "mcp.json"] {
        assert_eq!(
            fs::read_to_string(home.join(name)).unwrap(),
            fs::read_to_string(root.join(name)).unwrap()
        );
        assert_eq!(mode(&home.join(name)), 0o600);
    }
    assert_eq!(mode(&home), 0o700);
    assert_eq!(mode(&root.join("threads")), 0o700);
    assert_eq!(mode(&pi_sessions_dir(&home)), 0o700);
    // 멱등 — 루트의 표가 바뀌면 다음 부름에 따라간다.
    fs::write(root.join("mcp.json"), "{\"mcpServers\":{}}\n").unwrap();
    ensure_pi_lane_thread(&root, "a").unwrap();
    assert_eq!(
        fs::read_to_string(home.join("mcp.json")).unwrap(),
        "{\"mcpServers\":{}}\n"
    );
}

#[test]
fn ensure_thread_unlinks_login_links_and_keeps_human_files() {
    let t = tmpdir();
    let human = t.0.join("human");
    fs::create_dir_all(&human).unwrap();
    fs::write(human.join("auth.json"), "{\"x\":1}").unwrap();
    let root = t.0.join("lane");
    ensure_pi_home(&root, &Map::new(), &human, true).unwrap();
    let home = pi_lane_thread_home(&root, "k");
    fs::create_dir_all(&home).unwrap();
    symlink(human.join("auth.json"), home.join("auth.json")).unwrap();
    ensure_pi_lane_thread(&root, "k").unwrap();
    assert!(fs::symlink_metadata(home.join("auth.json")).is_err());
    assert_eq!(
        fs::read_to_string(human.join("auth.json")).unwrap(),
        "{\"x\":1}"
    );
}

#[test]
fn ensure_thread_without_root_fails_without_path_in_display() {
    let t = tmpdir();
    let err = ensure_pi_lane_thread(&t.0.join("missing-root"), "a").unwrap_err();
    let shown = err.to_string();
    assert!(!shown.contains(t.0.to_str().unwrap()), "{shown}");
    assert!(err.local_detail().contains("settings.json"));
}

#[test]
fn models_json_matches_canonical_shape_and_bytes() {
    let m = models(&["Org/model-1"]);
    let text =
        pi_lane_models_json(&lane("https://gateway.example", "/secrets/turn/k", &m)).unwrap();
    // 정본 `JSON.stringify(doc, null, 2) + '\n'` 과 같은 바이트.
    assert_eq!(
        text,
        "{\n  \"providers\": {\n    \"harkroom-lane\": {\n      \"baseUrl\": \"https://gateway.example/v1\",\n      \"api\": \"openai-completions\",\n      \"apiKey\": \"!cat '/secrets/turn/k'\",\n      \"models\": [\n        {\n          \"id\": \"Org/model-1\"\n        }\n      ]\n    }\n  }\n}\n"
    );
    assert_eq!(PI_LANE_PROVIDER, "harkroom-lane");
}

#[test]
fn base_url_https_or_loopback_http_only() {
    let m = models(&["m"]);
    for ok in [
        "https://g.example",
        "https://g.example:8443/root",
        "HTTPS://g.example",
        "http://127.0.0.1:9",
        "http://localhost",
        "http://LOCALHOST:3000",
        "http://[::1]:8080",
    ] {
        assert!(pi_lane_models_json(&lane(ok, "/k", &m)).is_ok(), "{ok}");
    }
    for bad in [
        "http://gateway.example",
        "http://127.0.0.2",
        "http://localhost.evil.example",
        "http://user@localhost",
        "ftp://g.example",
        "https://",
        "g.example",
        "https://g.example/\"x",
        "https://g.example/a b",
        "https://g.example/\\",
        "http://[::1",
        "",
    ] {
        assert_eq!(
            pi_lane_models_json(&lane(bad, "/k", &m)).unwrap_err(),
            LaneConfigError::BaseUrl,
            "{bad}"
        );
    }
}

#[test]
fn key_path_and_model_names_reject_shell_chars() {
    let m = models(&["m"]);
    let spaced = "/Users/u/Library/Application Support/app/turn-secrets/k";
    let doc: Value =
        serde_json::from_str(&pi_lane_models_json(&lane("https://g.example", spaced, &m)).unwrap())
            .unwrap();
    assert_eq!(
        doc["providers"][PI_LANE_PROVIDER]["apiKey"],
        format!("!cat '{spaced}'")
    );
    for key_path in [
        "/k; rm -rf ~",
        "/k $(id)",
        "relative/k",
        "/k'x",
        "/k\nx",
        "/k`x`",
        "",
    ] {
        assert_eq!(
            pi_lane_models_json(&lane("https://g.example", key_path, &m)).unwrap_err(),
            LaneConfigError::KeyPath,
            "{key_path:?}"
        );
    }
    let long = "a".repeat(129);
    for bad in ["m {x}", "", long.as_str(), "m\n"] {
        let mm = models(&[bad]);
        assert_eq!(
            pi_lane_models_json(&lane("https://g.example", "/k", &mm)).unwrap_err(),
            LaneConfigError::ModelName
        );
    }
    let ok = "a".repeat(128);
    assert!(
        pi_lane_models_json(&lane(
            "https://g.example",
            "/k",
            &models(&[&ok, "o/m:1.2_x-y"])
        ))
        .is_ok()
    );
    // 거절 문구에는 입력 값이 실리지 않는다.
    let e = pi_lane_models_json(&lane("https://g.example", "/secret path;x", &m)).unwrap_err();
    assert!(!e.to_string().contains("secret"));
}

#[test]
fn write_models_600_and_replaces_link_without_touching_target() {
    let t = tmpdir();
    let human = t.0.join("human-models.json");
    fs::write(&human, "{\"providers\":{}}").unwrap();
    let home = t.0.join("home");
    fs::create_dir_all(&home).unwrap();
    symlink(&human, home.join("models.json")).unwrap();
    let m = models(&["m"]);
    let p = write_pi_lane_models(&home, &lane("https://g.example", "/k", &m)).unwrap();
    assert_eq!(p, home.join("models.json"));
    assert!(!fs::symlink_metadata(&p).unwrap().file_type().is_symlink());
    assert_eq!(mode(&p), 0o600);
    assert_eq!(fs::read_to_string(&human).unwrap(), "{\"providers\":{}}");
    assert!(fs::read_to_string(&p).unwrap().contains("!cat '/k'"));
    // 거절이면 파일을 건드리지 않는다.
    let before = fs::read_to_string(&p).unwrap();
    let err = write_pi_lane_models(&home, &lane("http://evil.example", "/k", &m)).unwrap_err();
    assert!(matches!(err, PiLaneError::Config(LaneConfigError::BaseUrl)));
    assert_eq!(fs::read_to_string(&p).unwrap(), before);
}
