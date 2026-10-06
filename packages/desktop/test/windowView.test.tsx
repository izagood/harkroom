import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { WindowViewProvider, type WindowView } from '../src/state/windowView';
import { ThreadPanel } from '../src/components/ThreadPanel';
import { ChannelPane } from '../src/components/ChannelPane';
import { acc, msg, scheduledApiStub } from './helpers/fakeApi';
import { usePrefsStore } from '../src/state/prefsStore';
import { undoSendStorage } from '../src/lib/prefs';

/**
 * 완료 조건 ② — 열린 채널·스레드 패널이 **창마다 따로**다. 메인 창의 자리(스토어)는 c1·m1 을
 * 보고 있고, 새 창은 c2·r2 를 본다. 새 창의 화면은 스토어가 아니라 자기 자리를 그려야 하고,
 * 거기서 누른 「닫기」·「스레드 열기」는 메인 창의 자리를 건드리지 않아야 한다.
 */
const fakeController = () => {
  const c = {
    reply: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    closeThread: vi.fn(),
    openThread: vi.fn(),
    loadOlder: vi.fn(async () => undefined),
    loadChannelDoc: vi.fn(async () => null),
    api: scheduledApiStub(),
  };
  setController(c as unknown as Controller);
  return c;
};

const windowView = (over: Partial<WindowView> = {}): WindowView => ({
  kind: 'thread', channelId: 'c2', threadRootId: 'r2',
  openThread: vi.fn(), closeThread: vi.fn(), ...over,
});

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [
      { id: 'c1', name: 'main-room', kind: 'standard' } as never,
      { id: 'c2', name: 'side-room', kind: 'standard' } as never,
    ],
    activeChannelId: 'c1',
    threadRootId: 'm1',
    messages: {
      c1: [msg('m1', 'c1', 1, 'main root', 'u1'), msg('m2', 'c1', 2, 'main reply', 'u2', { threadRootId: 'm1' })],
      c2: [
        msg('r2', 'c2', 1, 'side root', 'u1', { replyCount: 1 }),
        msg('r3', 'c2', 2, 'side reply', 'u2', { threadRootId: 'r2' }),
        msg('r4', 'c2', 3, 'other side root', 'u1'),
      ],
    },
  });
});

afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('창마다 따로 보는 자리 (windowView)', () => {
  it('스레드 창은 메인 창의 스레드가 아니라 자기 스레드를 그린다', () => {
    fakeController();
    render(<WindowViewProvider value={windowView()}><ThreadPanel /></WindowViewProvider>);
    expect(screen.getByText('side root')).toBeTruthy();
    expect(screen.getByText('side reply')).toBeTruthy();
    expect(screen.queryByText('main reply')).toBeNull();
  });

  it('스레드 창의 답글은 그 창의 채널·뿌리로 간다', () => {
    const c = fakeController();
    render(<WindowViewProvider value={windowView()}><ThreadPanel /></WindowViewProvider>);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'from the window' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(c.reply).toHaveBeenCalledWith('from the window', [], 'c2', 'r2', false);
  });

  it('창의 × 는 그 창을 닫고, 메인 창의 스레드는 그대로다', () => {
    const c = fakeController();
    const view = windowView();
    render(<WindowViewProvider value={view}><ThreadPanel /></WindowViewProvider>);
    fireEvent.click(screen.getByRole('button', { name: '×' }));
    expect(view.closeThread).toHaveBeenCalled();
    expect(c.closeThread).not.toHaveBeenCalled();
    expect(useAppStore.getState().threadRootId).toBe('m1');
  });

  it('채널 창은 자기 채널을 그리고, 거기서 연 스레드는 자기 패널로 간다(W4)', () => {
    const c = fakeController();
    const view = windowView({ kind: 'channel', threadRootId: null });
    render(<WindowViewProvider value={view}><ChannelPane /></WindowViewProvider>);
    expect(screen.getByText('side root')).toBeTruthy();
    expect(screen.queryByText('main root')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '답글 1개' }));
    expect(view.openThread).toHaveBeenCalledWith('r2');
    expect(c.openThread).not.toHaveBeenCalled();
  });
});
