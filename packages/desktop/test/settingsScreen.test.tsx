import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { acc } from './helpers/fakeApi';

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'admin') });
  setController({ listAgents: vi.fn(async () => []) } as unknown as Controller);
});
afterEach(() => cleanup());

describe('SettingsScreen', () => {
  it('opens on Profile and switches sections from the nav', () => {
    render(<SettingsScreen onBack={vi.fn()} onSignOut={vi.fn()} onCommunitiesEmpty={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Profile' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.getByRole('heading', { name: 'Notifications' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Profile' })).toBeNull();
  });

  // 사이드바의 '에이전트 관리'가 설정을 열 때, 사용자는 이미 어디로 가고 싶은지 말한 것이다.
  it('can open straight into a requested section', () => {
    render(<SettingsScreen initialSection="updates" onBack={vi.fn()} onSignOut={vi.fn()} onCommunitiesEmpty={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Updates' })).toBeTruthy();
  });

  it('returns to the app', () => {
    const onBack = vi.fn();
    render(<SettingsScreen onBack={onBack} onSignOut={vi.fn()} onCommunitiesEmpty={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to app' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('passes sign-out through from a section', () => {
    const onSignOut = vi.fn();
    render(<SettingsScreen onBack={vi.fn()} onSignOut={onSignOut} onCommunitiesEmpty={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalled();
  });
});
