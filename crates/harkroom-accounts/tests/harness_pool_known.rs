//! `named_pool_known(하네스, 이름)` — 풀은 (하네스, 이름)으로 가리고, 네 조건은 하네스마다 같다(CR3).
//! 실제 디렉터리로 잰다(`named_pool_known.rs` 와 같은 까닭).
use harkroom_accounts::{
    AccountHarness, CODEX_DEFAULT_POOL, accounts_root, claude_named_pool_known, is_account_name,
    named_pool_known, pools_file_path,
};
use std::fs;
use std::path::{Path, PathBuf};

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("hk-acct-harness-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

/// 그 하네스의 계정 뿌리만 `root` 로 돌린다.
fn env(h: AccountHarness, root: &Path) -> impl Fn(&str) -> Option<String> + '_ {
    move |k| (k == h.accounts_dir_env()).then(|| root.to_string_lossy().into_owned())
}

fn known(h: AccountHarness, name: &str, root: &Path) -> bool {
    named_pool_known(h, name, env(h, root), root)
}

#[test]
fn harness_parse_takes_only_the_allow_list() {
    assert_eq!(
        AccountHarness::parse("claude"),
        Some(AccountHarness::Claude)
    );
    assert_eq!(AccountHarness::parse("codex"), Some(AccountHarness::Codex));
    for h in AccountHarness::ALL {
        assert_eq!(AccountHarness::parse(h.as_str()), Some(h));
    }
    for bad in [
        "",
        " ",
        "../x",
        "claude/..",
        "claude/",
        "/codex",
        "codex/../claude",
        "Claude",
        "CODEX",
        " codex",
        "codex ",
        "codex\0",
        "claude-accounts",
        "codex-accounts",
        "gemini",
        ".",
        "..",
    ] {
        assert_eq!(AccountHarness::parse(bad), None, "{bad:?}");
    }
}

#[test]
fn roots_and_pools_files_come_from_fixed_names() {
    let none = |_: &str| None;
    let home = Path::new("/h");
    assert_eq!(
        accounts_root(AccountHarness::Claude, none, home),
        PathBuf::from("/h/.harkroom-agent/claude-accounts")
    );
    assert_eq!(
        accounts_root(AccountHarness::Codex, none, home),
        PathBuf::from("/h/.harkroom-agent/codex-accounts")
    );
    // 남의 하네스 env 는 보지 않는다.
    let claude_only = |k: &str| (k == "HARKROOM_CLAUDE_ACCOUNTS_DIR").then(|| "/c".to_string());
    assert_eq!(
        accounts_root(AccountHarness::Codex, claude_only, home),
        PathBuf::from("/h/.harkroom-agent/codex-accounts")
    );
    for h in AccountHarness::ALL {
        assert_eq!(
            pools_file_path(h, Path::new("/r"), none),
            Ok(PathBuf::from("/r/pools.json"))
        );
    }
    let per = |k: &str| match k {
        "HARKROOM_OPERATOR_PER_COMMUNITY" => Some("1".to_string()),
        "HARKROOM_OPERATOR_ROOT" => Some("/op/c1".to_string()),
        _ => None,
    };
    assert_eq!(
        pools_file_path(AccountHarness::Claude, Path::new("/r"), per),
        Ok(PathBuf::from("/op/c1/claude-pools.json"))
    );
    assert_eq!(
        pools_file_path(AccountHarness::Codex, Path::new("/r"), per),
        Ok(PathBuf::from("/op/c1/codex-pools.json"))
    );
    let bad = |k: &str| (k == "HARKROOM_OPERATOR_PER_COMMUNITY").then(|| "1".to_string());
    for h in AccountHarness::ALL {
        assert!(pools_file_path(h, Path::new("/r"), bad).is_err());
    }
}

/// 네 조건이 하나씩 빠지면 거짓, 다 맞으면 참 — 하네스마다.
#[test]
fn four_conditions_hold_per_harness() {
    for h in AccountHarness::ALL {
        let root = tmp(&format!("four-{}", h.as_str()));
        fs::create_dir_all(root.join("team/acct-a")).unwrap();
        fs::create_dir_all(root.join("empty")).unwrap();

        // (a) 풀 설정 파일이 없다.
        assert!(!known(h, "team", &root), "{h:?} (a)");

        fs::write(root.join("pools.json"), r#"{"defaultPool":"team"}"#).unwrap();
        // 다 맞는다.
        assert!(known(h, "team", &root), "{h:?} all");
        // (b) 풀 목록에 없는 이름 — 기본 풀이 있어도 대신 받지 않는다.
        assert!(!known(h, "other", &root), "{h:?} (b)");
        // (b) 풀 아래 계정 이름은 풀 이름이 아니다.
        assert!(!known(h, "acct-a", &root), "{h:?} (b) account");
        // (d) 풀은 있는데 계정이 없다.
        assert!(!known(h, "empty", &root), "{h:?} (d)");
        // (c) 해석이 거절하는 이름 — lane 이 그 풀로 나오지 않는다.
        fs::create_dir_all(root.join("constructor/acct-a")).unwrap();
        assert!(!known(h, "constructor", &root), "{h:?} (c)");
        // 문법 밖 이름·빈 이름.
        for bad in ["", "../team", "team/..", "Team", "team/acct-a"] {
            assert!(!known(h, bad, &root), "{h:?} {bad:?}");
        }
        // (a) 파일이 있는데 해석되지 않는다.
        fs::write(root.join("pools.json"), "{").unwrap();
        assert!(!known(h, "team", &root), "{h:?} broken");
        let _ = fs::remove_dir_all(&root);
    }
}

/// 한 하네스의 풀은 다른 하네스의 풀이 아니다.
#[test]
fn pools_are_keyed_by_harness() {
    let home = tmp("keyed");
    let claude = home.join(".harkroom-agent/claude-accounts");
    let codex = home.join(".harkroom-agent/codex-accounts");
    fs::create_dir_all(claude.join("team/acct-a")).unwrap();
    fs::write(claude.join("pools.json"), "{}").unwrap();
    fs::create_dir_all(codex.join("night/acct-b")).unwrap();
    fs::write(codex.join("pools.json"), "{}").unwrap();
    let none = |_: &str| None;
    assert!(named_pool_known(
        AccountHarness::Claude,
        "team",
        none,
        &home
    ));
    assert!(!named_pool_known(
        AccountHarness::Codex,
        "team",
        none,
        &home
    ));
    assert!(named_pool_known(
        AccountHarness::Codex,
        "night",
        none,
        &home
    ));
    assert!(!named_pool_known(
        AccountHarness::Claude,
        "night",
        none,
        &home
    ));
    // 옛 이름은 claude 판 그대로다.
    assert!(claude_named_pool_known("team", none, &home));
    assert!(!claude_named_pool_known("night", none, &home));
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn codex_active_json_is_a_one_account_pool_under_the_reserved_name_only() {
    let h = AccountHarness::Codex;
    assert!(is_account_name(CODEX_DEFAULT_POOL));
    let root = tmp("codex-active");
    fs::create_dir_all(root.join("work")).unwrap();
    fs::write(root.join("work/auth.json"), "{}").unwrap();

    // `active.json` 이 없으면 기본 풀도 없다.
    assert!(!known(h, CODEX_DEFAULT_POOL, &root));

    fs::write(root.join("active.json"), r#"{"active":"work"}"#).unwrap();
    assert!(known(h, CODEX_DEFAULT_POOL, &root));
    // 다른 이름은 `active.json` 에 닿지 않는다 — 활성 계정 이름 자체도.
    for other in ["work", "team", "active", "default-2", "defaul", "codex"] {
        assert!(!known(h, other, &root), "{other:?}");
    }
    // claude 에는 이 물러섬이 없다.
    assert!(!known(AccountHarness::Claude, CODEX_DEFAULT_POOL, &root));

    // 가리킨 계정에 로그인이 없다 · 문법 밖 이름 · 계정 없음 · 깨진 파일 — 빈 풀.
    fs::create_dir_all(root.join("nologin")).unwrap();
    for body in [
        r#"{"active":"nologin"}"#,
        r#"{"active":"gone"}"#,
        r#"{"active":"../work"}"#,
        r#"{"active":null}"#,
        r#"{}"#,
        "{",
    ] {
        fs::write(root.join("active.json"), body).unwrap();
        assert!(!known(h, CODEX_DEFAULT_POOL, &root), "{body}");
    }
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn codex_pools_json_turns_the_fallback_off() {
    let h = AccountHarness::Codex;
    let root = tmp("codex-nofallback");
    fs::create_dir_all(root.join("work")).unwrap();
    fs::write(root.join("work/auth.json"), "{}").unwrap();
    fs::write(root.join("active.json"), r#"{"active":"work"}"#).unwrap();
    assert!(known(h, CODEX_DEFAULT_POOL, &root));

    // 풀 설정이 생기면 예약된 이름도 여느 풀 이름이다 — 그 이름의 풀 디렉터리가 없으니 거짓.
    fs::write(root.join("pools.json"), "{}").unwrap();
    assert!(!known(h, CODEX_DEFAULT_POOL, &root));
    // 깨진 풀 설정도 「있다」다 — 물러서지 않는다.
    fs::write(root.join("pools.json"), "{").unwrap();
    assert!(!known(h, CODEX_DEFAULT_POOL, &root));
    // 그 이름의 풀이 계정을 가지면 풀 설정으로 참이다.
    fs::write(root.join("pools.json"), "{}").unwrap();
    fs::create_dir_all(root.join("default/acct-a")).unwrap();
    assert!(known(h, CODEX_DEFAULT_POOL, &root));
    let _ = fs::remove_dir_all(&root);
}

/// 커뮤니티마다 프로세스 모드 — 풀 설정·활성 계정 파일 둘 다 커뮤니티 뿌리에서 읽는다.
#[test]
fn codex_per_community_files() {
    let h = AccountHarness::Codex;
    let root = tmp("codex-percomm");
    let op = tmp("codex-percomm-op");
    fs::create_dir_all(root.join("work")).unwrap();
    fs::write(root.join("work/auth.json"), "{}").unwrap();
    fs::create_dir_all(root.join("team/acct-a")).unwrap();
    // 기계에 하나인 자리의 파일은 이 모드에서 보지 않는다.
    fs::write(root.join("active.json"), r#"{"active":"work"}"#).unwrap();
    let get = |k: &str| match k {
        "HARKROOM_CODEX_ACCOUNTS_DIR" => Some(root.to_string_lossy().into_owned()),
        "HARKROOM_OPERATOR_PER_COMMUNITY" => Some("1".to_string()),
        "HARKROOM_OPERATOR_ROOT" => Some(op.to_string_lossy().into_owned()),
        _ => None,
    };
    assert!(!named_pool_known(h, CODEX_DEFAULT_POOL, get, &root));
    fs::write(op.join("codex-active.json"), r#"{"active":"work"}"#).unwrap();
    assert!(named_pool_known(h, CODEX_DEFAULT_POOL, get, &root));
    assert!(!named_pool_known(h, "team", get, &root));
    fs::write(op.join("codex-pools.json"), "{}").unwrap();
    assert!(named_pool_known(h, "team", get, &root));
    assert!(!named_pool_known(h, CODEX_DEFAULT_POOL, get, &root));
    // 커뮤니티 뿌리가 틀리면 닫힌 쪽.
    let bad = |k: &str| match k {
        "HARKROOM_OPERATOR_ROOT" => Some("rel".to_string()),
        other => get(other),
    };
    assert!(!named_pool_known(h, "team", bad, &root));
    assert!(!named_pool_known(h, CODEX_DEFAULT_POOL, bad, &root));
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&op);
}
