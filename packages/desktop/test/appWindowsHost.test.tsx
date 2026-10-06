import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { usePrefsStore } from '../src/state/prefsStore';
import { AppWindowsHost } from '../src/components/AppWindowsHost';
import { ThreadPanel } from '../src/components/ThreadPanel';
import { ChannelPane } from '../src/components/ChannelPane';
import {
  MAX_APP_WINDOWS, openAppWindow, resetAppWindowsForTest, setWindowOpener, useAppWindows,
} from '../src/lib/appWindows';
import { acc, msg, scheduledApiStub } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

/**
 * 스레드 창(판 3) — 메인 트리에서 **새 창 문서로** 포털을 단다. jsdom 의 두 번째 문서가 `window.open` 이
 * 돌려주는 같은 출처 창 노릇을 한다(실기는 PR 의 탐침 기록).
 */
function fakeWin() {
  const doc = document.implementation.createHTMLDocument('popup');
  const listeners: Record<string, Array<() => void>> = {};
  const win = {
    closed: false,
    document: doc,
    focus: vi.fn(),
    close: vi.fn(() => { win.closed = true; (listeners.pagehide ?? []).forEach((f) => f()); }),
    addEventListener: (type: string, fn: () => void) => { (listeners[type] ??= []).push(fn); },
    removeEventListener: () => undefined,
  };
  return win;
}

const fakeController = () => {
  const c = {
    reply: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    closeThread: vi.fn(() => useAppStore.getState().set({ threadRootId: null })),
    openThread: vi.fn(),
    loadOlder: vi.fn(async () => undefined),
    loadChannelDoc: vi.fn(async () => null),
    loadThreadForWindow: vi.fn(async () => true),
    markWindowRead: vi.fn(),
    api: scheduledApiStub(),
  };
  setController(c as unknown as Controller);
  return c;
};

let wins: ReturnType<typeof fakeWin>[] = [];

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  undoSendStorage.saveWindowMs(0);
  resetAppWindowsForTest();
  wins = [];
  setWindowOpener({ open: () => { const w = fakeWin(); wins.push(w); return w as unknown as Window; } });
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [{ id: 'c1', name: 'room', kind: 'standard' } as never],
    activeChannelId: 'c1',
    threadRootId: 'm1',
    messages: {
      c1: [
        msg('m1', 'c1', 1, 'root line\nsecond line', 'u1', { replyCount: 1 }),
        msg('m2', 'c1', 2, 'a reply', 'u2', { threadRootId: 'm1' }),
      ],
    },
  });
});

afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('스레드 창', () => {
  it('새 창 문서에 스레드를 그리고 제목줄은 「#채널 · 루트 첫 줄」이다', async () => {
    const c = fakeController();
    render(<AppWindowsHost />);
    act(() => { openAppWindow({ kind: 'thread', channelId: 'c1', rootId: 'm1' }); });
    const popup = wins[0]!.document;
    await waitFor(() => expect(within(popup.body).getByText('a reply')).toBeTruthy());
    expect(c.loadThreadForWindow).toHaveBeenCalledWith('c1', 'm1');
    expect(popup.title).toBe('#room · root line');
    // 스레드 창 안에는 ⧉ 가 없다 — 이미 창이다.
    expect(within(popup.body).queryByTestId('thread-pop-out')).toBeNull();
  });

  it('없는 스레드면 빈 상태로 알린다', async () => {
    const c = fakeController();
    c.loadThreadForWindow.mockResolvedValue(false);
    render(<AppWindowsHost />);
    act(() => { openAppWindow({ kind: 'thread', channelId: 'c1', rootId: 'gone' }); });
    await waitFor(() => expect(within(wins[0]!.document.body).getByTestId('window-empty').textContent).toContain('없습니다'));
  });

  it('패널 ⧉ 는 스레드를 창으로 **옮긴다**: 패널은 닫히고 초안이 창으로 따라간다(완료 조건 ③)', async () => {
    const c = fakeController();
    render(<><ThreadPanel /><AppWindowsHost /></>);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '쓰다 만 답글' } });
    fireEvent.click(screen.getByTestId('thread-pop-out'));
    expect(c.closeThread).toHaveBeenCalled();
    const popup = wins[0]!.document;
    // createHTMLDocument 는 defaultView 가 없어 role 조회가 안 된다 — 요소를 직접 찾는다.
    await waitFor(() => expect(popup.querySelector('textarea')).toBeTruthy());
    expect(popup.querySelector('textarea')!.value).toBe('쓰다 만 답글');
  });

  it('이미 띄운 스레드를 다시 떼면 새로 열지 않고 앞으로만(완료 조건 ④)', () => {
    fakeController();
    render(<><ThreadPanel /><AppWindowsHost /></>);
    act(() => { openAppWindow({ kind: 'thread', channelId: 'c1', rootId: 'm1' }); });
    fireEvent.click(screen.getAllByTestId('thread-pop-out')[0]!);
    expect(wins).toHaveLength(1);
    expect(wins[0]!.focus).toHaveBeenCalled();
  });

  it('⌘-클릭한 답글 N 은 메인 패널이 아니라 새 창으로 연다', () => {
    const c = fakeController();
    useAppStore.getState().set({ threadRootId: null });
    render(<ChannelPane />);
    fireEvent.click(screen.getByRole('button', { name: '답글 1개' }), { metaKey: true });
    expect(c.openThread).not.toHaveBeenCalled();
    expect(useAppWindows.getState().entries.map((e) => e.key)).toEqual(['thread-m1']);
  });

  it('9번째는 열지 않고 통지 줄로 이유를 말한다', () => {
    fakeController();
    for (let i = 0; i < MAX_APP_WINDOWS; i++) openAppWindow({ kind: 'thread', channelId: 'c1', rootId: `r${i}` });
    render(<ThreadPanel />);
    fireEvent.click(screen.getByTestId('thread-pop-out'));
    expect(wins).toHaveLength(MAX_APP_WINDOWS);
    expect(useAppStore.getState().notice).toContain('8개');
    expect(useAppStore.getState().threadRootId).toBe('m1');
  });
});
