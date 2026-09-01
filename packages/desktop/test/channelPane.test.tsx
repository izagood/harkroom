import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { acc, chan, msg } from './helpers/fakeApi';

const fakeController = () => {
  const c = { send: vi.fn(async () => undefined), openThread: vi.fn() };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general', 'main-repo')],
    activeChannelId: 'c1',
    messages: {
      c1: [
        msg('m1', 'c1', 1, 'hello world', 'u2'),
        msg('m2', 'c1', 2, 'thread reply hidden', 'u1', { threadRootId: 'm1' }),
        msg('m3', 'c1', 3, 'system message text', 'u2', {
          kind: 'system', meta: { repo: 'main-repo', oid: 'i1', avcsType: 'intent' },
        }),
      ],
    },
  });
});

afterEach(() => {
  cleanup();
});

describe('ChannelPane', () => {
  // 호버해야만 나타나는 버튼으로는 "이 메시지에 답글이 있다"를 알 수 없다. 답글이 달린 메시지는
  // 스레드를 열지 않고도 그 사실이 보여야 한다.
  it('shows a standing reply count on a message that has thread replies', () => {
    fakeController();
    render(<ChannelPane />);
    // m1 에는 m2 가 답글로 달려 있다 (beforeEach 픽스처).
    expect(screen.getByRole('button', { name: '1 reply' })).toBeTruthy();
  });

  it('pluralises the reply count', () => {
    fakeController();
    useAppStore.getState().set({
      messages: {
        c1: [
          msg('m1', 'c1', 1, 'root', 'u2'),
          msg('m2', 'c1', 2, 'reply one', 'u1', { threadRootId: 'm1' }),
          msg('m3', 'c1', 3, 'reply two', 'u1', { threadRootId: 'm1' }),
        ],
      },
    });
    render(<ChannelPane />);
    expect(screen.getByRole('button', { name: '2 replies' })).toBeTruthy();
  });

  it('offers no reply count on a message without replies', () => {
    fakeController();
    useAppStore.getState().set({ messages: { c1: [msg('m1', 'c1', 1, 'lonely', 'u2')] } });
    render(<ChannelPane />);
    expect(screen.queryByRole('button', { name: /repl(y|ies)$/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reply in thread' })).toBeTruthy();
  });

  it('opens the thread from the reply count', () => {
    const c = fakeController();
    render(<ChannelPane />);
    fireEvent.click(screen.getByRole('button', { name: '1 reply' }));
    expect(c.openThread).toHaveBeenCalledWith('m1');
  });

  // DM은 채널이 아니다 — '#' 접두사는 존재하지 않는 채널 이름을 가리킨다.
  it('addresses the composer to the person in a DM, without a channel prefix', () => {
    fakeController();
    useAppStore.getState().set({
      dms: [{ id: 'd1', memberIds: ['u1', 'u2'] }],
      activeChannelId: 'd1',
      messages: { d1: [] },
    });
    render(<ChannelPane />);
    expect(screen.getByPlaceholderText('Message bot')).toBeTruthy();
  });

  it('keeps the channel prefix on the composer for a standard channel', () => {
    fakeController();
    render(<ChannelPane />);
    expect(screen.getByPlaceholderText('Message #general')).toBeTruthy();
  });

  it('renders root messages only, resolves author handles', () => {
    fakeController();
    render(<ChannelPane />);
    expect(screen.getByText('hello world')).toBeTruthy();
    expect(screen.queryByText('thread reply hidden')).toBeNull();
    expect(screen.getAllByText('bot').length).toBeGreaterThan(0);
  });

  it('marks system messages with avcsType chip', () => {
    fakeController();
    render(<ChannelPane />);
    expect(screen.getByText('intent')).toBeTruthy();
  });

  it('sends on Enter and clears composer', () => {
    const c = fakeController();
    render(<ChannelPane />);
    const box = screen.getByPlaceholderText('Message #general') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hi there' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(c.send).toHaveBeenCalledWith('hi there');
    expect(box.value).toBe('');
  });

  it('opens a thread from a message that has no replies yet', () => {
    const c = fakeController();
    render(<ChannelPane />);
    // m1 은 답글이 있어 '1 reply' 로 바뀐다 — 여기서 보는 것은 답글 없는 m3 의 호버 진입점이다.
    fireEvent.click(screen.getAllByRole('button', { name: 'Reply in thread' })[0]!);
    expect(c.openThread).toHaveBeenCalledWith('m3');
  });

  it('ignores whitespace-only input and keeps draft', () => {
    const c = fakeController();
    render(<ChannelPane />);
    const box = screen.getByPlaceholderText('Message #general') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(c.send).not.toHaveBeenCalled();
    expect(box.value).toBe('   ');
  });

  it('restores draft when send fails', async () => {
    const c = fakeController();
    c.send.mockRejectedValueOnce(new Error('send failed'));
    render(<ChannelPane />);
    const box = screen.getByPlaceholderText('Message #general') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hi there' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(c.send).toHaveBeenCalledWith('hi there');
    await waitFor(() => expect(box.value).toBe('hi there'));
  });
});
