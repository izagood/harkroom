//! L3c-3b: 계정 축 — 풀 해석 → 스레드별 고르기 → 시도마다 그 계정의 `CLAUDE_CONFIG_DIR`·기록 홈.
use super::*;
use crate::adapter::{AgentHarness, MentionPermission};
use crate::turn_attempt_account::AttemptAccount;
use crate::turn_command::{TurnCommandOptions, build_turn_command};
use crate::turn_preset::TurnMode;
use std::fs;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("hk-acct-lane-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

/// 이 Mac 모양을 자리표시로: operator.json 에 claudePool 이 없고 `pools.json` 기본 풀 `work` 에 계정 둘.
fn default_pool_root(name: &str) -> PathBuf {
    let root = tmp(name);
    fs::create_dir_all(root.join("work/acct-a")).unwrap();
    fs::create_dir_all(root.join("work/acct-b")).unwrap();
    fs::write(root.join("pools.json"), r#"{"defaultPool":"work"}"#).unwrap();
    root
}

fn hub_at(root: &Path) -> AccountLaneHub {
    let env = BTreeMap::from([(
        "HARKROOM_CLAUDE_ACCOUNTS_DIR".to_string(),
        root.to_string_lossy().into_owned(),
    )]);
    let source = LaneSource::from_env(
        &env,
        Path::new("/nonexistent-home"),
        "00000000-0000-4000-8000-000000000001",
    );
    let store = Arc::new(SessionStore::new(root.join("sessions.json")));
    AccountLaneHub::start(source, store, Arc::new(|_l: &str| {})).unwrap()
}

#[test]
fn default_pool_gives_both_accounts_in_failover_order() {
    let root = default_pool_root("order");
    let hub = hub_at(&root);
    let lane = hub.lane_for("thread-1", None);
    let dirs: Vec<PathBuf> = lane
        .iter()
        .flatten()
        .map(|a| a.config_dir.clone())
        .collect();
    assert_eq!(dirs.len(), 2, "{lane:?}");
    for d in &dirs {
        assert!(d.starts_with(root.join("work")), "{d:?}");
    }
    assert!(
        lane.iter()
            .flatten()
            .all(|a| a.pool.as_deref() == Some("work"))
    );
    let snap = hub.snapshot();
    assert_eq!(snap.pool.as_deref(), Some("work"));
    assert_eq!(snap.lane.iter().flatten().count(), 2);
    let _ = fs::remove_dir_all(&root);
}

/// 조건 b: `CLAUDE_CONFIG_DIR` 는 시도마다 **그 계정 폴더로만** 간다 — 앞 시도·부모 env·기본 옵션의 값이 넘어오지 않는다.
/// 계정을 넘길 때(failover) 기록 찾기 홈도 같이 바뀐다.
#[test]
fn each_attempt_gets_only_its_account_config_dir_and_history_home() {
    let root = default_pool_root("attempts");
    let hub = hub_at(&root);
    let lane = hub.lane_for("thread-1", None);
    let stale = root.join("stale-config");
    let parent_env = BTreeMap::from([(
        "CLAUDE_CONFIG_DIR".to_string(),
        stale.to_string_lossy().into_owned(),
    )]);
    let mut base = TurnCommandOptions::new(
        AgentHarness::ClaudeCode,
        TurnMode::Mention,
        MentionPermission::Auto,
        "/opt/harkroom/harkroom-operator",
    );
    base.session_id = Some("00000000-0000-4000-8000-0000000000aa");
    base.claude_config_dir = Some(&stale);
    let mut seen = Vec::new();
    for (i, acc) in lane.iter().enumerate() {
        let att = AttemptAccount::of(acc.as_ref(), i + 1 == lane.len());
        let want = acc.as_ref().unwrap().config_dir.clone();
        let opts = att.command(&base);
        assert_eq!(opts.claude_config_dir, Some(want.as_path()));
        let plan = build_turn_command(&opts, &parent_env, Path::new("/nonexistent-home")).unwrap();
        assert_eq!(
            plan.env.get("CLAUDE_CONFIG_DIR").map(PathBuf::from),
            Some(want.clone()),
            "시도 {i}"
        );
        assert_eq!(
            att.homes(None, None, None).claude_config_dir,
            Some(want.clone()),
            "시도 {i} 기록 홈"
        );
        seen.push(want);
    }
    assert_eq!(seen.len(), 2);
    assert_ne!(seen[0], seen[1], "넘긴 시도는 다른 계정 폴더다");
    assert!(!seen.contains(&stale));
    let _ = fs::remove_dir_all(&root);
}

/// 지운 계정은 다음 턴의 축에서 빠진다 — 그 경로를 claude 가 새로 만들어 미로그인으로 뜨지 않게(정본 `presentAccounts`).
#[test]
fn deleted_account_drops_out_and_all_gone_is_default_login() {
    let root = default_pool_root("present");
    let hub = hub_at(&root);
    fs::remove_dir_all(root.join("work/acct-b")).unwrap();
    let lane = hub.lane_for("thread-1", None);
    assert_eq!(lane.iter().flatten().count(), 1, "{lane:?}");
    fs::remove_dir_all(root.join("work/acct-a")).unwrap();
    assert_eq!(hub.lane_for("thread-1", None), vec![None]);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn no_accounts_root_is_default_login() {
    let root = tmp("none").join("missing");
    let hub = hub_at(&root);
    assert_eq!(hub.lane_for("thread-1", None), vec![None]);
}

/// security 권고: `constructor` 풀은 TS 처럼 거절한다 — 러너가 뜨지 않는다(기본 로그인으로 돌지 않는다).
#[test]
fn constructor_pool_refuses_to_start() {
    let root = tmp("ctor");
    fs::create_dir_all(root.join("constructor/acct-a")).unwrap();
    fs::write(root.join("pools.json"), r#"{"defaultPool":"constructor"}"#).unwrap();
    let env = BTreeMap::from([(
        "HARKROOM_CLAUDE_ACCOUNTS_DIR".to_string(),
        root.to_string_lossy().into_owned(),
    )]);
    let source = LaneSource::from_env(&env, Path::new("/nonexistent-home"), "agent-1");
    let store = Arc::new(SessionStore::new(root.join("sessions.json")));
    let err = AccountLaneHub::start(source, store, Arc::new(|_l: &str| {}))
        .err()
        .unwrap();
    assert!(err.contains("constructor"), "{err}");
    let _ = fs::remove_dir_all(&root);
}
