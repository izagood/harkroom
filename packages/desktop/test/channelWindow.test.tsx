import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import { useActiveStore as useAppStore, useCommunityRegistry } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { usePrefsStore } from '../src/state/prefsStore';
import { Sidebar } from '../src/components/Sidebar';
import { AppWindowsHost } from '../src/components/AppWindowsHost';
import { ChannelPane } from '../src/components/ChannelPane';
import {
  channelWindowPaneClamp, channelWindowPaneDefault, loadSavedAppWindows, openAppWindow, resetAppWindowsForTest,
  setWindowOpener, useAppWindows,
} from '../src/lib/appWindows';
import { acc, chan, msg, scheduledApiStub } from './helpers/fakeApi';
import { paneStorage, undoSendStorage } from '../src/lib/prefs';

/** 채널 창(판 3 C1~C5) — 사이드바 손짓·⧉ 표시·옮기기·되돌리기·자기 스레드 패널(W4). */
function fakeWin() {
  const doc = document.implementation.createHTMLDocument('popup');
  const win = {
    closed: false, document: doc, focus: vi.fn(), innerWidth: 820,
    close: vi.fn(() => { win.closed = true; }),
    addEventListener: () => undefined, removeEventListener: () => undefined,
  };
  return win;
}

const fakeController = () => {
  const c = {
    openChannel: vi.fn(async () => undefined),
    openThread: vi.fn(async () => undefined),
    closeThread: vi.fn(),
    goBack: vi.fn(async () => false),
    send: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    loadOlder: vi.fn(async () => undefined),
    loadChannelDoc: vi.fn(async () => null),
    loadChannelForWindow: vi.fn(async () => undefined),
    loadThreadForWindow: vi.fn(async () => true),
    markWindowRead: vi.fn(),
    markChannelUnread: vi.fn(),
    toggleChannelStar: vi.fn(),
    api: scheduledApiStub(),
  };
  setController(c as unknown as Controller);
  return c;
};

const sidebar = () => render(
  <Sidebar panel="home" onOpenDirectory={vi.fn()} onOpenChannelDirectory={vi.fn()} onOpenInbox={vi.fn()}
    onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />,
);

let wins: ReturnType<typeof fakeWin>[] = [];
beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  undoSendStorage.saveWindowMs(0);
  resetAppWindowsForTest();
  wins = [];
  setWindowOpener({ open: () => { const w = fakeWin(); wins.push(w); return w as unknown as Window; } });
  useAppStore.getState().reset();
  const me = acc('u1', 'me');
  useAppStore.getState().set({
    me, accounts: { u1: me, u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general'), chan('c2', 'side')],
    channelMembers: { c1: [{ accountId: 'u1' } as never] },
    dms: [], connected: true, channelPrefs: {},
    activeChannelId: 'c1',
    messages: {
      c1: [msg('m1', 'c1', 1, 'main talk', 'u1')],
      c2: [msg('s1', 'c2', 1, 'side root', 'u1', { replyCount: 1 }), msg('s2', 'c2', 2, 'side reply', 'u2', { threadRootId: 's1' })],
    },
  });
});
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('채널 창', () => {
  it('사이드바 ⌘-클릭은 새 창으로 열고, 그 줄에 ⧉ 가 선다(완료 조건 ⑤)', () => {
    const c = fakeController();
    sidebar();
    expect(screen.queryByTestId('channel-popped-c2')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /side/ }), { metaKey: true });
    expect(c.openChannel).not.toHaveBeenCalled();
    expect(useAppWindows.getState().entries.map((e) => e.key)).toEqual(['channel-c2']);
    expect(screen.getByTestId('channel-popped-c2')).toBeTruthy();
  });

  it('띄워 둔 채널을 사이드바에서 그냥 눌러도 메인이 아니라 그 창을 앞으로(C4)', () => {
    const c = fakeController();
    act(() => { openAppWindow({ kind: 'channel', channelId: 'c2' }); });
    sidebar();
    fireEvent.click(screen.getByRole('button', { name: /side/ }));
    expect(c.openChannel).not.toHaveBeenCalled();
    expect(wins).toHaveLength(1);
    expect(wins[0]!.focus).toHaveBeenCalled();
  });

  it('우클릭 메뉴 맨 위 「채널을 새 창으로 열기」', () => {
    fakeController();
    sidebar();
    fireEvent.contextMenu(screen.getByRole('button', { name: /side/ }));
    const first = within(screen.getByRole('menu')).getAllByRole('menuitem')[0]!;
    expect(first.textContent).toContain('채널을 새 창으로 열기');
    fireEvent.click(first);
    expect(useAppWindows.getState().entries.map((e) => e.key)).toEqual(['channel-c2']);
  });

  it('채널 머리 ⧉ 는 채널을 **옮긴다** — 메인은 그 채널을 떠난다(W1)', async () => {
    const c = fakeController();
    render(<ChannelPane />);
    fireEvent.click(screen.getByTestId('channel-pop-out'));
    await waitFor(() => expect(useAppStore.getState().activeChannelId).toBeNull());
    expect(c.goBack).toHaveBeenCalled();
    expect(useAppWindows.getState().entries.map((e) => e.key)).toEqual(['channel-c1']);
  });

  it('창 안에서 연 스레드는 그 창 오른쪽 패널에 선다(W4), 메인 패널은 그대로', async () => {
    const c = fakeController();
    render(<AppWindowsHost />);
    act(() => { openAppWindow({ kind: 'channel', channelId: 'c2' }); });
    const popup = wins[0]!.document;
    await waitFor(() => expect(within(popup.body).getByText('side root')).toBeTruthy());
    expect(popup.title).toBe('#side');
    expect(c.loadChannelForWindow).toHaveBeenCalledWith('c2');
    // 새 창 문서는 defaultView 가 없어 fireEvent 를 못 쓴다 — 메인 쪽 MouseEvent 를 직접 쏜다.
    act(() => { within(popup.body).getByText('답글 1개').closest('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitFor(() => expect(within(popup.body).getByText('side reply')).toBeTruthy());
    expect(c.openThread).not.toHaveBeenCalled();
    expect(useAppStore.getState().threadRootId).toBeNull();
  });

  it('「메인 창으로 되돌리기」는 창을 닫고 메인이 그 채널을 연다', async () => {
    const c = fakeController();
    render(<AppWindowsHost />);
    act(() => { openAppWindow({ kind: 'channel', channelId: 'c2' }); });
    const popup = wins[0]!.document;
    await waitFor(() => expect(popup.querySelector('[data-testid="window-back-to-main"]')).toBeTruthy());
    act(() => { popup.querySelector('[data-testid="window-back-to-main"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(wins[0]!.close).toHaveBeenCalled();
    expect(c.openChannel).toHaveBeenCalledWith('c2');
    expect(useAppWindows.getState().entries).toHaveLength(0);
  });

  it('패널 폭은 창마다 따로 — 820 창에서 스레드를 열면 채널 열이 420 이상 남는다(designer #1174)', async () => {
    fakeController();
    paneStorage.saveThreadWidth(600); // 메인에서 넓혀 둔 사람
    render(<AppWindowsHost />);
    // 실제 여는 길(`openWindow`)처럼 지금 커뮤니티를 적어 연다 — 저장은 그 커뮤니티 몫만 한다.
    act(() => { openAppWindow({ kind: 'channel', channelId: 'c2' }, { communityId: useCommunityRegistry.getState().activeId }); });
    const popup = wins[0]!.document;
    await waitFor(() => expect(within(popup.body).getByText('답글 1개')).toBeTruthy());
    act(() => { within(popup.body).getByText('답글 1개').closest('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitFor(() => expect(popup.querySelector('[data-testid="thread-pane"]')).toBeTruthy());
    const pane = popup.querySelector<HTMLElement>('[data-testid="thread-pane"]')!;
    const width = parseInt(pane.style.width, 10);
    expect(width).toBe(380);
    expect(820 - width).toBeGreaterThanOrEqual(420);
    expect(pane.style.minWidth).toBe('280px');
    expect(pane.style.maxWidth).toContain('100% - 420px');
    // 손잡이(키보드)로 넓혀도 메인 저장 폭은 그대로, 창 장부에만 남는다
    act(() => { pane.querySelector('[role="separator"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(paneStorage.loadThreadWidth()).toBe(600);
    await waitFor(() => expect(useAppWindows.getState().entries[0]!.paneWidth).toBeGreaterThan(380));
    expect(loadSavedAppWindows()[0]!.paneWidth).toBe(useAppWindows.getState().entries[0]!.paneWidth);
  });

  it('기본 폭·좁힌 창의 폭 규칙', () => {
    expect(channelWindowPaneDefault(600, 820)).toBe(380);
    expect(channelWindowPaneDefault(320, 820)).toBe(320);
    expect(channelWindowPaneDefault(600, 600)).toBe(280);
    // 창을 줄이면 패널 쪽을 줄여 채널 열 420 을 지킨다 — 패널 하한 280 까지
    expect(channelWindowPaneClamp(500, 820)).toBe(400);
    expect(channelWindowPaneClamp(500, 1200)).toBe(500);
    expect(channelWindowPaneClamp(500, 600)).toBe(280);
  });
});
