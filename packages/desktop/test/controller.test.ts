import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../src/state/appStore';
import { Controller } from '../src/state/controller';
import { acc, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

beforeEach(() => useAppStore.getState().reset());

describe('Controller', () => {
  it('start loads directory data and connects ws', async () => {
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs);
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

  // 투영된 system 메시지는 사용자가 그 채널을 보고 있지 않아도 WS로 들어온다. 그때 maxSeq가
  // 올라가 버리면, 채널을 처음 열 때의 증분 조회가 backlog 전체를 건너뛴다.
  it('loads full history the first time a channel opens, even if live messages arrived first', async () => {
    const history = [msg('m1', 'c1', 1, '오래된 대화'), msg('m2', 'c1', 2, '그 다음 대화')];
    const api = fakeApi({ messages: vi.fn(async () => history) });
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();

    // 채널을 열지 않은 상태에서 실시간 메시지가 먼저 도착한다 (투영 system 메시지가 그렇다).
    callbacks.current!.onEvent({
      type: 'message.created',
      message: msg('m14', 'c1', 14, '투영된 intent'),
      audience: 'all',
    });

    await c.openChannel('c1');

    const since = (api.messages as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(since).toMatchObject({ since: 0 });
    expect(useAppStore.getState().messages.c1!.map((m) => m.id)).toEqual(['m1', 'm2', 'm14']);
  });

  it('reopening an already loaded channel fetches only what is new', async () => {
    const api = fakeApi({ messages: vi.fn(async () => [msg('m1', 'c1', 5, 'first load')]) });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();

    await c.openChannel('c1');
    await c.openChannel('c1');

    const since = (api.messages as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(since).toMatchObject({ since: 5 });
  });

  // 서버는 기동 시 투영용 system 계정을 만든다. 그보다 먼저 부트스트랩한 클라이언트는 그 계정을
  // 모르므로, 작성자를 모르는 메시지가 오면 디렉터리를 다시 받아야 한다.
  it('refetches the account directory when a message arrives from an unknown author', async () => {
    const api = fakeApi();
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    (api.accounts as ReturnType<typeof vi.fn>).mockResolvedValue([
      acc('u1', 'admin'), acc('u2', 'bot', 'agent'), acc('sys', 'murmur', 'agent'),
    ]);

    callbacks.current!.onEvent({
      type: 'message.created',
      message: msg('m20', 'c1', 20, '@jaebin intent: 무언가', 'sys', { kind: 'system' }),
      audience: 'all',
    });
    await vi.waitFor(() => expect(useAppStore.getState().accounts.sys).toBeDefined());

    expect(useAppStore.getState().accounts.sys!.handle).toBe('murmur');
  });

  it('does not refetch the directory for a message from a known author', async () => {
    const api = fakeApi();
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    const before = (api.accounts as ReturnType<typeof vi.fn>).mock.calls.length;

    callbacks.current!.onEvent({
      type: 'message.created',
      message: msg('m21', 'c1', 21, '아는 사람', 'u2'),
      audience: 'all',
    });
    await Promise.resolve();

    expect((api.accounts as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(before);
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

  it('refreshUnread ignores a stale response that arrives after a newer one', async () => {
    const entries2 = [{ id: 2, messageId: 'm2', reason: 'mention' as const, readAt: null, channelId: 'c1' }];
    let resolveStale: ((v: typeof entries2) => void) | null = null;
    let call = 0;
    const api = fakeApi({
      inboxUnread: vi.fn(() => {
        call += 1;
        if (call === 1) return Promise.resolve([]); // start()의 초기 로드
        if (call === 2) return new Promise<typeof entries2>((resolve) => { resolveStale = resolve; }); // 먼저 발행, 나중에 도착
        return Promise.resolve(entries2); // 나중에 발행, 먼저 도착
      }),
    });
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' }); // call #2 — 응답 지연
    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' }); // call #3 — 즉시 resolve
    await Promise.resolve();
    await Promise.resolve();
    expect(useAppStore.getState().unread).toEqual(entries2);

    resolveStale!([{ id: 1, messageId: 'm1', reason: 'mention', readAt: null, channelId: 'c1' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(useAppStore.getState().unread).toEqual(entries2); // stale 응답이 최신 값을 덮지 않는다
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
