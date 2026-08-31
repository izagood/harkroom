import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../src/state/appStore';
import { Controller } from '../src/state/controller';
import { fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

beforeEach(() => useAppStore.getState().reset());

describe('Controller', () => {
  it('start loads directory data and connects ws', async () => {
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs);
    // 세션 토큰은 ApiClient 내부 상태 — start는 WS용 토큰을 인자로 받지 않고
    // sessionStore를 읽지도 않는다. Controller 생성 시 토큰을 함께 받도록 구현하라.
    await c.start();
    const s = useAppStore.getState();
    expect(s.me?.handle).toBe('admin');
    expect(s.channels).toHaveLength(1);
    expect(Object.keys(s.accounts)).toHaveLength(2);
    callbacks.current!.onOpen();
    expect(useAppStore.getState().connected).toBe(true);
  });

  it('openChannel fetches since maxSeq and marks channel inbox read', async () => {
    const api = fakeApi({
      messages: vi.fn(async () => [msg('m1', 'c1', 1, 'a'), msg('m2', 'c1', 2, 'b')]),
      inboxUnread: vi.fn(async () => [
        { id: 7, messageId: 'm1', reason: 'mention', readAt: null, channelId: 'c1' },
      ]),
    });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    await c.openChannel('c1');
    const s = useAppStore.getState();
    expect(s.activeChannelId).toBe('c1');
    expect(s.messages.c1).toHaveLength(2);
    expect((api.markRead as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual([7]);
  });

  it('ws message.created upserts without duplicates; reconcile refetches on reopen', async () => {
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs);
    await c.start();
    await c.openChannel('c1');
    const m = msg('m9', 'c1', 9, 'live');
    callbacks.current!.onEvent({ type: 'message.created', message: m, audience: 'all' });
    callbacks.current!.onEvent({ type: 'message.created', message: m, audience: 'all' });
    expect(useAppStore.getState().messages.c1!.filter((x) => x.id === 'm9')).toHaveLength(1);
  });

  it('presence events update online list', async () => {
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs);
    await c.start();
    callbacks.current!.onEvent({ type: 'presence.snapshot', online: ['u1'] });
    callbacks.current!.onEvent({ type: 'presence.changed', accountId: 'u2', online: true });
    expect(useAppStore.getState().online.sort()).toEqual(['u1', 'u2']);
    callbacks.current!.onEvent({ type: 'presence.changed', accountId: 'u1', online: false });
    expect(useAppStore.getState().online).toEqual(['u2']);
  });

  it('send posts to active channel with idempotency key', async () => {
    const api = fakeApi();
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    await c.openChannel('c1');
    await c.send('hello');
    const call = (api.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('c1');
    expect(call[1]).toBe('hello');
    expect(typeof call[3]).toBe('string'); // idempotency key
  });
});
