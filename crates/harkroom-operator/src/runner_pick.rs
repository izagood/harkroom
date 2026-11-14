//! 에이전트마다 러너 구현을 고른다(B4-5c → L3c-3e). 정본은 `packages/operator/src/runnerPick.ts` 이고 표도 같다.
//!
//! | 로컬 설정·에이전트 | Rust 러너 파일 | 결과 |
//! |---|---|---|
//! | `runner` 가 `"rust"` 가 아님(없음·모르는 값) | — | node |
//! | `"rust"` + 하네스가 허용 목록(`RUST_RUNNER_HARNESSES` = claude-code·codex) 밖 | — | node, `rust_harness_unsupported` — Rust 러너는 opencode·kilo·pi·omp 홈을 아직 배선하지 않았다. 홈 배선 조각에서 하나씩 더한다. 모르는 이름도 node |
//! | `"rust"` + 러너의 풀 해석을 못 한다(`pools.json` 깨짐·뿌리 못 읽음 등) | — | node, `rust_account_pool_unreadable` |
//! | `"rust"` | 오퍼레이터 옆에 없음 | node, `rust_runner_missing` |
//! | `"rust"`(계정 풀·전용 제공사 경로 포함) | 있음 | rust |
//!
//! 계정 풀·lane 에이전트도 이제 rust 다(L3c-3e): Rust 러너가 러너와 같은 풀 해석(`harkroom-accounts`)으로 계정 폴더를 고르고
//! (L3c-3b), lane 러너는 그 에이전트 전용 폴더와 턴마다 받은 lane env 로만 돈다(L3c-3d). 「못 읽음은 node」는 그대로다.
//! 풀 해석은 이 crate 도 `harkroom-accounts` 의 같은 함수(`claude_account_use`)로 잰다 — B4-5e 의 넓은 판정을 좁혔다.
use crate::assignments::LocalAgent;
use crate::local_agents::RunnerKind;

/// 러너가 계정 풀로 돌 수 있는가(TS `AccountUse`). 기본값은 닫힌 쪽(`Unreadable`)이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AccountUse {
    None,
    Pool,
    #[default]
    Unreadable,
}

impl From<harkroom_accounts::ClaudeAccountUse> for AccountUse {
    fn from(u: harkroom_accounts::ClaudeAccountUse) -> Self {
        match u {
            harkroom_accounts::ClaudeAccountUse::None => AccountUse::None,
            harkroom_accounts::ClaudeAccountUse::Pool => AccountUse::Pool,
            harkroom_accounts::ClaudeAccountUse::Unreadable => AccountUse::Unreadable,
        }
    }
}

/// Rust 러너로 보내도 되는 하네스 — **허용 목록**(TS `RUST_RUNNER_HARNESSES`). 배선·시험을 마친 것만 둔다.
pub const RUST_RUNNER_HARNESSES: [&str; 2] = ["claude-code", "codex"];

/// `rust` 를 청했는데 node 로 떨어뜨린 이유(TS `RunnerFallback`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerFallback {
    HarnessUnsupported,
    AccountPoolUnreadable,
    RunnerMissing,
}

impl RunnerFallback {
    pub fn as_str(self) -> &'static str {
        match self {
            RunnerFallback::HarnessUnsupported => "rust_harness_unsupported",
            RunnerFallback::AccountPoolUnreadable => "rust_account_pool_unreadable",
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

/// `rust` 를 청했는가 — 이때만 파일·풀 해석을 본다.
pub fn wants_rust(local: Option<&LocalAgent>) -> bool {
    local.is_some_and(|l| l.runner == RunnerKind::Rust)
}

/// TS `pickRunner`. `harness` 는 서버 정의의 하네스 이름이다.
pub fn pick_runner(
    local: Option<&LocalAgent>,
    rust_runner_present: bool,
    account_use: AccountUse,
    harness: &str,
) -> RunnerPick {
    if !wants_rust(local) {
        return RunnerPick::NODE;
    }
    if !RUST_RUNNER_HARNESSES.contains(&harness) {
        return RunnerPick::node_because(RunnerFallback::HarnessUnsupported);
    }
    if account_use == AccountUse::Unreadable {
        return RunnerPick::node_because(RunnerFallback::AccountPoolUnreadable);
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
        assert_eq!(
            pick_runner(None, true, AccountUse::None, "claude-code"),
            RunnerPick::NODE
        );
        assert_eq!(
            pick_runner(
                Some(&LocalAgent::default()),
                true,
                AccountUse::None,
                "claude-code"
            ),
            RunnerPick::NODE
        );
    }

    /// L3c-3e: 계정 풀·lane 에이전트도 rust 다.
    #[test]
    fn pool_and_lane_agents_now_run_on_rust() {
        let pool = LocalAgent {
            claude_pool: Some("p".into()),
            ..rust()
        };
        assert_eq!(
            pick_runner(Some(&pool), true, AccountUse::Pool, "claude-code").kind,
            RunnerKind::Rust
        );
        assert_eq!(
            pick_runner(Some(&rust()), true, AccountUse::Pool, "claude-code").kind,
            RunnerKind::Rust
        );
        let lane = LocalAgent {
            provider_lane: Some(json!({"baseUrl": "https://api.example.com", "secretName": "k1"})),
            ..rust()
        };
        assert_eq!(
            pick_runner(Some(&lane), true, AccountUse::None, "claude-code").kind,
            RunnerKind::Rust
        );
    }

    /// 허용 목록(claude-code·codex) 밖은 풀·lane·파일과 상관없이 node — opencode·kilo·pi·omp·모르는 이름 모두.
    #[test]
    fn only_allowed_harnesses_go_to_rust() {
        for h in [
            "pi",
            "omp",
            "Codex",
            "codex-cli",
            "opencode",
            "kilo",
            "gemini",
            "claude",
            "",
            "new-harness",
        ] {
            let p = pick_runner(Some(&rust()), true, AccountUse::None, h);
            assert_eq!(p.kind, RunnerKind::Node, "{h}");
            assert_eq!(p.fallback, Some(RunnerFallback::HarnessUnsupported), "{h}");
        }
        for h in ["claude-code", "codex"] {
            assert_eq!(
                pick_runner(Some(&rust()), true, AccountUse::None, h).kind,
                RunnerKind::Rust,
                "{h}"
            );
        }
    }

    #[test]
    fn unreadable_and_missing_stay_on_node() {
        assert_eq!(
            pick_runner(Some(&rust()), true, AccountUse::Unreadable, "claude-code").fallback,
            Some(RunnerFallback::AccountPoolUnreadable)
        );
        assert_eq!(AccountUse::default(), AccountUse::Unreadable);
        assert_eq!(
            pick_runner(Some(&rust()), false, AccountUse::None, "claude-code").fallback,
            Some(RunnerFallback::RunnerMissing)
        );
    }
}
