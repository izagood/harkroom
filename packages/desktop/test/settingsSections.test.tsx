import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { ProfileSettings } from '../src/components/settings/ProfileSettings';
import { ConnectionSettings } from '../src/components/settings/ConnectionSettings';
import { UpdatesSettings } from '../src/components/settings/UpdatesSettings';
import { setController, type Controller } from '../src/state/controller';
import { acc, fakeApi } from './helpers/fakeApi';

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
  // 주소는 보관된 값이 아니라 **지금 붙어 있는** 클라이언트에서 읽는다. 토큰 보관이 키체인으로
  // 가면서 렌더 중 동기 읽기가 불가능해졌고, 어차피 사용자가 알고 싶은 것은 실제 연결 대상이다.
  beforeEach(() => {
    setController({ api: { ...fakeApi(), baseUrl: 'http://localhost:3400' } } as unknown as Controller);
  });

  it('shows the server it is connected to and the live socket state', () => {
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
