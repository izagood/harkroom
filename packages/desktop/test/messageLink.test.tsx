import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { messagePermalink } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { Controller, setController, type Controller as ControllerType } from '../src/state/controller';
import { ApiError } from '../src/lib/api';
import { MessageItem } from '../src/components/MessageItem';
import { Notice } from '../src/components/Notice';
import { acc, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

// #178 — 링크를 만드는 자리("Copy link")와 링크를 여는 자리(openMessage)의 회귀 테스트.
// 두 경로 모두 **조용한 실패**가 진짜 위험이다: 아무 일도 안 일어나면 사람은 앱이 멈춘
// 것으로 보고, 클립보드는 붙여넣기를 해 보고 나서야 안 됐다는 것을 안다.

const fakeController = () => {
  const c = {
    toggleReaction: vi.fn(async () => undefined),
    openThread: vi.fn(async () => undefined),
    editMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
  };
  setController(c as unknown as ControllerType);
  return c;
};

const setClipboard = (writeText: (text: string) => Promise<void>): void => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
    messages: { c1: [] },
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('openMessage', () => {
  it('opens the channel the linked message lives in', async () => {
    const linked = msg('m9', 'c1', 5, 'the decision we made', 'u2');
    const api = fakeApi({
      message: vi.fn(async () => linked),
      messages: vi.fn(async () => ({ messages: [linked], hasMore: false })),
    });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();

    await c.openMessage('m9');

    const s = useAppStore.getState();
    expect(s.activeChannelId).toBe('c1');
    // 이력에도 남는다 — 링크로 뛴 뒤 뒤로 가면 원래 보던 곳으로 돌아와야 한다.
    expect(s.history).toEqual([{ channelId: 'c1', threadRootId: null }]);
    // 열기만 하고 어느 것인지 안 보이면 긴 채널에서는 아무 일도 안 일어난 것과 같다.
    expect(s.highlightedMessageId).toBe('m9');
  });

  it('opens the thread panel when the link points at a reply', async () => {
    const reply = msg('r1', 'c1', 6, 'the reply', 'u2', { threadRootId: 'm9' });
    const api = fakeApi({
      message: vi.fn(async () => reply),
      messages: vi.fn(async () => ({ messages: [reply], hasMore: false })),
    });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();

    await c.openMessage('r1');

    const s = useAppStore.getState();
    expect(s.activeChannelId).toBe('c1');
    // 답글을 스레드 밖에서 보면 무엇에 대한 답인지 잃는다.
    expect(s.threadRootId).toBe('m9');
    expect(s.highlightedMessageId).toBe('r1');
  });

  it('shows the person an error when the linked message is not theirs to see', async () => {
    const api = fakeApi({
      message: vi.fn(async () => { throw new ApiError(403, 'forbidden', 'not a member of this dm channel'); }),
    });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();

    await c.openMessage('m-secret');

    // 조용히 아무 일도 하지 않으면 안 된다 — 화면에 실제로 뜨는지까지 본다.
    render(<Notice />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/can't open that message/i);
    expect(useAppStore.getState().activeChannelId).toBeNull();
    // 못 여는 메시지에 강조를 걸면 없는 곳을 가리킨다.
    expect(useAppStore.getState().highlightedMessageId).toBeNull();
  });

  it('shows the person an error when the linked message is gone', async () => {
    const api = fakeApi({
      message: vi.fn(async () => { throw new ApiError(404, 'not_found', 'no such message'); }),
    });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();

    await c.openMessage('m-gone');

    render(<Notice />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/gone/i);
    expect(useAppStore.getState().activeChannelId).toBeNull();
  });
});

describe('Copy link', () => {
  const openMenu = (): void => {
    fireEvent.click(screen.getByLabelText('More actions'));
  };

  it('puts the shared link form on the clipboard', async () => {
    fakeController();
    const writeText = vi.fn(async () => undefined);
    setClipboard(writeText);
    render(<MessageItem message={msg('m9', 'c1', 5, 'hello', 'u2')} />);

    openMenu();
    fireEvent.click(screen.getByText('Copy link'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(messagePermalink('m9')));
  });

  // 실패를 삼키면 사람은 붙여넣기를 시도하고 나서야 안 됐다는 것을 안다.
  it('shows the person the failure — and the link — when the clipboard write fails', async () => {
    fakeController();
    setClipboard(async () => { throw new Error('denied'); });
    render(<><MessageItem message={msg('m9', 'c1', 5, 'hello', 'u2')} /><Notice /></>);

    openMenu();
    fireEvent.click(screen.getByText('Copy link'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not copy/i);
    // 손으로 복사할 길을 남긴다.
    expect(alert.textContent).toContain(messagePermalink('m9'));
  });

  it('shows the failure when the environment has no clipboard at all', async () => {
    fakeController();
    render(<><MessageItem message={msg('m9', 'c1', 5, 'hello', 'u2')} /><Notice /></>);

    openMenu();
    fireEvent.click(screen.getByText('Copy link'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not copy/i);
  });
});

describe('highlight', () => {
  it('marks the message the person was just sent to', () => {
    fakeController();
    useAppStore.getState().set({ highlightedMessageId: 'm9' });
    const { container } = render(<MessageItem message={msg('m9', 'c1', 5, 'hello', 'u2')} />);

    expect(container.querySelector('[data-highlighted="true"]')).not.toBeNull();
  });

  it('leaves other messages alone', () => {
    fakeController();
    useAppStore.getState().set({ highlightedMessageId: 'm9' });
    const { container } = render(<MessageItem message={msg('m8', 'c1', 4, 'hello', 'u2')} />);

    expect(container.querySelector('[data-highlighted="true"]')).toBeNull();
  });
});
