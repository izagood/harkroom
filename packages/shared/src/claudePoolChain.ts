// 에이전트 하나에 붙은 **풀 여러 개의 순서**를 판정한다(2026-10-15, 풀 n개 — designer 시안 pool_chain).
//
// 규칙(jaebin 결정 D1~D5 전부 A):
// - 풀 순서는 에이전트마다 `pools.json` 의 `agents[id]` 목록이다(D1).
// - 풀이 **소진**됐다 = 그 풀의 계정이 **모두** 새 배정 기준(풀별, 기본 5시간 85% · 주간 97%)에
//   닿았다(D2). 풀 안에서 계정을 고르는 `agent/src/accountAssign.ts` 가 "더 줄 계정이 없다"고 보는
//   바로 그 선이다 — 그래서 화면의 숫자도 하나로 설명된다.
// - 새 스레드는 소진되지 않은 **첫** 풀로 간다. 앞 풀이 풀리면 새 스레드부터 앞으로 돌아온다(D3 —
//   이미 붙은 스레드는 옮기기 기준에서만 옮긴다, 그 판단은 러너 몫).
// - 모두 소진되면 멈추지 않는다 — 가장 먼저 풀리는 풀로 보낸다(D4).
// - 목록이 비었을 때만 기본 풀을 쓴다(D5 — 이 모듈 밖, `agentPoolChain` 호출자).
//
// **러너와 화면(설정 › 에이전트)이 같이 쓴다.** 두 곳이 다른 식을 쓰면 화면이 "1번을 쓴다"고 하는데
// 러너는 2번으로 보내는 날이 온다. 파일 I/O·시계는 인자로 받는다(웹뷰가 import 한다).
//
// **모르는 계정은 소진이 아니다.** 사용량을 못 읽었거나 낡은 계정을 "다 썼다"로 보면 조회 실패
// 하나로 멀쩡한 풀을 건너뛴다 — `pickAccount` 가 모르는 계정에 자격을 주는 것과 같은 규율이다.
import {
  resolveAssignThresholds,
  type ClaudeAssignThresholds,
  type ClaudePoolsConfig,
} from './claudePools.js';
import { isUsageFresh, type ClaudeUsageEntry } from './claudeUsage.js';
import type { ProviderUsageWindow } from './daemonProtocol.js'; // 타입만

/** 계정 하나가 새 배정 기준에 닿았는가와 그 이유. */
export interface PoolChainAccount {
  account: string;
  /** 믿을 만한(신선한) 사용량이 있나. 거짓이면 아래 % 는 `null` 이고 `hot` 은 거짓이다. */
  known: boolean;
  sessionPct: number | null;
  weeklyPct: number | null;
  /** 새 배정 기준에 닿았나(또는 사람이 지나야 하는 관문에 막혔나). */
  hot: boolean;
  /** 걸린 창. 둘 다면 `'both'`, 관문이면 `'blocked'`. */
  hotBy: 'session' | 'weekly' | 'both' | 'blocked' | null;
  /** 걸린 창이 모두 풀리는 시각. 모르면 `null`. */
  unblockAtMs: number | null;
}

export type PoolChainStatus =
  /** 새 스레드를 받을 수 있다. */
  | 'available'
  /** 계정이 모두 기준에 닿았다. */
  | 'exhausted'
  /** 이 기기에 그 풀 디렉터리가 없다 — 건너뛴다(목록에서 몰래 빼지 않는다). */
  | 'missing'
  /** 풀은 있는데 계정이 없다 — 건너뛴다. */
  | 'empty';

export interface PoolChainEntry {
  pool: string;
  status: PoolChainStatus;
  accounts: PoolChainAccount[];
  thresholds: ClaudeAssignThresholds;
  /** 소진이면 가장 먼저 풀리는 계정의 시각(한 계정이라도 풀리면 풀은 다시 쓸 수 있다). */
  unblockAtMs: number | null;
  /** 소진이면 어느 창 때문인가 — 계정마다 다르면 `'mixed'`. */
  exhaustedBy: 'session' | 'weekly' | 'mixed' | 'blocked' | null;
}

export interface PoolChainState {
  entries: PoolChainEntry[];
  /**
   * 새 스레드가 갈 풀의 자리(`entries` 의 인덱스). 소진되지 않은 첫 풀이고, 모두 소진이면 가장 먼저
   * 풀리는 풀이다(D4). 쓸 수 있는 풀이 하나도 없으면(전부 없음·빈 풀) `null`.
   */
  activeIndex: number | null;
  /** 쓸 수 있는 풀이 모두 소진이다(D4 — 그래도 `activeIndex` 로 보낸다). */
  allExhausted: boolean;
}

export interface PoolChainInput {
  /** 에이전트의 풀 순서(`agentPoolChain`). */
  chain: readonly string[];
  /** 디스크에 있는 풀 → 그 안의 계정 이름. 여기 없는 풀은 `missing` 이다. */
  accountsByPool: ReadonlyMap<string, readonly string[]>;
  /** usage.json 의 항목(모든 풀). `pool`·`account` 로 맞춘다. */
  usage: readonly ClaudeUsageEntry[];
  /** 풀별 기준을 읽을 설정. `null` 이면 기본값. */
  cfg: ClaudePoolsConfig | null;
  now: number;
  /** 사람이 지나야 하는 관문에 막힌 계정(`claudeGates`). 막힌 계정은 새 스레드를 못 받는다. */
  blocked?: (pool: string, account: string) => boolean;
}

/** 창이 기준에 닿았나. 이미 초기화 시각을 지난 창은 아직 다시 재지 않았어도 풀린 것으로 본다. */
function windowHot(w: ProviderUsageWindow | null, pct: number, now: number): boolean {
  if (!w || w.usedPercent < pct) return false;
  return w.resetsAtMs === null || w.resetsAtMs > now;
}

export function poolChainAccount(
  account: string, entry: ClaudeUsageEntry | undefined,
  t: ClaudeAssignThresholds, now: number, blocked: boolean,
): PoolChainAccount {
  const fresh = entry && isUsageFresh(entry, now) && entry.weekly ? entry : null;
  const sessionPct = fresh?.session?.usedPercent ?? null;
  const weeklyPct = fresh?.weekly?.usedPercent ?? null;
  if (blocked) {
    return { account, known: Boolean(fresh), sessionPct, weeklyPct, hot: true, hotBy: 'blocked', unblockAtMs: null };
  }
  if (!fresh) {
    return { account, known: false, sessionPct: null, weeklyPct: null, hot: false, hotBy: null, unblockAtMs: null };
  }
  const s = windowHot(fresh.session, t.newSessionPct, now);
  const w = windowHot(fresh.weekly, t.newWeeklyPct, now);
  const resets = [
    ...(s ? [fresh.session!.resetsAtMs] : []),
    ...(w ? [fresh.weekly!.resetsAtMs] : []),
  ];
  // 둘 다 걸렸으면 둘 다 풀려야 쓸 수 있다 — 늦은 쪽. 하나라도 모르면 모른다.
  const unblockAtMs = resets.length && resets.every((r) => r !== null) ? Math.max(...(resets as number[])) : null;
  return {
    account, known: true, sessionPct, weeklyPct, hot: s || w,
    hotBy: s && w ? 'both' : s ? 'session' : w ? 'weekly' : null,
    unblockAtMs,
  };
}

/** 에이전트의 풀 순서를 판정한다. **순수 함수다.** */
export function poolChainState(input: PoolChainInput): PoolChainState {
  const { chain, accountsByPool, usage, cfg, now } = input;
  const entries: PoolChainEntry[] = chain.map((pool) => {
    const thresholds = resolveAssignThresholds(cfg, pool);
    const names = accountsByPool.get(pool);
    if (!names) return { pool, status: 'missing', accounts: [], thresholds, unblockAtMs: null, exhaustedBy: null };
    const accounts = names.map((account) => poolChainAccount(
      account, usage.find((e) => e.pool === pool && e.account === account), thresholds, now,
      input.blocked?.(pool, account) ?? false,
    ));
    if (!accounts.length) return { pool, status: 'empty', accounts, thresholds, unblockAtMs: null, exhaustedBy: null };
    if (!accounts.every((a) => a.hot)) {
      return { pool, status: 'available', accounts, thresholds, unblockAtMs: null, exhaustedBy: null };
    }
    const known = accounts.map((a) => a.unblockAtMs).filter((v): v is number => v !== null);
    const kinds = new Set(accounts.map((a) => (a.hotBy === 'both' ? 'weekly' : a.hotBy)));
    return {
      pool, status: 'exhausted', accounts, thresholds,
      unblockAtMs: known.length ? Math.min(...known) : null,
      exhaustedBy: kinds.size === 1 ? ([...kinds][0] as 'session' | 'weekly' | 'blocked') : 'mixed',
    };
  });

  const first = entries.findIndex((e) => e.status === 'available');
  if (first >= 0) return { entries, activeIndex: first, allExhausted: false };
  const out = entries.map((e, i) => [e, i] as const).filter(([e]) => e.status === 'exhausted');
  if (!out.length) return { entries, activeIndex: null, allExhausted: false };
  // 모두 소진(D4): 가장 먼저 풀리는 풀. 시각을 모르는 풀은 뒤로, 같으면 목록 순서.
  const soonest = [...out].sort(([a, i], [b, j]) =>
    (a.unblockAtMs ?? Infinity) - (b.unblockAtMs ?? Infinity) || i - j)[0]!;
  return { entries, activeIndex: soonest[1], allExhausted: true };
}
