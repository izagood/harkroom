import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DEFAULT_PREFS } from '../src/lib/prefs';
import { usePrefsStore } from '../src/state/prefsStore';
import { NotificationSettings } from '../src/components/settings/NotificationSettings';

beforeEach(() => {
  localStorage.clear();
  usePrefsStore.setState({ notifications: { ...DEFAULT_PREFS.notifications } });
});
afterEach(() => cleanup());

describe('NotificationSettings', () => {
  it('writes a toggle straight into the store', () => {
    render(<NotificationSettings />);
    fireEvent.click(screen.getByRole('switch', { name: 'Direct messages' }));
    expect(usePrefsStore.getState().notifications.dm).toBe(false);
  });

  // 마스터가 꺼져 있는데 하위 토글이 살아 있으면, 켜도 아무 일이 없는 조작을 사용자가 하게 된다.
  it('disables the per-reason toggles while notifications are off', () => {
    usePrefsStore.setState({ notifications: { ...DEFAULT_PREFS.notifications, enabled: false } });
    render(<NotificationSettings />);
    expect((screen.getByRole('switch', { name: 'Mentions' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('switch', { name: 'Enable notifications' }) as HTMLInputElement).disabled).toBe(false);
  });

  // 브라우저 dev 모드에는 Tauri 알림 플러그인이 없다. 조용히 아무 일도 안 하면
  // 사용자는 설정이 고장난 줄 안다.
  it('warns when this build has no OS notification surface', () => {
    render(<NotificationSettings />);
    expect(screen.getByTestId('no-notification-surface')).toBeTruthy();
  });
});
