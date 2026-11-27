//! `claude_named_pool_known` — 서버가 준 풀 이름은 이 기기에 **설정된 이름 있는 풀**일 때만 받는다(s34 J2c-2, security J1·B1).
//! 실제 디렉터리로 잰다: `pools.json` 이 없으면 해석이 강제 풀 이름을 보지 않으므로, 가짜 판정으로는 이 경우가 안 잡힌다.
use harkroom_accounts::{ClaudeAccountUse, claude_account_use, claude_named_pool_known};
use std::fs;
use std::path::{Path, PathBuf};

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("hk-acct-known-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn env(root: &Path) -> impl Fn(&str) -> Option<String> + '_ {
    move |k| (k == "HARKROOM_CLAUDE_ACCOUNTS_DIR").then(|| root.to_string_lossy().into_owned())
}

#[test]
fn flat_accounts_without_pools_json_know_no_pool_name() {
    let root = tmp("flat");
    fs::create_dir_all(root.join("acct-a")).unwrap();
    // 넓은 판정은 어떤 이름이든 「풀로 돈다」고 답한다 — 이것이 B1 이다.
    assert_eq!(
        claude_account_use("agent-1", Some("team"), env(&root), &root),
        ClaudeAccountUse::Pool
    );
    assert!(!claude_named_pool_known("team", env(&root), &root));
    // 평평한 계정 이름을 풀 이름으로 줘도 받지 않는다.
    assert!(!claude_named_pool_known("acct-a", env(&root), &root));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn only_configured_named_pools_with_accounts_are_known() {
    let root = tmp("named");
    fs::create_dir_all(root.join("team/acct-a")).unwrap();
    fs::create_dir_all(root.join("empty")).unwrap();
    fs::write(root.join("pools.json"), r#"{"defaultPool":"team"}"#).unwrap();
    assert!(claude_named_pool_known("team", env(&root), &root));
    // 풀 목록에 없는 이름 — 기본 풀이 있어도 대신 받지 않는다.
    assert!(!claude_named_pool_known("other", env(&root), &root));
    // 풀은 있는데 계정이 없다.
    assert!(!claude_named_pool_known("empty", env(&root), &root));
    // 문법 밖 이름·빈 이름.
    assert!(!claude_named_pool_known("", env(&root), &root));
    assert!(!claude_named_pool_known("../team", env(&root), &root));
    assert!(!claude_named_pool_known("Team", env(&root), &root));
    // 해석이 거절하는 이름.
    fs::create_dir_all(root.join("constructor/acct-a")).unwrap();
    assert!(!claude_named_pool_known("constructor", env(&root), &root));
    // `pools.json` 이 깨졌으면 닫힌 쪽.
    fs::write(root.join("pools.json"), "{").unwrap();
    assert!(!claude_named_pool_known("team", env(&root), &root));
    let _ = fs::remove_dir_all(&root);
}
