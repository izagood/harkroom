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
}

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
export function openAppWindow(target: AppWindowTarget): OpenResult {
  const existing = findAppWindow(target);
  if (existing) {
    existing.win.focus();
    return { kind: 'focused', entry: existing };
  }
  const live = prune();
  if (live.length >= MAX_APP_WINDOWS) return { kind: 'limit' };
  const key = appWindowKey(target);
  const { width, height } = APP_WINDOW_SIZE[target.kind];
  const win = opener.open(`about:blank#hk-win=${key}`, `hk-${key}`, `width=${width},height=${height}`);
  if (!win) return { kind: 'blocked' };
  const entry: AppWindowEntry = { key, target, win };
  adoptStyles(win.document);
  win.addEventListener('pagehide', () => closeAppWindowEntry(key));
  useAppWindows.setState({ entries: [...live, entry] });
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
  opener = { open: (url, name, features) => window.open(url, name, features) };
}
