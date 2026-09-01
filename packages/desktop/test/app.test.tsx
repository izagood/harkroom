import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import App from '../src/App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('App', () => {
  it('shows connect screen without a stored session', async () => {
    render(<App />);
    expect(await screen.findByText('Server URL')).toBeTruthy();
  });

  // 저장된 세션으로 부팅하다 실패하면 세션을 지우고 로그인 화면으로 떨어진다. 이유를 말하지
  // 않으면 사용자에겐 "이유 없이 로그아웃됨"이 된다.
  it('explains why it fell back to the connect screen when a stored session fails', async () => {
    localStorage.setItem('murmur.session', JSON.stringify({ baseUrl: 'http://x', token: 'stale-token' }));
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'bad token' } }), { status: 401 }),
    ));

    render(<App />);

    expect(await screen.findByText(/세션|session/i)).toBeTruthy();
    expect(screen.getByText('Server URL')).toBeTruthy();
    expect(localStorage.getItem('murmur.session')).toBeNull();
  });

  it('shows error message when session startup fails after login', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      callCount++;
      const urlStr = String(url);
      // login succeeds
      if (urlStr.endsWith('/auth/login')) {
        return new Response(JSON.stringify({ token: 'tok-test' }), { status: 200 });
      }
      // me() (first call in controller.start()) fails with 500
      if (urlStr.endsWith('/auth/me')) {
        return new Response(JSON.stringify({ error: { code: 'server_error', message: 'Server error' } }), { status: 500 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    render(<App />);
    // Wait for ConnectScreen to appear
    expect(await screen.findByText('Server URL')).toBeTruthy();

    // Fill in and submit
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // Wait for error message
    await waitFor(() =>
      expect(screen.getByText('Signed in, but starting the session failed. Please try again.')).toBeTruthy(),
      { timeout: 3000 }
    );

    // Verify ConnectScreen is still shown
    expect(screen.getByText('Server URL')).toBeTruthy();
  });
});
