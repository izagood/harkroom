/**
 * 에이전트마다 러너 구현을 고른다(B4-5c → L3c-3e). 정본 판정은 여기 한 곳이다 — Rust 오퍼레이터 `runner_pick.rs` 가 같은 표를 따른다.
 *
 * | 로컬 설정·에이전트 | Rust 러너 파일 | 결과 |
 * |---|---|---|
 * | `runner` 가 `"rust"` 가 아님(없음·모르는 값) | — | node |
 * | `"rust"` + 하네스가 pi·omp | — | node, `rust_harness_unsupported` — Rust 러너는 pi·omp 홈을 아직 짓지 않는다(배선 뒤 푼다) |
 * | `"rust"` + 러너의 풀 해석을 못 한다(`pools.json` 깨짐·뿌리 못 읽음 등) | — | node, `rust_account_pool_unreadable` |
 * | `"rust"` | 오퍼레이터 옆에 없음 | node, `rust_runner_missing` |
 * | `"rust"`(계정 풀·전용 제공사 경로 포함) | 있음 | rust |
 *
 * 계정 풀·lane 에이전트도 이제 rust 다(L3c-3e): Rust 러너가 러너와 같은 풀 해석으로 계정 폴더를 고르고(L3c-3b), lane 러너는 그
 * 에이전트 전용 폴더와 턴마다 받은 lane env 로만 돈다(L3c-3d). 「못 읽음은 node」는 그대로다 — 모르면 Rust 러너로 보내지 않는다.
 */
import { runnerKindOf, type LocalAgentConfig, type RunnerKind } from './config.js';

export type RunnerFallback = 'rust_harness_unsupported' | 'rust_account_pool_unreadable' | 'rust_runner_missing';

/** 러너가 계정 풀로 도는가(`@harkroom/shared/claudeAccountLane` 의 `claudeAccountUse`). */
export type AccountUse = 'none' | 'pool' | 'unreadable';

/** Rust 러너가 아직 돌리지 못하는 하네스(홈 배선 전). */
export const RUST_RUNNER_UNSUPPORTED_HARNESSES: readonly string[] = ['pi', 'omp'];

export interface RunnerPick {
  kind: RunnerKind;
  /** `rust` 를 청했는데 node 로 떨어뜨린 이유. 청하지 않았으면 없다. */
  fallback?: RunnerFallback;
}

export function pickRunner(
  local: LocalAgentConfig | undefined,
  rustRunnerPresent: boolean,
  accountUse: AccountUse,
  /** 서버 정의의 하네스(`definition.harness`). */
  harness: string,
): RunnerPick {
  if (runnerKindOf(local) !== 'rust') return { kind: 'node' };
  if (RUST_RUNNER_UNSUPPORTED_HARNESSES.includes(harness)) return { kind: 'node', fallback: 'rust_harness_unsupported' };
  if (accountUse === 'unreadable') return { kind: 'node', fallback: 'rust_account_pool_unreadable' };
  if (!rustRunnerPresent) return { kind: 'node', fallback: 'rust_runner_missing' };
  return { kind: 'rust' };
}
