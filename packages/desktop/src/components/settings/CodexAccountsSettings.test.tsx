/**
 * Codex 카드. `__TAURI_INTERNALS__` 를 갈아끼워 데몬 응답을 흉내낸다(`ClaudeAccountsSettings.test`
 * 와 같은 수법). 값은 전부 가짜다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { CodexAccountsSettings } from './CodexAccountsSettings';

const SNAP = {
  root: '/home/u/.harkroom-agent/codex-accounts',
  active: 'work' as string | null,
  system: { loggedIn: true, authMode: 'chatgpt', email: 'sys@example.com' },
  accounts: [
    { name: 'work', status: { loggedIn: true, authMode: 'chatgpt', email: 'work@example.com', plan: 'pro' } },
    { name: 'spare', status: { loggedIn: false } },
  ],
};

let calls: { cmd: string; args?: Record<string, unknown> }[] = [];
let loginCb: ((p: unknown) => void) | undefined;

function stubTauri(snapshot: unknown = SNAP): void {
  calls = [];
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: (cb: (p: unknown) => void) => { loginCb = cb; return 1; },
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === 'codex_accounts_list') return snapshot;
      if (cmd === 'codex_account_login_start') return { loginId: 'lid-1' };
      return {};
    }),
  });
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Codex 카드', () => {
  it('시스템 기본값 줄이 맨 위에 서고, 활성 배지는 활성 계정에만 붙는다', async () => {
    stubTauri();
    render(<CodexAccountsSettings />);
    const work = await screen.findByTestId('codex-account-work');
    expect(within(work).getByText('work@example.com')).toBeTruthy();
    expect(within(work).getByText('Active')).toBeTruthy();
    expect(within(work).getByText('This device')).toBeTruthy();
    const system = screen.getByTestId('codex-account-system');
    expect(within(system).queryByText('Active')).toBeNull();
    // 로그인 안 된 계정에는 "사용" 버튼이 없다 — 활성으로 만들 수 없다
    const spare = screen.getByTestId('codex-account-spare');
    expect(within(spare).getByText('Not signed in')).toBeTruthy();
    expect(within(spare).queryByRole('button', { name: 'Use' })).toBeNull();
  });

  it('관리 계정이 없으면 점선 칸이 시스템 기본을 쓴다고 말하고, 시스템 줄이 활성이다', async () => {
    stubTauri({ ...SNAP, active: null, accounts: [] });
    render(<CodexAccountsSettings />);
    expect(await screen.findByTestId('codex-accounts-empty')).toBeTruthy();
    expect(within(screen.getByTestId('codex-account-system')).getByText('Active')).toBeTruthy();
  });

  it('시스템 기본으로 돌리기 → codex_account_activate(null)', async () => {
    stubTauri();
    render(<CodexAccountsSettings />);
    const system = await screen.findByTestId('codex-account-system');
    await waitFor(() => expect(within(system).getByRole('button', { name: 'Use' })).toBeTruthy());
    fireEvent.click(within(system).getByRole('button', { name: 'Use' }));
    await waitFor(() => expect(calls.some((c) => c.cmd === 'codex_account_activate' && c.args?.account === null)).toBe(true));
  });

  it('계정 추가: 이름 문법을 재고, 로그인 URL 이 오면 여는 버튼이 서고, done 이면 목록을 다시 읽는다', async () => {
    stubTauri();
    render(<CodexAccountsSettings />);
    await screen.findByTestId('codex-account-work');
    fireEvent.click(screen.getByRole('button', { name: /Add account/ }));
    const form = screen.getByTestId('codex-add-form');
    const input = within(form).getByRole('textbox');
    const signIn = within(form).getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: 'Bad Name' } });
    expect(signIn.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'work' } }); // 이미 있다
    expect(signIn.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'side' } });
    expect(signIn.disabled).toBe(false);
    fireEvent.click(signIn);
    await waitFor(() => expect(calls.some((c) => c.cmd === 'codex_account_login_start' && c.args?.account === 'side')).toBe(true));
    await screen.findByTestId('codex-login');

    loginCb?.({ payload: { loginId: 'lid-1', url: 'https://auth.openai.com/oauth/authorize?x=1' } });
    expect(await screen.findByRole('button', { name: 'Open sign-in page' })).toBeTruthy();

    const before = calls.filter((c) => c.cmd === 'codex_accounts_list').length;
    loginCb?.({ payload: { loginId: 'lid-1', done: true, status: { loggedIn: true } } });
    await waitFor(() => expect(screen.queryByTestId('codex-login')).toBeNull());
    await waitFor(() => expect(calls.filter((c) => c.cmd === 'codex_accounts_list').length).toBeGreaterThan(before));
  });

  it('제거는 확인을 한 번 거친다', async () => {
    stubTauri();
    render(<CodexAccountsSettings />);
    const spare = await screen.findByTestId('codex-account-spare');
    fireEvent.click(within(spare).getByRole('button', { name: 'Remove' }));
    expect(calls.some((c) => c.cmd === 'codex_account_remove')).toBe(false);
    fireEvent.click(within(spare).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls.some((c) => c.cmd === 'codex_account_remove' && c.args?.account === 'spare')).toBe(true));
  });
});
