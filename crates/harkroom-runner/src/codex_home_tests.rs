use super::*;
use std::os::unix::fs::PermissionsExt;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "hk-codexhome-{name}-{}-{}",
        std::process::id(),
        tmp_suffix()
    ));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn env(pairs: &[(&str, &str)]) -> Env {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn login(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join("auth.json"), "{}").unwrap();
}

#[test]
fn account_name_grammar_matches_ts() {
    assert!(is_account_name("work-1"));
    for bad in ["", "Work", "a/b", "..", "a_b", &"a".repeat(33)] {
        assert!(!is_account_name(bad), "{bad:?}");
    }
}

#[test]
fn roots_follow_env() {
    let e = env(&[("HOME", "/h")]);
    assert_eq!(source_codex_home(&e), PathBuf::from("/h/.codex"));
    assert_eq!(
        codex_accounts_root(&e),
        PathBuf::from("/h/.harkroom-agent/codex-accounts")
    );
    let e = env(&[
        ("HOME", "/h"),
        ("CODEX_HOME", "/x/./c/"),
        ("HARKROOM_CODEX_ACCOUNTS_DIR", "/a/../acc"),
    ]);
    assert_eq!(source_codex_home(&e), PathBuf::from("/x/c"));
    assert_eq!(codex_accounts_root(&e), PathBuf::from("/acc"));
}

#[test]
fn active_file_per_community() {
    let root = Path::new("/acc");
    assert_eq!(
        codex_active_file_path(root, &env(&[])).unwrap(),
        PathBuf::from("/acc/active.json")
    );
    let on = env(&[(PER_COMMUNITY_ENV, "1"), (OPERATOR_ROOT_ENV, "/r/x/")]);
    assert_eq!(
        codex_active_file_path(root, &on).unwrap(),
        PathBuf::from("/r/x/codex-active.json")
    );
    let bad = env(&[(PER_COMMUNITY_ENV, "1"), (OPERATOR_ROOT_ENV, "rel")]);
    assert!(codex_active_file_path(root, &bad).is_err());
}

#[test]
fn auth_source_falls_back_to_system() {
    let d = tmp("src");
    let acc = d.join("acc");
    let e = env(&[
        ("HOME", "/h"),
        ("CODEX_HOME", "/sys"),
        ("HARKROOM_CODEX_ACCOUNTS_DIR", acc.to_str().unwrap()),
    ]);
    let system = AuthSource {
        home: PathBuf::from("/sys"),
        account: None,
    };
    // 파일 없음
    assert_eq!(codex_auth_source(&e), system);
    fs::create_dir_all(&acc).unwrap();
    // 깨진 파일
    fs::write(acc.join("active.json"), "{").unwrap();
    assert_eq!(codex_auth_source(&e), system);
    // 문법 밖 이름(경로 칸)
    fs::write(acc.join("active.json"), r#"{"active":"../x"}"#).unwrap();
    assert_eq!(codex_auth_source(&e), system);
    // 계정은 있는데 로그인 없음
    fs::write(acc.join("active.json"), r#"{"active":"work"}"#).unwrap();
    assert_eq!(codex_auth_source(&e), system);
    login(&acc.join("work"));
    assert_eq!(
        codex_auth_source(&e),
        AuthSource {
            home: acc.join("work"),
            account: Some("work".into())
        }
    );
    // 스위치가 켜졌는데 뿌리가 틀리면 던지지 않고 시스템
    let mut e2 = e.clone();
    e2.insert(PER_COMMUNITY_ENV.into(), "1".into());
    assert_eq!(codex_auth_source(&e2), system);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn ensure_home_links_only_when_login_exists() {
    let d = tmp("ensure");
    let home = d.join("agent/codex-home");
    let src = d.join("sys");
    ensure_codex_home(&home, &src, &KnownHomes::default()).unwrap();
    assert_eq!(
        fs::metadata(&home).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(
        fs::symlink_metadata(home.join("auth.json")).is_err(),
        "원본이 없으면 만들지 않는다"
    );
    login(&src);
    ensure_codex_home(&home, &src, &KnownHomes::default()).unwrap();
    assert_eq!(
        fs::read_link(home.join("auth.json")).unwrap(),
        src.join("auth.json")
    );
    // 같은 자리면 그대로
    ensure_codex_home(&home, &src, &KnownHomes::default()).unwrap();
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn ensure_home_keeps_dedicated_login_file() {
    let d = tmp("file");
    let home = d.join("h");
    let src = d.join("sys");
    login(&src);
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("auth.json"), "mine").unwrap();
    ensure_codex_home(&home, &src, &KnownHomes::default()).unwrap();
    assert_eq!(fs::read_to_string(home.join("auth.json")).unwrap(), "mine");
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn ensure_home_switches_between_known_places_only() {
    let d = tmp("switch");
    let home = d.join("h");
    let sys = d.join("sys");
    let acc = d.join("acc");
    login(&sys);
    login(&acc.join("a"));
    login(&acc.join("b"));
    let known = KnownHomes {
        homes: vec![sys.clone()],
        accounts_root: Some(acc.clone()),
    };
    ensure_codex_home(&home, &sys, &known).unwrap();
    ensure_codex_home(&home, &acc.join("a"), &known).unwrap();
    assert_eq!(
        fs::read_link(home.join("auth.json")).unwrap(),
        acc.join("a/auth.json")
    );
    ensure_codex_home(&home, &acc.join("b"), &known).unwrap();
    assert_eq!(
        fs::read_link(home.join("auth.json")).unwrap(),
        acc.join("b/auth.json")
    );
    ensure_codex_home(&home, &sys, &known).unwrap();
    assert_eq!(
        fs::read_link(home.join("auth.json")).unwrap(),
        sys.join("auth.json")
    );
    // 임시 링크가 남지 않는다
    let left: Vec<_> = fs::read_dir(&home)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left.len(), 1, "{left:?}");
    // 모르는 자리를 가리키면 고치지 않고 실패
    let stranger = d.join("stranger");
    login(&stranger);
    fs::remove_file(home.join("auth.json")).unwrap();
    symlink(stranger.join("auth.json"), home.join("auth.json")).unwrap();
    let err = ensure_codex_home(&home, &sys, &known).unwrap_err();
    assert!(
        matches!(err, CodexHomeError::UnexpectedAuthLink { .. }),
        "{err}"
    );
    assert_eq!(
        fs::read_link(home.join("auth.json")).unwrap(),
        stranger.join("auth.json")
    );
    // 계정 뿌리 아래라도 한 단계 더 깊으면 모르는 자리
    login(&acc.join("a/deep"));
    fs::remove_file(home.join("auth.json")).unwrap();
    symlink(acc.join("a/deep/auth.json"), home.join("auth.json")).unwrap();
    assert!(ensure_codex_home(&home, &sys, &known).is_err());
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn sync_follows_active_account() {
    let d = tmp("sync");
    let home = d.join("h");
    let sys = d.join("sys");
    let acc = d.join("acc");
    login(&sys);
    login(&acc.join("work"));
    let e = env(&[
        ("HOME", "/h"),
        ("CODEX_HOME", sys.to_str().unwrap()),
        ("HARKROOM_CODEX_ACCOUNTS_DIR", acc.to_str().unwrap()),
    ]);
    assert_eq!(sync_codex_auth(&home, &e).unwrap(), None);
    assert_eq!(
        fs::read_link(home.join("auth.json")).unwrap(),
        sys.join("auth.json")
    );
    fs::write(acc.join("active.json"), r#"{"active":"work"}"#).unwrap();
    assert_eq!(sync_codex_auth(&home, &e).unwrap(), Some("work".into()));
    assert_eq!(
        fs::read_link(home.join("auth.json")).unwrap(),
        acc.join("work/auth.json")
    );
    assert_eq!(codex_sessions_dir(&home), home.join("sessions"));
    let _ = fs::remove_dir_all(&d);
}
