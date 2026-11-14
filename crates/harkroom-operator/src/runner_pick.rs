//! 에이전트마다 러너 구현을 고른다(B4-5c). 정본은 `packages/operator/src/runnerPick.ts` 이고 표도 같다.
//!
//! | 로컬 설정 | Rust 러너 파일 | 결과 |
//! |---|---|---|
//! | `runner` 가 `"rust"` 가 아님(없음·모르는 값) | — | node |
//! | `"rust"` + 계정 풀(`claudePool`) | — | node, `rust_needs_account_pool` |
//! | `"rust"` + 전용 제공사 경로(`providerLane`) | — | node, `rust_needs_provider_lane` |
//! | `"rust"` | 오퍼레이터 옆에 없음 | node, `rust_runner_missing` |
//! | `"rust"` | 있음 | rust |
//!
//! 풀·lane 에이전트를 떨어뜨리는 이유: Rust 러너는 아직 계정 풀·lane 을 모른다(L3c-3 몫). 그대로 돌리면 그 에이전트가
//! **사람의 기본 claude 로그인**으로 돌아 다른 계정·과금으로 조용히 바뀐다. L3c-3 이 들어오면 이 두 줄을 걷는다.
use crate::assignments::LocalAgent;
use crate::local_agents::{RunnerKind, read_provider_lane_config};

/// `rust` 를 청했는데 node 로 떨어뜨린 이유(TS `RunnerFallback`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerFallback {
    NeedsAccountPool,
    NeedsProviderLane,
    RunnerMissing,
}

impl RunnerFallback {
    pub fn as_str(self) -> &'static str {
        match self {
            RunnerFallback::NeedsAccountPool => "rust_needs_account_pool",
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
pub fn pick_runner(local: Option<&LocalAgent>, rust_runner_present: bool) -> RunnerPick {
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
        assert_eq!(pick_runner(None, true), RunnerPick::NODE);
        assert_eq!(
            pick_runner(Some(&LocalAgent::default()), true),
            RunnerPick::NODE
        );
    }

    #[test]
    fn rust_with_file_is_rust() {
        let p = pick_runner(Some(&rust()), true);
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
            pick_runner(Some(&pool), true).fallback,
            Some(RunnerFallback::NeedsAccountPool)
        );
        let lane = LocalAgent {
            provider_lane: Some(json!({"baseUrl": "https://api.example.com", "secretName": "k1"})),
            ..rust()
        };
        let p = pick_runner(Some(&lane), true);
        assert_eq!(p.kind, RunnerKind::Node);
        assert_eq!(p.fallback, Some(RunnerFallback::NeedsProviderLane));
        assert_eq!(
            pick_runner(Some(&rust()), false).fallback,
            Some(RunnerFallback::RunnerMissing)
        );
    }
}
