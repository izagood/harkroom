import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_PREFS, prefsStorage } from '../src/lib/prefs';
import { usePrefsStore } from '../src/state/prefsStore';
import { useActiveStore as useAppStore } from '../src/state/communities';

beforeEach(() => {
  localStorage.clear();
  usePrefsStore.setState({ notifications: { ...DEFAULT_PREFS.notifications } });
});

describe('usePrefsStore', () => {
  it('applies a partial notification patch without touching the rest', () => {
    usePrefsStore.getState().setNotifications({ dm: false });
    expect(usePrefsStore.getState().notifications.dm).toBe(false);
    expect(usePrefsStore.getState().notifications.mention).toBe(true);
  });

  // 별도 저장 버튼이 없다 — 토글은 즉시 반영이 관례다.
  it('persists immediately, without a save step', () => {
    usePrefsStore.getState().setNotifications({ enabled: false });
    expect(prefsStorage.load().notifications.enabled).toBe(false);
  });

  // appStore.reset() 은 로그아웃 때 도메인 데이터를 비운다. 설정이 거기 얹혀 있으면
  // 로그아웃할 때마다 알림 설정이 초기화된다 — 그래서 store 가 별개여야 한다.
  it('survives appStore.reset()', () => {
    usePrefsStore.getState().setNotifications({ enabled: false });
    useAppStore.getState().reset();
    expect(usePrefsStore.getState().notifications.enabled).toBe(false);
  });
});
