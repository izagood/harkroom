import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { ThisOperatorSettings } from '../src/components/settings/ThisOperatorSettings';
import { acc } from './helpers/fakeApi';
import { usePrefsStore } from '../src/state/prefsStore';

/**
 * 설정 › 이 기기 › 이 머신의 오퍼레이터(UX ⑥b-2). 오퍼레이터 페이지에 있던 "이 머신 등록" 을
 * 그대로 옮겨 왔다 — 회귀선도 그 페이지의 것을 옮겨 왔고(스펙 §3: 코드를 사람이 옮기지 않는다),
 * 쓸 수 없는 두 사정(웹 빌드·권한 없음)을 말하는지 더 잰다.
 */
function fakeController(operators: Array<{ id: string; name: string; online: boolean }> = []) {
  const c = {
    api: { baseUrl: 'https://example.com' },
    operators: vi.fn(async () => operators),
    operatorRegisterCode: vi.fn(async () => ({ code: 'hkreg_abc', expiresAt: '2026-09-21T00:05:00Z' })),
  };
  setController(c as unknown as Controller);
  return c;
}
/** 오퍼레이터 로컬 설정: 지금 서버(example.com)에 등록돼 있는가. */
const local = (registered: boolean, operatorId: string | null = 'op-7') => ({
  communities: [{ baseUrl: 'https://example.com', registered, operatorId, agents: {} }],
});
const withTauri = (invoke: ReturnType<typeof vi.fn>) => {
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke, metadata: { currentWindow: { label: 'main' } } };
};

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  // `member` 도 기본으로 `operator.register` 를 갖는다(스펙 §7 결정 2).
  useAppStore.getState().set({ me: acc('u1', 'me') });
});
afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  usePrefsStore.getState().setLocale('system');
});

describe('이 머신의 오퍼레이터 (UX ⑥b-2)', () => {
  it('Tauri 표면이 있으면 버튼 하나가 코드 발급 → 오퍼레이터 등록으로 이어지고, 이름만 보인다', async () => {
    const invoke = vi.fn(async (cmd: string) => (cmd === 'operator_register'
      ? { operatorId: 'op-7', name: 'this-mac', baseUrl: 'https://example.com' }
      : cmd === 'operator_agents_list' ? local(false) : {}));
    withTauri(invoke);
    const c = fakeController();
    render(<ThisOperatorSettings />);
    expect(screen.getByRole('heading', { name: '이 머신의 오퍼레이터' })).toBeTruthy();
    expect(await screen.findByText('아직 등록 안 됨')).toBeTruthy();
    fireEvent.click(screen.getByText('이 머신을 등록'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operator_register', { baseUrl: 'https://example.com', code: 'hkreg_abc', name: null }));
    expect(c.operatorRegisterCode).toHaveBeenCalled();
    const done = await screen.findByTestId('operator-registered-here');
    expect(done.textContent).toContain('this-mac');
    // 등록 코드는 화면을 거치지 않는다 — 오퍼레이터 id 도 보이지 않는다(이름만).
    expect(document.body.textContent).not.toContain('hkreg_abc');
    expect(document.body.textContent).not.toContain('op-7');
  });

  it('Tauri 표면이 없으면(웹) 버튼 대신 왜 안 되는지와 다른 길을 말한다', () => {
    fakeController();
    render(<ThisOperatorSettings />);
    expect(screen.queryByText('이 머신을 등록')).toBeNull();
    expect(screen.getByTestId('this-operator-unavailable').textContent).toContain('에이전트 › 오퍼레이터');
  });

  it('등록 권한이 없으면 버튼 대신 권한이 필요하다고 말한다', () => {
    withTauri(vi.fn(async () => local(false)));
    useAppStore.getState().set({ me: acc('u2', 'guest', 'human', false, { role: 'guest', capabilities: [] }) });
    fakeController();
    render(<ThisOperatorSettings />);
    expect(screen.queryByText('이 머신을 등록')).toBeNull();
    expect(screen.getByTestId('this-operator-no-cap')).toBeTruthy();
  });

  /**
   * **지금 등록돼 있는지 말한다**(designer #1016 검토) — 목록이 다른 페이지로 갔으니 이 페이지가
   * 스스로 말해야 같은 머신을 두 번 등록하지 않는다. 이름은 **operatorId 로** 목록에서 고른다.
   */
  it('이미 등록돼 있으면 "등록됨 · 이름 · 연결됨" 이고 버튼은 "다시 등록" 으로 낮아진다', async () => {
    withTauri(vi.fn(async (cmd: string) => (cmd === 'operator_agents_list' ? local(true) : {})));
    fakeController([{ id: 'op-x', name: 'this-mac', online: false }, { id: 'op-7', name: 'this-mac', online: true }]);
    render(<ThisOperatorSettings />);
    const status = await screen.findByTestId('this-operator-status');
    await waitFor(() => expect(status.dataset.state).toBe('registered'));
    expect(status.textContent).toBe('등록됨 · this-mac · 연결됨');
    expect(screen.getByTestId('this-operator-register').textContent).toBe('다시 등록');
  });

  it('로컬 설정을 못 읽으면 "알 수 없다" 고 말한다 — 등록 안 됨으로 지어내지 않는다', async () => {
    withTauri(vi.fn(async () => { throw new Error('daemon down'); }));
    fakeController();
    render(<ThisOperatorSettings />);
    await waitFor(() => expect(screen.getByTestId('this-operator-status').dataset.state).toBe('unknown'));
    expect(screen.getByTestId('this-operator-register').textContent).toBe('이 머신을 등록');
  });

  it('오퍼레이터 목록으로 가는 길이 글이 아니라 버튼이다', async () => {
    withTauri(vi.fn(async () => local(false)));
    fakeController();
    const onOpenSection = vi.fn();
    render(<ThisOperatorSettings onOpenSection={onOpenSection} />);
    fireEvent.click(await screen.findByTestId('this-operator-open-list'));
    expect(onOpenSection).toHaveBeenCalledWith('operators');
  });
});
