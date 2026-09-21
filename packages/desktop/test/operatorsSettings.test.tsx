/**
 * 설정 › Operators — 스펙 2026-09-20 §3(등록)·§2 책임표.
 *
 * 앱이 러너를 띄우지 않게 된 뒤로 사람이 앱에서 하는 일은 둘이다: **오퍼레이터를 등록**
 * (1회용 코드를 받아 그 머신에서 `harkroom-operator register` 에 넣는다)하고, 등록된
 * 것을 **본다·폐기한다**. 여기서 재는 것은 그 두 흐름이 컨트롤러의 표면에 닿는가와,
 * 코드가 화면에 **한 번만** 보인다는 사실을 화면이 말하는가다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { OperatorView } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { OperatorsSettings } from '../src/components/settings/OperatorsSettings';
import { acc } from './helpers/fakeApi';
import { usePrefsStore } from '../src/state/prefsStore';

beforeEach(() => usePrefsStore.getState().setLocale('ko'));
afterEach(() => usePrefsStore.getState().setLocale('system'));

const op = (id: string, name: string, extra: Partial<OperatorView> = {}): OperatorView => ({
  id, name, ownerAccountId: 'u1', createdAt: '2026-09-21T00:00:00Z', lastSeenAt: null, revokedAt: null,
  online: false, ...extra,
});

function fakeController(operators: OperatorView[] = []) {
  const c = {
    operators: vi.fn(async () => operators),
    api: { baseUrl: 'https://example.com' },
    operatorCapabilities: vi.fn(async (id: string) => (id === 'op-1'
      ? { agentIds: ['a-1', 'a-2'], harnesses: { 'claude-code': { installed: true, loggedIn: true }, codex: { installed: false, loggedIn: false } } }
      : Promise.reject(new Error('offline')))),
    operatorRegisterCode: vi.fn(async () => ({ code: 'hkreg_abc', expiresAt: '2026-09-21T00:05:00Z' })),
    revokeOperator: vi.fn(async () => undefined),
  };
  setController(c as unknown as Controller);
  return c;
}

beforeEach(() => {
  useAppStore.getState().reset();
  // `member` 도 기본으로 `operator.register` 를 갖는다(스펙 §7 결정 2) — 관리자가 아니어도 이 화면은 열린다.
  useAppStore.getState().set({ me: acc('u1', 'me') });
});
afterEach(() => cleanup());

describe('OperatorsSettings', () => {
  it('등록된 오퍼레이터를 이름·연결 상태와 함께 나열한다', async () => {
    fakeController([op('op-1', 'jaebin-mbp', { online: true }), op('op-2', 'gpu-box')]);
    render(<OperatorsSettings />);
    await screen.findByText('jaebin-mbp');
    expect(screen.getByText('gpu-box')).toBeTruthy();
    expect(screen.getByTestId('operator-online-op-1').textContent).toContain('연결됨');
    expect(screen.getByTestId('operator-online-op-2').textContent).toContain('끊김');
  });

  it('등록 코드를 발급하면 코드와 넣을 명령이 보이고, 한 번만 보인다고 말한다', async () => {
    const c = fakeController();
    render(<OperatorsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '등록 코드 발급' }));
    await waitFor(() => {
      expect(c.operatorRegisterCode).toHaveBeenCalledTimes(1);
      expect(screen.getAllByText(/hkreg_abc/).length).toBeGreaterThan(0);
    });
    // 코드를 어디에 넣는지 — 사람이 다음에 할 일이 화면에 있어야 한다.
    expect(screen.getByTestId('operator-register-command').textContent).toContain('harkroom-operator register');
    expect(screen.getByTestId('operator-register-command').textContent).toContain('hkreg_abc');
    expect(screen.getByText(/지금만 보인다/)).toBeTruthy();
  });

  it('폐기는 컨트롤러에 닿고 목록을 다시 읽는다', async () => {
    const c = fakeController([op('op-1', 'old-box')]);
    render(<OperatorsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'old-box 폐기' }));
    await waitFor(() => {
      expect(c.revokeOperator).toHaveBeenCalledWith('op-1');
      expect(c.operators).toHaveBeenCalledTimes(2);
    });
  });

  it('등록 능력이 없는 사람에게는 등록 버튼이 없다 — 목록은 본다', async () => {
    useAppStore.getState().set({ me: acc('u2', 'guest', 'human', false, { role: 'guest', capabilities: [] }) });
    fakeController([op('op-1', 'someone')]);
    render(<OperatorsSettings />);
    await screen.findByText('someone');
    expect(screen.queryByRole('button', { name: '등록 코드 발급' })).toBeNull();
  });
});

describe('오퍼레이터 능력(스펙 §3)', () => {
  it('붙어 있는 오퍼레이터는 로컬 설정의 에이전트 수와 하네스를 보이고, 끊긴 것은 능력 줄이 없다', async () => {
    fakeController([op('op-1', 'jaebin-mbp', { online: true }), op('op-2', 'gpu-box')]);
    render(<OperatorsSettings />);
    const caps = await screen.findByTestId('operator-caps-op-1');
    expect(caps.textContent).toContain('에이전트 2개');
    expect(caps.textContent).toContain('claude-code: 설치·로그인됨');
    expect(caps.textContent).toContain('codex: 없음');
    expect(screen.queryByTestId('operator-caps-op-2')).toBeNull();
  });
});

describe('이 머신 등록(스펙 §3) — 코드를 사람이 옮기지 않는다', () => {
  afterEach(() => { delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__; });
  it('Tauri 표면이 있으면 버튼 하나가 코드 발급 → 오퍼레이터 등록 → 목록 갱신으로 이어진다', async () => {
    const invoke = vi.fn(async (cmd: string) => (cmd === 'operator_register' ? { operatorId: 'op-7', name: 'this-mac', baseUrl: 'https://example.com' } : {}));
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke, metadata: { currentWindow: { label: 'main' } } };
    const c = fakeController();
    render(<OperatorsSettings />);
    fireEvent.click(await screen.findByText('이 머신을 등록'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operator_register', { baseUrl: 'https://example.com', code: 'hkreg_abc', name: null }));
    expect(c.operatorRegisterCode).toHaveBeenCalled();
    expect((await screen.findByTestId('operator-registered-here')).textContent).toContain('this-mac');
    // 목록을 다시 읽는다 — 방금 붙은 오퍼레이터가 online 으로 서게.
    await waitFor(() => expect(c.operators.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
  it('Tauri 표면이 없으면(웹) 이 머신 등록 버튼이 없고 코드 발급만 있다', async () => {
    fakeController();
    render(<OperatorsSettings />);
    await screen.findByText('등록 코드 발급');
    expect(screen.queryByText('이 머신을 등록')).toBeNull();
  });
});
