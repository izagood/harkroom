import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, Controller, type Controller as ControllerType } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc, chan, msg, fakeApi, fakeWsFactory } from './helpers/fakeApi';

const fakeController = () => {
  const c = {
    openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
    createChannel: vi.fn(), updateChannel: vi.fn(), archiveChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(), markChannelUnread: vi.fn(),
    send: vi.fn(), openThread: vi.fn(), loadOlder: vi.fn(),
  };
  setController(c as unknown as ControllerType);
  return c;
};

const sidebar = () => render(
  <Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />,
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
  // 행 자체가 트리거다(`⋯` 버튼은 없앴다). 우클릭 이벤트는 채널 버튼에서 그 행까지 올라간다.
  fireEvent.contextMenu(screen.getByText(name).closest('button') as HTMLElement);
  return screen.getByRole('menu');
};

// **언어를 한국어로 고정한다.** 이 파일의 축들은 사이드바의 한국어 문구로 쓰여 있고,
// 그 문구가 지키는 것은 언어가 아니라 **그 언어로 표현된 규율**이다(#619 가 대기 사슬에서
// 세운 방식과 같다). 영어가 원본이 되면서 기본값이 영어가 됐으므로, 한국어를 재려면
// 한국어라고 말해야 한다 — 그리고 그렇게 적어 두면 이 축들이 무엇을 재는지가 오히려
// 또렷해진다. 두 언어로 다 뜨는지는 `i18n.test.tsx` 가 잰다.
beforeEach(() => { vi.clearAllMocks(); usePrefsStore.getState().setLocale('ko'); });
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

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
