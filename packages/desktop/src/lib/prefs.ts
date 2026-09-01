// 사용자 설정 보관 지점 — sessionStore 와 같은 모양의 단일 표면. 저장 매체(localStorage)를
// 이 파일 밖으로 드러내지 않아서, 나중에 Tauri store 로 갈아끼울 때 여기만 고치면 된다.
export interface NotificationPrefs {
  enabled: boolean;
  mention: boolean;
  threadReply: boolean;
  dm: boolean;
  /** 알림 본문에 메시지 내용을 실을지. 끄면 제목(누가·어디서)만 남는다. */
  showPreview: boolean;
}

export interface Prefs {
  notifications: NotificationPrefs;
}

const KEY = 'murmur.prefs';

export const DEFAULT_PREFS: Prefs = {
  notifications: { enabled: true, mention: true, threadReply: true, dm: true, showPreview: true },
};

export const prefsStorage = {
  load(): Prefs {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return DEFAULT_PREFS;
      const parsed = JSON.parse(raw) as Partial<Prefs>;
      // 저장본을 그대로 쓰지 않고 기본값과 병합한다 — 없는 키를 undefined 로 두면
      // 나중에 추가된 설정이 기존 사용자에게 꺼진 채로 시작한다.
      return { notifications: { ...DEFAULT_PREFS.notifications, ...(parsed.notifications ?? {}) } };
    } catch {
      return DEFAULT_PREFS;
    }
  },
  save(p: Prefs): void {
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* 저장 불가 환경 허용 */ }
  },
};
