import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ConnectScreen } from '../src/screens/ConnectScreen';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ConnectScreen', () => {
  it('logs in and reports baseUrl+token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ token: 'tok-9' }), { status: 200 })));
    const onConnected = vi.fn();
    render(<ConnectScreen onConnected={onConnected} />);
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith('http://localhost:3400', 'tok-9'));
  });

  it('shows server error message on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'invalid_credentials', message: 'wrong handle or password' } }), { status: 401 })));
    render(<ConnectScreen onConnected={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'x1' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'bad-bad-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('wrong handle or password')).toBeTruthy());
  });

  it('bootstrap mode creates admin then logs in', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith('/bootstrap')) return new Response(JSON.stringify({ id: 'u1' }), { status: 201 });
      return new Response(JSON.stringify({ token: 'tok-b' }), { status: 200 });
    }));
    const onConnected = vi.fn();
    render(<ConnectScreen onConnected={onConnected} />);
    fireEvent.click(screen.getByText('First run? Create the admin account'));
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith('http://localhost:3400', 'tok-b'));
    expect(calls[0]).toContain('/bootstrap');
  });

  it('displays initialError if provided', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ token: 'tok-9' }), { status: 200 })));
    render(<ConnectScreen onConnected={vi.fn()} initialError="Signed in, but starting the session failed. Please try again." />);
    expect(screen.getByText('Signed in, but starting the session failed. Please try again.')).toBeTruthy();
  });

  // #120: 서버에 `POST /auth/register` 가 있는데 데스크탑에 화면이 없어서, admin 이 초대
  // 토큰을 발급해도 받는 사람이 이 앱에서 가입할 수 없었다.
  it('초대 토큰으로 가입한 뒤 곧바로 로그인된다', async () => {
    const calls: string[] = [];
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push(String(url));
      bodies.push(String(init?.body ?? ''));
      if (String(url).endsWith('/auth/register')) return new Response(JSON.stringify({ id: 'u9' }), { status: 201 });
      return new Response(JSON.stringify({ token: 'murs_new' }), { status: 200 });
    }));
    const onConnected = vi.fn();
    render(<ConnectScreen onConnected={onConnected} />);

    fireEvent.click(screen.getByRole('button', { name: /Have an invite token/ }));
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'newbie' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Newbie' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw123456' } });
    fireEvent.change(screen.getByLabelText('Invite token'), { target: { value: 'muri_abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join with invite' }));

    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(calls[0]).toContain('/auth/register');
    expect(bodies[0]).toContain('muri_abc');
    // 계정 생성 라우트는 세션을 주지 않는다 — 이어서 로그인해야 한다.
    expect(calls[1]).toContain('/auth/login');
  });

  // `invalid_invite`(400)는 사용자가 토큰을 다시 받아야 풀리는 것이라, 뭉개면 막힌 것처럼 보인다.
  it('이미 쓴 토큰이면 서버 오류를 사용자에게 보여준다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'invalid_invite', message: 'invite invalid or used' } }),
      { status: 400 },
    )));
    render(<ConnectScreen onConnected={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Have an invite token/ }));
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'newbie' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw123456' } });
    fireEvent.change(screen.getByLabelText('Invite token'), { target: { value: 'muri_used' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join with invite' }));

    expect(await screen.findByText(/invite invalid or used/)).toBeTruthy();
  });

  it('초대 토큰이 비면 제출되지 않는다', () => {
    render(<ConnectScreen onConnected={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Have an invite token/ }));
    const submit = screen.getByRole('button', { name: 'Join with invite' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  // 세 경우는 서로 다른 폼이다 — 부트스트랩은 "첫 사람", 가입은 "초대받은 사람"이다.
  it('로그인 모드에는 초대 토큰 칸이 없다', () => {
    render(<ConnectScreen onConnected={vi.fn()} />);
    expect(screen.queryByLabelText('Invite token')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /First run/ }));
    expect(screen.queryByLabelText('Invite token')).toBeNull();
    expect(screen.getByLabelText('Display name')).toBeTruthy();
  });
});
