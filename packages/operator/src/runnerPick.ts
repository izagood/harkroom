/**
 * 에이전트마다 러너 구현을 고른다(B4-5c → L3c-3e). 정본 판정은 여기 한 곳이다 — Rust 오퍼레이터 `runner_pick.rs` 가 같은 표를 따른다.
 *
 * | 로컬 설정·에이전트 | Rust 러너 파일 | 결과 |
 * |---|---|---|
 * | `runner` 가 정확히 `"node"` | — | node(되돌림, 이유 없음) |
 * | `"rust"`·없음(모르는 값 포함) + 하네스가 허용 목록(`RUST_RUNNER_HARNESSES` = claude-code·codex·opencode·kilo·pi·omp) 밖 | — | node, `rust_harness_unsupported` — 모르는 이름도 node |
 * | `"rust"`·없음 + 러너의 풀 해석을 못 한다(`pools.json` 깨짐·뿌리 못 읽음 등) | — | node, `rust_account_pool_unreadable` |
 * | `"rust"`·없음 | 오퍼레이터 옆에 없음 | node, `rust_runner_missing` |
 * | `"rust"`·없음(계정 풀·전용 제공사 경로 포함) | 있음 | rust |
 *
 * s9①: 기본은 rust 다 — `runner` 칸이 없는 에이전트도 위 조건을 모두 넘으면 rust 로 돈다. `runner: "node"` 로 되돌린다.
 *
 * 계정 풀·lane 에이전트도 이제 rust 다(L3c-3e): Rust 러너가 러너와 같은 풀 해석으로 계정 폴더를 고르고(L3c-3b), lane 러너는 그
 * 에이전트 전용 폴더와 턴마다 받은 lane env 로만 돈다(L3c-3d). 「못 읽음은 node」는 그대로다 — 모르면 Rust 러너로 보내지 않는다.
 */
import { runnerKindOf, type LocalAgentConfig, type RunnerKind } from './config.js';

export type RunnerFallback = 'rust_harness_unsupported' | 'rust_account_pool_unreadable' | 'rust_runner_missing';

/** 러너가 계정 풀로 도는가(`@harkroom/shared/claudeAccountLane` 의 `claudeAccountUse`). */
export type AccountUse = 'none' | 'pool' | 'unreadable';

/** Rust 러너로 보내도 되는 하네스 — **허용 목록**이다(배선·시험을 마친 것만). 그 밖(모르는 이름 포함)은 node. */
export const RUST_RUNNER_HARNESSES: readonly string[] = ['claude-code', 'codex', 'opencode', 'kilo', 'pi', 'omp'];

export interface RunnerPick {
  kind: RunnerKind;
  /** rust 대상(청함·기본)인데 node 로 떨어뜨린 이유. `"node"` 로 되돌렸으면 없다. */
  fallback?: RunnerFallback;
}

/**
 * `runner` 칸이 없는 에이전트의 기본이 Rust 인가(Rust `ABSENT_RUNNER_DEFAULTS_TO_RUST` 와 같은 값). `true` = node 가 있어도 기본 Rust.
 * 급할 때 바로 되돌리는 길은 에이전트별 `"runner": "node"` + 재배정이다. 이 상수를 `false` 로 돌리는 전체 되돌리기는 PR·새 앱 판·업데이트가
 * 든다(그러면 「단계」 — node 가 없을 때만 Rust).
 */
export const ABSENT_RUNNER_DEFAULTS_TO_RUST = true;

/** rust 대상인가 — 명시 rust → rust, 명시 node(모르는 값 포함) → node, 칸 없음 → 기본 rust. 이때만 파일·풀 해석을 본다. */
export function wantsRust(local: LocalAgentConfig | undefined, nodePresent: boolean): boolean {
  const kind = runnerKindOf(local);
  if (kind === 'rust') return true;
  if (kind === 'node') return false;
  return ABSENT_RUNNER_DEFAULTS_TO_RUST || !nodePresent;
}

export function pickRunner(
  local: LocalAgentConfig | undefined,
  rustRunnerPresent: boolean,
  accountUse: AccountUse,
  /** 서버 정의의 하네스(`definition.harness`). */
  harness: string,
  /** node 러너를 띄울 수 있는가 — TS 오퍼레이터는 node 위에서 돌아 늘 참이다(Rust 오퍼레이터는 PATH 로 잰다). */
  nodePresent: boolean,
): RunnerPick {
  if (!wantsRust(local, nodePresent)) return { kind: 'node' };
  if (!RUST_RUNNER_HARNESSES.includes(harness)) return { kind: 'node', fallback: 'rust_harness_unsupported' };
  if (accountUse === 'unreadable') return { kind: 'node', fallback: 'rust_account_pool_unreadable' };
  if (!rustRunnerPresent) return { kind: 'node', fallback: 'rust_runner_missing' };
  return { kind: 'rust' };
}
