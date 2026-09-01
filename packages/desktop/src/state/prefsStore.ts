import { create } from 'zustand';
import { prefsStorage, type NotificationPrefs, type Prefs } from '../lib/prefs';

export interface PrefsState extends Prefs {
  setNotifications(patch: Partial<NotificationPrefs>): void;
}

// useAppStore 와 반드시 별개다 — appStore.reset() 은 로그아웃 때 도메인 데이터를 비우는데,
// 설정은 로그아웃해도 남아야 한다.
export const usePrefsStore = create<PrefsState>((set, get) => ({
  ...prefsStorage.load(),
  setNotifications: (patch) => {
    const next: Prefs = { notifications: { ...get().notifications, ...patch } };
    prefsStorage.save(next);
    set(next);
  },
}));
