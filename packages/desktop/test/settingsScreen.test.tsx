import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { acc } from './helpers/fakeApi';
import { usePrefsStore } from '../src/state/prefsStore';

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

  /**
   * **누른 이름이 열린 이름이다**(UX ④ H5). 한국어에서 목차는 "Appearance" 였고 열린 페이지는
   * "모양" 이었다 — 사람은 제대로 왔는지 한 번 더 읽어야 했다. 이제 둘이 같은 키라 갈라질 수
   * 없지만, 그 약속이 두 언어에서 다 지켜지는지 **본래 결함이 난 자리**로 잰다.
   */
  it.each([['ko', '모양과 언어'], ['en', 'Appearance & language']] as const)(
    '목차 이름과 페이지 제목이 같다 (%s)', (locale, name) => {
      usePrefsStore.getState().setLocale(locale);
      try {
        render(<SettingsScreen onBack={vi.fn()} onSignOut={vi.fn()} onCommunitiesEmpty={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name }));
        expect(screen.getByRole('heading', { name })).toBeTruthy();
      } finally {
        usePrefsStore.getState().setLocale('system');
      }
    },
  );

  /**
   * **관리자가 아니면 워크스페이스 묶음은 읽기 전용이라고 머리에서 말한다**(UX ⑥b). 페이지마다 막혀
   * 있어도 들어가 보기 전에는 몰랐다. 관리자에게는 붙지 않는다 — 고칠 수 있는 사람에게 "읽기
   * 전용" 이라고 하면 거짓이다.
   */
  /*
   * 멤버라도 워크스페이스 묶음의 쓰기 능력을 하나 받았으면(초대·집합·MCP) 읽기 전용이 아니다 —
   * 서버가 그 능력으로 허락하기 때문이다(`workspaceEditable`).
   */
  it.each([
    ['관리자', { isAdmin: true }, false],
    ['능력 없는 멤버', { isAdmin: false, capabilities: [] }, true],
    ['초대 능력을 받은 멤버', { isAdmin: false, capabilities: ['member.invite'] }, false],
    ['집합 능력을 받은 멤버', { isAdmin: false, capabilities: ['channel.manage'] }, false],
  ] as const)('%s → 읽기 전용 표시 %s', (_who, over, shown) => {
    useAppStore.getState().set({ me: { ...acc('u1', 'me'), ...over } as never });
    usePrefsStore.getState().setLocale('ko');
    try {
      render(<SettingsScreen onBack={vi.fn()} onSignOut={vi.fn()} onCommunitiesEmpty={vi.fn()} />);
      const mark = screen.queryByTestId('settings-group-readonly');
      expect(mark !== null).toBe(shown);
      if (shown) expect(mark!.textContent).toContain('읽기 전용');
    } finally {
      usePrefsStore.getState().setLocale('system');
    }
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
