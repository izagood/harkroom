//! 에이전트마다 러너 구현을 고른다(B4-5c). 정본은 `packages/operator/src/runnerPick.ts` 이고 표도 같다.
//!
//! | 로컬 설정 | Rust 러너 파일 | 결과 |
//! |---|---|---|
//! | `runner` 가 `"rust"` 가 아님(없음·모르는 값) | — | node |
//! | `"rust"` + 계정 풀(`claudePool`) | — | node, `rust_needs_account_pool` |
//! | `"rust"` + 계정 뿌리에 계정 폴더가 있거나 `pools.json` 이 있다(B4-5e) | — | node, `rust_needs_account_pool` |
//! | `"rust"` + 그것을 못 읽는다 | — | node, `rust_account_pool_unreadable` |
//!
//! B4-5e: 이 판(Rust 오퍼레이터)에는 러너의 풀 해석(`loadClaudeAccountLane`)이 없다. 그래서 TS 처럼 「계정이 나오는가」를 좁게
//! 재지 않고 **넓게** 막는다 — 계정 폴더나 `pools.json` 이 하나라도 있으면 node 다(좁게 맞추려다 빠뜨리는 쪽보다 낫다).
//! | `"rust"` + 전용 제공사 경로(`providerLane`) | — | node, `rust_needs_provider_lane` |
//! | `"rust"` | 오퍼레이터 옆에 없음 | node, `rust_runner_missing` |
//! | `"rust"` | 있음 | rust |
//!
//! 풀·lane 에이전트를 떨어뜨리는 이유: Rust 러너는 아직 계정 풀·lane 을 모른다(L3c-3 몫). 그대로 돌리면 그 에이전트가
//! **사람의 기본 claude 로그인**으로 돌아 다른 계정·과금으로 조용히 바뀐다. L3c-3 이 들어오면 이 두 줄을 걷는다.
use crate::assignments::LocalAgent;
use crate::local_agents::{RunnerKind, read_provider_lane_config};

/// `rust` 를 청했는데 node 로 떨어뜨린 이유(TS `RunnerFallback`).
/// 러너가 계정 풀로 돌 수 있는가(TS `AccountUse`). 기본값은 닫힌 쪽(`Unreadable`)이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AccountUse {
    None,
    Pool,
    #[default]
    Unreadable,
}

/// B4-5e 넓은 판정 — 계정 뿌리에 디렉터리(링크 포함)가 하나라도 있거나 `pools.json` 이 있으면 `Pool`.
/// 뿌리·파일을 못 읽으면(없음 말고) `Unreadable`. 둘 다 없으면 `None`.
pub fn account_use_broad(root: &std::path::Path, pools_path: &std::path::Path) -> AccountUse {
    match std::fs::symlink_metadata(pools_path) {
        Ok(_) => return AccountUse::Pool,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return AccountUse::Unreadable,
    }
    let entries = match std::fs::read_dir(root) {
        Ok(it) => it,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return AccountUse::None,
        Err(_) => return AccountUse::Unreadable,
    };
    for entry in entries {
        let Ok(entry) = entry else {
            return AccountUse::Unreadable;
        };
        match entry.file_type() {
            Ok(t) if t.is_dir() || t.is_symlink() => return AccountUse::Pool,
            Ok(_) => {}
            Err(_) => return AccountUse::Unreadable,
        }
    }
    AccountUse::None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerFallback {
    AccountPoolUnreadable,
    NeedsAccountPool,
    NeedsProviderLane,
    RunnerMissing,
}

impl RunnerFallback {
    pub fn as_str(self) -> &'static str {
        match self {
            RunnerFallback::NeedsAccountPool => "rust_needs_account_pool",
            RunnerFallback::AccountPoolUnreadable => "rust_account_pool_unreadable",
            RunnerFallback::NeedsProviderLane => "rust_needs_provider_lane",
            RunnerFallback::RunnerMissing => "rust_runner_missing",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunnerPick {
    pub kind: RunnerKind,
    pub fallback: Option<RunnerFallback>,
}

impl RunnerPick {
    pub const NODE: RunnerPick = RunnerPick {
        kind: RunnerKind::Node,
        fallback: None,
    };

    fn node_because(f: RunnerFallback) -> Self {
        RunnerPick {
            kind: RunnerKind::Node,
            fallback: Some(f),
        }
    }
}

/// `rust` 를 청했는가 — 이때만 파일을 찾아본다.
pub fn wants_rust(local: Option<&LocalAgent>) -> bool {
    local.is_some_and(|l| l.runner == RunnerKind::Rust)
}

/// TS `pickRunner`.
pub fn pick_runner(
    local: Option<&LocalAgent>,
    rust_runner_present: bool,
    account_use: AccountUse,
) -> RunnerPick {
    let Some(l) = local.filter(|l| l.runner == RunnerKind::Rust) else {
        return RunnerPick::NODE;
    };
    if l.claude_pool.as_deref().is_some_and(|p| !p.is_empty()) {
        return RunnerPick::node_because(RunnerFallback::NeedsAccountPool);
    }
    if l.provider_lane
        .as_ref()
        .and_then(read_provider_lane_config)
        .is_some()
    {
        return RunnerPick::node_because(RunnerFallback::NeedsProviderLane);
    }
    match account_use {
        AccountUse::Pool => return RunnerPick::node_because(RunnerFallback::NeedsAccountPool),
        AccountUse::Unreadable => {
            return RunnerPick::node_because(RunnerFallback::AccountPoolUnreadable);
        }
        AccountUse::None => {}
    }
    if !rust_runner_present {
        return RunnerPick::node_because(RunnerFallback::RunnerMissing);
    }
    RunnerPick {
        kind: RunnerKind::Rust,
        fallback: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rust() -> LocalAgent {
        LocalAgent {
            runner: RunnerKind::Rust,
            ..Default::default()
        }
    }

    #[test]
    fn not_rust_is_node_without_reason() {
        assert_eq!(pick_runner(None, true, AccountUse::None), RunnerPick::NODE);
        assert_eq!(
            pick_runner(Some(&LocalAgent::default()), true, AccountUse::None),
            RunnerPick::NODE
        );
    }

    /// B4-5e 넓은 판정: pools.json 이 있거나 뿌리에 계정 폴더가 있으면 Pool, 둘 다 없으면 None.
    #[test]
    fn account_use_broad_blocks_any_pools_file_or_account_dir() {
        let base = std::env::temp_dir().join(format!("op-acct-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let case = |name: &str| {
            let r = base.join(name);
            std::fs::create_dir_all(&r).unwrap();
            r
        };
        // 아무것도 없다(뿌리 없음) → None
        let none = base.join("missing");
        assert_eq!(
            account_use_broad(&none, &none.join("pools.json")),
            AccountUse::None
        );
        // 빈 뿌리 → None
        let empty = case("empty");
        assert_eq!(
            account_use_broad(&empty, &empty.join("pools.json")),
            AccountUse::None
        );
        // 기본 풀만(pools.json + work/<계정>) → Pool
        let dp = case("default-pool");
        std::fs::write(dp.join("pools.json"), r#"{"defaultPool":"work"}"#).unwrap();
        std::fs::create_dir_all(dp.join("work/acct-a")).unwrap();
        assert_eq!(
            account_use_broad(&dp, &dp.join("pools.json")),
            AccountUse::Pool
        );
        // 에이전트 배정만(pools.json 에 agents) → Pool
        let asg = case("assign");
        std::fs::write(
            asg.join("pools.json"),
            r#"{"agents":{"00000000-0000-4000-8000-000000000001":["p1"]}}"#,
        )
        .unwrap();
        assert_eq!(
            account_use_broad(&asg, &asg.join("pools.json")),
            AccountUse::Pool
        );
        // pools.json 깨짐 → Pool(있기만 해도 막는다)
        let broken = case("broken");
        std::fs::write(broken.join("pools.json"), "{ not json").unwrap();
        assert_eq!(
            account_use_broad(&broken, &broken.join("pools.json")),
            AccountUse::Pool
        );
        // 뿌리에 계정 폴더만(암묵 풀) → Pool
        let implicit = case("implicit");
        std::fs::create_dir_all(implicit.join("acct-a")).unwrap();
        assert_eq!(
            account_use_broad(&implicit, &implicit.join("pools.json")),
            AccountUse::Pool
        );
        // 뿌리가 파일이라 읽지 못한다 → Unreadable
        let file_root = base.join("file-root");
        std::fs::write(&file_root, "x").unwrap();
        assert_eq!(
            account_use_broad(&file_root, &base.join("nope.json")),
            AccountUse::Unreadable
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn account_use_pool_or_unreadable_falls_back_to_node() {
        assert_eq!(
            pick_runner(Some(&rust()), true, AccountUse::Pool).fallback,
            Some(RunnerFallback::NeedsAccountPool)
        );
        assert_eq!(
            pick_runner(Some(&rust()), true, AccountUse::Unreadable).fallback,
            Some(RunnerFallback::AccountPoolUnreadable)
        );
        assert_eq!(AccountUse::default(), AccountUse::Unreadable);
    }

    #[test]
    fn rust_with_file_is_rust() {
        let p = pick_runner(Some(&rust()), true, AccountUse::None);
        assert_eq!(p.kind, RunnerKind::Rust);
        assert_eq!(p.fallback, None);
    }

    #[test]
    fn pool_and_lane_and_missing_fall_back_to_node() {
        let pool = LocalAgent {
            claude_pool: Some("p".into()),
            ..rust()
        };
        assert_eq!(
            pick_runner(Some(&pool), true, AccountUse::None).fallback,
            Some(RunnerFallback::NeedsAccountPool)
        );
        let lane = LocalAgent {
            provider_lane: Some(json!({"baseUrl": "https://api.example.com", "secretName": "k1"})),
            ..rust()
        };
        let p = pick_runner(Some(&lane), true, AccountUse::None);
        assert_eq!(p.kind, RunnerKind::Node);
        assert_eq!(p.fallback, Some(RunnerFallback::NeedsProviderLane));
        assert_eq!(
            pick_runner(Some(&rust()), false, AccountUse::None).fallback,
            Some(RunnerFallback::RunnerMissing)
        );
    }
}
