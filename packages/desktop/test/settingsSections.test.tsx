import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { ProfileSettings } from '../src/components/settings/ProfileSettings';
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

describe('Connection 흡수 (UX ⑥b-3)', () => {
  // 로그아웃은 프로필 한 곳이다. 안내는 실제 동작을 적는다 — 명시적 로그아웃은 이 기기의 세션을 전부 비운다.
  it('프로필의 로그아웃 안내는 이 기기의 커뮤니티가 모두 빠진다고 적는다', () => {
    render(<ProfileSettings onSignOut={vi.fn()} />);
    expect(screen.getByText(/Every community added on this device is removed/)).toBeTruthy();
  });
});

describe('UpdatesSettings', () => {
  // 이 자리는 "updater 가 아직 없다 — 없는 것을 없다고 적는다"를 재고 있었다.
  // **그 전제가 바뀌었다**: 앱에 `tauri-plugin-updater` 가 들어갔고 화면이 확인·설치를
  // 한다. 그러므로 "Not available" 은 이제 참이 아니라 거짓말이다.
  //
  // 확인 실패·최신·새 버전 발견·설치 실패 같은 흐름 전체의 회귀선은
  // `src/components/settings/UpdatesSettings.test.tsx` 에 있다(업데이트 표면을
  // 갈아끼워야 해서 그쪽에 모았다). 여기서는 이 섹션이 여전히 뜬다는 것만 잰다.
  // "Automatic updates · Available" 줄은 UX ③ 에서 뺐다 — 사양의 순서(지금 버전 → 새 버전 →
  // 설치)에 없고, 설치 버튼이 서 있다는 것이 이미 그 말을 한다. 못 한다고 말하지 않는지는
  // `UpdatesSettings.test.tsx` 의 첫 묶음이 잰다.
  it('states the current version and offers a way to check', () => {
    render(<UpdatesSettings />);
    expect(screen.getByText('Current version')).toBeTruthy();
    expect(screen.getByRole('button', { name: /check now/i })).toBeTruthy();
  });
});
