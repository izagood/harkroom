/**
 * 앱 기동 때 오퍼레이터를 못 세우거나 자동 등록을 못 하면 **사유가 화면에 남는다** — 전에는 `swallow` 로 버려져
 * 첫 설치에서 「에이전트가 안 돈다」가 조용히 생겼다. 다시 붙을 때 한 번 더 해 보고, 잘 되면 사유를 지운다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import { OperatorStartupBanner } from '../src/components/OperatorStartupBanner';
import type { DaemonObserver } from '../src/lib/runnerLauncher';
import { acc, fakeApi, fakeWsFactory } from './helpers/fakeApi';

const NODE_MISSING = 'env: node: No such file or directory';

beforeEach(() => {
  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: vi.fn(async (cmd: string) => (cmd === 'operator_agents_list' ? { communities: [] } : { name: 'mac' })),
  };
  useAppStore.getState().set({ me: acc('u1', 'owner', 'human', true), operatorStartupIssue: null, operatorStartupBannerDismissed: null });
});
afterEach(() => {
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function controller(observer: DaemonObserver, api: Parameters<typeof fakeApi>[0] = {}) {
  const full = fakeApi({
    operators: vi.fn(async () => []),
    operatorRegisterCode: vi.fn(async () => ({ code: 'hkreg_test' })),
    ...api,
  } as never);
  return new Controller(full, fakeWsFactory().makeWs, undefined, undefined, undefined, observer, { read: async () => null });
}

const ok: DaemonObserver = { observe: async () => ({ daemonPid: 1, attached: true, runners: [] }) as never };

describe('오퍼레이터 기동 실패를 버리지 않는다', () => {
  it('오퍼레이터가 안 뜨면 사유가 store 에 오르고, 다시 해서 되면 지워진다', async () => {
    let fail = true;
    const observer: DaemonObserver = { observe: async (c) => { if (fail) throw new Error(NODE_MISSING); return ok.observe(c); } };
    const c = controller(observer);
    await c.ensureOperatorAndRegister();
    expect(useAppStore.getState().operatorStartupIssue).toEqual({ kind: 'start', reason: expect.stringContaining('node') });
    fail = false;
    await c.ensureOperatorAndRegister();
    expect(useAppStore.getState().operatorStartupIssue).toBeNull();
  });

  it('자동 등록(코드 발급)이 실패하면 register 사유가 오른다', async () => {
    const c = controller(ok, { operatorRegisterCode: vi.fn(async () => { throw new Error('503 boom'); }) } as never);
    await c.ensureOperatorAndRegister();
    expect(useAppStore.getState().operatorStartupIssue).toEqual({ kind: 'register', reason: expect.stringContaining('boom') });
  });

  it('목록을 못 읽어 판단을 못 해도 사유가 오른다', async () => {
    const c = controller(ok, { operators: vi.fn(async () => { throw new Error('list down'); }) } as never);
    await c.ensureOperatorAndRegister();
    expect(useAppStore.getState().operatorStartupIssue).toEqual({ kind: 'register', reason: expect.stringContaining('list down') });
  });

  it('겹쳐 불러도 한 번만 돈다', async () => {
    const observe = vi.fn(ok.observe);
    const c = controller({ observe });
    await Promise.all([c.ensureOperatorAndRegister(), c.ensureOperatorAndRegister()]);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('Tauri 표면이 없으면(웹·테스트) 실패로 치지 않는다', async () => {
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const c = controller({ observe: async () => { throw new Error('no tauri'); } });
    await c.ensureOperatorAndRegister();
    expect(useAppStore.getState().operatorStartupIssue).toBeNull();
  });
});

describe('OperatorStartupBanner', () => {
  it('사유를 띠로 말하고, 설정 › 이 기기의 오퍼레이터로 보내고, 닫으면 같은 사유로는 다시 서지 않는다', () => {
    useAppStore.getState().set({ operatorStartupIssue: { kind: 'start', reason: NODE_MISSING } });
    const open = vi.fn();
    const { rerender } = render(<OperatorStartupBanner onOpenSettings={open} />);
    expect(screen.getByTestId('operator-startup-reason').textContent).toBe(NODE_MISSING);
    fireEvent.click(screen.getByTestId('operator-startup-open-settings'));
    expect(open).toHaveBeenCalledWith('this-operator');
    fireEvent.click(screen.getByTestId('operator-startup-dismiss'));
    expect(screen.queryByTestId('strip-operator-startup')).toBeNull();
    // 사유가 바뀌면 다시 선다.
    useAppStore.getState().set({ operatorStartupIssue: { kind: 'register', reason: 'other' } });
    rerender(<OperatorStartupBanner onOpenSettings={open} />);
    expect(screen.getByTestId('strip-operator-startup')).toBeTruthy();
  });

  it('사유가 없으면 그리지 않는다', () => {
    render(<OperatorStartupBanner />);
    expect(screen.queryByTestId('strip-operator-startup')).toBeNull();
  });
});
