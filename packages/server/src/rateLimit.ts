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
  size(): number;
}

export function createRateLimiter(now: () => number = () => Date.now()): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();

  return {
    hit(key, rule) {
      const t = now();
      // 만료된 키를 들고 있으면 요청마다 메모리가 자란다. 티켓 저장소와 같은 이유로 청소한다.
      for (const [k, w] of windows) {
        if (w.resetAt <= t) windows.delete(k);
      }
      const current = windows.get(key);
      if (!current) {
        windows.set(key, { count: 1, resetAt: t + rule.windowMs });
        return { allowed: true, retryAfterMs: 0 };
      }
      if (current.count < rule.max) {
        current.count += 1;
        return { allowed: true, retryAfterMs: 0 };
      }
      return { allowed: false, retryAfterMs: Math.max(1, current.resetAt - t) };
    },

    size() {
      return windows.size;
    },
  };
}
