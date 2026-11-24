// 다시 붙은 뒤 맞추기 — 끊긴 사이 **이미 받아 둔 줄**에 붙은 반응·답글 수가 화면에 오는지 잰다.
// 증분(`since`)은 새 줄만 주고 그 이벤트는 끊긴 소켓과 함께 지나갔으므로, 최신 페이지를 다시 받아야 온다.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import { fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';
import type { MessageRow } from '@harkroom/shared';

beforeEach(() => useAppStore.getState().reset());

type Opts = { since?: number; before?: number; thread?: string } | undefined;

/** 채널마다 줄을 들고 있는 가짜 서버. `since: 0` 은 최신 페이지, `since: n` 은 그 뒤의 새 줄만 준다. */
function fakeServer(rows: Record<string, MessageRow[]>) {
  const messages = vi.fn(async (channelId: string, opts?: Opts) => {
    const all = rows[channelId] ?? [];
    if (opts?.before !== undefined || opts?.thread) return { messages: [], hasMore: false };
    return { messages: all.filter((m) => m.seq > (opts?.since ?? 0)).map((m) => ({ ...m })), hasMore: false };
  });
  return { messages, rows };
}

const eyes = { emoji: '👀', accountIds: ['u2'] } as unknown as MessageRow['reactions'][number];

async function boot(server: ReturnType<typeof fakeServer>) {
  const { makeWs, callbacks } = fakeWsFactory();
  const c = new Controller(fakeApi({ messages: server.messages as never }), makeWs);
  await c.start();
  callbacks.current!.onOpen();
  await c.openChannel('c1');
  return { c, ws: callbacks.current! };
}

const row = (channelId: string, id: string) => useAppStore.getState().messages[channelId]!.find((m) => m.id === id)!;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('다시 붙은 뒤 맞추기 — 이미 받아 둔 줄의 반응·답글 수', () => {
  it('끊긴 사이 붙은 반응·답글 수가 다시 붙으면 열어 둔 채널에 실린다', async () => {
    const server = fakeServer({ c1: [msg('m1', 'c1', 1, '물음'), msg('m2', 'c1', 2, '다른 글')] });
    const { ws } = await boot(server);
    expect(row('c1', 'm1').reactions).toEqual([]);
    expect(row('c1', 'm1').replyCount).toBeNull();

    ws.onDown('network');
    // 끊긴 사이: m1 에 반응 하나와 답글 둘(답글은 새 줄이라 seq 가 뒤다).
    server.rows.c1 = [
      { ...server.rows.c1![0]!, reactions: [eyes], replyCount: 2, activityCount: 2 },
      server.rows.c1![1]!,
      msg('m3', 'c1', 3, '답 1', 'u2', { threadRootId: 'm1' }),
      msg('m4', 'c1', 4, '답 2', 'u2', { threadRootId: 'm1' }),
    ];
    ws.onOpen();
    await flush();

    expect(row('c1', 'm1').reactions).toEqual([eyes]);
    expect(row('c1', 'm1').replyCount).toBe(2);
    expect(useAppStore.getState().messages.c1!.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('이 세션의 첫 연결에서는 최신 페이지를 한 번 더 묻지 않는다', async () => {
    const server = fakeServer({ c1: [msg('m1', 'c1', 1, 'a')] });
    await boot(server);
    await flush();
    const firstPages = server.messages.mock.calls.filter(([, o]) => (o?.since ?? 0) === 0 && o?.before === undefined);
    expect(firstPages).toHaveLength(1);
  });

  it('보고 있지 않던 채널은 다시 열 때 한 번만 최신 페이지를 받는다', async () => {
    const server = fakeServer({
      c1: [msg('m1', 'c1', 1, 'a')],
      c2: [msg('n1', 'c2', 1, 'b')],
    });
    const { c, ws } = await boot(server);
    await c.openChannel('c2');
    await c.openChannel('c1');

    ws.onDown('network');
    server.rows.c2 = [{ ...server.rows.c2![0]!, reactions: [eyes] }];
    ws.onOpen();
    await flush();
    // 붙자마자 묻는 것은 보고 있는 채널뿐이다.
    expect(row('c2', 'n1').reactions).toEqual([]);

    await c.openChannel('c2');
    expect(row('c2', 'n1').reactions).toEqual([eyes]);

    const before = server.messages.mock.calls.length;
    await c.openChannel('c1');
    await c.openChannel('c2');
    const again = server.messages.mock.calls.slice(before).filter(([id, o]) => id === 'c2' && (o?.since ?? 0) === 0);
    expect(again).toHaveLength(0);
  });

  it('다시 받는 사이 실시간으로 바뀐 줄은 늦게 온 페이지가 덮지 않는다', async () => {
    const server = fakeServer({ c1: [msg('m1', 'c1', 1, '처음')] });
    const { ws } = await boot(server);
    ws.onDown('network');
    // 다시 붙은 뒤의 최신 페이지 응답을 붙잡아 둔다 — 그 사이 소켓으로 고침이 먼저 온다.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const stale = { messages: [{ ...server.rows.c1![0]! }], hasMore: false };
    server.messages.mockImplementation(async (_c: string, opts?: Opts) => {
      if ((opts?.since ?? 0) > 0) return { messages: [], hasMore: false };
      await held;
      return stale;
    });
    ws.onOpen();
    await flush();
    ws.onEvent({ type: 'message.updated', message: { ...server.rows.c1![0]!, body: '고친 뒤' }, audience: 'all' });
    release();
    await flush();
    expect(row('c1', 'm1').body).toBe('고친 뒤');
  });
});
