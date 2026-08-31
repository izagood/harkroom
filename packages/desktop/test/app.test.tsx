import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import App from '../src/App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('shows connect screen without a stored session', async () => {
    render(<App />);
    expect(await screen.findByText('Server URL')).toBeTruthy();
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
