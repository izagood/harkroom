use super::*;

/// 기동 때 모든 XDG 앱(opencode·kilo)의 설정을 러너 홈 안에 쓴다 — 사람 자리에는 쓰지 않는다.
#[test]
fn boot_writes_every_xdg_app_inside_runner_home() {
    let root = std::env::temp_dir().join(format!("hk-ocprep-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("state")).unwrap();
    std::fs::create_dir_all(root.join("person")).unwrap();
    let mcp = root.join("state/mcp.json");
    std::fs::write(
        &mcp,
        r#"{"mcpServers":{"harkroom":{"command":"/bin/op","args":["mcp"]}}}"#,
    )
    .unwrap();
    let prep = OpencodePrep {
        home: root.join("state/opencode-home"),
        lane: false,
        mcp_config_path: mcp,
        user_xdg_config: None,
        user_xdg_data: None,
        user_home: root.join("person"),
        skills_dir: None,
    };
    prep.boot().unwrap();
    for app in all_xdg_apps() {
        let f = crate::opencode_home::opencode_config_file(&prep.home, &app);
        assert!(f.exists(), "{}", app.dir);
    }
    let person: Vec<_> = walk(&root.join("person"));
    assert!(
        person.is_empty(),
        "사람 자리에 아무것도 안 쓴다: {person:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

fn walk(d: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(d)
        .map(|r| r.flatten().map(|e| e.path()).collect())
        .unwrap_or_default()
}
