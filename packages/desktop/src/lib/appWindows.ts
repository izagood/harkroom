import { create } from 'zustand';

/**
 * 채널·스레드 **새 창**의 장부(designer 판 3, jaebin 결정 W1~W4).
 *
 * ## 창은 그리기만 한다
 *
 * 새 창은 메인 웹뷰가 `window.open('about:blank#hk-win=<key>')` 으로 연다. 그 창은 메인과 같은
 * 출처의 `Window` 라서, 메인의 React 가 그 문서에 **포털로** 그린다 — 스토어·컨트롤러·WebSocket·
 * 알림은 메인 하나 그대로다(`src-tauri/src/app_windows.rs` 머리 주석). 창마다 컨트롤러를 띄우면
 * 같은 메시지에 OS 알림이 창 수만큼 뜨고 읽음 위치가 두 벌이 된다.
 *
 * ## 이 파일이 맡는 것
 *
 * - 키 → 창 장부. 이미 띄운 키는 새로 열지 않고 **앞으로** 가져온다(완료 조건 ④).
 * - 합쳐 최대 8개(C6). 9번째는 조용히 닫지 않고 `limit` 을 돌려 화면이 안내한다.
 * - 「앱 창 중 하나라도 포커스」 판정 — 알림이 창 수만큼 뜨지 않게(완료 조건 ①).
 * - 열린 키 목록을 스토어로 내놓는다 — 사이드바 ⧉ 표시가 그것을 본다(완료 조건 ⑤).
 */

export type AppWindowTarget =
  | { kind: 'thread'; channelId: string; rootId: string }
  | { kind: 'channel'; channelId: string };

/** 합쳐 열 수 있는 창 수(C6). */
export const MAX_APP_WINDOWS = 8;

/** 창 크기(디자인 판 3): 스레드 420×680, 채널 820×720. */
export const APP_WINDOW_SIZE = {
  thread: { width: 420, height: 680 },
  channel: { width: 820, height: 720 },
} as const;

/**
 * 창 키. Rust 쪽 `popup_label` 이 `[a-z0-9-]{1,80}` 만 받으므로 id 를 소문자로 내리고 그 밖의 글자는
 * 거른다 — id 는 uuid 라 실제로 걸러지는 것은 없다. 키는 **창의 정체**다: 같은 스레드는 같은 키라서
 * 두 번 눌러도 창이 하나다.
 */
export function appWindowKey(target: AppWindowTarget): string {
  const id = target.kind === 'thread' ? target.rootId : target.channelId;
  return `${target.kind}-${id.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
}

/** 열린 창 하나. `win` 은 포털이 그릴 문서를 쥔 같은 출처 `Window` 다. */
export interface AppWindowEntry {
  key: string;
  target: AppWindowTarget;
  win: Window;
  /** 📌 항상 위(W3 — 기본 끔, 창마다 켠다). */
  pinned: boolean;
  /** 이 창이 그리는 커뮤니티. 다른 커뮤니티로 옮기면 이 창은 그릴 스토어를 잃으므로 닫는다. */
  communityId: string | null;
  /** 열 수 없는 스레드였다 — 복원 목록에서 뺀다(판 3 3b). 창은 빈 상태로 남아 사람에게 알린다. */
  gone?: boolean;
  /**
   * 채널 창의 스레드 패널 폭(designer #1174). **창마다 따로**다 — 메인의 저장 폭(`paneStorage`)은 읽지도
   * 쓰지도 않는다. 없으면 창이 기본값(`channelWindowPaneDefault`)을 고른다.
   */
  paneWidth?: number;
}

/** 열 때 줄 수 있는 것(재시작 복원). */
export interface OpenOptions {
  communityId?: string | null;
  bounds?: WindowBounds;
  pinned?: boolean;
  paneWidth?: number;
}

export interface WindowBounds { x: number; y: number; width: number; height: number }

interface AppWindowsState {
  /** 열린 순서대로. 사이드바 ⧉·재시작 복원이 이 목록을 본다. */
  entries: AppWindowEntry[];
}

export const useAppWindows = create<AppWindowsState>(() => ({ entries: [] }));

export type OpenResult =
  | { kind: 'opened'; entry: AppWindowEntry }
  | { kind: 'focused'; entry: AppWindowEntry }
  | { kind: 'limit' }
  | { kind: 'blocked' };

/** 시험이 바꿔 끼우는 자리. 기본은 메인 창의 `window.open`. */
export interface WindowOpener {
  open(url: string, name: string, features: string): Window | null;
}

let opener: WindowOpener = { open: (url, name, features) => window.open(url, name, features) };
export function setWindowOpener(next: WindowOpener): void { opener = next; }

/** 닫힌 창을 장부에서 뺀다. 사람이 창의 빨간 단추로 닫으면 여기로 온다. */
function prune(): AppWindowEntry[] {
  const { entries } = useAppWindows.getState();
  const live = entries.filter((e) => !e.win.closed);
  if (live.length !== entries.length) useAppWindows.setState({ entries: live });
  return live;
}

export function findAppWindow(target: AppWindowTarget): AppWindowEntry | undefined {
  const key = appWindowKey(target);
  return prune().find((e) => e.key === key);
}

/**
 * 채널·스레드를 새 창으로 연다. 이미 띄운 것이면 그 창을 **앞으로** 가져오기만 한다(C4·3a).
 * 창 안에 무엇을 그릴지는 이 함수의 몫이 아니다 — 장부에 오르면 `AppWindowsHost` 가 포털을 단다.
 */
export function openAppWindow(target: AppWindowTarget, opts: OpenOptions = {}): OpenResult {
  const existing = findAppWindow(target);
  if (existing) {
    existing.win.focus();
    return { kind: 'focused', entry: existing };
  }
  const live = prune();
  if (live.length >= MAX_APP_WINDOWS) return { kind: 'limit' };
  const key = appWindowKey(target);
  const { width, height } = opts.bounds ?? APP_WINDOW_SIZE[target.kind];
  const at = opts.bounds ? `,left=${Math.round(opts.bounds.x)},top=${Math.round(opts.bounds.y)}` : '';
  const win = opener.open(`about:blank#hk-win=${key}`, `hk-${key}`, `width=${Math.round(width)},height=${Math.round(height)}${at}`);
  if (!win) return { kind: 'blocked' };
  const entry: AppWindowEntry = {
    key, target, win, pinned: false, communityId: opts.communityId ?? null,
    ...(opts.paneWidth ? { paneWidth: opts.paneWidth } : {}),
  };
  adoptStyles(win.document);
  win.addEventListener('pagehide', () => {
    closeAppWindowEntry(key);
    /**
     * 장부에서는 바로 빼되 **저장은 조금 뒤에** 한다. 앱을 끌 때도 새 창들이 먼저 닫히며 이 이벤트를 쏘는데,
     * 그때 바로 저장하면 복원할 목록이 비어 버린다(W2). 앱이 끝나는 중이면 이 타이머는 돌지 못한다 —
     * 사람이 창 하나를 닫은 경우에만 목록에서 빠진다.
     */
    setTimeout(persistAppWindows, 500);
  });
  win.addEventListener('resize', () => persistAppWindows());
  useAppWindows.setState({ entries: [...live, entry] });
  if (opts.pinned) void setAppWindowPinned(key, true);
  persistAppWindows();
  return { kind: 'opened', entry };
}

function closeAppWindowEntry(key: string): void {
  const { entries } = useAppWindows.getState();
  useAppWindows.setState({ entries: entries.filter((e) => e.key !== key) });
}

/** 창을 닫는다(「메인 창으로 되돌리기」·옮기기). 장부에서도 뺀다. */
export function closeAppWindow(target: AppWindowTarget): void {
  const found = findAppWindow(target);
  if (!found) return;
  closeAppWindowEntry(found.key);
  found.win.close();
  persistAppWindows();
}

// ── 채널 창의 스레드 패널 폭(designer #1174) ────────────────────────────────

/** 채널 창에서 채널 열이 지켜야 할 최소 폭. 이보다 좁으면 이름줄·시각·툴바가 꺾이고 잘린다(첨부 6). */
export const CHANNEL_WINDOW_MIN_CHANNEL = 420;
/** 채널 창 안 스레드 패널의 최소 폭. 메인의 하한(400)보다 낮다 — 창이 작아서다. */
export const CHANNEL_WINDOW_MIN_THREAD = 280;
/** 기본 폭은 채널 열에 이만큼 남긴다: 820 창이면 패널 380 · 채널 440. */
const CHANNEL_WINDOW_DEFAULT_ROOM = 440;

/** 처음 연 채널 창의 패널 폭: `min(메인 저장 폭, 창 폭 − 440)`. 메인 저장 폭은 기본값의 재료로만 읽는다. */
export function channelWindowPaneDefault(mainSaved: number, windowWidth: number): number {
  return Math.max(CHANNEL_WINDOW_MIN_THREAD, Math.min(mainSaved, windowWidth - CHANNEL_WINDOW_DEFAULT_ROOM));
}

/** 지금 창 폭에서 실제로 그릴 폭 — 채널 열이 420 아래로 내려가지 않게 패널 쪽을 줄인다. */
export function channelWindowPaneClamp(width: number, windowWidth: number): number {
  return Math.max(CHANNEL_WINDOW_MIN_THREAD, Math.min(width, windowWidth - CHANNEL_WINDOW_MIN_CHANNEL));
}

export function setAppWindowPaneWidth(key: string, paneWidth: number): void {
  const { entries } = useAppWindows.getState();
  useAppWindows.setState({ entries: entries.map((e) => (e.key === key ? { ...e, paneWidth } : e)) });
  persistAppWindows();
}

/** 열 수 없는 스레드로 판명 — 복원 목록에서 뺀다(창은 빈 상태로 남는다). */
export function markAppWindowGone(key: string): void {
  const { entries } = useAppWindows.getState();
  useAppWindows.setState({ entries: entries.map((e) => (e.key === key ? { ...e, gone: true } : e)) });
  persistAppWindows();
}

// ── 📌 항상 위(W3) ───────────────────────────────────────────────────────────

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
let invokeOverride: Invoke | null = null;
/** 시험용: Tauri IPC 자리를 바꿔 끼운다. */
export function setAppWindowInvoke(next: Invoke | null): void { invokeOverride = next; }
function tauriInvoke(): Invoke | null {
  if (invokeOverride) return invokeOverride;
  const invoke = (globalThis as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__?.invoke;
  return typeof invoke === 'function' ? invoke : null;
}

/**
 * 창을 항상 위로 둔다/푼다. 부르는 것은 **메인 웹뷰**다(새 창은 JS 를 돌리지 않는다) — 권한
 * `core:window:allow-set-always-on-top` 도 메인 쪽 capabilities 에 있다. 라벨은 Rust 가 키로 지은
 * `win-<key>`(`src-tauri/src/app_windows.rs`). `@tauri-apps/api` 를 들이지 않는 것은 `lib/badge.ts` 와 같은 규칙이다.
 */
export async function setAppWindowPinned(key: string, pinned: boolean): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    try {
      await invoke('plugin:window|set_always_on_top', { label: `win-${key}`, value: pinned });
    } catch {
      return; // 창이 사라졌거나 권한이 없다 — 표시를 바꾸지 않는다(된 것처럼 보이면 안 된다).
    }
  }
  const { entries } = useAppWindows.getState();
  useAppWindows.setState({ entries: entries.map((e) => (e.key === key ? { ...e, pinned } : e)) });
  persistAppWindows();
}

// ── 재시작 복원(W2) ─────────────────────────────────────────────────────────

const STORAGE_KEY = 'harkroom.appWindows';

export interface SavedAppWindow {
  target: AppWindowTarget;
  communityId: string | null;
  pinned: boolean;
  paneWidth?: number;
  bounds?: WindowBounds;
}

function boundsOf(win: Window): WindowBounds | undefined {
  const { screenX: x, screenY: y, innerWidth: width, innerHeight: height } = win;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

/**
 * 지금 보고 있는 커뮤니티. 저장은 **이 커뮤니티 몫만 다시 쓰고** 다른 커뮤니티의 목록은 그대로 둔다 —
 * 커뮤니티를 옮기며 닫은 창들이 목록에서 사라지면 돌아왔을 때 복원할 것이 없다.
 */
let scope: string | null = null;
export function setAppWindowScope(communityId: string | null | undefined): void { scope = communityId ?? null; }

/** 지금 열린 창들을 적어 둔다. 실패(저장소 막힘)는 조용히 넘긴다 — 복원은 편의다. */
export function persistAppWindows(): void {
  const others = loadSavedAppWindows().filter((w) => w.communityId !== scope);
  const mine: SavedAppWindow[] = prune()
    .filter((e) => !e.gone && e.communityId === scope)
    .map((e) => ({
      target: e.target, communityId: e.communityId, pinned: e.pinned, bounds: boundsOf(e.win),
      ...(e.paneWidth ? { paneWidth: e.paneWidth } : {}),
    }));
  const saved = [...others, ...mine];
  try {
    if (saved.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* 저장소 막힘 */ }
}

const isSafeId = (v: unknown): v is string => typeof v === 'string' && /^[0-9A-Za-z-]{1,64}$/.test(v);

export function loadSavedAppWindows(): SavedAppWindow[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is SavedAppWindow => {
      const t = (r as SavedAppWindow | null)?.target;
      /**
       * 저장소는 **이 앱 밖에서도 고칠 수 있는 값**이다. 복원 목록의 id 는 uuid 꼴(`[0-9A-Za-z-]`)만 받는다 —
       * 그 밖의 글자가 키로 흘러 들어가 `about:blank#hk-win=…` 를 다른 모양으로 만들지 못하게 여기서 한 번,
       * 키를 지을 때(`appWindowKey`) 한 번, Rust 의 `popup_label` 에서 또 한 번 거른다.
       */
      return !!t && isSafeId(t.channelId)
        && (t.kind === 'channel' || (t.kind === 'thread' && isSafeId((t as { rootId?: unknown }).rootId)));
    });
  } catch {
    return [];
  }
}

/**
 * 앱이 뜰 때 지난번 창을 다시 연다 — 같은 커뮤니티의 것만(다른 커뮤니티의 창은 그 커뮤니티를 열 때
 * 연다). 합쳐 최대 8개(C6). 열 수 없는 스레드는 창이 빈 상태로 알린 뒤 목록에서 빠진다.
 */
export function restoreAppWindows(communityId: string | null): number {
  let opened = 0;
  for (const s of loadSavedAppWindows().filter((w) => w.communityId === communityId).slice(0, MAX_APP_WINDOWS)) {
    const paneWidth = typeof s.paneWidth === 'number' && Number.isFinite(s.paneWidth) ? s.paneWidth : undefined;
    const r = openAppWindow(s.target, { communityId, bounds: s.bounds, pinned: s.pinned, paneWidth });
    if (r.kind === 'opened') opened++;
  }
  return opened;
}

/**
 * 「사람이 지금 Harkroom 을 보고 있다」 — 메인이든 새 창이든 **하나라도** 포커스면 참이다.
 * 알림 판정(`Controller.announce*`)이 `document.hasFocus()` 대신 이것을 쓴다: 메인만 보면 새 창에서
 * 보고 있는 동안에도 알림이 뜨고, 창마다 보면 포커스 없는 창 수만큼 뜬다.
 */
export function anyAppWindowFocused(): boolean {
  if (document.hasFocus()) return true;
  return prune().some((e) => {
    try {
      return e.win.document.hasFocus();
    } catch {
      return false;
    }
  });
}

/**
 * 메인 문서의 스타일을 새 창 문서로 옮긴다. 포털은 DOM 만 옮기므로 CSS 는 따로 실어야 한다.
 * `<style>`(개발 서버의 HMR 스타일)과 `<link rel=stylesheet>`(빌드 결과) 둘 다 복제한다.
 * 테마 클래스(`<html class="dark">` 등)와 `data-*` 도 같이 옮긴다 — 색 토큰이 거기 걸려 있다.
 */
export function adoptStyles(doc: Document, source: Document = document): void {
  for (const node of Array.from(source.head.querySelectorAll('style, link[rel="stylesheet"]'))) {
    doc.head.appendChild(doc.importNode(node, true));
  }
  syncRootAttributes(doc, source);
}

export function syncRootAttributes(doc: Document, source: Document = document): void {
  const from = source.documentElement;
  const to = doc.documentElement;
  to.className = from.className;
  to.lang = from.lang;
  for (const { name, value } of Array.from(from.attributes)) {
    if (name.startsWith('data-') || name === 'style') to.setAttribute(name, value);
  }
}

/** 시험용: 장부를 비운다. */
export function resetAppWindowsForTest(): void {
  useAppWindows.setState({ entries: [] });
  invokeOverride = null;
  scope = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
  opener = { open: (url, name, features) => window.open(url, name, features) };
}
