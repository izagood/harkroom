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

  /**
   * **빈 화면은 답이 아니다.** 목차에 없는 값이 `initialSection` 으로 들어오면 지금 구조는
   * 모든 분기가 거짓이 되어 본문이 통째로 빈다(#488 A3-a 의 띠가 실제로 그랬다: 이벤트
   * 객체를 섹션 자리에 흘렸다). 부르는 쪽 하나를 고치는 것으로는 다음 배선 실수를 막지
   * 못하므로, 이 화면 자신이 **모르는 섹션을 기본 섹션으로 되돌린다**.
   */
  it('목차에 없는 섹션을 받아도 빈 화면이 되지 않는다', () => {
    render(<SettingsScreen initialSection={{ type: 'click' } as never} onBack={vi.fn()} onSignOut={vi.fn()} onCommunitiesEmpty={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Profile' })).toBeTruthy();
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
