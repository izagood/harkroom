import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, Controller, type Controller as C } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { acc, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

afterEach(() => cleanup());

describe('삭제 권한이 UI에서 도달 가능해야 한다', () => {
  const seed = (me: ReturnType<typeof acc>) => {
    useAppStore.getState().reset();
    useAppStore.getState().set({
      me, accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') }, activeChannelId: 'c1',
    });
    setController({ openThread: vi.fn(), editMessage: vi.fn(), deleteMessage: vi.fn() } as unknown as C);
  };

  // 서버는 "작성자 또는 admin" 삭제를 허용한다. UI가 작성자만 내주면 잘못 올라간 비밀·스팸을
  // 치울 경로가 admin 에게 없다 — 서버가 열어 둔 조정 수단이 도달 불가가 된다.
  it('offers delete on another account message when I am an admin', () => {
    seed({ ...acc('u1', 'admin'), isAdmin: true });
    render(<MessageItem message={msg('m1', 'c1', 1, 'spam from a bot', 'u2')} />);

    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    // 수정은 admin 에게도 열리지 않는다 — 남의 발언을 고칠 수 있으면 기록이 증거가 못 된다.
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('offers neither on another account message when I am not an admin', () => {
    seed(acc('u1', 'admin'));
    render(<MessageItem message={msg('m1', 'c1', 1, 'not mine', 'u2')} />);

    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('offers neither on a system message even to an admin', () => {
    seed({ ...acc('u1', 'admin'), isAdmin: true });
    render(<MessageItem message={msg('m1', 'c1', 1, 'projected', 'u2', { kind: 'system' })} />);

    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});

describe('스레드 패널은 루트의 삭제를 따라간다', () => {
  // 루트가 사라진 스레드를 계속 열어 두면 답글만 남은 빈 패널에 갇힌다.
  it('closes the panel when the open thread root is deleted elsewhere', async () => {
    useAppStore.getState().reset();
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi({ messages: vi.fn(async () => ({ messages: [msg('m1', 'c1', 1, 'root')], hasMore: false })) }), makeWs);
    await c.start();
    await c.openChannel('c1');
    await c.openThread('m1');
    expect(useAppStore.getState().threadRootId).toBe('m1');

    callbacks.current!.onEvent({ type: 'message.deleted', channelId: 'c1', messageId: 'm1', audience: 'all' });

    expect(useAppStore.getState().threadRootId).toBeNull();
  });

  it('closes the panel when I delete the open thread root myself', async () => {
    useAppStore.getState().reset();
    const { makeWs } = fakeWsFactory();
    const c = new Controller(fakeApi({ messages: vi.fn(async () => ({ messages: [msg('m1', 'c1', 1, 'root')], hasMore: false })) }), makeWs);
    await c.start();
    await c.openChannel('c1');
    await c.openThread('m1');

    await c.deleteMessage('m1');

    expect(useAppStore.getState().threadRootId).toBeNull();
  });

  it('leaves the panel alone when a different message is deleted', async () => {
    useAppStore.getState().reset();
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi({
      messages: vi.fn(async () => ({
        messages: [msg('m1', 'c1', 1, 'root'), msg('m2', 'c1', 2, 'other')], hasMore: false,
      })),
    }), makeWs);
    await c.start();
    await c.openChannel('c1');
    await c.openThread('m1');

    callbacks.current!.onEvent({ type: 'message.deleted', channelId: 'c1', messageId: 'm2', audience: 'all' });

    expect(useAppStore.getState().threadRootId).toBe('m1');
  });
});
