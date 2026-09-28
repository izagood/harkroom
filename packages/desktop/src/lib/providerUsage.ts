/**
 * 계정별 한도 사용률(2026-09-28, 2단계) — 웹뷰 쪽.
 *
 * 출처 순서는 데몬이 정한다(`operator/src/usageChain.ts`): **공식(각 CLI) → 비공식 공급자 API → 로컬 추정.**
 * - 공식: Claude `claude -p /usage`, Codex `codex app-server` → `account/rateLimits/read`. **늘 켜져 있다.**
 * - 비공식: Claude `/api/oauth/usage`, Codex `wham/usage`. 공식이 실패했을 때만, 그리고 **이 화면의
 *   토글이 켜졌을 때만** 쓴다. 문서화되지 않은 경로라 경고를 붙인다.
 * - 로컬 추정: 트랜스크립트 합계(Claude 표). 위 둘과 무관하게 늘 그려진다.
 */
import { useCallback, useEffect, useState } from 'react';

import type { ProviderAccountUsage, ProviderUsageSnapshot, ProviderUsageWindow } from '@harkroom/shared/daemonProtocol';

import { usePrefsStore } from '../state/prefsStore';

export type { ProviderAccountUsage, ProviderUsageSnapshot, ProviderUsageWindow };

/**
 * **비공식 API 로 넘어가는 것의 기본값**(사람이 토글을 고른 적 없을 때). jaebin 방침(2026-09-28):
 * 공식으로 읽을 수 있으면 공식을 쓰고, 비공식은 어쩔 수 없을 때만 — 그래서 기본은 꺼짐이다.
 * 바꾸려면 이 한 줄만 고친다 — 손댄 적 없는 사람(`providerUsageApi: null`)에게 곧바로 먹는다.
 */
export const UNOFFICIAL_USAGE_API_DEFAULT = false;

/** 폴 간격. 데몬이 계정마다 CLI 를 띄우므로 로컬 추정(10초)보다 길게 — 데몬도 2분 캐시를 둔다. */
export const PROVIDER_USAGE_POLL_MS = 60_000;

/** 비공식 API 로 넘어가도 되나(토글). 공식 경로는 이 값과 무관하게 돈다. */
export function useUnofficialUsageAllowed(): [boolean, (on: boolean) => void] {
  const pref = usePrefsStore((s) => s.providerUsageApi);
  const set = usePrefsStore((s) => s.setProviderUsageApi);
  return [pref ?? UNOFFICIAL_USAGE_API_DEFAULT, set];
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
 * 폴링한다(`enabled` = 이 빌드에 데몬 표면이 있다). 창이 숨으면 접고 다시 보이면 즉시 한 번 —
 * `ClaudeAccountsSettings` 의 로컬 폴과 같은 규율. 실패해도 마지막 스냅샷은 지우지 않는다.
 */
export function useProviderUsage(kind: ProviderKind, enabled: boolean, allowUnofficial: boolean): {
  snap: ProviderUsageSnapshot | null;
  refresh(): Promise<void>;
} {
  const [snap, setSnap] = useState<ProviderUsageSnapshot | null>(null);
  const refresh = useCallback(async () => {
    const call = invoke();
    if (!call) return;
    try {
      setSnap((await call(COMMAND[kind], { allowUnofficial })) as ProviderUsageSnapshot);
    } catch {
      // 스냅샷을 지우지 않는다 — 한 번의 실패로 막대가 사라지면 사람은 한도가 풀린 줄 안다.
    }
  }, [kind, allowUnofficial]);

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
