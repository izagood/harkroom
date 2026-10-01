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

type Measured = Omit<ProviderAccountUsage, 'account' | 'pool'>;

export async function cliThenApi(
  cli: () => Promise<UsageResult>,
  api: () => Promise<UsageResult>,
): Promise<Measured> {
  const a = await cli();
  if (!a.error) return { ...a, source: 'cli' };
  const b = await api();
  // 둘 다 실패하면 **CLI 쪽 이유**를 싣는다 — 사람이 고칠 수 있는 것(로그인·CLI 설치)이 그쪽이다.
  return b.error ? { ...a, source: 'cli' } : { ...b, source: 'api' };
}

/**
 * 키(계정)별로 결과를 잠시 들고 있는다. 진행 중인 요청도 공유한다 — 폴 둘이 겹쳐도 CLI 는 하나다.
 *
 * ## `{ stale: true }` — 화면용 stale-while-revalidate (2026-10-01)
 *
 * 설정 › Provider accounts 는 열 때마다 이 값을 묻는다. TTL 이 지났다고 CLI 를 다시 띄워 **그 결과를
 * 기다리면** 화면이 계정 수와 무관하게 가장 느린 CLI 만큼(최대 45초) 비어 있다. 그래서 화면 경로는
 * 지난 값이 있으면 **그것을 곧바로** 돌려주고, 새로 재는 것은 뒤에서 한다 — 다음 폴이 새 값을 받는다.
 * 지난 값이 아예 없을 때(데몬이 막 떴다)만 기다린다.
 *
 * 백그라운드 폴러(`claudeUsagePoller`)는 이것을 쓰지 **않는다**: 폴러는 "지난 번과 값이 달라졌나"로
 * 계정이 쓰이는지 판단하므로 낡은 값을 받으면 판단이 한 주기 밀린다.
 */
export function createUsageCache(ttlMs: number = USAGE_CACHE_MS, now: () => number = Date.now) {
  interface Entry {
    at: number;
    value: Promise<Measured>;
    /** 뒤에서 다시 재는 중인가 — 화면이 연달아 물어도 CLI 는 하나다. */
    refreshing: boolean;
  }
  const entries = new Map<string, Entry>();

  const store = (key: string, load: () => Promise<Measured>): Entry => {
    const entry: Entry = { at: now(), value: load(), refreshing: false };
    entries.set(key, entry);
    // 실패한 요청은 곧바로 다시 잴 수 있게 캐시에서 뺀다(에러 결과는 값이라 남긴다).
    // 그 사이 다른 값이 자리를 차지했으면 건드리지 않는다.
    entry.value.catch(() => { if (entries.get(key) === entry) entries.delete(key); });
    return entry;
  };

  const cache = (key: string, load: () => Promise<Measured>, opts: { stale?: boolean } = {}): Promise<Measured> => {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    if (!hit || !opts.stale) return store(key, load).value;
    if (!hit.refreshing) {
      hit.refreshing = true;
      const next = load();
      next.then(
        (value) => {
          // `forget` 로 버려졌거나 그 사이 새로 잰 값이 들어왔으면 옛 시도를 쓰지 않는다 — 다시 로그인한
          // 계정에 옛 로그인의 % 가 되살아나면 안 된다.
          if (entries.get(key) === hit) entries.set(key, { at: now(), value: Promise.resolve(value), refreshing: false });
        },
        () => { hit.refreshing = false; },
      );
    }
    return hit.value;
  };
  /** 그 키의 값을 버린다 — 다시 로그인한 계정은 옛 로그인의 %를 돌려주면 안 된다. */
  cache.forget = (key: string): void => { entries.delete(key); };
  return cache;
}
