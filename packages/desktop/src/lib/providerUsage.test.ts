import { describe, expect, it } from 'vitest';

import { usageFor } from './providerUsage';

describe('providerUsage', () => {
  it('usageFor: 풀·계정으로 고르고, 모양이 이상한 스냅샷에는 null', () => {
    const snap = { measuredAtMs: 0, accounts: [
      { account: 'a', pool: 'work', session: null, weekly: null, fetchedAtMs: 0 },
      { account: 'a', pool: 'home', session: null, weekly: null, fetchedAtMs: 0 },
    ] };
    expect(usageFor(snap, 'a', 'home')?.pool).toBe('home');
    expect(usageFor(snap, 'b')).toBeNull();
    expect(usageFor({} as never, 'a')).toBeNull();
    expect(usageFor(null, 'a')).toBeNull();
  });
});
