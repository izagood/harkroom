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
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}

const KEY = 'murmur.prefs';
const DRAFTS_KEY = 'murmur.drafts';
const SIDEBAR_WIDTH_KEY = 'murmur.sidebarWidth';
const SIDEBAR_COLLAPSED_KEY = 'murmur.sidebarCollapsed';

export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 480;

export const DEFAULT_PREFS: Prefs = {
  notifications: { enabled: true, mention: true, threadReply: true, dm: true, showPreview: true },
  sidebarWidth: 240,
  sidebarCollapsed: false,
};

export const prefsStorage = {
  load(): Prefs {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return DEFAULT_PREFS;
      const parsed = JSON.parse(raw) as Partial<Prefs>;
      // 저장본을 그대로 쓰지 않고 기본값과 병합한다 — 없는 키를 undefined 로 두면
      // 나중에 추가된 설정이 기존 사용자에게 꺼진 채로 시작한다.
      return {
        notifications: { ...DEFAULT_PREFS.notifications, ...(parsed.notifications ?? {}) },
        sidebarWidth: parsed.sidebarWidth ?? DEFAULT_PREFS.sidebarWidth,
        sidebarCollapsed: parsed.sidebarCollapsed ?? DEFAULT_PREFS.sidebarCollapsed,
      };
    } catch {
      return DEFAULT_PREFS;
    }
  },
  save(p: Prefs): void {
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* 저장 불가 환경 허용 */ }
  },
};

export const sidebarStorage = {
  loadWidth(): number {
    try {
      const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (!raw) return DEFAULT_PREFS.sidebarWidth;
      const parsed = parseInt(raw, 10);
      if (isNaN(parsed)) return DEFAULT_PREFS.sidebarWidth;
      return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, parsed));
    } catch {
      return DEFAULT_PREFS.sidebarWidth;
    }
  },
  saveWidth(width: number): void {
    try {
      const clamped = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
    } catch { /* 저장 불가 환경 허용 */ }
  },
  loadCollapsed(): boolean {
    try {
      const raw = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      if (!raw) return DEFAULT_PREFS.sidebarCollapsed;
      return raw === 'true';
    } catch {
      return DEFAULT_PREFS.sidebarCollapsed;
    }
  },
  saveCollapsed(collapsed: boolean): void {
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed)); } catch { /* 저장 불가 환경 허용 */ }
  },
};

/**
 * 미완성 초안을 기기 로컬에 보관한다(#184).
 *
 * `design.md` 가 "설정은 기기의 속성만 담는다"고 제한한 것은 **설정**이고 초안은 설정이
 * 아니다 — 사용자가 쓴 입력 자체다. 같은 매체를 쓰더라도 근거는 따로 세운다: 초안은
 * 그 기기에서 쓰다 만 글이므로 기기에 묶이는 것이 맞다.
 *
 * 이 저장소는 민감도에 따라 매체를 나눠 뒀다 — 세션 토큰은 **키체인**, 알림 토글은 기기
 * 로컬. 초안은 그 사이다: 토큰만큼 비밀은 아니지만 알림 토글과 달리 **사용자가 쓴 문장
 * 전체**다. 그래서 **로그아웃 시 전량 삭제**한다(`appStore.clearDrafts`). 계정이 사라진
 * 뒤에도 그 문장이 디스크에 남으면 `#92`(argv 노출)와 PAT 키체인 결정이 세운 기준과
 * 어긋난다.
 */
export const draftsStorage = {
  load(): Record<string, string> {
    try {
      const raw = localStorage.getItem(DRAFTS_KEY);
      if (!raw) return {};
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  },
  save(drafts: Record<string, string>): void {
    try {
      if (Object.keys(drafts).length === 0) {
        localStorage.removeItem(DRAFTS_KEY);
      } else {
        localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
      }
    } catch { /* 저장 불가 환경 허용 */ }
  },
  clear(): void {
    try { localStorage.removeItem(DRAFTS_KEY); } catch { /* noop */ }
  },
};
