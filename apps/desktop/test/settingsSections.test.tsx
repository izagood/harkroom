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
    setController({
      api: { ...fakeApi(), baseUrl: 'http://localhost:3400' },
      // `ConnectionSettings` 가 `ProjectionUrl`(admin 전용)을 함께 그린다 — 바깥
      // `beforeEach` 가 admin 계정을 심어 두므로 조회가 실제로 일어난다.
      projectionConfig: vi.fn(async () => ({ url: null, source: null, appUrl: null, envUrl: null })),
      setProjectionConfig: vi.fn(async () => ({ url: null, source: null, appUrl: null, envUrl: null })),
      refreshProjection: vi.fn(async () => {}),
    } as unknown as Controller);
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
  // 이 자리는 "updater 가 아직 없다 — 없는 것을 없다고 적는다"를 재고 있었다.
  // **그 전제가 바뀌었다**: 앱에 `tauri-plugin-updater` 가 들어갔고 화면이 확인·설치를
  // 한다. 그러므로 "Not available" 은 이제 참이 아니라 거짓말이다.
  //
  // 확인 실패·최신·새 버전 발견·설치 실패 같은 흐름 전체의 회귀선은
  // `src/components/settings/UpdatesSettings.test.tsx` 에 있다(업데이트 표면을
  // 갈아끼워야 해서 그쪽에 모았다). 여기서는 이 섹션이 여전히 뜬다는 것만 잰다.
  it('states plainly that automatic updates are available', () => {
    render(<UpdatesSettings />);
    expect(screen.getByText('Available')).toBeTruthy();
  });
});
