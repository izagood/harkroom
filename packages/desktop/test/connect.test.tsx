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
});
