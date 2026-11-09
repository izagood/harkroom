// 로그인할 때 자동으로 시작(designer 시안 login-autostart · 2026-11-09 결정 B안): 설정 줄 다섯 상태 · 한 번 묻는 띠 ·
// 승인 대기·켜지 못함일 때만 서는 주의 띠.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LoginItemHost } from '../src/components/LoginItemHost';
import { ThisOperatorSettings } from '../src/components/settings/ThisOperatorSettings';
import {
  loginItemStorage, loginItemView, resetLoginItemForTest, setLoginItemSurface, shouldAskLoginItem,
  type LoginItemStatus, type LoginItemSurface,
} from '../src/lib/loginItem';
import { setFdaSurface, type FdaStatus } from '../src/lib/fullDiskAccess';
import { setController, type Controller } from '../src/state/controller';
import { registerLocalOperator } from '../src/lib/operatorLocal';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { en } from '../src/i18n/en';
import { ko } from '../src/i18n/ko';
import { acc } from './helpers/fakeApi';

const BASE = 'https://example.com';

function fakeSurface(initial: LoginItemStatus, onSet?: (on: boolean) => LoginItemStatus | Error): LoginItemSurface & { now(): LoginItemStatus } {
  let now = initial;
  return {
    now: () => now,
    status: vi.fn(async () => now),
    set: vi.fn(async (on: boolean) => {
      const out = onSet ? onSet(on) : on ? 'on' : 'off';
      if (out instanceof Error) throw out;
      now = out;
      return out;
    }),
    openSettings: vi.fn(async () => {}),
  };
}

function fda(status: FdaStatus) {
  setFdaSurface({ status: async () => status, openSettings: async () => {}, revealApp: async () => {}, relaunch: async () => {} });
}

/** 오퍼레이터 로컬 표면 — 이 서버 주소에 등록돼 있는지만 답한다. */
function operatorLocal(registered: boolean) {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: vi.fn(async (cmd: string) => (cmd === 'operator_agents_list' ? { communities: [{ baseUrl: BASE, registered }] } : null)),
  };
}

beforeEach(() => {
  localStorage.clear();
  resetLoginItemForTest();
  setController({ api: { baseUrl: BASE }, operators: vi.fn(async () => []) } as unknown as Controller);
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'me') });
  fda('on');
});
afterEach(() => {
  cleanup();
  setLoginItemSurface(null);
  setFdaSurface(null);
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('loginItemView', () => {
  it('켠 적이 있는데 꺼짐이면 「시스템 설정에서 꺼짐」, 방금 거절됐으면 「켜지 못함」', () => {
    expect(loginItemView('unsupported', false, null)).toBe('hidden');
    expect(loginItemView(null, false, null)).toBe('hidden');
    expect(loginItemView('off', false, null)).toBe('off');
    expect(loginItemView('off', true, null)).toBe('system');
    expect(loginItemView('on', true, null)).toBe('on');
    expect(loginItemView('approval', true, null)).toBe('approval');
    expect(loginItemView('off', false, 'denied')).toBe('failed');
    // 거절 뒤 macOS 가 켜짐·승인 대기로 읽히면 그쪽이 맞다.
    expect(loginItemView('on', false, 'denied')).toBe('on');
  });

  it('묻는 띠는 등록돼 있고 꺼져 있고 안 물었고 FDA 첫 창이 비켰을 때만', () => {
    const base = { status: 'off' as const, asked: false, wanted: false, registered: true, fdaBusy: false };
    expect(shouldAskLoginItem(base)).toBe(true);
    expect(shouldAskLoginItem({ ...base, asked: true })).toBe(false);
    expect(shouldAskLoginItem({ ...base, registered: false })).toBe(false);
    expect(shouldAskLoginItem({ ...base, fdaBusy: true })).toBe(false);
    expect(shouldAskLoginItem({ ...base, wanted: true })).toBe(false);
    for (const s of ['on', 'approval', 'unknown', 'unsupported'] as const) expect(shouldAskLoginItem({ ...base, status: s })).toBe(false);
  });

  it('문구는 ko/en 둘 다 있고 「데몬」이라 부르지 않는다', () => {
    const KO = ko as unknown as Record<string, unknown>;
    const EN = en as unknown as Record<string, unknown>;
    const keys = Object.keys(EN).filter((k) => k.startsWith('loginItem.'));
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) {
      expect(KO[k], k).toBeTruthy();
      expect(`${String(KO[k])}${String(EN[k])}`).not.toMatch(/데몬|daemon/i);
    }
    expect(en['loginItem.label']).toBe('Start at login');
    expect(ko['loginItem.label']).toBe('로그인할 때 자동으로 시작');
  });
});

describe('설정 › 이 머신의 오퍼레이터 「시작」 줄', () => {
  it('macOS 13 미만·데스크톱 밖이면 묶음째 숨긴다', async () => {
    setLoginItemSurface(fakeSurface('unsupported'));
    render(<ThisOperatorSettings />);
    await screen.findByText(en['fda.group']).catch(() => null);
    expect(screen.queryByTestId('login-item-row')).toBeNull();
  });

  it('꺼짐 → 스위치를 켜면 켜짐, 이 기기에 「켰음」을 적는다', async () => {
    const s = fakeSurface('off');
    setLoginItemSurface(s);
    render(<ThisOperatorSettings />);
    const row = await screen.findByTestId('login-item-row');
    expect(row.dataset.state).toBe('off');
    expect(screen.queryByTestId('login-item-chip')).toBeNull();
    fireEvent.click(screen.getByTestId('login-item-switch'));
    await waitFor(() => expect(screen.getByTestId('login-item-row').dataset.state).toBe('on'));
    expect(s.set).toHaveBeenCalledWith(true);
    expect(loginItemStorage.wanted()).toBe(true);
    expect((screen.getByTestId('login-item-switch') as HTMLInputElement).checked).toBe(true);
  });

  it('켜지 못함 — 스위치는 꺼짐으로 남고 사유와 [다시 시도]', async () => {
    let fail = true;
    const s = fakeSurface('off', (on) => (on && fail ? new Error('Operation not permitted (code 1)') : on ? 'on' : 'off'));
    setLoginItemSurface(s);
    render(<ThisOperatorSettings />);
    await screen.findByTestId('login-item-row');
    fireEvent.click(screen.getByTestId('login-item-switch'));
    await waitFor(() => expect(screen.getByTestId('login-item-row').dataset.state).toBe('failed'));
    expect((screen.getByTestId('login-item-switch') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('login-item-row').textContent).toContain('Operation not permitted');
    fail = false;
    fireEvent.click(screen.getByTestId('login-item-retry'));
    await waitFor(() => expect(screen.getByTestId('login-item-row').dataset.state).toBe('on'));
  });

  it('승인 대기 — 스위치는 켜진 채 주의 칩과 [시스템 설정 열기]', async () => {
    const s = fakeSurface('approval');
    setLoginItemSurface(s);
    render(<ThisOperatorSettings />);
    const row = await screen.findByTestId('login-item-row');
    await waitFor(() => expect(row.dataset.state).toBe('approval'));
    expect(screen.getByTestId('login-item-chip').textContent).toBe(en['loginItem.chip.approval']);
    expect((screen.getByTestId('login-item-switch') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('login-item-open-system'));
    expect(s.openSettings).toHaveBeenCalledTimes(1);
  });

  it('칩·버튼이 있어도 줄 이름·설명을 누르면 스위치가 바뀐다 — [시스템 설정 열기]가 눌리지 않는다', async () => {
    const s = fakeSurface('approval');
    setLoginItemSurface(s);
    render(<ThisOperatorSettings />);
    await waitFor(() => expect(screen.getByTestId('login-item-row').dataset.state).toBe('approval'));
    // 버튼은 label 밖이다.
    expect(screen.getByTestId('login-item-open-system').closest('label')).toBeNull();
    fireEvent.click(screen.getByText(en['loginItem.label']));
    await waitFor(() => expect(screen.getByTestId('login-item-row').dataset.state).toBe('off'));
    expect(s.set).toHaveBeenCalledWith(false);
    expect(s.openSettings).not.toHaveBeenCalled();
  });

  it('여기서 켰는데 꺼짐으로 읽히면 「시스템 설정에서 꺼짐」 — 칩 없이 설명만', async () => {
    loginItemStorage.setWanted(true);
    setLoginItemSurface(fakeSurface('off'));
    render(<ThisOperatorSettings />);
    await waitFor(() => expect(screen.getByTestId('login-item-row').dataset.state).toBe('system'));
    expect(screen.queryByTestId('login-item-chip')).toBeNull();
    expect(screen.getByTestId('login-item-row').textContent).toContain(en['loginItem.row.system']);
  });
});

describe('작업 화면의 띠', () => {
  it('등록된 맥에서 한 번만 묻는다 — [켜기]면 켜지고, 다시 그려도 묻지 않는다', async () => {
    operatorLocal(true);
    const s = fakeSurface('off');
    setLoginItemSurface(s);
    const first = render(<LoginItemHost fdaDialogOpen={false} />);
    await screen.findByTestId('login-item-ask');
    expect(loginItemStorage.wasAsked()).toBe(true);
    fireEvent.click(screen.getByTestId('login-item-ask-on'));
    await screen.findByTestId('login-item-ask-done');
    expect(s.set).toHaveBeenCalledWith(true);
    first.unmount();
    resetLoginItemForTest();
    setLoginItemSurface(fakeSurface('off'));
    loginItemStorage.setWanted(false);
    render(<LoginItemHost fdaDialogOpen={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('login-item-ask')).toBeNull();
  });

  it('첫 실행 — 띠 자리가 먼저 서고 자동 등록이 뒤에 끝나도, 등록이 끝나면 묻는다', async () => {
    let registered = false;
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: vi.fn(async (cmd: string) => {
        if (cmd === 'operator_agents_list') return { communities: [{ baseUrl: BASE, registered }] };
        if (cmd === 'operator_register') { registered = true; return { name: 'mac' }; }
        return null;
      }),
    };
    setLoginItemSurface(fakeSurface('off'));
    render(<LoginItemHost fdaDialogOpen={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('login-item-ask')).toBeNull();
    await registerLocalOperator(BASE, 'code');
    await screen.findByTestId('login-item-ask');
  });

  it('등록 전·FDA 첫 창이 떠 있을 때는 묻지 않는다', async () => {
    operatorLocal(false);
    setLoginItemSurface(fakeSurface('off'));
    const a = render(<LoginItemHost fdaDialogOpen={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('login-item-ask')).toBeNull();
    a.unmount();
    operatorLocal(true);
    const b = render(<LoginItemHost fdaDialogOpen />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('login-item-ask')).toBeNull();
    expect(loginItemStorage.wasAsked()).toBe(false);
    // 창이 닫히면 그 뒤에 선다.
    b.rerender(<LoginItemHost fdaDialogOpen={false} />);
    await screen.findByTestId('login-item-ask');
  });

  it('승인 대기면 주의 띠 — [나중에]로 접고, 오퍼레이터 시작 실패 띠가 있으면 그쪽에 비킨다', async () => {
    loginItemStorage.markAsked();
    setLoginItemSurface(fakeSurface('approval'));
    const r = render(<LoginItemHost fdaDialogOpen={false} />);
    const band = await screen.findByTestId('login-item-band');
    expect(band.dataset.state).toBe('approval');
    fireEvent.click(screen.getByTestId('login-item-band-dismiss'));
    expect(screen.queryByTestId('login-item-band')).toBeNull();
    r.unmount();
    useAppStore.getState().set({ operatorStartupIssue: { kind: 'start', reason: 'node not found' } });
    render(<LoginItemHost fdaDialogOpen={false} />);
    await new Promise((r2) => setTimeout(r2, 20));
    expect(screen.queryByTestId('login-item-band')).toBeNull();
  });

  it('시스템 설정에서 직접 끈 것은 띠를 세우지 않는다', async () => {
    loginItemStorage.markAsked();
    loginItemStorage.setWanted(true);
    setLoginItemSurface(fakeSurface('off'));
    render(<LoginItemHost fdaDialogOpen={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('login-item-band')).toBeNull();
    expect(screen.queryByTestId('login-item-ask')).toBeNull();
  });
});
