/**
 * 계정별 한도 사용률(2026-09-28, 2단계) — 웹뷰 쪽.
 *
 * 호출 순서는 데몬이 정한다(`operator/src/usageChain.ts`): **CLI → (실패하면) API.**
 * CLI(`claude -p /usage`, `codex app-server` → `account/rateLimits/read`)와 API(`/api/oauth/usage`,
 * `wham/usage`)는 **출처가 같다** — CLI 가 안에서 그 API 를 부른다. 그래서 켜고 끌 것이 없다.
 */
import { useCallback, useEffect, useState } from 'react';

import type { ProviderAccountUsage, ProviderUsageSnapshot, ProviderUsageWindow } from '@harkroom/shared/daemonProtocol';

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

/**
 * 폴링한다(`enabled` = 이 빌드에 데몬 표면이 있다). 창이 숨으면 접고 다시 보이면 즉시 한 번 —
 * `AgentsSettings` 의 목록 폴과 같은 규율. 실패해도 마지막 스냅샷은 지우지 않는다.
 */
export function useProviderUsage(kind: ProviderKind, enabled: boolean): {
  snap: ProviderUsageSnapshot | null;
  refresh(): Promise<void>;
} {
  const [snap, setSnap] = useState<ProviderUsageSnapshot | null>(null);
  const refresh = useCallback(async () => {
    const call = invoke();
    if (!call) return;
    try {
      setSnap((await call(COMMAND[kind])) as ProviderUsageSnapshot);
    } catch {
      // 스냅샷을 지우지 않는다 — 한 번의 실패로 막대가 사라지면 사람은 한도가 풀린 줄 안다.
    }
  }, [kind]);

  useEffect(() => {
    if (!enabled) { setSnap(null); return; }
    void refresh();
    const id = setInterval(() => { if (!document.hidden) void refresh(); }, PROVIDER_USAGE_POLL_MS);
    const onVis = (): void => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [enabled, refresh]);

  return { snap, refresh };
}

/** claude 는 `(pool, account)`, codex 는 `('', account)` — 시스템 기본은 account `''`. */
export function usageFor(
  snap: ProviderUsageSnapshot | null, account: string, pool?: string,
): ProviderAccountUsage | null {
  // `accounts` 를 다시 잰다 — 옛 데몬·테스트 스텁이 `{}` 를 돌려줄 수 있고, 그때 화면이 죽으면 안 된다.
  if (!Array.isArray(snap?.accounts)) return null;
  return snap.accounts.find((a) => a.account === account && (pool === undefined || (a.pool ?? '') === pool)) ?? null;
}
