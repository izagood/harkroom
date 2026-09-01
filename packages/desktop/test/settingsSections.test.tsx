import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { ProfileSettings } from '../src/components/settings/ProfileSettings';
import { ConnectionSettings } from '../src/components/settings/ConnectionSettings';
import { UpdatesSettings } from '../src/components/settings/UpdatesSettings';
import { acc } from './helpers/fakeApi';

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: { ...acc('u1', 'admin'), isAdmin: true }, connected: true });
});
afterEach(() => cleanup());

describe('ProfileSettings', () => {
  it('shows the signed-in identity and flags the admin role', () => {
    render(<ProfileSettings onSignOut={vi.fn()} />);
    expect(screen.getByText('@admin')).toBeTruthy();
    expect(screen.getByText('Administrator')).toBeTruthy();
  });

  // 서버에 PATCH /accounts/me 가 없다. 편집 가능한 것처럼 보이면 사용자가 방법을 찾아 헤맨다.
  it('offers no editable field, and says why', () => {
    render(<ProfileSettings onSignOut={vi.fn()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByTestId('profile-readonly-note')).toBeTruthy();
  });

  it('signs out on request', () => {
    const onSignOut = vi.fn();
    render(<ProfileSettings onSignOut={onSignOut} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalled();
  });
});

describe('ConnectionSettings', () => {
  it('shows the server it is connected to and the live socket state', () => {
    localStorage.setItem('murmur.session', JSON.stringify({ baseUrl: 'http://localhost:3400', token: 't' }));
    render(<ConnectionSettings onSignOut={vi.fn()} />);
    expect(screen.getByText('http://localhost:3400')).toBeTruthy();
    expect(screen.getByTestId('connection-state').textContent).toBe('Connected');
  });

  it('reports a dropped socket', () => {
    useAppStore.getState().set({ connected: false });
    render(<ConnectionSettings onSignOut={vi.fn()} />);
    expect(screen.getByTestId('connection-state').textContent).toBe('Disconnected');
  });
});

describe('UpdatesSettings', () => {
  // updater 가 아직 없다. 없는 것을 없다고 적는 편이, 메뉴를 뒤지다 포기하는 것보다 낫다.
  it('states plainly that automatic updates do not exist yet', () => {
    render(<UpdatesSettings />);
    expect(screen.getByText('Not available')).toBeTruthy();
  });
});
