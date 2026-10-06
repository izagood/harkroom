import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  anyAppWindowFocused, appWindowKey, closeAppWindow, MAX_APP_WINDOWS, openAppWindow,
  resetAppWindowsForTest, setWindowOpener, useAppWindows, type AppWindowTarget,
} from '../src/lib/appWindows';

/** 같은 출처 새 창의 흉내 — 실제 `window.open` 이 돌려주는 것처럼 자기 문서를 가진다. */
function fakeWin(focused = false) {
  const doc = document.implementation.createHTMLDocument('popup');
  vi.spyOn(doc, 'hasFocus').mockReturnValue(focused);
  const listeners: Record<string, () => void> = {};
  const win = {
    closed: false,
    document: doc,
    focus: vi.fn(),
    close: vi.fn(() => { win.closed = true; listeners.pagehide?.(); }),
    addEventListener: (type: string, fn: () => void) => { listeners[type] = fn; },
  };
  return win;
}

const thread = (rootId: string): AppWindowTarget => ({ kind: 'thread', channelId: 'c1', rootId });
const ROOT = '0B7E2C1A-1111-4A4A-9C9C-123456789ABC';

beforeEach(() => {
  resetAppWindowsForTest();
  vi.restoreAllMocks();
});

describe('appWindows', () => {
  it('키는 Rust 쪽 라벨 문법([a-z0-9-])에 맞는다', () => {
    expect(appWindowKey(thread(ROOT))).toBe('thread-0b7e2c1a-1111-4a4a-9c9c-123456789abc');
    expect(appWindowKey({ kind: 'channel', channelId: 'Ab_c' })).toBe('channel-abc');
  });

  it('about:blank#hk-win=<키> 로 열고, 창 크기는 종류별이다', () => {
    const open = vi.fn(() => fakeWin() as unknown as Window);
    setWindowOpener({ open });
    expect(openAppWindow(thread(ROOT)).kind).toBe('opened');
    expect(open).toHaveBeenCalledWith(
      'about:blank#hk-win=thread-0b7e2c1a-1111-4a4a-9c9c-123456789abc',
      'hk-thread-0b7e2c1a-1111-4a4a-9c9c-123456789abc',
      'width=420,height=680',
    );
    openAppWindow({ kind: 'channel', channelId: 'c2' });
    expect(open).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), 'width=820,height=720');
  });

  it('이미 띄운 것은 새로 열지 않고 앞으로만 가져온다(완료 조건 ④)', () => {
    const w = fakeWin();
    const open = vi.fn(() => w as unknown as Window);
    setWindowOpener({ open });
    openAppWindow(thread(ROOT));
    const again = openAppWindow(thread(ROOT));
    expect(again.kind).toBe('focused');
    expect(open).toHaveBeenCalledTimes(1);
    expect(w.focus).toHaveBeenCalledTimes(1);
  });

  it('합쳐 8개까지 — 9번째는 열지 않고 limit 을 돌려준다(C6)', () => {
    const open = vi.fn(() => fakeWin() as unknown as Window);
    setWindowOpener({ open });
    for (let i = 0; i < MAX_APP_WINDOWS; i++) expect(openAppWindow(thread(`r${i}`)).kind).toBe('opened');
    expect(openAppWindow({ kind: 'channel', channelId: 'c9' }).kind).toBe('limit');
    expect(open).toHaveBeenCalledTimes(MAX_APP_WINDOWS);
  });

  it('사람이 창을 닫으면 장부에서 빠지고 다시 열 수 있다', () => {
    setWindowOpener({ open: () => fakeWin() as unknown as Window });
    openAppWindow(thread(ROOT));
    closeAppWindow(thread(ROOT));
    expect(useAppWindows.getState().entries).toHaveLength(0);
    expect(openAppWindow(thread(ROOT)).kind).toBe('opened');
  });

  it('메인이 포커스가 아니어도 새 창 하나가 포커스면 「보고 있다」(완료 조건 ①)', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    expect(anyAppWindowFocused()).toBe(false);
    setWindowOpener({ open: () => fakeWin(true) as unknown as Window });
    openAppWindow(thread(ROOT));
    expect(anyAppWindowFocused()).toBe(true);
  });

  it('새 창 문서로 메인의 스타일과 테마 클래스를 옮긴다', () => {
    const style = document.createElement('style');
    style.textContent = '.x{color:red}';
    document.head.appendChild(style);
    document.documentElement.classList.add('dark');
    const w = fakeWin();
    setWindowOpener({ open: () => w as unknown as Window });
    openAppWindow(thread(ROOT));
    expect(w.document.head.querySelector('style')?.textContent).toBe('.x{color:red}');
    expect(w.document.documentElement.classList.contains('dark')).toBe(true);
    style.remove();
    document.documentElement.classList.remove('dark');
  });
});
