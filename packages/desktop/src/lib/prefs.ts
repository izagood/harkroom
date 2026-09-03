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

export type ColorMode = 'system' | 'light' | 'dark';

export interface Prefs {
  notifications: NotificationPrefs;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  colorMode: ColorMode;
  /** 앱 시작 시 내가 소유한 에이전트의 러너를 자동으로 띄울지(#250). */
  runnerAutoStart: boolean;
  /**
   * 러너를 돌릴 murmur 저장소 경로(#250). 빈 문자열은 '아직 정하지 않았다'다.
   *
   * **기본값을 지어내지 않는다.** 앱은 자기가 어느 디렉터리에 체크아웃돼 있는지 알 수
   * 없고(번들된 앱의 cwd 는 `/` 다), 짐작한 경로로 자식을 띄우면 "왜 러너가 안 뜨지"의
   * 원인이 사람이 볼 수 없는 곳에 숨는다. 비어 있으면 띄우지 않고 그 사실을 말한다.
   */
  runnerRepoPath: string;
}

const KEY = 'murmur.prefs';
const DRAFTS_KEY = 'murmur.drafts';
const SIDEBAR_WIDTH_KEY = 'murmur.sidebarWidth';
const SIDEBAR_COLLAPSED_KEY = 'murmur.sidebarCollapsed';
const UNDO_SEND_KEY = 'murmur.undoSendMs';

export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 480;

/**
 * 보냄 취소 창의 기본 길이(#223, 기본값은 #274 에서 0 으로). **0 이라 기본 동작은 즉시
 * 발송**이고, 되돌리기는 켜는 사람의 선택이다.
 *
 * 켜 두는 것을 기본으로 하지 않는 이유: 창이 늦추는 것은 잘못 보낸 그 한 통이 아니라
 * **모든 메시지**다. 잘못 보내는 일은 드물게 일어나므로, 항상 켜 두면 드문 실수 하나를 위해
 * 평소의 모든 대화가 창 길이만큼 밀린다. 값을 이미 고른 기기의 저장값은 이 기본값이 바뀌어도
 * 덮이지 않는다(`loadWindowMs`).
 */
export const DEFAULT_UNDO_SEND_MS = 0;
/** 이보다 길게 두면 자기가 보낸 것이 언제 나갈지 모르는 상태로 앉아 있게 된다. */
export const MAX_UNDO_SEND_MS = 30_000;

export const DEFAULT_PREFS: Prefs = {
  notifications: { enabled: true, mention: true, threadReply: true, dm: true, showPreview: true },
  sidebarWidth: 240,
  sidebarCollapsed: false,
  colorMode: 'system',
  runnerAutoStart: true,
  runnerRepoPath: '',
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
        colorMode: parsed.colorMode ?? DEFAULT_PREFS.colorMode,
        runnerAutoStart: parsed.runnerAutoStart ?? DEFAULT_PREFS.runnerAutoStart,
        runnerRepoPath: parsed.runnerRepoPath ?? DEFAULT_PREFS.runnerRepoPath,
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
 * 보냄 취소 창의 길이를 기기 로컬에 둔다(#223).
 *
 * 계정 설정이 아닌 이유: 얼마나 기다릴지는 이 기기에서 일하는 방식이다 — `design.md` 의
 * "값은 전부 기기 로컬이다" 가 그대로 적용된다. 같은 사람이 노트북에서는 창을 두고
 * 데스크톱에서는 끌 수 있어야 한다.
 *
 * **0 이면 창을 끈다** — 그때는 예전처럼 누른 즉시 나간다. 끄기를 별도 토글로 두지 않는
 * 이유는, 길이와 켜짐 여부가 한 값이면 "켜져 있는데 0초" 같은 모순 상태가 아예 없기
 * 때문이다.
 */
export const undoSendStorage = {
  loadWindowMs(): number {
    try {
      const raw = localStorage.getItem(UNDO_SEND_KEY);
      if (raw === null) return DEFAULT_UNDO_SEND_MS;
      const parsed = parseInt(raw, 10);
      // 깨진 값은 기본값으로 되돌린다 — NaN 을 그대로 setTimeout 에 넘기면 즉시 실행되어
      // 창이 조용히 사라진다(끈 것과 구분되지 않는다).
      if (isNaN(parsed)) return DEFAULT_UNDO_SEND_MS;
      return Math.max(0, Math.min(MAX_UNDO_SEND_MS, parsed));
    } catch {
      return DEFAULT_UNDO_SEND_MS;
    }
  },
  saveWindowMs(ms: number): void {
    try {
      const clamped = Math.max(0, Math.min(MAX_UNDO_SEND_MS, ms));
      localStorage.setItem(UNDO_SEND_KEY, String(clamped));
    } catch { /* 저장 불가 환경 허용 */ }
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
