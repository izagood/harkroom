/**
 * claude 계정 풀 설정 화면.
 *
 * **Tauri 표면을 위조한다.** 이 화면의 모든 쓰기는 `invoke` 를 지나고, 그 뒤에는 데몬이
 * 있다 — 테스트가 진짜 데몬을 세울 수는 없다. 그래서 `__TAURI_INTERNALS__` 를 갈아끼우는
 * 이 저장소의 판례를 따른다(`session.test.ts`, `keychainWaitNotice.test.tsx`).
 *
 * 재는 것은 **화면이 무엇을 말하고 무엇을 보내는가**다: 로그인 상태를 정확히 그리는지,
 * 파괴적 연산에 확인을 두는지, 러너 반영을 안내하는지, 표면이 없을 때 정직한지.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ClaudeAccountsSettings } from './ClaudeAccountsSettings';

const POOLS_SNAPSHOT = {
  root: '/home/u/.murmur-agent/claude-accounts',
  mode: 'pools' as const,
  defaultPool: 'work',
  agents: { a1: 'personal' },
  pools: [
    {
      name: 'work',
      accounts: [
        { name: 'lime', status: { loggedIn: true, email: 'me@corp.example', orgName: 'Corp', subscriptionType: 'team' } },
        { name: 'plum', status: { loggedIn: false } },
      ],
    },
    { name: 'personal', accounts: [{ name: 'gmail', status: { loggedIn: true, email: 'me@personal.example', orgName: 'Personal', subscriptionType: 'max' } }] },
  ],
  strays: [] as string[],
};

let calls: { cmd: string; args?: Record<string, unknown> }[] = [];

function stubTauri(snapshot: unknown = POOLS_SNAPSHOT, over: Record<string, unknown> = {}): void {
  calls = [];
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: (cb: (p: unknown) => void) => {
      (globalThis as unknown as { __loginCb?: (p: unknown) => void }).__loginCb = cb;
      return 1;
    },
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === 'claude_accounts_list') return snapshot;
      if (cmd in over) return (over as Record<string, unknown>)[cmd];
      if (cmd === 'claude_account_login_start') return { loginId: 'lid-1' };
      if (cmd === 'claude_account_move') return { loggedIn: true };
      return {};
    }),
  });
}

/** 데몬이 보낸 로그인 이벤트를 흉내낸다. Rust 가 감싸는 모양(`{ payload }`)을 지킨다. */
function emitLogin(body: unknown): void {
  (globalThis as unknown as { __loginCb?: (p: unknown) => void }).__loginCb?.({ payload: body });
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('목록', () => {
  it('풀과 계정을 그리고, 로그인 계정의 정체를 보여 준다', async () => {
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('work');
    expect(screen.getByText('personal')).toBeTruthy();
    expect(screen.getByText('lime')).toBeTruthy();
    // 정체가 보여야 사용자가 어느 계정인지 안다 — 이름만으로는 자기가 붙인 별명일 뿐이다.
    expect(screen.getByText(/me@corp\.example/)).toBeTruthy();
    expect(screen.getByText(/Corp/)).toBeTruthy();
  });

  it('미로그인 계정을 그 사실과 함께 남긴다 — 목록에서 숨기지 않는다', async () => {
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('plum');
    // 숨기면 사용자는 자기가 만든 계정이 사라진 줄 안다. 로그인해야 할 대상이다.
    expect(screen.getByText(/Not signed in/i)).toBeTruthy();
  });

  it('어느 풀이 기본인지 표시하고, 기본이 아닌 풀에만 지정 버튼을 준다', async () => {
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('work');
    // 기본 풀에는 설명이 붙고 '기본으로' 버튼이 없다 — 이미 기본이다.
    expect(screen.getByText(/Default pool/i)).toBeTruthy();
    const makeDefault = screen.getAllByRole('button', { name: /make default/i });
    expect(makeDefault).toHaveLength(1); // personal 에만 있다
  });

  it('러너가 재시작해야 반영된다는 사실을 말한다', async () => {
    // 러너는 풀을 기동 시 1회 읽는다. 안 말하면 사용자는 계정을 추가하고 왜 안 쓰는지 모른다.
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('work');
    expect(screen.getByText(/restart/i)).toBeTruthy();
  });
});

describe('평평한 계정 이전 안내', () => {
  it('strays 가 있으면 이전을 안내한다', async () => {
    stubTauri({ ...POOLS_SNAPSHOT, strays: ['leftover'] });
    render(<ClaudeAccountsSettings />);
    await screen.findByText(/leftover/);
    expect(screen.getByText(/Accounts outside any pool/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /move into a pool/i })).toBeTruthy();
  });

  it('이전 결과가 미로그인이면 다시 로그인하라고 말한다 — 성공했다고 하지 않는다', async () => {
    stubTauri({ ...POOLS_SNAPSHOT, strays: ['leftover'] }, { claude_account_move: { loggedIn: false } });
    render(<ClaudeAccountsSettings />);
    await screen.findByText(/leftover/);
    fireEvent.click(screen.getByRole('button', { name: /move into a pool/i }));
    await waitFor(() => expect(screen.getByText(/no longer signed in/i)).toBeTruthy());
  });
});

describe('삭제', () => {
  it('계정 삭제에 확인 단계가 있다 — 자격증명이 사라진다', async () => {
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('lime');
    fireEvent.click(screen.getByRole('button', { name: /remove account lime/i }));
    // 한 번 눌러서는 안 지워진다.
    expect(calls.some((c) => c.cmd === 'claude_account_remove')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(calls.some((c) => c.cmd === 'claude_account_remove')).toBe(true));
  });

  it('풀 삭제에도 확인 단계가 있다', async () => {
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('work');
    fireEvent.click(screen.getByRole('button', { name: /remove pool work/i }));
    expect(calls.some((c) => c.cmd === 'claude_pool_remove')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(calls.some((c) => c.cmd === 'claude_pool_remove')).toBe(true));
  });
});

describe('계정 추가', () => {
  it('URL 을 링크로 보여 주고 시크릿 창을 안내한다', async () => {
    // 링크를 직접 보여 주는 이유의 절반이 이것이다 — 브라우저가 자동으로 열리면
    // 시크릿 창을 못 고르고, 그러면 기존 쿠키로 같은 계정에 다시 로그인된다.
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('work');
    fireEvent.click(screen.getByRole('button', { name: /add account to work/i }));
    fireEvent.change(screen.getByLabelText(/account name/i), { target: { value: 'newone' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => expect(calls.some((c) => c.cmd === 'claude_account_login_start')).toBe(true));
    emitLogin({ loginId: 'lid-1', url: 'https://claude.com/oauth?x=1' });
    const link = await screen.findByRole('link', { name: /claude\.com/ });
    expect(link.getAttribute('href')).toBe('https://claude.com/oauth?x=1');
    expect(screen.getByText(/private|incognito/i)).toBeTruthy();
  });

  it('코드를 제출하면 그 로그인의 id 로 보낸다', async () => {
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('work');
    fireEvent.click(screen.getByRole('button', { name: /add account to work/i }));
    fireEvent.change(screen.getByLabelText(/account name/i), { target: { value: 'newone' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    await waitFor(() => expect(calls.some((c) => c.cmd === 'claude_account_login_start')).toBe(true));
    emitLogin({ loginId: 'lid-1', url: 'https://claude.com/oauth?x=1' });

    fireEvent.change(await screen.findByLabelText(/code/i), { target: { value: 'THE-CODE' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.cmd === 'claude_account_login_submit');
      expect(call?.args).toEqual({ loginId: 'lid-1', code: 'THE-CODE' });
    });
  });

  it('이름 문법을 입력 단계에서 안내한다', async () => {
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('work');
    fireEvent.click(screen.getByRole('button', { name: /add account to work/i }));
    fireEvent.change(screen.getByLabelText(/account name/i), { target: { value: 'Bad Name' } });
    // 보내지 않는다 — 데몬이 거절할 것을 미리 말한다.
    expect((screen.getByRole('button', { name: /^sign in$/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/lowercase|a-z/i)).toBeTruthy();
  });

  it('실패로 끝나면 그 사유를 남긴다 — 무음으로 사라지지 않는다', async () => {
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('work');
    fireEvent.click(screen.getByRole('button', { name: /add account to work/i }));
    fireEvent.change(screen.getByLabelText(/account name/i), { target: { value: 'newone' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    await waitFor(() => expect(calls.some((c) => c.cmd === 'claude_account_login_start')).toBe(true));

    emitLogin({ loginId: 'lid-1', done: true, status: { loggedIn: false }, error: '로그인이 끝나지 않았다' });
    await waitFor(() => expect(screen.getByText(/끝나지 않았다|did not finish/i)).toBeTruthy());
  });
});

describe('풀 만들기', () => {
  it('새 풀 이름을 설정 쓰기로 보낸다 — 그것이 생성 경로다', async () => {
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('work');
    fireEvent.click(screen.getByRole('button', { name: /new pool/i }));
    fireEvent.change(screen.getByLabelText(/pool name/i), { target: { value: 'client-a' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.cmd === 'claude_accounts_configure');
      const config = call?.args?.config as { order?: Record<string, string[]> } | undefined;
      expect(config?.order).toHaveProperty('client-a');
    });
  });
});

describe('Tauri 표면이 없을 때', () => {
  it('쓸 수 없다는 사실을 말하고 아무것도 부르지 않는다', () => {
    // 웹·테스트 환경이다. 버튼만 그려 두면 눌리는데 아무 일도 안 나고, 사람은 자기
    // 설정이 깨진 줄 안다.
    render(<ClaudeAccountsSettings />);
    expect(screen.getByText(/not available in this build/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new pool/i })).toBeNull();
  });
});
