/**
 * 로그인이 풀린 Claude 계정의 **전역 경고**를 계정 목록에서 가른다(2026-10-15, 시안 auth-warning-mock).
 *
 * 두 단계다(designer):
 * - **S1** 계정 하나 풀림 — 풀의 다른 계정이 이어받아 일은 돈다. 노랑 카드, 사이드바는 그대로.
 * - **S2** 에이전트가 쓰는 풀 전부 풀림 — 그 에이전트는 멈춘다(러너 78). 빨강 카드·사이드바·OS 알림.
 *
 * 재료는 이 맥 오퍼레이터의 계정 목록(`authFailure`, 러너가 남긴 표식)과 러너 종료 사유(`stopped` — 이 맥
 * 오퍼레이터가 띄운 러너의 `runnerExit` 에서 `harness-login-required` 로 가린 것) 둘뿐이다. **다른 기기의
 * 에이전트는 여기 없다**(B안의 한계) — 커뮤니티를 섞지 않도록 에이전트 이름은 부르는 쪽이 지금 커뮤니티에서
 * 찾는다. 순수 함수다.
 */
import { agentPoolsOf, type ClaudeAccountsSnapshot } from './claudeAccounts';

export interface AuthWarningS1 {
  kind: 's1';
  pool: string;
  account: string;
  /** 그 풀에서 아직 로그인이 살아 있는 계정 수 / 전체. */
  left: number;
  total: number;
  atMs: number;
}

export interface AuthWarningS2 {
  kind: 's2';
  /** 전부 풀린 풀. 러너 종료로만 안 경우(풀을 모름)는 `null`. */
  pool: string | null;
  /** 다시 로그인으로 열 계정 — 그 풀의 첫 번째 풀린 계정. 모르면 `null`. */
  account: string | null;
  total: number;
  /** 멈춘(또는 멈출) 에이전트 id. 이 맥 오퍼레이터 것뿐. */
  agentIds: string[];
  atMs: number;
}

export type AuthWarning = AuthWarningS1 | AuthWarningS2;

/**
 * 경고 목록. 순서는 **S2 먼저**(모든 턴을 막는다), 그다음 S1 — 각 갈래 안에서는 먼저 풀린 순.
 *
 * - 풀 하나의 계정이 **전부** `authFailure` 면 그 풀은 S2 다. 그 풀을 순서에 둔 에이전트 중 **다른 풀도 전부
 *   풀린** 에이전트만 멈춘 것으로 센다(풀 n개면 다음 풀이 받는다). 순서가 없는 에이전트는 기본 풀을 쓴다.
 * - 일부만 풀렸으면 풀린 계정마다 S1.
 * - 러너가 로그인 사유로 물러났는데(`stopped`) 위 어디에도 안 잡힌 에이전트(표식이 안 남은 옛 러너·목록을
 *   못 읽음)는 풀 없는 S2 하나로 모은다 — 모르는 풀을 지어내지 않는다.
 */
export function authWarnings(
  snap: ClaudeAccountsSnapshot | null,
  stopped: ReadonlyMap<string, number>,
): AuthWarning[] {
  const s2: AuthWarningS2[] = [];
  const s1: AuthWarningS1[] = [];
  const deadPools = new Map<string, number>();
  for (const pool of snap?.pools ?? []) {
    const failed = pool.accounts.filter((a) => a.authFailure);
    if (!failed.length) continue;
    const firstAt = Math.min(...failed.map((a) => a.authFailure!.atMs));
    if (failed.length === pool.accounts.length) {
      deadPools.set(pool.name, firstAt);
      s2.push({ kind: 's2', pool: pool.name, account: failed[0]!.name, total: pool.accounts.length, agentIds: [], atMs: firstAt });
    } else {
      for (const a of failed) {
        s1.push({
          kind: 's1', pool: pool.name, account: a.name,
          left: pool.accounts.length - failed.length, total: pool.accounts.length, atMs: a.authFailure!.atMs,
        });
      }
    }
  }
  const placed = new Set<string>();
  if (snap) {
    const agentIds = new Set([...Object.keys(snap.agents), ...stopped.keys()]);
    for (const agentId of agentIds) {
      const chain = agentPoolsOf(snap, agentId);
      const pools = chain.length ? chain : snap.defaultPool !== null ? [snap.defaultPool] : [];
      if (!pools.length || !pools.every((p) => deadPools.has(p))) continue;
      const card = s2.find((c) => c.pool === pools[0]);
      if (card) { card.agentIds.push(agentId); placed.add(agentId); }
    }
  }
  const orphans = [...stopped.entries()].filter(([id]) => !placed.has(id));
  if (orphans.length) {
    s2.push({
      kind: 's2', pool: null, account: null, total: 0,
      agentIds: orphans.map(([id]) => id), atMs: Math.min(...orphans.map(([, at]) => at)),
    });
  }
  const byAt = (a: AuthWarning, b: AuthWarning) => a.atMs - b.atMs;
  return [...s2.sort(byAt), ...s1.sort(byAt)];
}

/**
 * [나중에] 로 접은 카드를 가리는 열쇠. **상태가 나빠지면 열쇠가 바뀐다** — S1→S2 는 갈래가, 다른 계정이
 * 새로 풀리면 계정이, 멈춘 에이전트가 늘면 수가 바뀌어 카드가 다시 선다(시안 ⑤).
 */
export function authWarningKey(w: AuthWarning): string {
  return w.kind === 's1'
    ? `s1:${w.pool}:${w.account}:${w.atMs}`
    : `s2:${w.pool ?? ''}:${w.agentIds.length}:${w.atMs}`;
}
