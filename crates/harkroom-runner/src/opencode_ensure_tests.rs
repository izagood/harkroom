use super::*;
use crate::opencode_home::OPENCODE_APP;
use std::os::unix::fs::PermissionsExt as _;

struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn root(tag: &str) -> Root {
    let r = std::env::temp_dir().join(format!("hk-ocx-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&r);
    fs::create_dir_all(&r).unwrap();
    Root(r)
}

/// 사람 설정(개인 MCP·provider·모델)과 사람 로그인을 갖춘 자리.
fn person(r: &Root) -> (PathBuf, PathBuf) {
    let cfg = r.0.join("person/config/opencode");
    let data = r.0.join("person/data/opencode");
    fs::create_dir_all(&cfg).unwrap();
    fs::create_dir_all(&data).unwrap();
    fs::write(
        cfg.join("opencode.json"),
        r#"{
          // 사람 설정
          "provider": {"p": {"npm": "x"}},
          "model": "p/m1",
          "mcp": {"personal": {"type": "local", "command": ["leak"]}},
          "agent": {"mine": {}},
        }"#,
    )
    .unwrap();
    fs::write(data.join("auth.json"), "{}").unwrap();
    (cfg, data)
}

fn mcp() -> Map<String, Value> {
    serde_json::from_value(json!({"harkroom": {"command": "/bin/op", "args": ["mcp"]}})).unwrap()
}

fn read(p: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
}

fn mode(p: &Path) -> u32 {
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}

/// 사람 설정에서는 provider·model 만 오고, MCP 는 오퍼레이터 표뿐이다(사람 개인 MCP 가 턴에 붙지 않는다). 로그인은 링크로 빌린다.
#[test]
fn non_lane_inherits_only_provider_and_model_and_links_login() {
    let r = root("plain");
    let (cfg, data) = person(&r);
    let home = r.0.join("state/opencode-home");
    let m = mcp();
    let o = EnsureOpencodeHome {
        opencode_home: &home,
        mcp_servers: &m,
        app: &OPENCODE_APP,
        user_config_dir: &cfg,
        user_data_dir: &data,
        provider_lane: None,
    };
    ensure_opencode_home(&o).unwrap();
    let file = opencode_config_file(&home, &OPENCODE_APP);
    let c = read(&file);
    assert_eq!(c["provider"], json!({"p": {"npm": "x"}}));
    assert_eq!(c["model"], "p/m1");
    assert!(
        c["mcp"].get("personal").is_none(),
        "사람 개인 MCP 는 안 온다"
    );
    assert!(c["mcp"].get("harkroom").is_some());
    assert!(c["agent"].get("mine").is_none(), "사람 agent 칸도 안 온다");
    assert_eq!(
        c["agent"][OPENCODE_READONLY_AGENT]["permission"]["bash"],
        "deny"
    );
    assert_eq!(c["agent"][OPENCODE_READONLY_AGENT]["model"], "p/m1");
    assert_eq!(mode(&file), 0o600);
    assert_eq!(mode(&home), 0o700);
    let auth = opencode_dirs(&home)
        .xdg_data_home
        .join("opencode/auth.json");
    assert_eq!(fs::read_link(&auth).unwrap(), data.join("auth.json"));
    // 멱등 — 다시 불러도 같다.
    ensure_opencode_home(&o).unwrap();
    assert_eq!(read(&file), c);
}

/// 로그인 링크가 엉뚱한 곳을 가리키면 실패한다. 러너 전용 로그인(일반 파일)은 보존한다.
#[test]
fn unexpected_auth_link_fails_and_own_login_is_kept() {
    let r = root("auth");
    let (cfg, data) = person(&r);
    let home = r.0.join("state/opencode-home");
    let target = home.join("data/opencode");
    fs::create_dir_all(&target).unwrap();
    symlink(r.0.join("elsewhere.json"), target.join("auth.json")).unwrap();
    let m = mcp();
    let o = EnsureOpencodeHome {
        opencode_home: &home,
        mcp_servers: &m,
        app: &OPENCODE_APP,
        user_config_dir: &cfg,
        user_data_dir: &data,
        provider_lane: None,
    };
    assert!(matches!(
        ensure_opencode_home(&o),
        Err(EnsureError::UnexpectedAuthLink)
    ));
    fs::remove_file(target.join("auth.json")).unwrap();
    fs::write(target.join("auth.json"), "own").unwrap();
    ensure_opencode_home(&o).unwrap();
    assert_eq!(fs::read_to_string(target.join("auth.json")).unwrap(), "own");
}

/// lane 러너: 사람 provider·로그인을 물리지 않는다(남은 링크는 뗀다). lane 블록·채널 칸을 쓰고 잠금 파일을 남기지 않는다.
#[test]
fn lane_uses_no_person_config_or_login() {
    let r = root("lane");
    let (cfg, data) = person(&r);
    let home = r.0.join("state/opencode-home");
    let target = home.join("data/opencode");
    fs::create_dir_all(&target).unwrap();
    symlink(data.join("auth.json"), target.join("auth.json")).unwrap();
    let m = mcp();
    let allows = vec!["Bash(git status)".to_string()];
    let ch_id = "11111111-2222-4333-8444-555555555555";
    ensure_opencode_home(&EnsureOpencodeHome {
        opencode_home: &home,
        mcp_servers: &m,
        app: &OPENCODE_APP,
        user_config_dir: &cfg,
        user_data_dir: &data,
        provider_lane: Some(LaneHome {
            model: Some("claude-x"),
            skills_dir: None,
            channel: Some((ch_id, &allows)),
        }),
    })
    .unwrap();
    let c = read(&opencode_config_file(&home, &OPENCODE_APP));
    assert!(c["provider"].get("p").is_none(), "사람 provider 없음");
    assert!(c["provider"].get("harkroom-lane").is_some());
    let ch = opencode_lane_agent_name(ch_id).unwrap();
    assert_eq!(
        c["agent"][&ch]["permission"]["bash"],
        Value::Object(lane_opencode_bash_table(&allows))
    );
    assert!(
        fs::symlink_metadata(target.join("auth.json")).is_err(),
        "사람 로그인 링크를 뗀다"
    );
    assert!(data.join("auth.json").exists(), "사람 파일은 그대로");
    assert!(!opencode_config_lock_path(&home).exists());
}

/// 러너 홈 자리가 링크면 거절한다(링크 너머 폴더에 쓰지 않는다).
#[test]
fn symlinked_home_is_refused() {
    let r = root("link");
    let (cfg, data) = person(&r);
    let elsewhere = r.0.join("someone");
    fs::create_dir_all(&elsewhere).unwrap();
    fs::create_dir_all(r.0.join("state")).unwrap();
    let home = r.0.join("state/opencode-home");
    symlink(&elsewhere, &home).unwrap();
    let m = mcp();
    let e = ensure_opencode_home(&EnsureOpencodeHome {
        opencode_home: &home,
        mcp_servers: &m,
        app: &OPENCODE_APP,
        user_config_dir: &cfg,
        user_data_dir: &data,
        provider_lane: None,
    });
    assert!(matches!(e, Err(EnsureError::Io(_))));
    assert_eq!(
        fs::read_dir(&elsewhere).unwrap().count(),
        0,
        "링크 너머에 아무것도 안 쓴다"
    );
}

/// 주인이 죽은 잠금은 걷고 잡는다. 산 주인의 잠금은 시한까지 기다린 뒤 실패한다.
#[test]
fn config_lock_takes_dead_owner_and_times_out_on_live() {
    let r = root("lock");
    let lock = r.0.join(".config.lock");
    fs::write(&lock, "999999 1\n").unwrap();
    let got = with_config_lock(
        &lock,
        Duration::from_millis(200),
        Duration::from_secs(30),
        || Ok(7),
    );
    assert_eq!(got.unwrap(), 7);
    assert!(!lock.exists());
    fs::write(&lock, format!("{} 1\n", std::process::id())).unwrap();
    let e = with_config_lock(
        &lock,
        Duration::from_millis(100),
        Duration::from_secs(30),
        || Ok(1),
    );
    assert!(matches!(e, Err(EnsureError::LockTimeout)));
}
