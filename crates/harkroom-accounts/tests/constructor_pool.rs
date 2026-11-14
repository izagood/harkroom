//! TS 는 풀 이름이 `constructor` 면 `orderAccounts` 에서 던진다(`cfg.order[pool]` 이 `Object` 함수). Rust 도 거절한다(L3c-3b,
//! security 권고). 골든 밖 — TS 의 오류 문구가 엔진 문구(`… is not a function`)라 골든에 싣지 않는다.
use harkroom_accounts::load_claude_account_lane;
use std::fs;
use std::path::PathBuf;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("hk-acct-ctor-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn constructor_pool_is_refused_like_ts() {
    let root = tmp("default");
    fs::create_dir_all(root.join("constructor/acct-a")).unwrap();
    fs::write(root.join("pools.json"), r#"{"defaultPool":"constructor"}"#).unwrap();
    let err = load_claude_account_lane(&root, "agent-1", None, None, |_| None).unwrap_err();
    assert!(err.contains("constructor"), "{err}");
    // 강제 풀도 같다(TS 도 accountsIn → orderAccounts 를 지난다).
    let err = load_claude_account_lane(&root, "agent-1", Some("constructor"), None, |_| None)
        .unwrap_err();
    assert!(err.contains("constructor"), "{err}");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn constructor_pool_with_explicit_order_follows_ts() {
    // `HARKROOM_CLAUDE_ACCOUNTS` 가 있으면 TS 는 orderAccounts 를 거치지 않는다 — 던지지 않는다.
    let root = tmp("ordered");
    fs::create_dir_all(root.join("constructor/acct-a")).unwrap();
    fs::write(root.join("pools.json"), r#"{"defaultPool":"constructor"}"#).unwrap();
    let lane = load_claude_account_lane(&root, "agent-1", None, Some("acct-a"), |_| None).unwrap();
    assert_eq!(lane.accounts.len(), 1);
    let _ = fs::remove_dir_all(&root);
}
