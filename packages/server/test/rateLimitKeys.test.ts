import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../src/rateLimit.js';

const rule = { windowMs: 60_000, max: 1 };

describe('리미터 키 수 상한', () => {
  // 계정 단위 리밋은 요청자가 고른 문자열을 키로 쓴다 — 무작위 이름을 퍼부어도 메모리가 끝없이 늘면 안 된다.
  it('drops the oldest keys instead of growing without bound', () => {
    const limiter = createRateLimiter(() => 0, { maxKeys: 3 });

    for (const k of ['a', 'b', 'c', 'd', 'e']) limiter.hit(k, rule);

    expect(limiter.size()).toBe(3);
    // 가장 오래된 'a' 는 버려져 1 부터 다시 센다(느슨해지는 쪽으로만 틀린다), 남은 'e' 는 그대로 막힌다.
    expect(limiter.hit('a', rule).allowed).toBe(true);
    expect(limiter.hit('e', rule).allowed).toBe(false);
  });

  it('forgets a window once it has expired even between sweeps', () => {
    let t = 0;
    const limiter = createRateLimiter(() => t);

    limiter.hit('k', rule);
    expect(limiter.hit('k', rule).allowed).toBe(false);
    t = rule.windowMs + 1;
    expect(limiter.hit('k', rule).allowed).toBe(true);
  });
});
