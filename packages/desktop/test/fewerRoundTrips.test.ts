/**
 * **직렬 왕복 줄이기** (2026-10-02, 지연 분석 스레드의 C안). 왕복 하나가 130~300ms(Cloudflare 해외
 * PoP 경로)라, 서로를 기다릴 이유가 없는 조회는 겹쳐 낸다. 시간이 아니라 상태(풀지 않은 promise)로
 * "앞 조회가 끝나기 전에 이미 나가 있는가"를 잰다 — `openMessageRoundTrips.test.ts` 와 같은 방식.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import type { TicketProvider } from '../src/lib/ws';
import { fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

type Page = { messages: MessageRow[]; hasMore: boolean };
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => useAppStore.getState().reset());

describe('다른 채널의 스레드 열기', () => {
  it('스레드 조회를 채널 열기와 함께 낸다 — 채널 조회를 기다리지 않는다', async () => {
    const gate = deferred<Page>();
    let gated = false;
    const reply = { ...msg('rep', 'c2', 6, '답글'), threadRootId: 'root-x' };
    const messages = vi.fn(async (_c: string, o?: { thread?: string }) => {
      if (o?.thread) return { messages: [msg('root-x', 'c2', 5, '뿌리'), reply], hasMore: false };
      if (gated) return gate.promise;
      return { messages: [], hasMore: false };
    });
    const c = new Controller(fakeApi({ messages }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    gated = true;
    messages.mockClear();

    const done = c.openThread('root-x', { channelId: 'c2' });
    await vi.waitFor(() => expect(messages.mock.calls.some(([, o]) => o?.thread === 'root-x')).toBe(true));
    // 채널 c2 조회는 아직 서 있고, 패널도 아직 서지 않았다(채널을 옮긴 뒤에 세운다).
    expect(useAppStore.getState().threadRootId).toBeNull();

    gate.resolve({ messages: [msg('latest', 'c2', 9, '최신')], hasMore: false });
    await done;
    const s = useAppStore.getState();
    expect(s.activeChannelId).toBe('c2');
    expect(s.threadRootId).toBe('root-x');
    // 두 응답이 같은 채널 목록에 합쳐진다 — 어느 쪽이 먼저 와도 빠지는 것이 없다.
    expect(s.messages.c2!.map((m) => m.id).sort()).toEqual(['latest', 'rep', 'root-x']);
    // 다른 채널 내용이 섞이지 않는다.
    expect((s.messages.c1 ?? []).some((m) => m.channelId !== 'c1')).toBe(false);
  });

  it('스레드 조회가 실패하면 패널을 열다 말지 않는다', async () => {
    const messages = vi.fn(async (_c: string, o?: { thread?: string }) => {
      if (o?.thread) throw new Error('offline');
      return { messages: [], hasMore: false };
    });
    const c = new Controller(fakeApi({ messages }), fakeWsFactory().makeWs);
    await c.start();

    await c.openThread('root-x', { channelId: 'c2' });

    expect(useAppStore.getState().threadRootId).toBeNull();
    expect(useAppStore.getState().notice).toMatch(/Could not open that thread/);
  });
});

describe('검색 결과로 점프', () => {
  it('부르는 쪽이 준 행이 있으면 메시지를 다시 묻지 않는다', async () => {
    const hit = msg('hit', 'c2', 5, '찾은 글');
    const message = vi.fn(async () => hit);
    const messages = vi.fn(async (_c: string, o?: { around?: number }) =>
      o?.around !== undefined ? { messages: [hit], hasMore: true } : { messages: [hit], hasMore: false });
    const c = new Controller(fakeApi({ messages, message }), fakeWsFactory().makeWs);
    await c.start();

    await c.openMessage('hit', hit);

    expect(message).not.toHaveBeenCalled();
    expect(useAppStore.getState().activeChannelId).toBe('c2');
    expect(useAppStore.getState().highlightedMessageId).toBe('hit');
  });

  it('다른 id 의 행이면 쓰지 않고 서버에 묻는다', async () => {
    const real = msg('m1', 'c1', 1, '진짜');
    const message = vi.fn(async () => real);
    const c = new Controller(fakeApi({ message }), fakeWsFactory().makeWs);
    await c.start();

    await c.openMessage('m1', msg('other', 'c2', 5, '엉뚱한 행'));

    expect(message).toHaveBeenCalledWith('m1');
    expect(useAppStore.getState().activeChannelId).toBe('c1');
  });
});

describe('첫 진입의 WS 티켓', () => {
  it('티켓을 첫 묶음과 함께 받고, 첫 연결에만 쓴다', async () => {
    const meGate = deferred<Awaited<ReturnType<ReturnType<typeof fakeApi>['me']>>>();
    const base = fakeApi();
    const me = vi.fn(() => meGate.promise);
    const wsTicket = vi.fn(async () => `t${wsTicket.mock.calls.length}`);
    let getTicket: TicketProvider | null = null;
    const makeWs = ((_u: string, gt: TicketProvider) => {
      getTicket = gt;
      return { close: vi.fn(), send: vi.fn() };
    }) as unknown as ConstructorParameters<typeof Controller>[1];
    const c = new Controller(fakeApi({ me, wsTicket }), makeWs);

    const started = c.start();
    // 첫 묶음(me)이 아직 서 있는데 티켓은 이미 나가 있다.
    await vi.waitFor(() => expect(wsTicket).toHaveBeenCalledTimes(1));
    meGate.resolve(await base.me());
    await started;

    expect(await getTicket!()).toBe('t1'); // 미리 받은 것
    expect(wsTicket).toHaveBeenCalledTimes(1);
    expect(await getTicket!()).toBe('t2'); // 다시 붙을 때는 새로 받는다(1회용)
    expect(wsTicket).toHaveBeenCalledTimes(2);
  });
});
