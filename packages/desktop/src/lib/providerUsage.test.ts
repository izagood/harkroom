import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFS, prefsStorage } from './prefs';
import { PROVIDER_USAGE_API_DEFAULT, usageFor } from './providerUsage';

describe('providerUsage', () => {
  it('저장본에 값이 없으면 null(= 상수 기본값을 따른다)', () => {
    localStorage.setItem('harkroom.prefs', JSON.stringify({ colorMode: 'dark' }));
    expect(prefsStorage.load().providerUsageApi).toBeNull();
    expect(DEFAULT_PREFS.providerUsageApi).toBeNull();
    expect(typeof PROVIDER_USAGE_API_DEFAULT).toBe('boolean');
    localStorage.setItem('harkroom.prefs', JSON.stringify({ providerUsageApi: false }));
    expect(prefsStorage.load().providerUsageApi).toBe(false);
    localStorage.clear();
  });

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
