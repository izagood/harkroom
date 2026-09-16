// **누른 것은 반드시 보인다** — 본문 자리를 나눠 쓰는 셋(관제탑·인박스·채널) 사이의 규칙이다.
//
// 2026-09-16 신고: *"채널이랑 Inbox 를 누르면 ... 기존에 있던 창을 닫아야만 보이게 되어
// 있어."* 인박스를 열어 둔 채 사이드바에서 채널을 누르면 채널은 **인박스 뒤로** 열렸다 —
// `activeChannelId` 는 바뀌었지만 화면에는 아무 일도 일어나지 않았고, 사람은 클릭이 먹지
// 않았다고 읽는다.
//
// `inboxPane.test.tsx` 는 **인박스 줄을 눌렀을 때**의 같은 규칙을 잰다(그쪽은 인박스가
// 스스로 접는다). 여기서 재는 것은 **인박스 밖에서 시작한 이동**이다 — 그 길은 스무 곳이
// 넘고 전부 `controller.openChannel` 로 모이므로, 목 컨트롤러로는 아무것도 증명하지 못한다.
// 그래서 이 파일만 **진짜 `Controller`** 를 세운다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { InboxEntry } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, Controller, getController, type Controller as ControllerType } from '../src/state/controller';
import { Workspace } from '../src/components/Workspace';
import { acc, chan, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

const entry = (id: number, channelId: string, threadRootId: string | null = null): InboxEntry => ({
  id, messageId: `m${id}`, reason: threadRootId ? 'thread_reply' : 'mention', readAt: null, channelId,
  authorId: 'u2', body: '이거 봐줘', meta: {}, createdAt: '2024-01-01T00:00:00.000Z', threadRootId,
});

/**
 * **진짜 컨트롤러**를 세운다(위 머리말). `start()` 는 부르지 않는다 — 이 파일이 재는 것은
 * 부팅이 아니라 이동이고, 부팅을 태우면 WS·디렉터리 조회까지 이 테스트의 사정이 된다.
 * 스토어는 `inboxPane.test.tsx` 와 같은 모양으로 손으로 세운다.
 */
const mount = (rows: InboxEntry[], apiOverrides: Record<string, unknown> = {}) => {
  const api = fakeApi({ inbox: vi.fn(async () => rows), ...apiOverrides });
  const { makeWs } = fakeWsFactory();
  setController(new Controller(api, makeWs) as unknown as ControllerType);
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
    channels: [chan('c1', 'general'), chan('c2', 'dev')],
    connected: true,
    activeChannelId: 'c1',
    messages: { c1: [msg('m1', 'c1', 1, '뿌리', 'u2')] },
  });
  render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);
  return api;
};

const openInbox = async (): Promise<void> => {
  fireEvent.click(screen.getByText('Inbox'));
  await screen.findByTestId('inbox-pane');
};

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  localStorage.clear();
  useAppStore.getState().reset();
});
afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
  setController(null as unknown as ControllerType);
});

describe('본문 자리 — 누른 것이 보인다 (2026-09-16)', () => {
  /** 신고된 그 동작 그대로. 사이드바의 채널 줄이 이동의 가장 흔한 입구다. */
  it('인박스를 열어 둔 채 사이드바에서 채널을 누르면 그 채널이 선다', async () => {
    mount([entry(1, 'c1')]);
    await openInbox();
    expect(screen.queryByTestId('channel-pane')).toBeNull();

    fireEvent.click(screen.getByText('dev'));

    await waitFor(() => expect(screen.queryByTestId('inbox-pane')).toBeNull());
    expect(screen.getByTestId('channel-pane')).toBeTruthy();
    expect(useAppStore.getState().activeChannelId).toBe('c2');
  });

  /**
   * **보던 채널을 다시 누르는 경우.** `activeChannelId` 가 그대로라, 값을 지켜보는 화면은
   * 이 클릭을 못 본다 — 신호를 값이 아니라 **세는 수**로 둔 이유가 이것이다. 인박스를 열기
   * 전에 보던 채널로 돌아가는 것은 드문 조작이 아니다.
   */
  it('보던 채널을 다시 눌러도 자리가 돌아온다', async () => {
    mount([entry(1, 'c1')]);
    await openInbox();

    fireEvent.click(screen.getByText('general'));

    await waitFor(() => expect(screen.queryByTestId('inbox-pane')).toBeNull());
    expect(screen.getByTestId('channel-pane')).toBeTruthy();
  });

  /**
   * **답글로 가는 이동은 자리를 뺏지 않는다**(#783). 스레드 패널은 오른쪽에 형제로 서므로
   * 둘이 함께 보인다 — *"막는 말을 확인하면서 그 스레드를 여는 것이 기본 동작"*.
   *
   * 인박스 밖(예: 링크·검색 결과)에서 답글을 열어도 같아야 한다. 그래서 인박스 줄을 누르지
   * 않고 컨트롤러를 직접 부른다 — 인박스의 자기 판정(`openEntry`)을 빌리지 않고 **이동
   * 자체**가 자리를 지키는지 본다.
   */
  it('답글을 여는 이동은 인박스를 접지 않는다', async () => {
    mount([entry(1, 'c1')], {
      message: vi.fn(async () => msg('m9', 'c1', 9, '답글', 'u2', { threadRootId: 'm1' })),
      messages: vi.fn(async () => ({ messages: [msg('m1', 'c1', 1, '뿌리', 'u2')], hasMore: false })),
    });
    await openInbox();

    await act(async () => { await getController().openMessage('m9'); });

    expect(screen.getByTestId('inbox-pane')).toBeTruthy();
  });

  /**
   * 관제탑도 같은 자리를 쓴다. 그쪽 사이드바에는 채널 줄이 없으므로 입구는 이동 그
   * 자체다(⌘K 검색 결과·본문 링크·대기 줄이 전부 이 길로 온다).
   */
  it('관제탑이 서 있어도 채널로 가는 이동이면 채널이 선다', async () => {
    mount([]);
    fireEvent.click(screen.getByTestId('rail-agents'));
    await screen.findByTestId('agent-tower');

    await act(async () => { await getController().openChannel('c2'); });

    await waitFor(() => expect(screen.queryByTestId('agent-tower')).toBeNull());
    expect(screen.getByTestId('channel-pane')).toBeTruthy();
  });
});
