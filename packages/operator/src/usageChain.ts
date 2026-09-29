// 사용량 **호출 순서**(2026-09-28, jaebin 승인): CLI → (실패하면) API. 이 둘뿐이다 — 트랜스크립트
// 토큰 합계로 재던 로컬 추정(`claudeUsage.ts`)은 %를 낼 수 없어 걷어 냈다(2026-09-29, jaebin 지시).
//
// **CLI 와 API 는 출처가 같다** — 둘 다 공급자의 1st-party 엔드포인트이고 차이는 호출 방식뿐이다.
//
// | 하네스 | ① CLI (기본) | ② API 직접 (①이 실패하면 자동) | 근거: CLI 가 안에서 부르는 것 |
// |---|---|---|---|
// | Claude | `claude -p /usage` | `GET api.anthropic.com/api/oauth/usage` | claude 2.1.283 실행 파일에 `/api/oauth/usage` 문자열(+`?at_wall=1&skip_spend=1` 등) |
// | Codex | `codex app-server` → `account/rateLimits/read` | `GET chatgpt.com/backend-api/wham/usage` | openai/codex `backend-client/src/client/rate_limit_resets.rs` 가 `{base}/wham/usage` 를 만든다 |
//
// CLI 를 먼저 쓰는 이유: 토큰을 **우리가 읽지 않고**(CLI 가 자기 로그인으로 묻는다), 만료 갱신도 CLI 가
// 한다. API 는 CLI 가 없거나 Claude 의 글자 출력 파싱이 깨졌을 때 받쳐 준다.
//
// **캐시를 둔다.** CLI 경로는 계정마다 프로세스를 하나씩 띄운다(claude 는 node 앱). 화면이 1분마다
// 폴링해도 한도 창은 분 단위로 움직이므로, 같은 계정은 `USAGE_CACHE_MS` 안에서 한 번만 잰다.
import type { ProviderAccountUsage } from '@harkroom/shared/daemonProtocol';

import type { UsageResult } from './cliUsage.js';

export const USAGE_CACHE_MS = 2 * 60 * 1000;

export async function cliThenApi(
  cli: () => Promise<UsageResult>,
  api: () => Promise<UsageResult>,
): Promise<Omit<ProviderAccountUsage, 'account' | 'pool'>> {
  const a = await cli();
  if (!a.error) return { ...a, source: 'cli' };
  const b = await api();
  // 둘 다 실패하면 **CLI 쪽 이유**를 싣는다 — 사람이 고칠 수 있는 것(로그인·CLI 설치)이 그쪽이다.
  return b.error ? { ...a, source: 'cli' } : { ...b, source: 'api' };
}

/** 키(계정)별로 결과를 잠시 들고 있는다. 진행 중인 요청도 공유한다 — 폴 둘이 겹쳐도 CLI 는 하나다. */
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
