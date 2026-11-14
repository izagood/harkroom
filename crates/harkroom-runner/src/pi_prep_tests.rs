use super::*;
use std::fs;
use std::os::unix::fs::symlink;
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
        "hk-piprep-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(d.join("state")).unwrap();
    fs::create_dir_all(d.join("person/.pi/agent")).unwrap();
    Tmp(fs::canonicalize(&d).unwrap())
}

/// 사람 pi 루트의 파일 이름·내용·mtime 한 벌.
fn snapshot(d: &Path) -> Vec<(String, String, std::time::SystemTime)> {
    let mut v: Vec<_> = fs::read_dir(d)
        .unwrap()
        .flatten()
        .map(|e| {
            let m = fs::symlink_metadata(e.path()).unwrap();
            (
                e.file_name().to_string_lossy().into_owned(),
                fs::read_to_string(e.path()).unwrap_or_default(),
                m.modified().unwrap(),
            )
        })
        .collect();
    v.sort();
    v
}

fn fixture(t: &Tmp, lane: bool) -> PiPrep {
    let person = t.0.join("person/.pi/agent");
    fs::write(person.join("auth.json"), r#"{"x":{"type":"api_key"}}"#).unwrap();
    fs::write(person.join("models.json"), r#"{"providers":{}}"#).unwrap();
    fs::write(
        person.join("settings.json"),
        r#"{"defaultProvider":"p","defaultModel":"m","packages":["evil"]}"#,
    )
    .unwrap();
    fs::write(
        person.join("mcp.json"),
        r#"{"mcpServers":{"mine":{"command":"/bin/x"}}}"#,
    )
    .unwrap();
    let mcp = t.0.join("state/mcp.json");
    fs::write(
        &mcp,
        r#"{"mcpServers":{"harkroom":{"command":"/bin/op","args":["mcp-bridge"]}}}"#,
    )
    .unwrap();
    let state = t.0.join("state");
    PiPrep {
        home: if lane {
            pi_lane_root(&state).unwrap()
        } else {
            pi_home_dir(&state)
        },
        lane,
        mcp_config_path: mcp,
        source_dir: person,
    }
}

/// 보통 러너: 러너 루트 안에만 쓰고 사람 `~/.pi/agent` 는 이름·내용·mtime 이 그대로다. 로그인·제공자는 링크, 확장은 안 들인다.
#[test]
fn ensure_writes_only_inside_runner_root() {
    let t = tmpdir();
    let prep = fixture(&t, false);
    let before = snapshot(&prep.source_dir);
    prep.ensure().unwrap();
    prep.ensure().unwrap(); // 멱등
    assert_eq!(
        snapshot(&prep.source_dir),
        before,
        "사람 pi 루트는 안 건드린다"
    );
    assert_eq!(prep.home, t.0.join("state/pi-home"));
    for f in ["auth.json", "models.json"] {
        assert_eq!(
            fs::read_link(prep.home.join(f)).unwrap(),
            prep.source_dir.join(f)
        );
    }
    let settings = fs::read_to_string(prep.home.join("settings.json")).unwrap();
    assert!(settings.contains("defaultModel") && !settings.contains("packages"));
    let mcp = fs::read_to_string(prep.home.join("mcp.json")).unwrap();
    assert!(
        mcp.contains("harkroom") && !mcp.contains("mine"),
        "사람 mcp.json 을 물려받지 않는다"
    );
}

/// 턴마다 다시 읽는다 — MCP 표가 바뀌면 다음 `ensure` 가 반영한다.
#[test]
fn ensure_rereads_mcp_table() {
    let t = tmpdir();
    let prep = fixture(&t, false);
    prep.ensure().unwrap();
    fs::write(
        &prep.mcp_config_path,
        r#"{"mcpServers":{"avcs":{"command":"/bin/avcs"}}}"#,
    )
    .unwrap();
    prep.ensure().unwrap();
    let mcp = fs::read_to_string(prep.home.join("mcp.json")).unwrap();
    assert!(mcp.contains("avcs") && !mcp.contains("harkroom"));
}

/// MCP 표를 못 읽으면 실패한다(기동이면 뜨지 않고, 턴이면 띄우지 않는다).
#[test]
fn ensure_fails_without_mcp_table() {
    let t = tmpdir();
    let mut prep = fixture(&t, false);
    prep.mcp_config_path = t.0.join("state/none.json");
    assert!(prep.ensure().is_err());
}

/// lane 러너: lane 루트에 사람 로그인·제공자·설정을 하나도 들이지 않는다. 전에 걸린 링크도 뗀다.
#[test]
fn lane_root_inherits_nothing() {
    let t = tmpdir();
    let prep = fixture(&t, true);
    assert_eq!(prep.home, t.0.join("state/pi-provider-lane"));
    symlink(
        prep.source_dir.join("auth.json"),
        prep.home.join("auth.json"),
    )
    .unwrap();
    let before = snapshot(&prep.source_dir);
    prep.ensure().unwrap();
    assert_eq!(snapshot(&prep.source_dir), before);
    assert!(fs::symlink_metadata(prep.home.join("auth.json")).is_err());
    assert!(fs::symlink_metadata(prep.home.join("models.json")).is_err());
    let settings = fs::read_to_string(prep.home.join("settings.json")).unwrap();
    assert!(!settings.contains("defaultModel"));
}

/// lane 루트 자리가 링크면 거절한다(링크 너머 사람 루트에 쓰지 않게, security #2141 조건과 같은 검사).
#[test]
fn lane_root_rejects_symlink() {
    let t = tmpdir();
    let state = t.0.join("state");
    symlink(t.0.join("person/.pi/agent"), state.join("pi-provider-lane")).unwrap();
    assert!(pi_lane_root(&state).is_err());
}
