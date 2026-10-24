import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readAskMeta } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import { ApiError } from '../src/lib/api';
import { acc, chan, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

/**
 * **먼저 보낸 페이지가 나중에 바뀐 행을 덮지 않는다**(2026-10-24).
 *
 * 사고: 링크로 스레드를 열면 그 스레드 페이지를 묻는다. 그 조회가 5.3초 걸리는 사이 사람이 카드에 답했고
 * (200, 소켓 `message.updated` 도 옴), 답 1초 뒤에 도착한 페이지 — 답하기 **전** 스냅숏 — 가 답 적힌 행을
 * 옛것으로 덮어 카드가 다시 열렸다. 다시 눌러도 409 만 돌아와 새로고침 전까지 열린 채였다.
 */
const ask = (answered: boolean) => ({
  kind: 'ask',
  ask: {
    to: { kind: 'human' }, options: [{ id: 'merge', label: 'merge' }, { id: 'hold', label: 'hold' }],
    ...(answered ? { answeredAt: '2026-10-24T01:16:11Z', answeredBy: 'u1', answeredWith: 'merge' } : {}),
  },
});

const root = msg('root', 'c1', 1, 'root', 'u2');
const openCard = { ...msg('card', 'c1', 3, 'card', 'u2', { threadRootId: 'root' }), meta: ask(false) } as never;
const answeredCard = { ...(openCard as object), meta: ask(true) } as never;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function app(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({ channels: vi.fn(async () => [chan('c1', 'task')]), ...over });
  const { makeWs, callbacks } = fakeWsFactory();
  const c = new Controller(api, makeWs);
  await c.start();
  useAppStore.getState().set({ me: acc('u1', 'alice'), messages: { c1: [root, openCard] }, activeChannelId: 'c1' });
  return { api, c, callbacks };
}

const card = () => (useAppStore.getState().messages.c1 ?? []).find((m) => m.id === 'card');
const answer = () => (card() ? readAskMeta(card()!.meta)?.answeredWith ?? null : null);

beforeEach(() => useAppStore.getState().reset());

describe('늦게 온 페이지', () => {
  it('답하기 전에 보낸 스레드 페이지가 답 뒤에 와도 카드는 답한 채로 남는다', async () => {
    const page = deferred<{ messages: never[]; hasMore: boolean }>();
    const { c, callbacks } = await app({
      messages: vi.fn(async (_c: string, q?: { thread?: string }) => (q?.thread ? page.promise : { messages: [], hasMore: false })) as never,
      answerAsk: vi.fn(async () => answeredCard) as never,
    });
    const opening = c.openThread('root', { channelId: 'c1' });
    await c.answerAsk('card', 'merge', 'c1');
    callbacks.current!.onEvent({ type: 'message.updated', message: answeredCard, audience: 'all' } as never);
    expect(answer()).toBe('merge');

    page.resolve({ messages: [root, openCard] as never[], hasMore: false });
    await opening;
    expect(answer()).toBe('merge');
  });

  it('소켓으로만 답이 와도 같다 — 버튼을 누른 쪽이 다른 기기여도', async () => {
    const page = deferred<{ messages: never[]; hasMore: boolean }>();
    const { c, callbacks } = await app({
      messages: vi.fn(async (_c: string, q?: { thread?: string }) => (q?.thread ? page.promise : { messages: [], hasMore: false })) as never,
    });
    const opening = c.openThread('root', { channelId: 'c1' });
    callbacks.current!.onEvent({ type: 'message.updated', message: answeredCard, audience: 'all' } as never);
    page.resolve({ messages: [root, openCard] as never[], hasMore: false });
    await opening;
    expect(answer()).toBe('merge');
  });

  it('실시간 갱신 **뒤에** 보낸 페이지는 그대로 넣는다 — 막는 것은 먼저 보낸 것뿐이다', async () => {
    const later = { ...(answeredCard as object), body: 'edited later' } as never;
    const { c, callbacks } = await app({
      messages: vi.fn(async (_c: string, q?: { thread?: string }) => (q?.thread ? { messages: [root, later], hasMore: false } : { messages: [], hasMore: false })) as never,
    });
    callbacks.current!.onEvent({ type: 'message.updated', message: answeredCard, audience: 'all' } as never);
    await c.openThread('root', { channelId: 'c1' });
    expect(card()!.body).toBe('edited later');
  });

  it('지우기 전에 보낸 페이지가 늦게 와도 지운 줄을 되살리지 않는다', async () => {
    const page = deferred<{ messages: never[]; hasMore: boolean }>();
    const { c, callbacks } = await app({
      messages: vi.fn(async (_c: string, q?: { thread?: string }) => (q?.thread ? page.promise : { messages: [], hasMore: false })) as never,
    });
    const opening = c.openThread('root', { channelId: 'c1' });
    callbacks.current!.onEvent({ type: 'message.deleted', channelId: 'c1', messageId: 'card' } as never);
    page.resolve({ messages: [root, openCard] as never[], hasMore: false });
    await opening;
    expect(card()).toBeUndefined();
  });

  it('답 뒤에 늦게 온 페이지라도 건드리지 않은 다른 줄은 넣는다', async () => {
    const page = deferred<{ messages: never[]; hasMore: boolean }>();
    const other = msg('other', 'c1', 2, 'older reply', 'u2', { threadRootId: 'root' });
    const { c, callbacks } = await app({
      messages: vi.fn(async (_c: string, q?: { thread?: string }) => (q?.thread ? page.promise : { messages: [], hasMore: false })) as never,
    });
    const opening = c.openThread('root', { channelId: 'c1' });
    callbacks.current!.onEvent({ type: 'message.updated', message: answeredCard, audience: 'all' } as never);
    page.resolve({ messages: [root, other, openCard] as never[], hasMore: false });
    await opening;
    expect((useAppStore.getState().messages.c1 ?? []).map((m) => m.id)).toEqual(['root', 'other', 'card']);
    expect(answer()).toBe('merge');
  });
});

describe('409(이미 정해짐)', () => {
  it('답하기가 409 면 그 카드를 다시 받아 맞춘다', async () => {
    const { c, api } = await app({
      answerAsk: vi.fn(async () => { throw new ApiError(409, 'already_answered', 'this choice is already answered'); }) as never,
      message: vi.fn(async () => answeredCard) as never,
    });
    await c.answerAsk('card', 'hold', 'c1');
    expect(api.message).toHaveBeenCalledWith('card');
    expect(answer()).toBe('merge');
  });

  it('답하지 않기도 409 면 다시 받는다', async () => {
    const { c, api } = await app({
      closeAsk: vi.fn(async () => { throw new ApiError(409, 'already_answered', 'this choice is already answered'); }) as never,
      message: vi.fn(async () => answeredCard) as never,
    });
    await c.closeAsk('card', 'c1');
    expect(api.message).toHaveBeenCalledWith('card');
    expect(answer()).toBe('merge');
  });

  it('409 가 아닌 거절(403)은 다시 받지 않는다', async () => {
    const { c, api } = await app({
      answerAsk: vi.fn(async () => { throw new ApiError(403, 'forbidden', 'no'); }) as never,
      message: vi.fn(async () => answeredCard) as never,
    });
    await c.answerAsk('card', 'merge', 'c1');
    expect(api.message).not.toHaveBeenCalled();
    expect(answer()).toBeNull();
  });
});

describe('건너뛴 줄의 스레드 재료', () => {
  it('실시간으로 바뀐 루트도 비어 있는 재료(답글 수 등)는 늦게 온 페이지에서 채운다', async () => {
    const page = deferred<{ messages: never[]; hasMore: boolean }>();
    const { c, callbacks } = await app({
      messages: vi.fn(async () => page.promise) as never,
    });
    useAppStore.getState().set({ messages: {} });
    const loading = c.openChannel('c1');
    const live = { ...msg('r9', 'c1', 9, 'edited', 'u2'), replyCount: null } as never;
    callbacks.current!.onEvent({ type: 'message.created', message: live, audience: 'all' } as never);
    page.resolve({ messages: [{ ...msg('r9', 'c1', 9, 'old body', 'u2'), replyCount: 4, openAskHumanCount: 1 }] as never[], hasMore: false });
    await loading;
    const row = (useAppStore.getState().messages.c1 ?? []).find((m) => m.id === 'r9')!;
    expect(row.body).toBe('edited');
    expect(row.replyCount).toBe(4);
  });
});
