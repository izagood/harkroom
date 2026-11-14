/**
 * 에이전트마다 러너 구현을 고른다(B4-5c). 정본 판정은 여기 한 곳이다 — Rust 오퍼레이터 `runner_pick.rs` 가 같은 표를 따른다.
 *
 * | 로컬 설정 | Rust 러너 파일 | 결과 |
 * |---|---|---|
 * | `runner` 가 `"rust"` 가 아님(없음·모르는 값) | — | node |
 * | `"rust"` + 계정 풀(`claudePool`) | — | node, `rust_needs_account_pool` |
 * | `"rust"` + 러너의 풀 해석에서 계정이 나온다(`pools.json` 배정·기본 풀·뿌리 계정, B4-5e) | — | node, `rust_needs_account_pool` |
 * | `"rust"` + 그 해석을 못 한다(`pools.json` 깨짐·뿌리 못 읽음 등) | — | node, `rust_account_pool_unreadable` |
 * | `"rust"` + 전용 제공사 경로(`providerLane`) | — | node, `rust_needs_provider_lane` |
 * | `"rust"` | 오퍼레이터 옆에 없음 | node, `rust_runner_missing` |
 * | `"rust"` | 있음 | rust |
 *
 * 풀·lane 에이전트를 떨어뜨리는 이유: Rust 러너는 아직 계정 풀·lane 을 모른다(L3c-3 몫). 그대로 돌리면 그 에이전트가
 * **사람의 기본 claude 로그인**으로 돌아 다른 계정·과금으로 조용히 바뀐다. L3c-3 이 들어오면 이 두 줄을 걷는다.
 */
import { readProviderLaneConfig } from '@harkroom/shared/providerLane';
import { runnerKindOf, type LocalAgentConfig, type RunnerKind } from './config.js';

export type RunnerFallback = 'rust_needs_account_pool' | 'rust_account_pool_unreadable' | 'rust_needs_provider_lane' | 'rust_runner_missing';

/** 러너가 계정 풀로 도는가(`@harkroom/shared/claudeAccountLane` 의 `claudeAccountUse`). */
export type AccountUse = 'none' | 'pool' | 'unreadable';

export interface RunnerPick {
  kind: RunnerKind;
  /** `rust` 를 청했는데 node 로 떨어뜨린 이유. 청하지 않았으면 없다. */
  fallback?: RunnerFallback;
}

export function pickRunner(local: LocalAgentConfig | undefined, rustRunnerPresent: boolean, accountUse: AccountUse): RunnerPick {
  if (runnerKindOf(local) !== 'rust') return { kind: 'node' };
  if (local?.claudePool) return { kind: 'node', fallback: 'rust_needs_account_pool' };
  // 러너가 실제로 고르는 계정(B4-5e). operator.json 에 `claudePool` 이 없어도 `pools.json` 기본 풀·배정으로 풀에 든다.
  if (accountUse === 'pool') return { kind: 'node', fallback: 'rust_needs_account_pool' };
  if (accountUse !== 'none') return { kind: 'node', fallback: 'rust_account_pool_unreadable' };
  if (readProviderLaneConfig(local?.providerLane) !== null) return { kind: 'node', fallback: 'rust_needs_provider_lane' };
  if (!rustRunnerPresent) return { kind: 'node', fallback: 'rust_runner_missing' };
  return { kind: 'rust' };
}
