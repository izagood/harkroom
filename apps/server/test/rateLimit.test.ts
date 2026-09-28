import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../src/rateLimit.js';

describe('rate limiter', () => {
  it('allows up to max within the window and refuses the next', () => {
    let now = 1_000;
    const limiter = createRateLimiter(() => now);
    const rule = { windowMs: 60_000, max: 3 };

    expect(limiter.hit('k', rule).allowed).toBe(true);
    expect(limiter.hit('k', rule).allowed).toBe(true);
    expect(limiter.hit('k', rule).allowed).toBe(true);
    const refused = limiter.hit('k', rule);

    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('lets the caller back in once the window has passed', () => {
    let now = 1_000;
    const limiter = createRateLimiter(() => now);
    const rule = { windowMs: 60_000, max: 1 };
    limiter.hit('k', rule);
    expect(limiter.hit('k', rule).allowed).toBe(false);

    now += 60_001;

    expect(limiter.hit('k', rule).allowed).toBe(true);
  });

  it('counts keys independently', () => {
    const limiter = createRateLimiter(() => 1_000);
    const rule = { windowMs: 60_000, max: 1 };
    limiter.hit('a', rule);

    expect(limiter.hit('b', rule).allowed).toBe(true);
    expect(limiter.hit('a', rule).allowed).toBe(false);
  });

  // 만료된 키를 들고 있으면 요청마다 메모리가 자란다(티켓 저장소와 같은 이유로 청소한다).
  it('drops expired keys instead of holding them forever', () => {
    let now = 1_000;
    const limiter = createRateLimiter(() => now);
    const rule = { windowMs: 100, max: 5 };
    for (let i = 0; i < 20; i += 1) limiter.hit(`k${i}`, rule);
    expect(limiter.size()).toBe(20);

    now += 1_000;
    limiter.hit('fresh', rule);

    expect(limiter.size()).toBe(1);
  });
});
