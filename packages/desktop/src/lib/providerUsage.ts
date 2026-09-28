/**
 * 공급자 API 사용률(2026-09-28, 2단계) — 웹뷰 쪽.
 *
 * **비공식 엔드포인트**(Claude `/api/oauth/usage`, Codex `wham/usage`)라 화면의 토글 뒤에 둔다.
 * 꺼져 있으면 데몬을 부르지도 않고, 화면은 지금까지의 로컬 추정(트랜스크립트 합계)만 그린다.
 * 토큰을 읽고 부르는 것은 전부 데몬이다(`operator/src/providerUsage.ts`) — 여기는 결과만 받는다.
 */
import { useCallback, useEffect, useState } from 'react';

import type { ProviderAccountUsage, ProviderUsageSnapshot, ProviderUsageWindow } from '@harkroom/shared/daemonProtocol';

import { usePrefsStore } from '../state/prefsStore';

export type { ProviderAccountUsage, ProviderUsageSnapshot, ProviderUsageWindow };

/**
 * **사람이 고른 적 없을 때의 기본값.** 비공식 API 를 기본으로 켤지는 아직 정하지 않았다
 * (jaebin 결정 대기). 정해지면 이 한 줄만 바꾼다 — 토글을 손댄 적 없는 사람(`providerUsageApi:
 * null`)에게 곧바로 먹는다.
 */
export const PROVIDER_USAGE_API_DEFAULT = true;

/** 폴 간격. 공급자 쪽 호출이라 로컬 추정(10초)보다 길게 — 한도 창은 분 단위로 움직인다. */
export const PROVIDER_USAGE_POLL_MS = 60_000;

export function useProviderUsageEnabled(): [boolean, (on: boolean) => void] {
  const pref = usePrefsStore((s) => s.providerUsageApi);
  const set = usePrefsStore((s) => s.setProviderUsageApi);
  return [pref ?? PROVIDER_USAGE_API_DEFAULT, set];
}

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
 * 켜져 있을 때만 폴링한다. 창이 숨으면 접고 다시 보이면 즉시 한 번 — `ClaudeAccountsSettings`
 * 의 로컬 폴과 같은 규율. 실패해도 마지막 스냅샷은 지우지 않는다.
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
