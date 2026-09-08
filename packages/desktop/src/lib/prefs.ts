// 사용자 설정 보관 지점 — sessionStore 와 같은 모양의 단일 표면. 저장 매체(localStorage)를
// 이 파일 밖으로 드러내지 않아서, 나중에 Tauri store 로 갈아끼울 때 여기만 고치면 된다.
//
// `runnerRepoPath`·`runnerCommand`(#250·#305·#425)는 `#431` 1단계에서 없앴다. 러너가
// 소스 체크아웃을 `pnpm --filter @murmur/agent start` 로 실행하던 시절엔 "그 소스가 어디
// 있나"(`runnerRepoPath`)와 "`pnpm` 이 어디 있나"(`runnerCommand`)를 앱이 알아야 했다.
// 러너가 Tauri sidecar 로 배포되면서 그 물음 자체가 사라졌다 — sidecar 는 자기 위치를
// 스스로 알고 `pnpm` 을 거치지 않는다. 에이전트가 **일할 저장소**는 이 값들과 다른
// 것이었고(`workingDir`, DB, 에이전트별) 그대로 남는다.

export interface NotificationPrefs {
  enabled: boolean;
  mention: boolean;
  threadReply: boolean;
  dm: boolean;
  /** 알림 본문에 메시지 내용을 실을지. 끄면 제목(누가·어디서)만 남는다. */
  showPreview: boolean;
}

export type ColorMode = 'system' | 'light' | 'dark';

/**
 * 화면에 쓸 언어. `'system'` 은 **브라우저에게 묻는다**(`detectLocale`) — 색 모드의
 * `'system'` 과 같은 규약이라 설정 화면에서 둘이 같은 것을 뜻한다.
 *
 * 값을 `Locale` 로 좁히지 않고 문자열로 두는 이유: 이 파일은 **저장 매체**를 다루고
 * 저장본에는 **우리가 지운 언어**가 남아 있을 수 있다(언어를 하나 빼는 날). 좁은 타입은
 * 그 값을 읽는 순간 거짓말이 되므로, 좁히는 일은 읽는 쪽(`loadLocale`)이 한다.
 */
export type LocalePref = 'system' | string;

export interface Prefs {
  notifications: NotificationPrefs;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  colorMode: ColorMode;
  /** 앱 시작 시 내가 소유한 에이전트의 러너를 자동으로 띄울지(#250). */
  runnerAutoStart: boolean;
  /** 화면 언어. 기본은 `'system'` — 브라우저가 말하는 것을 따른다. */
  locale: LocalePref;
}

const KEY = 'murmur.prefs';
const DRAFTS_KEY = 'murmur.drafts';
const SIDEBAR_WIDTH_KEY = 'murmur.sidebarWidth';
const SIDEBAR_COLLAPSED_KEY = 'murmur.sidebarCollapsed';
const UNDO_SEND_KEY = 'murmur.undoSendMs';
const THREAD_WIDTH_KEY = 'murmur.threadWidth';
const TERMINAL_WIDTH_KEY = 'murmur.terminalWidth';

export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 480;

/*
 * 스레드·터미널 패널의 폭. 사이드바 폭과 **같은 종류의 값**이라 같은 매체에
 * 둔다 — 어느 패널을 얼마나 벌려 두는지는 이 기기에서 일하는 방식이고, 계정을 따라
 * 다니면 화면 크기가 다른 기기에서 남의 창 설정을 물려받는다(`design.md`: 값은 전부
 * 기기 로컬이다).
 *
 * 기본값은 **오늘 화면 그대로**다: 스레드는 `max-w-[640px]` 가 넓은 창에서 실제로
 * 만들던 폭, 터미널은 `w-[38rem]`(608px). 기능이 들어오면서 레이아웃이 조용히 달라지면
 * 사람은 폭 조절이 아니라 "화면이 망가졌다"를 먼저 본다.
 */
export const DEFAULT_THREAD_WIDTH = 640;
export const MIN_THREAD_WIDTH = 360;
/**
 * 스레드의 상한은 **거의 걸리지 않도록** 크게 둔다. 실질 상한은 이 상수가 아니라 대화에
 * 남길 최소 폭이어야 한다(`MIN_CHANNEL_WIDTH`) — 스레드는 일이 사는 곳이라 화면에서 가장
 * 커야 하고(설치본 확인, 2026-09-07), 900px 였을 때 넓은 화면에서 **남는 자리를 두고도**
 * 더 끌리지 않았다.
 *
 * 그래도 상수를 0 으로 두지 않는 이유: 이 값은 `style.width` 로 나가는 숫자다. 기하
 * 계산이 무엇을 잘못 재든(사각형이 0 인 환경, 형제 패널이 겹친 순간) 화면이 4K 밖으로
 * 나가지는 않게 붙잡아 두는 마지막 난간이다.
 */
export const MAX_THREAD_WIDTH = 2000;
export const DEFAULT_TERMINAL_WIDTH = 608;
export const MIN_TERMINAL_WIDTH = 360;
export const MAX_TERMINAL_WIDTH = 1000;

/**
 * 대화에 반드시 남겨 두는 폭. 상한이 상수뿐이면 스레드·터미널이 대화를 폭 0 으로 밀어낼
 * 수 있고, 사람은 그것을 "채널이 사라졌다"로 읽는다 — 되돌릴 손잡이는 사라진 그 자리에
 * 있으니 빠져나올 길도 없다. 그래서 끌 수 있는 최대는 상수와 **남은 자리** 중 작은
 * 쪽이다(`PaneResizer`).
 *
 * 이 값이 지키는 것은 **되돌릴 수 있음**이지 편안함이 아니다. 200px 의 대화는 좁지만
 * 거기 있다는 것이 보이고 구분선을 다시 잡을 수 있다 — 편안한 폭이 얼마인지는 앉은
 * 사람이 끌어서 정한다. 그래서 320px 에서 내렸다: 스레드에 줄 자리를 우리가 쥐고 있을
 * 근거가 "대화도 넓어야 한다"는 우리 취향뿐이었다.
 *
 * **구분선마다 남길 자리가 다르다.** 스레드 구분선 왼쪽에는 대화만 있지만, 터미널
 * 구분선 왼쪽에는 대화**와 스레드**가 있다. 그래서 이 상수를 `PaneResizer` 가 직접
 * 읽지 않고 각 호출부가 자기 몫을 계산해 넘긴다 — 하나로 뭉치면 터미널을 끌 때 스레드의
 * `min-width` 와 부딪쳐 줄이 넘치고, 부모가 `overflow-hidden` 이라 그것이 조용히 잘린다.
 */
export const MIN_CHANNEL_WIDTH = 200;

/**
 * 인박스 자리의 폭(#488 C2 — *"모달이 아니라 자리"*).
 *
 * **끌 수 있게 만들지 않았다.** 스레드·터미널이 `paneStorage` 에 폭을 두는 이유는 그 안에
 * 들어갈 것의 크기를 우리가 모르기 때문이다 — 선택지 카드·완료 보고·터미널 출력은 화면
 * 크기와 지금 하는 일에 따라 필요한 폭이 다르다. 인박스는 그렇지 않다: **한 줄에 네 가지**
 * (얼굴 · 말표 · 본문 한 줄 · 언제·어디)를 담는 목록이고, 넓혀도 본문 한 줄이 길어질 뿐
 * 더 보이는 것이 없다. 끌 수 있는 손잡이는 사람에게 **고를 것이 있다는 뜻**이라, 고를 것이
 * 없는 자리에 달면 그것 자체가 거짓말이다.
 *
 * `PaneResizer` 를 쓸 수 없다는 사정도 겹친다 — 그 부품은 **오른쪽에 붙은 패널**의 왼쪽
 * 가장자리에 서는 것을 전제로 이동량을 계산한다(그 파일의 주석). 인박스는 채널의 왼쪽이라
 * 방향이 반대다.
 *
 * 320px 은 실측이다: 말표(`나를 막는 것` 등)와 채널 이름이 한 줄에서 잘리지 않는 최소
 * 폭이고, 그 아래로 내려가면 본문 한 줄이 두세 글자만 남아 *"무엇을"* 을 말하지 못한다.
 *
 * `MIN_` 만 있고 `MAX_` 가 없는 이유: 고정 폭이라 상한이 곧 이 값이다. 그래도 상수를 둘로
 * 나눈 이름을 쓰는 것은 **`flex-shrink` 가 이 아래로 못 내려간다**는 뜻을 담기 때문이다 —
 * 좁은 창에서 폭 0 이 되면 닫기 버튼까지 사라져 빠져나올 길이 없어진다(`MIN_CHANNEL_WIDTH`
 * 의 주석과 같은 규칙: 이 값이 지키는 것은 편안함이 아니라 되돌릴 수 있음이다).
 */
export const INBOX_PANE_WIDTH = 360;
export const MIN_INBOX_PANE_WIDTH = 320;

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
  locale: 'system',
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
        locale: parsed.locale ?? DEFAULT_PREFS.locale,
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
 * 스레드·터미널 패널의 폭을 기기 로컬에 둔다.
 *
 * 읽을 때도 clamp 한다 — 상수를 나중에 좁히면 예전 기기에 남은 값이 범위 밖이 되는데,
 * 그것을 그대로 style 에 넘기면 다음 사람은 "clamp 이 왜 안 걸리나"를 드래그 코드에서
 * 찾는다. 깨진 값(NaN)은 기본값으로 되돌린다: `sidebarStorage` 와 같은 규약이다.
 */
const loadWidth = (key: string, fallback: number, min: number, max: number): number => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  } catch {
    return fallback;
  }
};

const saveWidth = (key: string, width: number, min: number, max: number): void => {
  try {
    localStorage.setItem(key, String(Math.max(min, Math.min(max, width))));
  } catch { /* 저장 불가 환경 허용 */ }
};

export const paneStorage = {
  loadThreadWidth(): number {
    return loadWidth(THREAD_WIDTH_KEY, DEFAULT_THREAD_WIDTH, MIN_THREAD_WIDTH, MAX_THREAD_WIDTH);
  },
  saveThreadWidth(width: number): void {
    saveWidth(THREAD_WIDTH_KEY, width, MIN_THREAD_WIDTH, MAX_THREAD_WIDTH);
  },
  loadTerminalWidth(): number {
    return loadWidth(TERMINAL_WIDTH_KEY, DEFAULT_TERMINAL_WIDTH, MIN_TERMINAL_WIDTH, MAX_TERMINAL_WIDTH);
  },
  saveTerminalWidth(width: number): void {
    saveWidth(TERMINAL_WIDTH_KEY, width, MIN_TERMINAL_WIDTH, MAX_TERMINAL_WIDTH);
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
