/**
 * 첫 창 나눠 받기(2026-10-06, jaebin: "보이는 채팅은 몇 개 안 되는데 왜 500개나 받아?").
 *
 * 첫 화면은 `FIRST_PAGE_LIMIT` 행만 받아 바로 그리고, 그 아래를 `INITIAL_HISTORY_LIMIT` 까지 뒤에서
 * 채운다. 붙잡는 규율:
 *  - 첫 페이지가 스토어에 들어간 시점에 뒤채움은 아직 오지 않아도 된다(기다리지 않는다).
 *  - 뒤채움은 받은 구간(coverage)과 `hasMore` 를 `loadOlder` 와 같은 모양으로 적는다.
 *  - 뒤채움 중 맨 위에 닿아도(`loadOlder`) 같은 구간을 두 번 묻지 않는다.
 *  - 뒤채움이 실패하면 `hasMore` 는 참으로 남아 사람이 위로 올리면 다시 물을 수 있다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, FIRST_PAGE_LIMIT, INITIAL_HISTORY_LIMIT } from '../src/state/controller';
import { fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

beforeEach(() => useAppStore.getState().reset());

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

type Page = { messages: ReturnType<typeof msg>[]; hasMore: boolean };
const rows = (lo: number, hi: number) =>
  Array.from({ length: hi - lo + 1 }, (_, i) => msg(`m${lo + i}`, 'c1', lo + i, `글 ${lo + i}`, 'u2'));

describe('첫 창 나눠 받기', () => {
  it('첫 페이지는 뒤채움을 기다리지 않고 들어가고, 뒤채움이 그 아래를 첫 창까지 채운다', async () => {
    const back = deferred<Page>();
    const messages = vi.fn((_c: string, o?: { since?: number; before?: number }) =>
      (o?.before !== undefined ? back.promise : Promise.resolve({ messages: rows(951, 1000), hasMore: true })));
    const c = new Controller(fakeApi({ messages: messages as never }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');

    expect(useAppStore.getState().messages.c1).toHaveLength(FIRST_PAGE_LIMIT);
    expect(messages).toHaveBeenCalledWith('c1', { before: 951, limit: INITIAL_HISTORY_LIMIT - FIRST_PAGE_LIMIT });

    back.resolve({ messages: rows(501, 950), hasMore: true });
    await vi.waitFor(() => expect(useAppStore.getState().messages.c1).toHaveLength(INITIAL_HISTORY_LIMIT));
    expect(useAppStore.getState().hasMore.c1).toBe(true);
  });

  it('뒤채움 중 맨 위에 닿아도 같은 구간을 다시 묻지 않는다', async () => {
    const back = deferred<Page>();
    const messages = vi.fn((_c: string, o?: { before?: number }) =>
      (o?.before !== undefined ? back.promise : Promise.resolve({ messages: rows(951, 1000), hasMore: true })));
    const c = new Controller(fakeApi({ messages: messages as never }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    const older = c.loadOlder('c1');
    back.resolve({ messages: rows(501, 950), hasMore: false });
    await older;
    const befores = (messages.mock.calls as unknown as Array<[string, { before?: number }]>).filter(([, o]) => o?.before !== undefined);
    expect(befores).toHaveLength(1);
    expect(useAppStore.getState().hasMore.c1).toBe(false);
  });

  it('뒤채움이 실패하면 과거로 가는 길(hasMore)은 남고, loadOlder 가 다시 묻는다', async () => {
    let first = true;
    const messages = vi.fn(async (_c: string, o?: { before?: number }) => {
      if (o?.before === undefined) return { messages: rows(951, 1000), hasMore: true };
      if (first) { first = false; throw new Error('network'); }
      return { messages: rows(501, 950), hasMore: false };
    });
    const c = new Controller(fakeApi({ messages: messages as never }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    await new Promise((r) => setTimeout(r, 0));
    expect(useAppStore.getState().hasMore.c1).toBe(true);
    await c.loadOlder('c1');
    expect(useAppStore.getState().messages.c1).toHaveLength(INITIAL_HISTORY_LIMIT);
  });

  it('첫 페이지가 과거 끝까지 담았으면(hasMore false) 뒤채움을 내지 않는다', async () => {
    const messages = vi.fn(async () => ({ messages: rows(1, 10), hasMore: false }));
    const c = new Controller(fakeApi({ messages }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    expect(messages).toHaveBeenCalledTimes(1);
  });
});
