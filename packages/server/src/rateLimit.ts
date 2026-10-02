/**
 * 고정 창(fixed window) 레이트 리미터.
 *
 * 의존성을 안 쓴다: 스펙 §3 의 "서버 인스턴스 1개" 전제와 일관되고(티켓 저장소도 인메모리다),
 * 병렬 작업 중인 다른 브랜치와 락파일이 충돌하는 것을 피한다. 대가는 명확하다 —
 * **카운터는 인스턴스 로컬이고 재시작으로 리셋된다.** 수평 확장 시 공유 저장소로 교체해야 한다.
 *
 * 시계를 주입받는 이유: 창 만료를 sleep 없이 결정적으로 검증할 수 있어야 한다.
 */
export interface RateLimitRule {
  windowMs: number;
  max: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** 거절일 때 얼마나 기다려야 하는가. 허용이면 0. */
  retryAfterMs: number;
}

export interface RateLimiter {
  hit(key: string, rule: RateLimitRule): RateLimitVerdict;
  /** 키를 지운다(성공한 로그인이 그 계정의 실패 수를 비운다). */
  reset(key: string): void;
  size(): number;
}

/**
 * 키 수 상한. 계정 단위 리밋은 **요청자가 고른 문자열**(login_id)을 키로 쓴다 — 무작위 이름을
 * 퍼부으면 창(15분) 동안 키가 끝없이 는다. 넘으면 가장 오래 전에 만든 키부터 버린다(Map 은 넣은
 * 순서를 지킨다). 버려진 키는 다음 시도에서 1 부터 다시 센다 — 리밋이 느슨해지는 쪽으로만 틀린다.
 */
export const RATE_LIMIT_MAX_KEYS = 50_000;
/**
 * 만료 키 청소 간격(최대). 예전에는 `hit` 마다 Map 전체를 훑었다 — 키가 많으면 요청마다 O(n) 이다.
 * 지금은 가장 이른 만료 시각과 이 간격 중 이른 쪽에만 훑는다.
 */
const SWEEP_EVERY_MS = 10_000;

export function createRateLimiter(
  now: () => number = () => Date.now(),
  opts: { maxKeys?: number } = {},
): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  const maxKeys = opts.maxKeys ?? RATE_LIMIT_MAX_KEYS;
  let nextSweepAt = 0;

  return {
    hit(key, rule) {
      const t = now();
      // 만료된 키를 들고 있으면 메모리가 자란다. 티켓 저장소와 같은 이유로 청소하되, 간격을 둔다.
      if (t >= nextSweepAt) {
        for (const [k, w] of windows) {
          if (w.resetAt <= t) windows.delete(k);
        }
        nextSweepAt = t + SWEEP_EVERY_MS;
      }
      let current = windows.get(key);
      if (current && current.resetAt <= t) {
        windows.delete(key);
        current = undefined;
      }
      if (!current) {
        while (windows.size >= maxKeys) {
          const oldest = windows.keys().next().value;
          if (oldest === undefined) break;
          windows.delete(oldest);
        }
        windows.set(key, { count: 1, resetAt: t + rule.windowMs });
        // 창이 청소 간격보다 짧으면 그 창이 끝날 때 청소를 앞당긴다 — 간격만 두면 짧은 창의 키가 쌓인다.
        nextSweepAt = Math.min(nextSweepAt, t + rule.windowMs);
        return { allowed: true, retryAfterMs: 0 };
      }
      if (current.count < rule.max) {
        current.count += 1;
        return { allowed: true, retryAfterMs: 0 };
      }
      return { allowed: false, retryAfterMs: Math.max(1, current.resetAt - t) };
    },

    reset(key) {
      windows.delete(key);
    },

    size() {
      return windows.size;
    },
  };
}
