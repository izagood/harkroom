import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  anyAppWindowFocused, appWindowKey, closeAppWindow, loadSavedAppWindows, markAppWindowGone, MAX_APP_WINDOWS,
  openAppWindow, resetAppWindowsForTest, restoreAppWindows, setAppWindowInvoke, setAppWindowPinned, setAppWindowScope,
  setWindowOpener, useAppWindows, type AppWindowTarget,
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
    screenX: 100, screenY: 50, innerWidth: 420, innerHeight: 680,
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

  it('📌 은 메인 웹뷰에서 그 창 라벨로 항상 위를 건다(W3 — 기본 끔)', async () => {
    const invoke = vi.fn(async () => undefined);
    setAppWindowInvoke(invoke);
    setWindowOpener({ open: () => fakeWin() as unknown as Window });
    const r = openAppWindow(thread(ROOT));
    expect(r.kind === 'opened' && r.entry.pinned).toBe(false);
    await setAppWindowPinned(appWindowKey(thread(ROOT)), true);
    expect(invoke).toHaveBeenCalledWith('plugin:window|set_always_on_top', {
      label: 'win-thread-0b7e2c1a-1111-4a4a-9c9c-123456789abc', value: true,
    });
    expect(useAppWindows.getState().entries[0]!.pinned).toBe(true);
  });

  it('📌 가 실패하면 켜진 것처럼 보이지 않는다', async () => {
    setAppWindowInvoke(vi.fn(async () => { throw new Error('denied'); }));
    setWindowOpener({ open: () => fakeWin() as unknown as Window });
    openAppWindow(thread(ROOT));
    await setAppWindowPinned(appWindowKey(thread(ROOT)), true);
    expect(useAppWindows.getState().entries[0]!.pinned).toBe(false);
  });

  it('재시작 복원(W2): 위치·크기·📌 를 적어 두고 같은 커뮤니티의 것만 다시 연다', async () => {
    setAppWindowInvoke(vi.fn(async () => undefined));
    setAppWindowScope('k1');
    setWindowOpener({ open: () => fakeWin() as unknown as Window });
    openAppWindow(thread(ROOT), { communityId: 'k1' });
    openAppWindow({ kind: 'channel', channelId: 'c2' }, { communityId: 'k1' });
    await setAppWindowPinned('channel-c2', true);
    const saved = loadSavedAppWindows();
    expect(saved.map((w) => w.target.kind)).toEqual(['thread', 'channel']);
    expect(saved[1]).toMatchObject({ pinned: true, bounds: { x: 100, y: 50, width: 420, height: 680 } });

    // 앱을 다시 띄운 것처럼 장부만 비운다(저장은 남는다).
    useAppWindows.setState({ entries: [] });
    const open = vi.fn(() => fakeWin() as unknown as Window);
    setWindowOpener({ open });
    expect(restoreAppWindows('k2')).toBe(0);
    expect(restoreAppWindows('k1')).toBe(2);
    expect(open).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), 'width=420,height=680,left=100,top=50');
    await vi.waitFor(() => expect(useAppWindows.getState().entries.find((e) => e.key === 'channel-c2')?.pinned).toBe(true));
  });

  it('열 수 없는 스레드는 복원 목록에서 뺀다', () => {
    setWindowOpener({ open: () => fakeWin() as unknown as Window });
    openAppWindow(thread(ROOT));
    markAppWindowGone(appWindowKey(thread(ROOT)));
    expect(loadSavedAppWindows()).toHaveLength(0);
  });

  it('다른 커뮤니티의 저장 목록은 지우지 않는다', () => {
    setWindowOpener({ open: () => fakeWin() as unknown as Window });
    setAppWindowScope('k1');
    openAppWindow(thread(ROOT), { communityId: 'k1' });
    setAppWindowScope('k2');
    useAppWindows.setState({ entries: [] });
    openAppWindow({ kind: 'channel', channelId: 'c9' }, { communityId: 'k2' });
    expect(loadSavedAppWindows().map((w) => w.communityId).sort()).toEqual(['k1', 'k2']);
  });
});
