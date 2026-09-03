import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, Controller, type Controller as C } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { Sidebar } from '../src/components/Sidebar';
import { acc, chan, fakeApi, fakeWsFactory, msg, scheduledApiStub } from './helpers/fakeApi';

afterEach(() => cleanup());

const seed = (over: Partial<ReturnType<typeof useAppStore.getState>> = {}) => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general'), chan('c2', 'other')],
    activeChannelId: 'c1',
    ...over,
  });
  // #222: 컴포저가 예약 목록을 읽는다 — 목에 이 표면이 없으면 화면이 뜨지 않는다.
  setController({ openChannel: vi.fn(), openThread: vi.fn(), startDm: vi.fn(), logout: vi.fn(), api: scheduledApiStub() } as unknown as C);
};

describe('안 읽음 구분선', () => {
  beforeEach(() => seed());

  // 구분선은 **채널을 열 때의** 읽음 위치로 그린다. 라이브 값을 쓰면 열자마자 읽음 처리가
  // 돌아 구분선이 즉시 사라져 아무 쓸모가 없다.
  it('draws the divider before the first message newer than the frozen position', () => {
    useAppStore.getState().set({
      messages: { c1: [
        msg('m1', 'c1', 1, 'read one', 'u2'),
        msg('m2', 'c1', 2, 'read two', 'u2'),
        msg('m3', 'c1', 3, 'fresh', 'u2'),
      ] },
      dividerSeq: { c1: 2 },
    });

    render(<ChannelPane />);

    const divider = screen.getByText(/new messages/i);
    expect(divider).toBeTruthy();
    // 구분선이 m3 앞에 와야 한다 — m2 뒤, m3 위.
    const rendered = document.body.textContent ?? '';
    expect(rendered.indexOf('read two')).toBeLessThan(rendered.indexOf('New messages'));
    expect(rendered.indexOf('New messages')).toBeLessThan(rendered.indexOf('fresh'));
  });

  it('draws no divider when everything is already read', () => {
    useAppStore.getState().set({
      messages: { c1: [msg('m1', 'c1', 1, 'read', 'u2')] },
      dividerSeq: { c1: 1 },
    });

    render(<ChannelPane />);

    expect(screen.queryByText(/new messages/i)).toBeNull();
  });

  // 자기 발화는 구분선을 만들지 않는다 — 내가 쓴 것 위에 "안 읽음"이 뜨면 무의미하다.
  it('ignores my own messages when placing the divider', () => {
    useAppStore.getState().set({
      messages: { c1: [msg('m1', 'c1', 1, 'read', 'u2'), msg('m2', 'c1', 2, 'mine', 'u1')] },
      dividerSeq: { c1: 1 },
    });

    render(<ChannelPane />);

    expect(screen.queryByText(/new messages/i)).toBeNull();
  });
});

describe('채널 미읽음 배지', () => {
  beforeEach(() => seed());

  it('shows the unread count on a channel that has one', () => {
    useAppStore.getState().set({ reads: { c2: { lastReadSeq: 0, unread: 3 } } });

    render(<Sidebar onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenSaved={() => {}} onLogout={() => {}} onOpenSettings={() => {}} collapsed={false} onToggleCollapse={() => {}} />);

    expect(screen.getByLabelText('3 unread in other')).toBeTruthy();
  });

  it('shows no badge at zero', () => {
    useAppStore.getState().set({ reads: { c2: { lastReadSeq: 5, unread: 0 } } });

    render(<Sidebar onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenSaved={() => {}} onLogout={() => {}} onOpenSettings={() => {}} collapsed={false} onToggleCollapse={() => {}} />);

    expect(screen.queryByLabelText(/unread in other/)).toBeNull();
  });
});

describe('Controller 읽음 위치', () => {
  it('loads all read states on start', async () => {
    useAppStore.getState().reset();
    const api = fakeApi({ reads: vi.fn(async () => [{ channelId: 'c1', lastReadSeq: 2, unread: 4 }]) });
    const { makeWs } = fakeWsFactory();

    await new Controller(api, makeWs).start();

    expect(useAppStore.getState().reads.c1).toEqual({ lastReadSeq: 2, unread: 4 });
  });

  // 채널을 열면 (a) 그 순간의 위치를 구분선용으로 얼려 두고 (b) 최신까지 읽음 처리한다.
  it('freezes the divider position and then marks the channel read', async () => {
    useAppStore.getState().reset();
    const api = fakeApi({
      reads: vi.fn(async () => [{ channelId: 'c1', lastReadSeq: 1, unread: 2 }]),
      messages: vi.fn(async () => ({ messages: [msg('m1', 'c1', 1, 'a', 'u2'), msg('m2', 'c1', 3, 'b', 'u2')], hasMore: false })),
      markChannelRead: vi.fn(async () => undefined),
    });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();

    await c.openChannel('c1');

    expect(useAppStore.getState().dividerSeq.c1).toBe(1);
    expect(api.markChannelRead).toHaveBeenCalledWith('c1', 3);
    expect(useAppStore.getState().reads.c1).toEqual({ lastReadSeq: 3, unread: 0 });
  });

  // 다른 채널에 남의 메시지가 오면 배지가 올라가야 한다. 보고 있는 채널은 올라가지 않는다.
  it('bumps the badge for an inactive channel and not for the open one', async () => {
    useAppStore.getState().reset();
    const api = fakeApi({ reads: vi.fn(async () => [
      { channelId: 'c1', lastReadSeq: 0, unread: 0 },
      { channelId: 'c2', lastReadSeq: 0, unread: 0 },
    ]) });
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    useAppStore.getState().set({ activeChannelId: 'c1' });

    callbacks.current!.onEvent({ type: 'message.created', message: msg('x', 'c2', 9, 'ping', 'u2'), audience: 'all' });
    callbacks.current!.onEvent({ type: 'message.created', message: msg('y', 'c1', 9, 'here', 'u2'), audience: 'all' });

    await waitFor(() => expect(useAppStore.getState().reads.c2!.unread).toBe(1));
    expect(useAppStore.getState().reads.c1!.unread).toBe(0);
  });

  it('does not bump the badge for my own message', async () => {
    useAppStore.getState().reset();
    const api = fakeApi({ reads: vi.fn(async () => [{ channelId: 'c2', lastReadSeq: 0, unread: 0 }]) });
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();

    callbacks.current!.onEvent({ type: 'message.created', message: msg('z', 'c2', 9, 'mine', 'u1'), audience: 'all' });

    expect(useAppStore.getState().reads.c2!.unread).toBe(0);
  });
});
