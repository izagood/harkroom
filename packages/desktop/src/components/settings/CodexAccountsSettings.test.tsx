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
  it('첫 답 전에는 스켈레톤 — 목록이 오면 줄을 먼저 그리고, 사용량은 따로 채운다', async () => {
    let listDone: (v: unknown) => void = () => {};
    let usageDone: (v: unknown) => void = () => {};
    vi.stubGlobal('__TAURI_INTERNALS__', {
      transformCallback: () => 1,
      invoke: vi.fn((cmd: string) => {
        if (cmd === 'codex_accounts_list') return new Promise((r) => { listDone = r; });
        if (cmd === 'codex_accounts_provider_usage') return new Promise((r) => { usageDone = r; });
        return Promise.resolve({});
      }),
    });
    render(<CodexAccountsSettings />);
    // 목록 전: "로그아웃됨"이라고 단언하지 않고 자리표시를 그린다.
    expect(screen.getByTestId('provider-accounts-skeleton')).toBeTruthy();
    expect(screen.getByTestId('codex-system-skeleton')).toBeTruthy();
    expect(screen.queryByText('Not signed in')).toBeNull();

    listDone(SNAP);
    const work = await screen.findByTestId('codex-account-work');
    expect(screen.queryByTestId('provider-accounts-skeleton')).toBeNull();
    // 사용량은 아직 — 막대 자리에 스켈레톤.
    expect(within(work).getByTestId('provider-usage-skeleton')).toBeTruthy();

    usageDone({
      measuredAtMs: 0,
      accounts: [{ account: 'work', fetchedAtMs: 0, source: 'cli', session: { usedPercent: 40, resetsAtMs: null }, weekly: null }],
    });
    await waitFor(() => expect(within(work).getByTestId('provider-usage')).toBeTruthy());
    expect(screen.queryByTestId('provider-usage-skeleton')).toBeNull();
  });

  it('사용량 첫 답이 실패하면 스켈레톤을 거둔다 — 영원히 "불러오는 중"이 아니다', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {
      transformCallback: () => 1,
      invoke: vi.fn((cmd: string) => {
        if (cmd === 'codex_accounts_list') return Promise.resolve(SNAP);
        if (cmd === 'codex_accounts_provider_usage') return Promise.reject(new Error('daemon 이 답하지 않는다'));
        return Promise.resolve({});
      }),
    });
    render(<CodexAccountsSettings />);
    await screen.findByTestId('codex-account-work');
    await waitFor(() => expect(screen.queryByTestId('provider-usage-skeleton')).toBeNull());
  });

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

describe('공급자 API 사용률 막대', () => {
  const USAGE = {
    measuredAtMs: Date.parse('2026-09-28T12:00:00Z'),
    accounts: [
      { account: '', session: null, weekly: null, fetchedAtMs: 0, error: 'token-expired' },
      {
        account: 'work', fetchedAtMs: 0,
        session: { usedPercent: 93.4, resetsAtMs: Date.parse('2026-09-28T13:00:00Z') },
        weekly: { usedPercent: 12, resetsAtMs: null },
      },
    ],
  };
  const stubWithUsage = (): void => {
    calls = [];
    vi.stubGlobal('__TAURI_INTERNALS__', {
      transformCallback: () => 1,
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'codex_accounts_list') return SNAP;
        if (cmd === 'codex_accounts_provider_usage') return USAGE;
        return {};
      }),
    });
  };

  it('계정 줄에 5시간·주간 % 가 서고, 못 읽은 계정은 이유를 말한다 — 데몬에는 아무것도 넘기지 않는다', async () => {
    stubWithUsage();
    render(<CodexAccountsSettings />);
    const work = await screen.findByTestId('codex-account-work');
    await waitFor(() => expect(within(work).getByText('93%')).toBeTruthy());
    expect(within(work).getByText('12%')).toBeTruthy();
    const system = screen.getByTestId('codex-account-system');
    expect(within(system).getByTestId('provider-usage-error').textContent).toMatch(/expired/);
    expect(calls.find((c) => c.cmd === 'codex_accounts_provider_usage')?.args).toBeUndefined();
  });

  it('API 로 읽은 값도 CLI 로 읽은 값과 똑같이 그린다 — 출처가 같아 꼬리표가 없다', async () => {
    USAGE.accounts[1] = { ...USAGE.accounts[1]!, source: 'api' } as never;
    stubWithUsage();
    render(<CodexAccountsSettings />);
    const work = await screen.findByTestId('codex-account-work');
    await waitFor(() => expect(within(work).getByText('93%')).toBeTruthy());
    expect(within(work).getAllByTestId('provider-usage')).toHaveLength(1);
    expect(within(work).queryByText(/API/)).toBeNull();
  });
});
