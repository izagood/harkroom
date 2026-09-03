import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, Controller, type Controller as ControllerType } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { acc, chan, msg, fakeApi, fakeWsFactory } from './helpers/fakeApi';

const fakeController = () => {
  const c = {
    openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
    createChannel: vi.fn(), updateChannel: vi.fn(), archiveChannel: vi.fn(),
    toggleChannelMute: vi.fn(), toggleChannelStar: vi.fn(), markChannelUnread: vi.fn(),
    send: vi.fn(), openThread: vi.fn(), loadOlder: vi.fn(),
  };
  setController(c as unknown as ControllerType);
  return c;
};

const sidebar = () => render(
  <Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} />,
);

/** `c1` 은 메시지가 있고 `c2` 는 없다 — 항목이 붙는 조건이 그것이다. */
const seed = () => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general'), chan('c2', 'empty')],
    dms: [], connected: true,
    messages: { c1: [msg('m1', 'c1', 4, 'older', 'u2'), msg('m2', 'c1', 7, 'newest', 'u2')] },
  });
};

const openMenuFor = (name: string) => {
  const row = screen.getByText(name).closest('div.relative') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: '⋯' }));
  return screen.getByRole('menu');
};

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('채널 미읽음으로 표시 UI (#154)', () => {
  it('메뉴에서 누르면 마지막 메시지 seq 로 컨트롤러를 부른다', () => {
    seed();
    const c = fakeController();
    sidebar();

    fireEvent.click(within(openMenuFor('general')).getByText('미읽음으로 표시'));

    // 마지막 메시지 seq 다 — 결과가 미읽음 1 이어야 하므로 최댓값이지 개수가 아니다.
    expect(c.markChannelUnread).toHaveBeenCalledWith('c1', 7);
  });

  // 누를 것이 없는데 항목이 있으면 "할 수 있다"는 거짓 신호다(docs/design.md §4).
  it('메시지가 없는 채널에는 그 항목이 없다', () => {
    seed();
    fakeController();
    sidebar();

    expect(within(openMenuFor('empty')).queryByText('미읽음으로 표시')).toBeNull();
  });
});

describe('Controller.markChannelUnread (#154)', () => {
  beforeEach(() => useAppStore.getState().reset());

  it('서버에 보내고 사이드바 미읽음을 그 자리에서 올린다', async () => {
    const api = fakeApi({
      reads: vi.fn(async () => [{ channelId: 'c1', lastReadSeq: 7, unread: 0 }]),
      messages: vi.fn(async () => ({
        messages: [msg('m1', 'c1', 4, 'older', 'u2'), msg('m2', 'c1', 7, 'newest', 'u2')],
        hasMore: false,
      })),
    });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    await c.openChannel('c1');

    await c.markChannelUnread('c1', 7);

    expect(api.markChannelUnread).toHaveBeenCalledWith('c1', 7);
    const state = useAppStore.getState().reads.c1!;
    expect(state.unread).toBe(1);
    // 경계가 seq - 1 로 내려가야 채널을 다시 열 때 읽음 ack 가 나가고 표시가 지워진다.
    expect(state.lastReadSeq).toBe(6);
  });
});
