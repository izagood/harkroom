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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ClaudeAccountsSettings } from './ClaudeAccountsSettings';
import { usePrefsStore } from '../../state/prefsStore';

const POOLS_SNAPSHOT = {
  root: '/home/u/.harkroom-agent/claude-accounts',
  mode: 'pools' as const,
  defaultPool: 'work',
  agents: { a1: 'personal' },
  pools: [
    {
      name: 'work',
      accounts: [
        { name: 'aria', status: { loggedIn: true, email: 'me@corp.example', orgName: 'Corp', subscriptionType: 'team' } },
        { name: 'cedar', status: { loggedIn: false } },
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
    expect(screen.getByText('aria')).toBeTruthy();
    // 정체가 보여야 사용자가 어느 계정인지 안다 — 이름만으로는 자기가 붙인 별명일 뿐이다.
    expect(screen.getByText(/me@corp\.example/)).toBeTruthy();
    expect(screen.getByText(/Corp/)).toBeTruthy();
  });

  it('미로그인 계정을 그 사실과 함께 남긴다 — 목록에서 숨기지 않는다', async () => {
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('cedar');
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

/**
 * 사용량은 **공급자가 말한 %** 하나다(2026-09-29). 트랜스크립트 토큰 합계로 짐작하던 로컬 추정은
 * 걷어 냈다 — 되살아나면 같은 물음에 답이 둘이 된다.
 */
describe('사용량', () => {
  const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);

  it('계정 줄 아래에 5시간·주간 막대를 그린다', async () => {
    stubTauri(POOLS_SNAPSHOT, {
      claude_accounts_provider_usage: {
        measuredAtMs: NOW,
        accounts: [{
          account: 'aria', pool: 'work', source: 'cli', fetchedAtMs: NOW,
          session: { usedPercent: 42, resetsAtMs: null }, weekly: { usedPercent: 7, resetsAtMs: null },
        }],
      },
    });
    render(<ClaudeAccountsSettings />);
    const box = await screen.findByTestId('claude-provider-usage-work-aria');
    expect(box.textContent).toContain('42%');
    expect(box.textContent).toContain('7%');
  });

  it('첫 답 전에는 스켈레톤 — 목록을 먼저 그리고, 사용량은 와야 막대로 바뀐다', async () => {
    let listDone: (v: unknown) => void = () => {};
    let usageDone: (v: unknown) => void = () => {};
    vi.stubGlobal('__TAURI_INTERNALS__', {
      transformCallback: () => 1,
      invoke: vi.fn((cmd: string) => {
        if (cmd === 'claude_accounts_list') return new Promise((r) => { listDone = r; });
        if (cmd === 'claude_accounts_provider_usage') return new Promise((r) => { usageDone = r; });
        return Promise.resolve({});
      }),
    });
    render(<ClaudeAccountsSettings />);
    // 목록 전: 빈 화면("계정이 없다")이 아니라 자리표시.
    expect(screen.getByTestId('provider-accounts-skeleton')).toBeTruthy();

    listDone(POOLS_SNAPSHOT);
    await screen.findByTestId('claude-account-work-aria');
    expect(screen.queryByTestId('provider-accounts-skeleton')).toBeNull();
    // 사용량을 기다리는 동안 계정마다 막대 자리표시가 선다(3계정).
    expect(screen.getAllByTestId('provider-usage-skeleton')).toHaveLength(3);

    usageDone({
      measuredAtMs: NOW,
      accounts: [{
        account: 'aria', pool: 'work', source: 'cli', fetchedAtMs: NOW,
        session: { usedPercent: 42, resetsAtMs: null }, weekly: null,
      }],
    });
    expect((await screen.findByTestId('claude-provider-usage-work-aria')).textContent).toContain('42%');
    // 첫 답이 왔으면 값이 없는 계정의 자리표시도 거둔다 — 그 계정은 "모른다"가 사실이다.
    expect(screen.queryByTestId('provider-usage-skeleton')).toBeNull();
  });

  it('트랜스크립트를 세는 옛 경로를 부르지 않고, 토큰 열도 그리지 않는다', async () => {
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('aria');
    expect(calls.some((c) => c.cmd === 'claude_accounts_usage')).toBe(false);
    expect(screen.queryByText('Cache')).toBeNull();
    expect(screen.queryByText(/transcripts/i)).toBeNull();
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

/**
 * 확인은 **겹창**이다. 앞판은 페이지 맨 아래 "Confirm" 카드로 붙였고, 누른 `⋯` 에서 멀어서
 * 오류 배너로 읽혔다(2026-09-29). 그래서 dialog 로 뜨는지 · 기본 손가락이 취소인지 ·
 * 한 번만 보내는지 · 실패를 창 안에서 말하는지를 잰다.
 */
describe('삭제', () => {
  const removes = (cmd: string) => calls.filter((c) => c.cmd === cmd);

  async function openAccountRemove(): Promise<void> {
    render(<ClaudeAccountsSettings />);
    await screen.findByText('aria');
    // 파괴적 조작은 `⋯` 뒤에 있다 — 색이 아니라 확인 단계가 안전을 지므로 줄에서 내렸다.
    fireEvent.click(screen.getByRole('button', { name: /actions for account aria/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /remove account aria/i }));
  }

  it('계정 삭제에 확인 단계가 있다 — 자격증명이 사라진다', async () => {
    stubTauri();
    await openAccountRemove();
    // 한 번 눌러서는 안 지워진다.
    expect(removes('claude_account_remove')).toHaveLength(0);
    const dialog = screen.getByRole('dialog', { name: 'Remove account aria?' });
    expect(dialog.textContent).toContain('in pool work');
    expect(dialog.textContent).toContain('saved sign-in is deleted');
    // 하단 "Confirm" 카드는 더 없다. 버튼 이름은 하는 일이다.
    expect(screen.queryByText('Confirm')).toBeNull();
    expect(screen.getByTestId('confirm-ok').textContent).toBe('Remove');
    fireEvent.click(screen.getByTestId('confirm-ok'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(removes('claude_account_remove')).toEqual([
      { cmd: 'claude_account_remove', args: { pool: 'work', account: 'aria' } },
    ]);
  });

  it('열리면 포커스는 취소(Keep)에 가고, Esc 는 아무것도 지우지 않고 닫는다', async () => {
    stubTauri();
    await openAccountRemove();
    expect(document.activeElement).toBe(screen.getByTestId('confirm-cancel'));
    expect(screen.getByTestId('confirm-cancel').textContent).toBe('Keep');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(removes('claude_account_remove')).toHaveLength(0);
  });

  it('확인을 연타해도 제거는 한 번만 가고, 도는 동안 Esc 로 닫히지 않는다', async () => {
    let finish!: () => void;
    stubTauri(POOLS_SNAPSHOT, {
      claude_account_remove: new Promise<void>((r) => { finish = r; }),
    });
    await openAccountRemove();
    const ok = screen.getByTestId('confirm-ok');
    fireEvent.click(ok);
    fireEvent.click(ok);
    expect(removes('claude_account_remove')).toHaveLength(1);
    expect((ok as HTMLButtonElement).disabled).toBe(true);
    // 도중에 창이 닫히면 결과를 말할 자리가 없다.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    finish();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(removes('claude_account_remove')).toHaveLength(1);
  });

  it('실패하면 창을 닫지 않고 창 안에 까닭을 보여 준다', async () => {
    // 게터로 준다 — 미리 만든 거절 Promise 는 부르기 전까지 "처리 안 된 거절"로 잡힌다.
    stubTauri(POOLS_SNAPSHOT, { get claude_account_remove() { return Promise.reject(new Error('keychain locked')); } });
    await openAccountRemove();
    fireEvent.click(screen.getByTestId('confirm-ok'));
    expect((await screen.findByTestId('confirm-error')).textContent).toBe('keychain locked');
    expect(screen.getByRole('dialog', { name: 'Remove account aria?' })).toBeTruthy();
    // 다시 시도할 수 있다.
    expect((screen.getByTestId('confirm-ok') as HTMLButtonElement).disabled).toBe(false);
  });

  it('풀 삭제에도 같은 겹창으로 묻는다', async () => {
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('work');
    fireEvent.click(screen.getByRole('button', { name: /actions for pool work/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /remove pool work/i }));
    expect(removes('claude_pool_remove')).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Remove pool work?' }).textContent).toContain('Every account in it');
    expect(screen.getByTestId('confirm-ok').textContent).toBe('Remove pool');
    fireEvent.click(screen.getByTestId('confirm-ok'));
    await waitFor(() => expect(removes('claude_pool_remove')).toEqual([
      { cmd: 'claude_pool_remove', args: { pool: 'work' } },
    ]));
    expect(removes('claude_account_remove')).toHaveLength(0);
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
    await waitFor(() => expect(calls.some((c) => c.cmd === 'claude_account_login_start')).toBe(true));
    emitLogin({ loginId: 'lid-1', url: 'https://claude.com/oauth?x=1' });

    fireEvent.change(await screen.findByLabelText(/code/i), { target: { value: 'THE-CODE' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.cmd === 'claude_account_login_submit');
      expect(call?.args).toEqual({ loginId: 'lid-1', code: 'THE-CODE' });
    });
  });

  it('이름을 묻지 않고 곧바로 로그인한다 — 디렉터리 이름은 화면이 짓는다', async () => {
    // 사람이 붙인 이름(`lime`)은 재인증 뒤 실제 로그인(Lychee 팀)과 어긋났다(2026-09-29).
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('work');
    fireEvent.click(screen.getByRole('button', { name: /add account to work/i }));
    expect(screen.queryByLabelText(/account name/i)).toBeNull();
    await waitFor(() => expect(calls.some((c) => c.cmd === 'claude_account_login_start')).toBe(true));
    const args = calls.find((c) => c.cmd === 'claude_account_login_start')?.args;
    expect(args?.pool).toBe('work');
    // 데몬이 다시 재는 문법(`^[a-z0-9-]{1,32}$`)에 맞아야 한다 — 러너·pools.json 이 옛 이름과 똑같이 다룬다.
    expect(args?.account).toMatch(/^acct-[0-9a-f]{8}$/);
  });

  it('실패로 끝나면 그 사유를 남긴다 — 무음으로 사라지지 않는다', async () => {
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('work');
    fireEvent.click(screen.getByRole('button', { name: /add account to work/i }));
    await waitFor(() => expect(calls.some((c) => c.cmd === 'claude_account_login_start')).toBe(true));

    emitLogin({ loginId: 'lid-1', done: true, status: { loggedIn: false }, error: '로그인이 끝나지 않았다' });
    await waitFor(() => expect(screen.getByText(/끝나지 않았다|did not finish/i)).toBeTruthy());
  });
});

describe('다시 로그인', () => {
  const starts = () => calls.filter((c) => c.cmd === 'claude_account_login_start');

  async function openReauthFromMenu(): Promise<void> {
    render(<ClaudeAccountsSettings />);
    await screen.findByText('aria');
    fireEvent.click(screen.getByRole('button', { name: /actions for account aria/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /sign in again to aria/i }));
  }

  it('⋯ 메뉴에서 묻고, 확인하면 같은 이름으로 reauth 로그인을 띄운다 — 새 이름을 짓지 않는다', async () => {
    stubTauri();
    await openReauthFromMenu();
    // 확인 전에는 아무것도 띄우지 않는다.
    expect(starts()).toHaveLength(0);
    const dialog = screen.getByRole('dialog', { name: 'Sign in again to aria?' });
    // 무엇이 남는가 · 시크릿 창 · 돌던 턴 — 셋을 말한다(jaebin 2026-10-01: 막지 않고 알린다).
    expect(dialog.textContent).toMatch(/only the sign-in changes/);
    expect(dialog.textContent).toMatch(/private browser window/);
    expect(dialog.textContent).toMatch(/not stopped/);
    expect(screen.getByTestId('confirm-ok').textContent).toBe('Sign in again');
    fireEvent.click(screen.getByTestId('confirm-ok'));
    await waitFor(() => expect(starts()).toHaveLength(1));
    expect(starts()[0]!.args).toEqual({ pool: 'work', account: 'aria', reauth: true });
    emitLogin({ loginId: 'lid-1', url: 'https://claude.com/oauth?x=1' });
    // 패널 제목은 추가가 아니라 그 계정이다.
    expect(await screen.findByText(/Sign in again — me@corp\.example/)).toBeTruthy();
    expect(screen.queryByText(/Add account to work/)).toBeNull();
  });

  it('취소하면 로그인을 띄우지 않고 계정도 지우지 않는다', async () => {
    stubTauri();
    await openReauthFromMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(starts()).toHaveLength(0);
    expect(calls.some((c) => c.cmd === 'claude_account_remove')).toBe(false);
  });

  it('same sign-in 경고 옆에서 바로 누를 수 있다', async () => {
    const acct = (name: string) => ({
      name,
      status: { loggedIn: true, email: 'me@corp.example', orgName: 'Corp', orgId: 'o1', accountId: 'a1' },
    });
    stubTauri({ ...POOLS_SNAPSHOT, pools: [{ name: 'work', accounts: [acct('lime'), acct('lychee')] }] });
    render(<ClaudeAccountsSettings />);
    await screen.findByTestId('claude-account-work-lychee');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again to lychee' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Sign in again to lychee?' })).getByTestId('confirm-ok'));
    await waitFor(() => expect(starts()).toHaveLength(1));
    expect(starts()[0]!.args).toEqual({ pool: 'work', account: 'lychee', reauth: true });
  });

  it('데몬이 거절하면(지운 계정 등) 패널을 닫고 사유를 보인다', async () => {
    stubTauri();
    const internals = (globalThis as unknown as { __TAURI_INTERNALS__: { invoke: ReturnType<typeof vi.fn> } }).__TAURI_INTERNALS__;
    const base = internals.invoke.getMockImplementation()!;
    internals.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'claude_account_login_start') { calls.push({ cmd, args }); throw new Error('다시 로그인할 계정이 없다: work/aria'); }
      return base(cmd, args);
    });
    await openReauthFromMenu();
    fireEvent.click(screen.getByTestId('confirm-ok'));
    expect(await screen.findByText(/다시 로그인할 계정이 없다/)).toBeTruthy();
    expect(screen.queryByText(/Sign in again —/)).toBeNull();
  });
});

describe('정체 표시', () => {
  const withLogin = (name: string, orgName: string | undefined, ids: [string, string]) => ({
    name,
    status: {
      loggedIn: true, email: 'me@corp.example', subscriptionType: 'team',
      ...(orgName ? { orgName } : {}), orgId: ids[0], accountId: ids[1],
    },
  });

  it('줄 첫 칸은 팀이고 계정 이름은 id 로 곁에 선다', async () => {
    stubTauri({
      ...POOLS_SNAPSHOT,
      pools: [{ name: 'work', accounts: [withLogin('lime', 'Acme-Lychee', ['o1', 'a1'])] }],
    });
    render(<ClaudeAccountsSettings />);
    const row = await screen.findByTestId('claude-account-work-lime');
    expect(row.firstElementChild?.textContent).toBe('Acme-Lychee');
    expect(row.textContent).toContain('lime');
  });

  it('같은 풀에 같은 로그인이 둘이면 알린다 — 팀명이 빠져도 uuid 로 가린다', async () => {
    // 실측: 재인증 직후 `.claude.json` 에 organizationName 이 없었다. 표시용 글자로 비교하면 놓친다.
    stubTauri({
      ...POOLS_SNAPSHOT,
      pools: [{ name: 'work', accounts: [
        withLogin('lime', undefined, ['o1', 'a1']),
        withLogin('lychee', 'Acme-Lychee', ['o1', 'a1']),
        withLogin('plum', 'Acme-Plum', ['o2', 'a1']),
      ] }],
    });
    render(<ClaudeAccountsSettings />);
    await screen.findByTestId('claude-account-work-lime');
    const dups = screen.getAllByTestId('claude-account-duplicate').map((el) => el.textContent);
    expect(dups).toEqual(['same sign-in as lychee', 'same sign-in as lime']);
  });
});

describe('풀 만들기', () => {
  it('풀의 배정 기준을 보이고, 고치면 기본값과 다른 칸만 보낸다 (C ③)', async () => {
    stubTauri({ ...POOLS_SNAPSHOT, assign: { work: { newSessionPct: 70 } } });
    render(<ClaudeAccountsSettings />);
    const row = await screen.findByTestId('claude-assign-work');
    expect(row.textContent).toContain('70% (5-hour)');
    expect(row.textContent).toContain('97% (weekly)');
    // 계정이 하나뿐인 풀에는 고를 것이 없으므로 그리지 않는다
    expect(screen.queryByTestId('claude-assign-personal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /edit assignment limits for work/i }));
    fireEvent.change(screen.getByLabelText(/skip for new threads at weekly % \(work\)/i), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.cmd === 'claude_accounts_configure');
      const config = call?.args?.config as { assign?: unknown } | undefined;
      expect(config?.assign).toEqual({ work: { newSessionPct: 70, newWeeklyPct: 90 } });
    });
  });

  it('옛 데몬(assign 없음)에게는 기준 칸을 보내지 않는다 — 디스크의 값을 지우지 않게', async () => {
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('work');
    fireEvent.click(screen.getByRole('button', { name: /new pool/i }));
    fireEvent.change(screen.getByLabelText(/pool name/i), { target: { value: 'client-b' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    await waitFor(() => expect(calls.some((c) => c.cmd === 'claude_accounts_configure')).toBe(true));
    const config = calls.find((c) => c.cmd === 'claude_accounts_configure')!.args!.config as Record<string, unknown>;
    expect(config).not.toHaveProperty('assign');
  });

  it('계정 줄에 러너와 같은 점수와 새 배정 제외 여부를 보인다', async () => {
    const NOW = Date.UTC(2026, 8, 29, 12);
    stubTauri(POOLS_SNAPSHOT, {
      claude_accounts_provider_usage: {
        measuredAtMs: NOW,
        accounts: [{
          account: 'aria', pool: 'work', source: 'cli', fetchedAtMs: NOW,
          session: { usedPercent: 90, resetsAtMs: null }, weekly: { usedPercent: 50, resetsAtMs: NOW + 10 * 3_600_000 },
        }],
      },
    });
    render(<ClaudeAccountsSettings />);
    const box = await screen.findByTestId('claude-provider-usage-work-aria');
    const score = within(box).getByTestId('claude-assign-score');
    // (100 − 50) ÷ 10h = 5.00
    expect(score.textContent).toContain('5.00%/h');
    expect(score.textContent).toContain('skipped for new threads');
  });

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

/**
 * [Refresh usage](2026-10-09). 폴은 데몬 캐시 값을 받으므로 사람이 "지금 값"을 보려면 기다려야 했다 —
 * 이 버튼은 `force` 를 실어 캐시를 건너뛴다. 재는 것: 무엇을 보내는가 · 도는 동안 무엇을 보이는가 ·
 * 실패하면 무엇을 말하는가.
 */
describe('사용량 새로고침', () => {
  const NOW = Date.UTC(2026, 9, 9, 13, 15);
  const usage = (pct: number, at = NOW) => ({
    measuredAtMs: at,
    accounts: [{
      account: 'aria', pool: 'work', source: 'cli', fetchedAtMs: at,
      session: { usedPercent: pct, resetsAtMs: null }, weekly: { usedPercent: 1, resetsAtMs: null },
    }],
  });

  function stubUsage(onForce: (args: Record<string, unknown>) => Promise<unknown>): void {
    calls = [];
    vi.stubGlobal('__TAURI_INTERNALS__', {
      transformCallback: () => 1,
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'claude_accounts_list') return POOLS_SNAPSHOT;
        if (cmd === 'claude_accounts_provider_usage') return args?.force ? onForce(args) : usage(10);
        return {};
      }),
    });
  }

  it('전체 새로고침은 `force` 만 싣고, 도는 동안 잠기고 막대가 흐려지며, 끝나면 새 값과 잰 시각을 보인다', async () => {
    let done: (v: unknown) => void = () => {};
    stubUsage(() => new Promise((r) => { done = r; }));
    render(<ClaudeAccountsSettings />);
    const box = await screen.findByTestId('claude-provider-usage-work-aria');
    await waitFor(() => expect(box.textContent).toContain('10%'));
    const ctl = screen.getByTestId('claude-usage-refresh');
    expect(within(ctl).getByTestId('claude-usage-refresh-updated').textContent).toMatch(/^Updated /);

    fireEvent.click(within(ctl).getByRole('button', { name: /refresh usage/i }));
    const busy = await within(ctl).findByRole('button', { name: /refreshing/i });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    // 동작 줄이기 설정을 따른다 — 그냥 animate-spin 이면 설정을 무시하고 돈다.
    expect(within(busy).getByTestId('usage-refresh-icon').getAttribute('class')).toBe('motion-safe:animate-spin');
    expect(screen.getByTestId('claude-provider-usage-work-aria').getAttribute('aria-busy')).toBe('true');
    const forced = calls.filter((c) => c.cmd === 'claude_accounts_provider_usage' && c.args?.force);
    expect(forced.map((c) => c.args)).toEqual([{ force: true }]);

    done(usage(55, NOW + 60_000));
    await waitFor(() => expect(screen.getByTestId('claude-provider-usage-work-aria').textContent).toContain('55%'));
    const idle = within(ctl).getByRole('button', { name: /refresh usage/i });
    expect(within(idle).getByTestId('usage-refresh-icon').getAttribute('class')).toBeNull();
    expect(screen.getByTestId('claude-provider-usage-work-aria').getAttribute('aria-busy')).toBe('false');
  });

  it('실패하면 까닭을 한 줄로 말하고 지난 막대는 지킨다 · 다음 성공이 그 줄을 내린다', async () => {
    let fail = true;
    stubUsage(async () => { if (fail) throw new Error('daemon 이 답하지 않는다'); return usage(70); });
    render(<ClaudeAccountsSettings />);
    const box = await screen.findByTestId('claude-provider-usage-work-aria');
    await waitFor(() => expect(box.textContent).toContain('10%'));
    fireEvent.click(screen.getByRole('button', { name: /refresh usage/i }));
    const alert = await screen.findByTestId('claude-usage-refresh-error');
    expect(alert.textContent).toContain('daemon 이 답하지 않는다');
    expect(screen.getByTestId('claude-provider-usage-work-aria').textContent).toContain('10%');

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /refresh usage/i }));
    await waitFor(() => expect(screen.getByTestId('claude-provider-usage-work-aria').textContent).toContain('70%'));
    expect(screen.queryByTestId('claude-usage-refresh-error')).toBeNull();
  });

  it('계정 `⋯` 의 새로고침은 그 계정(풀·이름)만 싣는다', async () => {
    stubUsage(async () => usage(33));
    render(<ClaudeAccountsSettings />);
    await screen.findByTestId('claude-provider-usage-work-aria');
    fireEvent.click(screen.getByRole('button', { name: /actions for account aria/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /refresh usage for aria/i }));
    await waitFor(() => expect(screen.getByTestId('claude-provider-usage-work-aria').textContent).toContain('33%'));
    const forced = calls.filter((c) => c.cmd === 'claude_accounts_provider_usage' && c.args?.force);
    expect(forced.map((c) => c.args)).toEqual([{ force: true, account: 'aria', pool: 'work' }]);
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

describe('사람이 지나야 하는 관문 (2026-10-01)', () => {
  // 러너가 관문(조직 관리 설정 승인 등)에서 넘긴 계정. 러너는 대신 누르지 않는다 — 사람이 그 계정의
  // 터미널을 열어 고른다.
  const GATED = {
    ...POOLS_SNAPSHOT,
    pools: [{
      name: 'work',
      accounts: [
        { name: 'aria', status: { loggedIn: true, email: 'me@corp.example', orgName: 'Corp' }, attention: { atMs: 1 } },
        { name: 'cedar', status: { loggedIn: false } },
      ],
    }],
  };

  it('표식이 있는 계정에만 이유 줄과 [Open terminal] 이 선다 — 계정 줄(메일 칸) 밖 둘째 줄이다', async () => {
    stubTauri(GATED);
    render(<ClaudeAccountsSettings />);
    const notes = await screen.findAllByTestId('claude-account-attention');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toMatch(/waiting for your choice/);
    // 안 2: 막힌 계정은 빼지 않고 맨 뒤로 간다 — "건너뛴다"고 말하지 않는다.
    expect(notes[0]!.textContent).toMatch(/New threads try this account last until you answer it/);
    expect(notes[0]!.textContent).not.toMatch(/skip/);
    // 계정 줄 안에는 없다 — 메일 칸을 밀어내지 않는다(designer D1).
    expect(within(screen.getByTestId('claude-account-work-aria')).queryByTestId('claude-account-attention')).toBeNull();
  });

  it('[Open terminal] 은 이름만 넘긴다 — 경로·명령은 데몬이 조립한다', async () => {
    stubTauri(GATED);
    render(<ClaudeAccountsSettings />);
    fireEvent.click(await screen.findByTestId('claude-account-attention-open'));
    await waitFor(() => expect(calls.filter((c) => c.cmd === 'claude_account_open_terminal')).toEqual([
      { cmd: 'claude_account_open_terminal', args: { pool: 'work', account: 'aria' } },
    ]));
    expect(await screen.findByTestId('claude-account-terminal-note')).toBeTruthy();
  });

  it('창에서 돌아오면 다시 읽고, 표식이 사라졌으면 "돌아왔다"로 바꾸고 더는 포커스마다 읽지 않는다', async () => {
    let current: unknown = GATED;
    calls = [];
    vi.stubGlobal('__TAURI_INTERNALS__', {
      transformCallback: () => 1,
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'claude_accounts_list') return current;
        return {};
      }),
    });
    render(<ClaudeAccountsSettings />);
    fireEvent.click(await screen.findByTestId('claude-account-attention-open'));
    await screen.findByTestId('claude-account-terminal-note');
    const lists = () => calls.filter((c) => c.cmd === 'claude_accounts_list').length;
    // 아직 고르지 않았다 — 안내는 그대로, 포커스마다 다시 읽는다.
    let before = lists();
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(lists()).toBe(before + 1));
    expect(screen.getByTestId('claude-account-terminal-note')).toBeTruthy();
    // 사람이 고르고 나왔다 — 표식이 사라졌다.
    current = { ...GATED, pools: [{ name: 'work', accounts: GATED.pools[0]!.accounts.map(({ attention: _a, ...rest }) => rest) }] };
    before = lists();
    window.dispatchEvent(new Event('focus'));
    expect((await screen.findByTestId('claude-account-terminal-back')).textContent).toMatch(/is back/);
    expect(screen.queryByTestId('claude-account-terminal-note')).toBeNull();
    expect(screen.queryByTestId('claude-account-attention')).toBeNull();
    // 끝났으니 포커스로 더 읽지 않는다(D3).
    const after = lists();
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 50));
    expect(lists()).toBe(after);
  });
});


/** 한국어로 고르면 이 화면이 한 언어로 선다(i18n P3, 2026-10-10 — 영어로 박혀 있던 41곳). */
describe('앱 언어를 따른다', () => {
  afterEach(() => usePrefsStore.getState().setLocale('system'));

  it('한국어로 고르면 머리·풀·열 이름·버튼·미로그인 표시가 한국어다', async () => {
    usePrefsStore.getState().setLocale('ko');
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('work');
    expect(screen.getByText('기본 풀')).toBeTruthy();
    expect(screen.getByText('계정 1개')).toBeTruthy();
    expect(screen.getAllByText('팀').length).toBeGreaterThan(0);
    expect(screen.getAllByText('계정 추가').length).toBe(2);
    expect(screen.getByRole('button', { name: 'work 에 계정 추가' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '기본으로' })).toBeTruthy();
    expect(screen.getAllByText('로그인 안 됨').length).toBeGreaterThan(0);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/Default pool|Add account|Not signed in|Signed in as|Runners pick up|New pool/);
  });

  it('영어 복수형은 1 과 2 가 다르다', async () => {
    usePrefsStore.getState().setLocale('en');
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('work');
    expect(screen.getByText('1 account')).toBeTruthy();
  });
});
