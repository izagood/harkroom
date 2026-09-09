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
 * 표가 된 뒤의 회귀선(#702). 여기서 지키는 것은 **읽을 수 있다는 사실**이다 — 앞판은
 * 이 숫자들을 라벨용 회색 11px(면과 3.08:1, AA 미달)로 그렸고, 그것이 이 개편의 이유다.
 */
describe('사용량이 읽히는가', () => {
  const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);
  const HOUR = 3_600_000;

  function usageSnapshot(over: Partial<Record<string, unknown>> = {}) {
    return {
      measuredAtMs: NOW,
      windowMs: 5 * HOUR,
      accounts: [
        {
          pool: 'work', account: 'aria', windowStartMs: NOW - 5 * HOUR,
          tokens: { input: 5_300_000, output: 1_100_000, cacheRead: 209_100_000, cacheCreation: 0 },
          responses: 1283, lastUsedAtMs: NOW - HOUR, limitHit: null, unreadableFiles: 0,
        },
        {
          pool: 'work', account: 'cedar', windowStartMs: NOW - 5 * HOUR,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          responses: 0, lastUsedAtMs: NOW - 2 * HOUR,
          limitHit: { atMs: NOW - HOUR, resetsAtMs: NOW + 2 * HOUR, rateLimitType: 'five_hour' },
          unreadableFiles: 0,
        },
      ],
      ...over,
    };
  }

  it('숫자를 라벨용 회색에 두지 않는다 — 그 색은 면과 3.08:1 로 AA 미달이다', async () => {
    stubTauri(POOLS_SNAPSHOT, { claude_accounts_usage: usageSnapshot() });
    render(<ClaudeAccountsSettings />);
    const cell = await waitFor(() => {
      const found = screen.getAllByTestId('claude-account-usage').find((el) => el.textContent === '1283');
      if (!found) throw new Error('아직');
      return found;
    });
    // 색을 값으로 고정하지 않고 **금지된 토큰**만 못박는다 — 팔레트가 바뀌어도 이 규율은 산다.
    expect(cell.className).not.toContain('text-fg-subtle');
    expect(cell.className).toContain('text-fg');
    // 열끼리 자리가 맞아야 눈으로 비교된다.
    expect(cell.className).toContain('tabular-nums');
  });

  it('열 이름은 풀마다 한 번만 선다 — 계정 줄마다 반복하지 않는다', async () => {
    stubTauri(POOLS_SNAPSHOT, { claude_accounts_usage: usageSnapshot() });
    render(<ClaudeAccountsSettings />);
    await screen.findByText('aria');
    // work(2계정) · personal(1계정) 두 풀이니 머리줄은 둘이다. 계정 수(3)가 아니다.
    expect(screen.getAllByText('Cache')).toHaveLength(2);
  });

  it('한도 상태를 문장이 아니라 경고 알약으로 그린다', async () => {
    // 앞판은 이것을 이메일 아래 같은 회색 문장으로 뒀다 — 이 화면에서 가장 결정적인
    // 사실이 나머지 잡정보와 똑같이 생겼다. 색만 올리면 부족하고 **모양**이 달라야 한다.
    stubTauri(POOLS_SNAPSHOT, { claude_accounts_usage: usageSnapshot() });
    render(<ClaudeAccountsSettings />);
    const pill = await screen.findByText(/Limited — back/);
    const box = pill.closest('[data-testid="claude-account-state"]');
    expect(box?.className).toContain('text-warning');
    expect(box?.className).toContain('bg-warning-surface');
  });

  it('안 돈 계정에 `0` 을 그리지 않는다 — 잰 적 없음과 구별되어야 한다', async () => {
    stubTauri(POOLS_SNAPSHOT, { claude_accounts_usage: usageSnapshot() });
    render(<ClaudeAccountsSettings />);
    await screen.findByText('cedar');
    const row = screen.getByTestId('claude-account-work-cedar');
    expect(row.textContent).toContain('—');
    expect(row.textContent).not.toMatch(/\b0\b/);
  });

  it('사용량이 아직 안 왔으면 `—` 가 아니라 `…` 다 — 재는 중과 안 돎은 다른 사실이다', async () => {
    // 사용량 호출을 영원히 매달아 둔다.
    stubTauri(POOLS_SNAPSHOT, { claude_accounts_usage: new Promise(() => {}) });
    render(<ClaudeAccountsSettings />);
    await screen.findByText('aria');
    expect(screen.getByTestId('claude-account-work-aria').textContent).toContain('…');
  });

  it('언제 잰 값인지 말한다 — 안 말하면 안 변하는 숫자가 고장으로 읽힌다', async () => {
    stubTauri(POOLS_SNAPSHOT, { claude_accounts_usage: usageSnapshot() });
    render(<ClaudeAccountsSettings />);
    // `NOW` 는 UTC 12:00 이다. 시각 표기는 실행 환경의 시간대를 따르므로 값을 고정하지
    // 않고 **시각이 있다는 사실**만 잰다 — 값을 박으면 CI 의 TZ 에 달린 테스트가 된다.
    await waitFor(() => {
      expect(screen.getByText(/measured \d{2}:\d{2}/)).toBeTruthy();
    });
  });

  it('마지막으로 돈 날이 오늘이 아니면 날짜가 붙는다 — `17:12` 만으로는 어제와 구별되지 않는다', async () => {
    const base = usageSnapshot();
    const [aria, cedar] = base.accounts;
    if (!aria || !cedar) throw new Error('fixture 가 깨졌다');
    // aria 는 **어제** 마지막으로 돌았고 cedar 는 오늘이다. 실제 화면에서 본 그 모양이다:
    // 어제 17:12 에 멈춘 계정이 17:00 짜리 화면에서 `17:12` 로 서서, 12분 **뒤** 시각이
    // "마지막으로 돈 때"로 보였다.
    const snap = {
      ...base,
      accounts: [
        { ...aria, lastUsedAtMs: NOW - 23 * HOUR },
        { ...cedar, lastUsedAtMs: NOW - 2 * HOUR },
      ],
    };
    stubTauri(POOLS_SNAPSHOT, { claude_accounts_usage: snap });
    render(<ClaudeAccountsSettings />);
    await screen.findByText('aria');

    // 시각 표기는 실행 환경의 시간대를 따르므로 **값을 박지 않는다** — 오늘인 것과
    // 아닌 것이 서로 다른 모양이라는 사실만 잰다(23시간 차는 어느 시간대에서도 다른 날이다).
    await waitFor(() => {
      const cells = screen.getAllByTestId('claude-account-last-used').map((el) => el.textContent ?? '');
      const yesterday = cells.find((t) => t !== '' && t !== '…' && t !== '—' && !/^\d{2}:\d{2}$/.test(t));
      const today = cells.find((t) => /^\d{2}:\d{2}$/.test(t));
      // 하나는 `HH:MM` 이 아니어야 한다(날짜가 붙었다), 하나는 `HH:MM` 그대로여야 한다.
      expect(yesterday).toBeTruthy();
      expect(today).toBeTruthy();
      expect(yesterday).toMatch(/\d{2}:\d{2}$/);
    });
  });
});

describe('사용량을 되풀이해 잰다', () => {
  const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);
  const HOUR = 3_600_000;

  function usageOf(responses: number) {
    return {
      measuredAtMs: NOW, windowMs: 5 * HOUR,
      accounts: [{
        pool: 'work', account: 'aria', windowStartMs: NOW - 5 * HOUR,
        tokens: { input: 10, output: 10, cacheRead: 10, cacheCreation: 0 },
        responses, lastUsedAtMs: NOW, limitHit: null, unreadableFiles: 0,
      }],
    };
  }

  /** `claude_accounts_usage` 가 몇 번 불렸나. 폴이 도는지를 재는 유일한 관측이다. */
  function usageCalls(): number {
    return calls.filter((c) => c.cmd === 'claude_accounts_usage').length;
  }

  /**
   * `document.hidden` 을 갈아끼운다. jsdom 의 그것은 프로토타입의 getter 라
   * `vi.spyOn` 이 인스턴스에 못 걸린다 — 그래서 인스턴스에 직접 정의한다.
   */
  function setHidden(hidden: boolean): void {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  }

  beforeEach(() => {
    // `shouldAdvanceTime` 은 이 저장소의 폴링 테스트 판례다(`AgentsSettings.test.tsx`) —
    // 실제 시간도 흐르게 두어 `waitFor` 가 멈추지 않는다.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
  });

  it('열어 둔 채로 두면 스스로 다시 잰다 — 앞판은 마운트 때 한 번이 전부였다', async () => {
    stubTauri(POOLS_SNAPSHOT, { claude_accounts_usage: usageOf(1) });
    render(<ClaudeAccountsSettings />);
    await waitFor(() => { expect(usageCalls()).toBe(1); });

    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => { expect(usageCalls()).toBe(2); });
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => { expect(usageCalls()).toBe(3); });
  });

  it('창이 숨어 있으면 왕복을 접는다 — 안 보는 화면 때문에 디스크를 읽지 않는다', async () => {
    stubTauri(POOLS_SNAPSHOT, { claude_accounts_usage: usageOf(1) });
    render(<ClaudeAccountsSettings />);
    await waitFor(() => { expect(usageCalls()).toBe(1); });

    setHidden(true);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(usageCalls()).toBe(1);

    // 다시 보이면 **tick 을 기다리지 않고** 바로 잰다 — 돌아온 사람이 제일 먼저 보는
    // 것이 낡은 숫자면 이 폴을 넣은 이유가 없다.
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => { expect(usageCalls()).toBe(2); });
  });

  it('폴이 실패해도 앞서 잰 값을 지우지 않는다 — 표가 통째로 `…` 로 돌아가면 안 된다', async () => {
    let attempt = 0;
    calls = [];
    vi.stubGlobal('__TAURI_INTERNALS__', {
      transformCallback: () => 1,
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'claude_accounts_list') return POOLS_SNAPSHOT;
        if (cmd === 'claude_accounts_usage') {
          attempt += 1;
          if (attempt === 1) return usageOf(1283);
          throw new Error('daemon is away');
        }
        return {};
      }),
    });
    render(<ClaudeAccountsSettings />);
    await waitFor(() => {
      expect(screen.getAllByTestId('claude-account-usage').some((el) => el.textContent === '1283')).toBe(true);
    });

    await vi.advanceTimersByTimeAsync(10_000);
    // 실패했다는 사실은 말해지고,
    await waitFor(() => { expect(screen.getByText(/Last refresh failed: daemon is away/)).toBeTruthy(); });
    // 숫자는 그대로 남는다.
    expect(screen.getAllByTestId('claude-account-usage').some((el) => el.textContent === '1283')).toBe(true);
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
    await screen.findByText('aria');
    // 파괴적 조작은 `⋯` 뒤에 있다 — 색이 아니라 확인 단계가 안전을 지므로 줄에서 내렸다.
    fireEvent.click(screen.getByRole('button', { name: /actions for account aria/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /remove account aria/i }));
    // 한 번 눌러서는 안 지워진다.
    expect(calls.some((c) => c.cmd === 'claude_account_remove')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(calls.some((c) => c.cmd === 'claude_account_remove')).toBe(true));
  });

  it('풀 삭제에도 확인 단계가 있다', async () => {
    stubTauri();
    render(<ClaudeAccountsSettings />);
    await screen.findByText('work');
    fireEvent.click(screen.getByRole('button', { name: /actions for pool work/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /remove pool work/i }));
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
