/**
 * 계정별 한도 사용률(2026-09-28, 2단계) — 웹뷰 쪽.
 *
 * 호출 순서는 데몬이 정한다(`operator/src/usageChain.ts`): **CLI → (실패하면) API.**
 * CLI(`claude -p /usage`, `codex app-server` → `account/rateLimits/read`)와 API(`/api/oauth/usage`,
 * `wham/usage`)는 **출처가 같다** — CLI 가 안에서 그 API 를 부른다. 그래서 켜고 끌 것이 없다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ProviderAccountUsage, ProviderUsageSnapshot, ProviderUsageWindow } from '@harkroom/shared/daemonProtocol';
import { errorTextNow } from './errorText';

export type { ProviderAccountUsage, ProviderUsageSnapshot, ProviderUsageWindow };

/** 폴 간격. 데몬이 계정마다 CLI 를 띄우므로 길게 — 데몬도 2분 캐시를 둔다. */
export const PROVIDER_USAGE_POLL_MS = 60_000;

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
function invoke(): Invoke | null {
  const g = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } };
  return g.__TAURI_INTERNALS__?.invoke ?? null;
}

export type ProviderKind = 'claude' | 'codex';

const COMMAND: Record<ProviderKind, string> = {
  claude: 'claude_accounts_provider_usage',
  codex: 'codex_accounts_provider_usage',
};

/** [Refresh usage] 의 대상. 비우면 전부, `account`(+claude 는 `pool`)를 주면 그 계정만. */
export interface UsageRefreshTarget { pool?: string; account: string }

/** 새로고침 중인 대상을 가리키는 키 — 전부면 `*`. */
export function refreshKey(target?: UsageRefreshTarget): string {
  return target ? `${target.pool ?? ''}/${target.account}` : '*';
}

/**
 * 폴링한다(`enabled` = 이 빌드에 데몬 표면이 있다). 창이 숨으면 접고 다시 보이면 즉시 한 번 —
 * `AgentsSettings` 의 목록 폴과 같은 규율. 실패해도 마지막 스냅샷은 지우지 않는다.
 *
 * `refresh(target?)` 는 사람이 누른 [Refresh usage](2026-10-09) — 데몬에 `force` 를 실어 캐시를 건너뛰고
 * **새로 잰 값을 기다린다.** 폴은 그대로 캐시 값을 받는다.
 */
export function useProviderUsage(kind: ProviderKind, enabled: boolean): {
  snap: ProviderUsageSnapshot | null;
  /**
   * 첫 답을 아직 못 받았는가. 화면은 이 동안 막대 자리에 스켈레톤을 그린다 — 비워 두면 "한도 정보가
   * 없는 계정"과 구분되지 않는다. 첫 답이 실패로 끝나도 내려간다(그때는 막대가 없는 것이 사실이다).
   */
  loading: boolean;
  /** 지금 새로고침 중인 대상(`refreshKey`). 비었으면 누른 것이 없다. */
  refreshing: ReadonlySet<string>;
  /** 마지막 [Refresh usage] 가 실패한 까닭. 다음 새로고침이 성공하면 내려간다. 폴의 실패는 싣지 않는다. */
  refreshError: string | null;
  refresh(target?: UsageRefreshTarget): Promise<void>;
} {
  const [snap, setSnap] = useState<ProviderUsageSnapshot | null>(null);
  const [settled, setSettled] = useState(false);
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(new Set());
  const [refreshError, setRefreshError] = useState<string | null>(null);
  /**
   * 답의 순서. 새로고침 답이 들어오면 그 **전에 보낸** 폴 답은 버린다 — 늦게 도착한 폴이 캐시의 옛 값으로
   * 방금 잰 값을 덮으면, 사람은 눌렀는데 숫자가 되돌아가는 것을 본다.
   */
  const sent = useRef(0);
  const floor = useRef(0);

  const poll = useCallback(async () => {
    const call = invoke();
    if (!call) return;
    const seq = ++sent.current;
    try {
      const next = (await call(COMMAND[kind])) as ProviderUsageSnapshot;
      if (seq > floor.current) setSnap(next);
    } catch {
      // 스냅샷을 지우지 않는다 — 한 번의 실패로 막대가 사라지면 사람은 한도가 풀린 줄 안다.
    } finally {
      setSettled(true);
    }
  }, [kind]);

  const refresh = useCallback(async (target?: UsageRefreshTarget) => {
    const call = invoke();
    if (!call) return;
    const key = refreshKey(target);
    setRefreshing((cur) => new Set(cur).add(key));
    try {
      const args: Record<string, unknown> = { force: true };
      if (target) {
        args.account = target.account;
        if (kind === 'claude') args.pool = target.pool ?? '';
      }
      const next = (await call(COMMAND[kind], args)) as ProviderUsageSnapshot;
      floor.current = sent.current;
      setSnap(next);
      setRefreshError(null);
    } catch (err) {
      setRefreshError(errorTextNow(err));
    } finally {
      setSettled(true);
      setRefreshing((cur) => { const s = new Set(cur); s.delete(key); return s; });
    }
  }, [kind]);

  useEffect(() => {
    if (!enabled) { setSnap(null); setSettled(false); return; }
    void poll();
    const id = setInterval(() => { if (!document.hidden) void poll(); }, PROVIDER_USAGE_POLL_MS);
    const onVis = (): void => { if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [enabled, poll]);

  return { snap, loading: enabled && !settled && snap === null, refreshing, refreshError, refresh };
}

/**
 * 화면에 "Updated 22:15" 로 적을 시각 — 계정 값 가운데 **가장 오래된** 잰 시각이다. 데몬은 캐시 값을
 * 곧바로 돌려주므로(`usageChain.ts` 의 `stale`) 스냅샷을 받은 시각은 값의 나이를 말하지 않는다.
 */
export function usageUpdatedAt(snap: ProviderUsageSnapshot | null): number | null {
  if (!Array.isArray(snap?.accounts) || snap.accounts.length === 0) return null;
  const times = snap.accounts.map((a) => a.fetchedAtMs).filter((n) => typeof n === 'number' && n > 0);
  return times.length ? Math.min(...times) : null;
}

/** claude 는 `(pool, account)`, codex 는 `('', account)` — 시스템 기본은 account `''`. */
export function usageFor(
  snap: ProviderUsageSnapshot | null, account: string, pool?: string,
): ProviderAccountUsage | null {
  // `accounts` 를 다시 잰다 — 옛 데몬·테스트 스텁이 `{}` 를 돌려줄 수 있고, 그때 화면이 죽으면 안 된다.
  if (!Array.isArray(snap?.accounts)) return null;
  return snap.accounts.find((a) => a.account === account && (pool === undefined || (a.pool ?? '') === pool)) ?? null;
}
