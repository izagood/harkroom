// 러너 버전 칩의 기준(오퍼레이터별 버전)이 서버 신호를 따라오는가. 오퍼레이터가 갱신돼 다시 붙으면
// 서버가 `operator.changed` 를 내고, 칩 셋(격자·띠·프로필)이 같은 훅으로 새 기준을 읽어야 한다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import type { OperatorView } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController, type Controller as ControllerType } from '../src/state/controller';
import { useOperatorVersions } from '../src/lib/useOperatorVersions';
import { fakeApi, fakeWsFactory } from './helpers/fakeApi';

const op = (version: string | null): OperatorView => ({
  id: 'op-1', name: '맥북', ownerAccountId: 'u1', createdAt: '2026-09-21T00:00:00Z',
  lastSeenAt: null, revokedAt: null, online: true, version,
});

beforeEach(() => useAppStore.getState().reset());
afterEach(() => cleanup());

describe('useOperatorVersions', () => {
  it('컨트롤러가 `operator.changed` 를 받으면 다시 읽으라는 신호를 올린다', async () => {
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs);
    await c.start();
    const before = useAppStore.getState().operatorsRevision;
    callbacks.current!.onEvent({ type: 'operator.changed', operatorId: 'op-1', audience: 'all' });
    expect(useAppStore.getState().operatorsRevision).toBe(before + 1);
  });

  it('목록을 오퍼레이터 id → 버전으로 접고, 신호가 오면 새 버전을 읽는다', async () => {
    let version: string | null = '0.3.45';
    const operators = vi.fn(async () => [op(version)]);
    setController({ operators } as unknown as ControllerType);

    const { result } = renderHook(() => useOperatorVersions());
    await waitFor(() => expect(result.current?.get('op-1')).toBe('0.3.45'));

    version = '0.3.47';
    act(() => { useAppStore.getState().set({ operatorsRevision: useAppStore.getState().operatorsRevision + 1 }); });
    await waitFor(() => expect(result.current?.get('op-1')).toBe('0.3.47'));
    expect(operators).toHaveBeenCalledTimes(2);
  });

  it('못 읽으면 null — 판정은 그때 아무것도 뒤처졌다고 하지 않는다', async () => {
    setController({ operators: vi.fn(async () => { throw new Error('offline'); }) } as unknown as ControllerType);
    const { result } = renderHook(() => useOperatorVersions());
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toBeNull();
  });

  it('끄면 읽지 않는다 — 설정을 볼 수 없는 사람의 프로필', async () => {
    const operators = vi.fn(async () => [op('0.3.45')]);
    setController({ operators } as unknown as ControllerType);
    const { result } = renderHook(() => useOperatorVersions(false));
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toBeNull();
    expect(operators).not.toHaveBeenCalled();
  });
});
