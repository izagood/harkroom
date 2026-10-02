// 배지 A(2026-10-02 jaebin) — 사이드바·레일·독 배지의 숫자는 **보드의 "내 차례" 수**다.
//
// 컨트롤러가 보드와 같은 재료(`GET /inbox?threads=1`)·같은 판정(`buildBoard` → `mineCount`)으로
// `inboxMine` 을 채운다. 여기서는 그 수가 보드 머리글과 같은지, 나중에로 미루면 줄고 새 말이 오면
// 다시 느는지, 미룬 시각이 지나면 서버 신호 없이도 다시 느는지를 잰다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { InboxEntry, InboxThreadState, MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import { buildBoard, mineCount } from '../src/lib/inboxBoard';
import { fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

beforeEach(() => useAppStore.getState().reset());
afterEach(() => vi.useRealTimers());

const ME = 'u1';
const HOUR = 3_600_000;
const entry = (id: number, root: string, createdAt: string): InboxEntry => ({
  id, messageId: `m${id}`, reason: 'mention', readAt: null, channelId: 'c1', authorId: 'u2',
  body: '봐 줘', meta: {}, createdAt, threadRootId: root,
});
/** 나에게 열린 물음이 있는 머리 — 내 차례 카드 하나. */
const head = (id: string): MessageRow => msg(id, 'c1', 1, '머리', 'u2', {
  replyCount: 1, openAskHumanCount: 0, openAskAccountIds: [ME], openAskLinks: [], unresolvedFailureCount: 0,
  failureCount: 0, lastKind: 'user', lastAuthorId: 'u2',
});

type Board = { entries: InboxEntry[]; threads: MessageRow[]; threadStates: InboxThreadState[] };

async function boot(board: () => Board) {
  const api = fakeApi({ inboxBoard: vi.fn(async () => board()) });
  const { makeWs, callbacks } = fakeWsFactory();
  const c = new Controller(api, makeWs);
  await c.start();
  await vi.waitFor(() => expect(api.inboxBoard).toHaveBeenCalled());
  const changed = async (): Promise<void> => {
    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: ME });
  };
  return { c, api, changed, callbacks };
}

describe('배지 = 보드의 내 차례 수', () => {
  it('보드 머리글과 같은 함수로 같은 수를 낸다', async () => {
    const t0 = new Date(Date.now() - HOUR).toISOString();
    const data: Board = { entries: [entry(1, 'r1', t0), entry(2, 'r2', t0), entry(3, 'r2', t0)], threads: [head('r1'), head('r2')], threadStates: [] };
    await boot(() => data);
    const expected = mineCount(buildBoard({
      ...data, me: { id: ME, kind: 'human' }, isAgent: () => false, nowMs: Date.now(),
    }));
    expect(expected).toBe(2);
    await vi.waitFor(() => expect(useAppStore.getState().inboxMine).toBe(expected));
  });

  it('나중에로 미루면 줄고, 그 뒤 나에게 새 말이 오면 다시 는다', async () => {
    const t0 = new Date(Date.now() - HOUR).toISOString();
    let data: Board = { entries: [entry(1, 'r1', t0)], threads: [head('r1')], threadStates: [] };
    const { changed } = await boot(() => data);
    await vi.waitFor(() => expect(useAppStore.getState().inboxMine).toBe(1));

    // 미룸 — 서버가 내 계정에 inbox.updated 를 보낸다(#1035).
    const later: InboxThreadState = { rootId: 'r1', state: 'later', until: new Date(Date.now() + 10 * HOUR).toISOString(), updatedAt: new Date().toISOString() };
    data = { ...data, threadStates: [later] };
    await changed();
    await vi.waitFor(() => expect(useAppStore.getState().inboxMine).toBe(0));

    // 미룬 뒤에 새 부름이 온다.
    data = { ...data, entries: [entry(2, 'r1', new Date(Date.now() + 1000).toISOString()), ...data.entries] };
    await changed();
    await vi.waitFor(() => expect(useAppStore.getState().inboxMine).toBe(1));
  });

  it('미룬 시각이 지나면 서버 신호 없이도 다시 는다(1분마다 다시 센다)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t0 = new Date(Date.now() - HOUR).toISOString();
    const until = new Date(Date.now() + 90_000).toISOString();
    const data: Board = {
      entries: [entry(1, 'r1', t0)], threads: [head('r1')],
      threadStates: [{ rootId: 'r1', state: 'later', until, updatedAt: new Date().toISOString() }],
    };
    const { api } = await boot(() => data);
    await vi.waitFor(() => expect(api.inboxBoard).toHaveBeenCalledTimes(1));
    expect(useAppStore.getState().inboxMine).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(useAppStore.getState().inboxMine).toBe(1);
    // 왕복 없이 센 것이다.
    expect(api.inboxBoard).toHaveBeenCalledTimes(1);
  });

  it('조회가 실패하면 앞선 수를 0 으로 지우지 않는다', async () => {
    const t0 = new Date(Date.now() - HOUR).toISOString();
    let fail = false;
    const { changed } = await boot(() => {
      if (fail) throw new Error('down');
      return { entries: [entry(1, 'r1', t0)], threads: [head('r1')], threadStates: [] };
    });
    await vi.waitFor(() => expect(useAppStore.getState().inboxMine).toBe(1));
    fail = true;
    await changed();
    await new Promise((r) => setTimeout(r, 20));
    expect(useAppStore.getState().inboxMine).toBe(1);
  });
});

describe('보드와 배지가 조회 하나를 나눈다 (#1076 후속)', () => {
  it('신호 하나에 조회 하나 — 보드는 그 재료를 받아 그린다(inboxBoardRevision)', async () => {
    const t0 = new Date(Date.now() - HOUR).toISOString();
    const data: Board = { entries: [entry(1, 'r1', t0)], threads: [head('r1')], threadStates: [] };
    const { c, api, changed } = await boot(() => data);
    await vi.waitFor(() => expect(useAppStore.getState().inboxBoardRevision).toBe(1));
    const before = (api.inboxBoard as ReturnType<typeof vi.fn>).mock.calls.length;
    await changed();
    await vi.waitFor(() => expect(useAppStore.getState().inboxBoardRevision).toBe(2));
    expect((api.inboxBoard as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1);
    expect(c.inboxBoardSnapshot()).toEqual(data);
  });

  it('도는 중에 또 부르면 같은 약속을 받고, 끝난 뒤 한 번 더 받아 새 재료로 풀린다', async () => {
    const t0 = new Date(Date.now() - HOUR).toISOString();
    let n = 0;
    let release: (() => void) | null = null;
    const { c, api } = await boot(() => ({ entries: [entry(++n, 'r1', t0)], threads: [head('r1')], threadStates: [] }));
    await vi.waitFor(() => expect(useAppStore.getState().inboxBoardRevision).toBe(1));
    const fn = api.inboxBoard as ReturnType<typeof vi.fn>;
    const calls = fn.mock.calls.length;
    const original = fn.getMockImplementation()!;
    fn.mockImplementationOnce(async () => { await new Promise<void>((r) => { release = r; }); return original(); });
    const first = c.loadInboxBoard();
    const second = c.loadInboxBoard();
    expect(second).toBe(first);
    release!();
    const got = await second;
    // 처음 것 + 도는 동안 부른 것의 뒤따름 하나 = 둘. 셋째는 없다.
    expect(fn.mock.calls.length).toBe(calls + 2);
    expect(got.entries[0]!.id).toBe(n);
  });

  it('보드가 열면서 부르면 배지도 그 순간 보드와 맞춰진다', async () => {
    const t0 = new Date(Date.now() - HOUR).toISOString();
    let data: Board = { entries: [entry(1, 'r1', t0)], threads: [head('r1')], threadStates: [] };
    const { c } = await boot(() => data);
    await vi.waitFor(() => expect(useAppStore.getState().inboxMine).toBe(1));
    // 신호 없이 상태가 바뀌었다(예: 남이 내게 온 물음을 닫음) — 배지는 아직 1.
    data = { ...data, threads: [{ ...head('r1'), openAskAccountIds: [] }] };
    expect(useAppStore.getState().inboxMine).toBe(1);
    await c.loadInboxBoard();
    expect(useAppStore.getState().inboxMine).toBe(0);
  });
});
