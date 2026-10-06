import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ConnectScreen } from '../src/screens/ConnectScreen';
import { pendingWorkspace } from '../src/lib/gate';

const GATE = 'https://gate.example.com';
const WS = 'https://mine.example.com';

beforeEach(() => { localStorage.clear(); });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

/** 만들기 폼을 열고 네 칸을 채운다. */
function fillCreateForm() {
  fireEvent.click(screen.getByRole('button', { name: /Create a hosted community/ }));
  fireEvent.change(screen.getByLabelText('Provisioning service URL'), { target: { value: GATE } });
  fireEvent.change(screen.getByLabelText('Community name'), { target: { value: 'mine' } });
  fireEvent.change(screen.getByLabelText('Invite code'), { target: { value: 'hrg_ok' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'me@example.com' } });
}

describe('ConnectScreen — 호스팅 워크스페이스 만들기', () => {
  /**
   * 이 흐름의 핵심: 만들기 → 기다림 → 클레임이 **한 화면에서 이어진다.** 중간에 사용자가
   * 토큰을 옮겨 적는 단계가 없어야 한다.
   */
  it('만들고, 준비되면 클레임해서 그대로 로그인된다', async () => {
    const calls: string[] = [];
    const bodies: string[] = [];
    let jobPolls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      bodies.push(String(init?.body ?? ''));
      if (u.endsWith('/api/workspaces')) {
        return new Response(JSON.stringify({
          jobId: 'job-1', name: 'mine', url: WS, claimToken: 'claim_secret',
        }), { status: 202 });
      }
      if (u.includes('/api/workspaces/job-1')) {
        jobPolls += 1;
        // 첫 폴링은 아직 기다리는 중, 두 번째에 준비된다.
        return new Response(JSON.stringify(
          jobPolls === 1
            ? { status: 'waiting_ready', message: '브랜치가 아직 머지되지 않았을 수 있다', done: false }
            : { status: 'ready', message: '테넌트가 응답한다', url: WS, done: true },
        ), { status: 200 });
      }
      if (u.endsWith('/claim')) return new Response(JSON.stringify({ id: 'u-1' }), { status: 201 });
      if (u.endsWith('/auth/login')) return new Response(JSON.stringify({ token: 'tok-c' }), { status: 200 });
      if (u.endsWith('/auth/me')) {
        return new Response(JSON.stringify({
          id: 'acct_c', handle: 'owner', displayName: 'Owner', kind: 'human', isAdmin: true, disabled: false, deleted: false,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    const onConnected = vi.fn();
    render(<ConnectScreen onConnected={onConnected} />);
    fillCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create community' }));

    // 서버가 준 문장을 **그대로** 보여 준다 — 화면이 자기 말로 바꾸면 무엇을 기다리는지
    // 알 수 없다.
    expect(await screen.findByText(/머지되지 않았을 수 있다/, {}, { timeout: 8000 })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Create admin account' }, { timeout: 15000 })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Login ID'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Handle (@)'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Owner' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create admin account' }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(WS, 'tok-c', 'acct_c', 'owner'));

    // **토큰이 자동으로 실려 갔다.** 사용자는 그것을 보지도 입력하지도 않았다.
    const claimBody = bodies[calls.findIndex((c) => c.endsWith('/claim'))];
    expect(claimBody).toContain('claim_secret');
    // 클레임은 gate 가 아니라 **만들어진 워크스페이스**로 간다.
    expect(calls.find((c) => c.endsWith('/claim'))).toBe(`${WS}/claim`);
    // 클레임이 끝나면 보관본이 남지 않는다.
    expect(pendingWorkspace.read()).toBeNull();
  }, 30000);

  /**
   * gate 는 "없는 코드 / 다 쓴 코드 / 만료된 코드"를 **일부러 구분해 주지 않는다** —
   * 구분해 주면 유효한 코드를 찾는 탐색에 답이 된다. 화면이 그것을 되살리면 서버가 감춘
   * 것을 클라이언트가 흘리는 셈이다.
   */
  it('초대 코드 거절은 한 가지 문구다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'invalid_invite', message: 'invite code is not usable' } }),
      { status: 403 },
    )));
    render(<ConnectScreen onConnected={vi.fn()} />);
    fillCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create community' }));

    const shown = await screen.findByText(/invite code cannot be used/i);
    expect(shown).toBeTruthy();
    // 왜 거절됐는지(없음/소진/만료)를 화면이 말하지 않는다.
    expect(document.body.textContent).not.toMatch(/expired|exhausted|already used/i);
  });

  it('이름이 겹치면 다른 이름을 쓰라고 말한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'name_taken', message: 'that name is already in use' } }),
      { status: 409 },
    )));
    render(<ConnectScreen onConnected={vi.fn()} />);
    fillCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create community' }));
    expect(await screen.findByText(/already taken/i)).toBeTruthy();
  });

  /** 실패한 작업은 **실패로 보여야 한다** — 계속 도는 것처럼 두면 사람이 영영 기다린다. */
  it('작업이 실패하면 그 사유를 보여준다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/api/workspaces')) {
        return new Response(JSON.stringify({
          jobId: 'job-x', name: 'mine', url: WS, claimToken: 'claim_x',
        }), { status: 202 });
      }
      if (u.includes('/api/workspaces/job-x')) {
        return new Response(JSON.stringify({
          status: 'failed', message: 'push rejected', done: true,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    render(<ConnectScreen onConnected={vi.fn()} />);
    fillCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create community' }));
    expect(await screen.findByText('push rejected', {}, { timeout: 8000 })).toBeTruthy();
  }, 15000);

  /**
   * 기다림이 길기 때문에(승인이 필요하다) 앱을 닫는 일이 실제로 생긴다. 그때 보관본이
   * 없으면 `claimToken` 이 사라지고, 그 토큰은 다시 볼 수 없으므로 워크스페이스는
   * **만들어졌는데 아무도 가져갈 수 없는** 상태가 된다.
   */
  it('만드는 중에 앱을 닫아도 이어받는다', async () => {
    pendingWorkspace.write({
      gateUrl: GATE, jobId: 'job-9', claimToken: 'claim_saved', url: WS, name: 'mine',
    });
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/workspaces/job-9')) {
        return new Response(JSON.stringify({ status: 'ready', message: '준비됨', url: WS, done: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    // 새로 뜬 앱: 로그인 화면으로 시작했는데 만들던 것이 있으면 그쪽으로 옮겨 간다.
    render(<ConnectScreen onConnected={vi.fn()} />);
    expect(await screen.findByText(WS, {}, { timeout: 8000 })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Create admin account' }, { timeout: 8000 })).toBeTruthy();
  }, 15000);

  /** 버리면 **보관본까지** 지워야 다음 기동에 되살아나지 않는다. */
  it('버리면 보관본도 사라진다', async () => {
    pendingWorkspace.write({
      gateUrl: GATE, jobId: 'job-d', claimToken: 'claim_d', url: WS, name: 'mine',
    });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ status: 'waiting_ready', message: '기다리는 중', done: false }), { status: 200 })));

    render(<ConnectScreen onConnected={vi.fn()} />);
    const discard = await screen.findByRole('button', { name: /Discard and go back/ }, { timeout: 8000 });
    fireEvent.click(discard);

    expect(pendingWorkspace.read()).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy());
  }, 15000);

  /** 네 칸이 다 차기 전에는 보내지 않는다 — gate 가 400 으로 돌려보낼 요청이다. */
  it('빈 칸이 있으면 제출되지 않는다', () => {
    render(<ConnectScreen onConnected={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Create a hosted community/ }));
    const submit = screen.getByRole('button', { name: 'Create community' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Provisioning service URL'), { target: { value: GATE } });
    expect((screen.getByRole('button', { name: 'Create community' }) as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * 서비스 칸에 **만들 워크스페이스 자신의 주소**를 넣는 실수(2026-09-29 실측). 그 주소는 아직
   * 없으므로 보내기 전에 칸 밑에서 알려 준다.
   */
  it('서비스 칸에 워크스페이스 주소를 넣으면 칸 밑에서 알려 준다', () => {
    render(<ConnectScreen onConnected={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Create a hosted community/ }));
    fireEvent.change(screen.getByLabelText('Community name'), { target: { value: 'mine' } });
    fireEvent.change(screen.getByLabelText('Provisioning service URL'), { target: { value: WS } });
    expect(screen.getByText(/looks like the new community's own address/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Provisioning service URL'), { target: { value: GATE } });
    expect(screen.queryByText(/looks like the new community's own address/)).toBeNull();
  });

  /** 응답을 못 받으면(CORS·DNS) 네트워크 탓만 하지 않고 무엇을 넣는 칸인지 말한다. */
  it('서비스에 닿지 않으면 주소를 확인하라고 한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    render(<ConnectScreen onConnected={vi.fn()} />);
    fillCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create community' }));
    expect(await screen.findByText(/not the new community's address/)).toBeTruthy();
    expect(pendingWorkspace.read()).toBeNull();
  });

  /** `add` 겹창에서는 새 워크스페이스를 만들 자리가 아니다(부트스트랩과 같은 근거). */
  it('add 모드에는 만들기 입구가 없다', () => {
    render(<ConnectScreen mode="add" onAdded={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Create a hosted community/ })).toBeNull();
  });
});

describe('ConnectScreen — 복구 키는 만든 직후 한 번만 (R1)', () => {
  // 모양만 맞춘 가짜 키다. 글자 그대로 적으면 비밀 검사(gitleaks)가 진짜 키로 읽는다.
  const KEY = ['hrk1', 'mine', 'k1', 'A'.repeat(43), 'abcd'].join('.');

  function stubGate(withKey: boolean) {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/api/workspaces')) {
        return new Response(JSON.stringify({
          jobId: 'job-k', name: 'mine', url: WS, claimToken: 'claim_k', ...(withKey ? { recoveryKey: KEY } : {}),
        }), { status: 202 });
      }
      return new Response(JSON.stringify({ status: 'waiting_ready', done: false }), { status: 200 });
    }));
  }

  it('보여 주고, 저장 확인 전에는 넘어가지 않고, 어디에도 남기지 않는다', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    stubGate(true);
    render(<ConnectScreen onConnected={vi.fn()} />);
    fillCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create community' }));

    expect((await screen.findByTestId('recovery-key-value')).textContent).toBe(KEY);
    // 진행 화면·공용 버튼은 아직 없다 — 키를 받기 전에 넘어가지 않는다.
    expect(screen.queryByRole('button', { name: 'Waiting…' })).toBeNull();
    const cont = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);

    // 보관본은 클레임 토큰만 든다. 키는 localStorage 어디에도 없다.
    expect(pendingWorkspace.read()?.claimToken).toBe('claim_k');
    expect(JSON.stringify({ ...localStorage })).not.toContain('hrk1.');

    fireEvent.click(screen.getByRole('checkbox'));
    expect(cont.disabled).toBe(false);
    fireEvent.click(cont);

    expect(screen.queryByTestId('recovery-key-step')).toBeNull();
    expect(document.body.textContent).not.toContain('hrk1.');
    expect(await screen.findByRole('button', { name: 'Waiting…' })).toBeTruthy();
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain('hrk1.');
    for (const s of spies) s.mockRestore();
  });

  it('앱을 다시 열면 키는 다시 나오지 않는다(이어받기는 클레임 토큰만)', async () => {
    stubGate(true);
    render(<ConnectScreen onConnected={vi.fn()} />);
    fillCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create community' }));
    await screen.findByTestId('recovery-key-value');
    cleanup();
    render(<ConnectScreen onConnected={vi.fn()} />);
    expect(await screen.findByText(WS)).toBeTruthy();
    expect(screen.queryByTestId('recovery-key-step')).toBeNull();
  });

  it('옛 gate(키 없음)면 이 단계를 건너뛴다', async () => {
    stubGate(false);
    render(<ConnectScreen onConnected={vi.fn()} />);
    fillCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create community' }));
    expect(await screen.findByRole('button', { name: 'Waiting…' })).toBeTruthy();
    expect(screen.queryByTestId('recovery-key-step')).toBeNull();
  });

  it('복사한 키는 60초 뒤 클립보드가 아직 그 값일 때만 지운다', async () => {
    let clip = '';
    const writeText = vi.fn(async (t: string) => { clip = t; });
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText, readText: async () => clip } });
    stubGate(true);
    render(<ConnectScreen onConnected={vi.fn()} />);
    fillCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create community' }));
    await screen.findByTestId('recovery-key-value');

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(clip).toBe(KEY);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(clip).toBe(KEY);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clip).toBe('');

    // 그 사이 사람이 다른 것을 복사했으면 건드리지 않는다.
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await vi.advanceTimersByTimeAsync(0);
    clip = 'something else';
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clip).toBe('something else');
  });
});
