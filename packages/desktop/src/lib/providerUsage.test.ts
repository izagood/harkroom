import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { usageFor, usageUpdatedAt, useProviderUsage } from './providerUsage';

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

describe('useProviderUsage — 새로고침과 폴의 순서 (2026-10-09)', () => {
  const at = (pct: number) => ({
    measuredAtMs: 0,
    accounts: [{ account: 'a', pool: 'w', session: { usedPercent: pct, resetsAtMs: null }, weekly: null, fetchedAtMs: 1 }],
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('새로고침 답이 들어온 뒤 늦게 도착한 **그 전에 보낸** 폴 답은 새 값을 덮지 않는다', async () => {
    const polls: ((v: unknown) => void)[] = [];
    let forced: (v: unknown) => void = () => {};
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: vi.fn((_cmd: string, args?: Record<string, unknown>) =>
        new Promise((r) => { if (args?.force) forced = r; else polls.push(r); })),
    });
    const { result } = renderHook(() => useProviderUsage('claude', true));
    await waitFor(() => expect(polls).toHaveLength(1)); // 첫 폴이 매달려 있다
    let p!: Promise<void>;
    act(() => { p = result.current.refresh(); });
    expect(result.current.refreshing.has('*')).toBe(true);
    await act(async () => { forced(at(80)); await p; });
    expect(result.current.snap?.accounts[0]?.session?.usedPercent).toBe(80);
    await act(async () => { polls[0]!(at(10)); await Promise.resolve(); });
    expect(result.current.snap?.accounts[0]?.session?.usedPercent).toBe(80);
    expect(result.current.refreshing.size).toBe(0);
  });

  it('usageUpdatedAt: 계정 값 가운데 가장 오래 전에 잰 시각 · 계정이 없으면 null', () => {
    const snap = { measuredAtMs: 9, accounts: [
      { account: 'a', session: null, weekly: null, fetchedAtMs: 300 },
      { account: 'b', session: null, weekly: null, fetchedAtMs: 100 },
    ] };
    expect(usageUpdatedAt(snap)).toBe(100);
    expect(usageUpdatedAt({ measuredAtMs: 9, accounts: [] })).toBeNull();
    expect(usageUpdatedAt(null)).toBeNull();
  });
});
