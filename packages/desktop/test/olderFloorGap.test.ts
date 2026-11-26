/**
 * 이전 메시지의 아래 끝과 실패 표시(2026-11-26, 채널 본문에 열흘치 틈이 굳던 결함).
 *
 *  - 「이전 메시지」는 **최신 쪽에서 이어 받은 구간의 아래 끝**부터 묻는다. 스레드를 열 때 함께 실려 온
 *    옛 뿌리가 목록에 홀로 서 있어도 그 seq 아래를 묻지 않는다 — 그러면 최신 구간과 그 뿌리 사이를 끝내 안 받는다.
 *  - 뒤채움·이전 메시지 받기가 실패하면 `olderFailed` 가 서고, 다음 받기가 성공하면 걷힌다.
 *  - 새 창도 메인 창과 같은 모양(첫 페이지 + 본문 줄 뒤채움)으로 연다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, FIRST_PAGE_LIMIT, INITIAL_HISTORY_LIMIT, FEED_PAGE_LIMIT } from '../src/state/controller';
import { fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

beforeEach(() => useAppStore.getState().reset());

const rows = (lo: number, hi: number) =>
  Array.from({ length: hi - lo + 1 }, (_, i) => msg(`m${lo + i}`, 'c1', lo + i, `글 ${lo + i}`, 'u2'));
type Opts = { since?: number; before?: number; limit?: number; feed?: boolean };
const befores = (fn: ReturnType<typeof vi.fn>) =>
  (fn.mock.calls as unknown as Array<[string, Opts | undefined]>).map(([, o]) => o?.before).filter((b) => b !== undefined);

describe('이전 메시지의 아래 끝', () => {
  it('스레드로 들어온 옛 뿌리가 있어도 최신 구간의 아래 끝부터 묻는다', async () => {
    let fail = true;
    const messages = vi.fn(async (_c: string, o?: Opts) => {
      if (o?.before === undefined) return { messages: rows(951, 1000), hasMore: true };
      if (fail) { fail = false; throw new Error('timeout'); }
      return { messages: rows(900, 950), hasMore: true };
    });
    const c = new Controller(fakeApi({ messages: messages as never }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    await vi.waitFor(() => expect(useAppStore.getState().olderFailed.c1).toBe(true));
    // 옛 스레드를 열어 그 뿌리(seq 100)가 채널 목록에 들어왔다.
    useAppStore.getState().upsertMessages('c1', [msg('root100', 'c1', 100, '옛 스레드', 'u2')]);

    await c.loadOlder('c1');
    expect(befores(messages)).toEqual([951, 951]);
    expect(useAppStore.getState().olderFailed.c1).toBeUndefined();

    // 이어 받은 구간이 늘었으니 다음은 그 아래 끝에서 — 여전히 옛 뿌리가 아니다.
    await c.loadOlder('c1');
    expect(befores(messages)).toEqual([951, 951, 900]);
  });

  it('이전 메시지 받기가 실패해도 던지지 않고 실패를 적는다', async () => {
    let backfilled = false;
    const messages = vi.fn(async (_c: string, o?: Opts) => {
      if (o?.before === undefined) return { messages: rows(951, 1000), hasMore: true };
      if (!backfilled) { backfilled = true; return { messages: rows(501, 950), hasMore: true }; }
      throw new Error('timeout');
    });
    const c = new Controller(fakeApi({ messages: messages as never }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    await vi.waitFor(() => expect(useAppStore.getState().backfilling.c1).toBeUndefined());
    expect(useAppStore.getState().messages.c1).toHaveLength(INITIAL_HISTORY_LIMIT);
    expect(useAppStore.getState().olderFailed.c1).toBeUndefined();
    await expect(c.loadOlder('c1')).resolves.toBeUndefined();
    expect(useAppStore.getState().olderFailed.c1).toBe(true);
    expect(useAppStore.getState().hasMore.c1).toBe(true);
  });
});

describe('새 창 열기', () => {
  it('첫 페이지를 받고 본문 줄을 뒤에서 채운다', async () => {
    const messages = vi.fn(async (_c: string, o?: Opts) =>
      (o?.before === undefined ? { messages: rows(951, 1000), hasMore: true } : { messages: rows(501, 950), hasMore: true }));
    const c = new Controller(fakeApi({ messages: messages as never }), fakeWsFactory().makeWs);
    await c.start();
    await c.loadChannelForWindow('c1');
    expect(messages).toHaveBeenCalledWith('c1', { since: 0, limit: FIRST_PAGE_LIMIT });
    expect(messages).toHaveBeenCalledWith('c1', { before: 951, limit: FEED_PAGE_LIMIT, feed: true });
    await vi.waitFor(() => expect(useAppStore.getState().messages.c1).toHaveLength(INITIAL_HISTORY_LIMIT));
  });
});
