// 사용량 **출처 순서**(2026-09-28, jaebin 방침): 공식 → (안 되면, 그리고 사람이 켰을 때만) 비공식
// → 로컬 추정. 로컬 추정(`claudeUsage.ts`)은 화면이 늘 따로 그리므로 여기에는 앞의 둘만 있다.
//
// | 하네스 | 공식 | 비공식(토글) |
// |---|---|---|
// | Claude | CLI `claude -p /usage` | `api.anthropic.com/api/oauth/usage` |
// | Codex | CLI `codex app-server` → `account/rateLimits/read` | `chatgpt.com/backend-api/wham/usage` |
//
// **캐시를 둔다.** 공식 경로는 계정마다 CLI 프로세스를 하나씩 띄운다(claude 는 node 앱). 화면이 1분마다
// 폴링해도 한도 창은 분 단위로 움직이므로, 같은 계정은 `USAGE_CACHE_MS` 안에서 한 번만 잰다.
import type { ProviderAccountUsage } from '@harkroom/shared/daemonProtocol';

import type { UsageResult } from './cliUsage.js';

export const USAGE_CACHE_MS = 2 * 60 * 1000;

export async function officialThenUnofficial(
  official: () => Promise<UsageResult>,
  unofficial: (() => Promise<UsageResult>) | null,
): Promise<Omit<ProviderAccountUsage, 'account' | 'pool'>> {
  const a = await official();
  if (!a.error) return { ...a, source: 'cli' };
  if (!unofficial) return { ...a, source: 'cli' };
  const b = await unofficial();
  // 둘 다 실패하면 **공식 쪽 이유**를 싣는다 — 사람이 고칠 수 있는 것(로그인·CLI 설치)이 그쪽이다.
  return b.error ? { ...a, source: 'cli' } : { ...b, source: 'unofficial-api' };
}

/** 키(계정·모드)별로 결과를 잠시 들고 있는다. 진행 중인 요청도 공유한다 — 폴 둘이 겹쳐도 CLI 는 하나다. */
export function createUsageCache(ttlMs: number = USAGE_CACHE_MS, now: () => number = Date.now) {
  const entries = new Map<string, { at: number; value: Promise<Omit<ProviderAccountUsage, 'account' | 'pool'>> }>();
  return (key: string, load: () => Promise<Omit<ProviderAccountUsage, 'account' | 'pool'>>) => {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = load();
    entries.set(key, { at: now(), value });
    // 실패한 요청은 곧바로 다시 잴 수 있게 캐시에서 뺀다(에러 결과는 값이라 남긴다).
    value.catch(() => entries.delete(key));
    return value;
  };
}
