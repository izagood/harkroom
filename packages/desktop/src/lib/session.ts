// 토큰 보관 지점 — 후속에서 OS 키체인 구현으로 교체할 단일 표면.
export interface StoredSession { baseUrl: string; token: string }

const KEY = 'murmur.session';

export const sessionStore = {
  load(): StoredSession | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StoredSession;
      return parsed.baseUrl && parsed.token ? parsed : null;
    } catch { return null; }
  },
  save(s: StoredSession): void {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 저장 불가 환경 허용 */ }
  },
  clear(): void {
    try { localStorage.removeItem(KEY); } catch { /* noop */ }
  },
};
