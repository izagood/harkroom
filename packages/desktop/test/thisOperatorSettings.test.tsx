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
function fakeController() {
  const c = {
    api: { baseUrl: 'https://example.com' },
    operatorRegisterCode: vi.fn(async () => ({ code: 'hkreg_abc', expiresAt: '2026-09-21T00:05:00Z' })),
  };
  setController(c as unknown as Controller);
  return c;
}
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
    const invoke = vi.fn(async (cmd: string) => (cmd === 'operator_register' ? { operatorId: 'op-7', name: 'this-mac', baseUrl: 'https://example.com' } : {}));
    withTauri(invoke);
    const c = fakeController();
    render(<ThisOperatorSettings />);
    expect(screen.getByRole('heading', { name: '이 머신의 오퍼레이터' })).toBeTruthy();
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
    withTauri(vi.fn());
    useAppStore.getState().set({ me: acc('u2', 'guest', 'human', false, { role: 'guest', capabilities: [] }) });
    fakeController();
    render(<ThisOperatorSettings />);
    expect(screen.queryByText('이 머신을 등록')).toBeNull();
    expect(screen.getByTestId('this-operator-no-cap')).toBeTruthy();
  });
});
