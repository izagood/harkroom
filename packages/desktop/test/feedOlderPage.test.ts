/**
 * **답글뿐인 구간에서도 옛 페이지가 본문 줄을 데려온다**(스레드 36caac7a, 안 B).
 *
 * 채널 옛 페이지는 답글까지 섞어 limit 을 채웠다. 긴 스레드가 있는 채널은 그 구간의 페이지가 답글뿐이라
 * 화면(`ChannelPane` 의 `roots`)에 늘어나는 줄이 없고, 다음 페이지를 부르는 계기는 스크롤 이벤트뿐이라
 * 맨 위에서 멈췄다. 이제 뒤채움·`loadOlder` 는 `feed` 로 **본문에 서는 줄만** 받는다.
 *
 * 가짜 서버는 서버의 `listMessages`·`hasMore` 와 같은 규칙으로 답한다(`feed` 를 모르는 옛 서버도 흉내 낸다).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import { fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

beforeEach(() => useAppStore.getState().reset());

/**
 * 답글뿐인 구간이 **둘** 있는 채널: 머리 1..1000 · 스레드 T1(머리 1001, 답글 1002..2000, 1500 은 alsoInChannel) ·
 * 머리 2001..2450 · 스레드 T2(머리 2451, 답글 2452..3450) · 머리 3451..3500. 첫 창(50) 아래는 T2 의 답글이고,
 * 뒤채움(450) 아래는 T1 의 답글이다 — 뒤채움과 `loadOlder` 가 각각 답글 구간을 만난다.
 */
const threadOf = (seq: number): string | null =>
  seq >= 1002 && seq <= 2000 ? 'm1001' : seq >= 2452 && seq <= 3450 ? 'm2451' : null;
const CHANNEL: MessageRow[] = Array.from({ length: 3500 }, (_, i) => {
  const seq = i + 1;
  const root = threadOf(seq);
  return msg(`m${seq}`, 'c1', seq, `글 ${seq}`, 'u2', root ? { threadRootId: root, alsoInChannel: seq === 1500 } : {});
});
const inFeed = (m: MessageRow) => m.threadRootId === null || m.alsoInChannel;

type Opts = { since?: number; before?: number; limit?: number; feed?: boolean };
/** 서버의 채널 목록 규칙. `knowsFeed` 가 거짓이면 옛 서버처럼 `feed` 를 버린다. */
const server = (knowsFeed: boolean) => async (_c: string, o: Opts = {}) => {
  const limit = o.limit ?? 200;
  const feed = knowsFeed && !!o.feed;
  if (o.before !== undefined) {
    const pool = CHANNEL.filter((m) => m.seq < o.before! && (!feed || inFeed(m)));
    const messages = pool.slice(-limit);
    const oldest = messages[0]?.seq;
    const hasMore = oldest !== undefined && CHANNEL.some((m) => m.seq < oldest && (!feed || inFeed(m)));
    return { messages, hasMore };
  }
  const messages = CHANNEL.slice(-limit);
  return { messages, hasMore: true };
};

const feedRoots = () => (useAppStore.getState().messages.c1 ?? []).filter(inFeed).length;

describe('채널 옛 페이지는 본문에 서는 줄로 센다(feed)', () => {
  it('최신 창 아래가 답글뿐이어도 뒤채움과 loadOlder 가 매번 본문 줄을 늘린다', async () => {
    const c = new Controller(fakeApi({ messages: server(true) as never }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    // 첫 창(50행)은 3451..3500 의 머리다. 뒤채움은 그 아래 **본문 줄** 450 개를 데려온다 — T2 답글 450 행이 아니라.
    await expect.poll(feedRoots).toBe(50 + 450);
    expect(useAppStore.getState().hasMore.c1).toBe(true);

    // 그 아래는 T1 의 답글 구간이다 — 피드 페이지는 그것을 건너 본문 줄 200 개씩을 데려온다.
    const before = feedRoots();
    await c.loadOlder('c1');
    expect(feedRoots()).toBe(before + 200);
    await c.loadOlder('c1');
    expect(feedRoots()).toBe(before + 400);
  });

  it('본문에 설 줄이 끝나면 답글이 더 남았어도 hasMore 가 거짓이 된다', async () => {
    const c = new Controller(fakeApi({ messages: server(true) as never }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    await expect.poll(feedRoots).toBe(500);
    for (let i = 0; i < 10 && useAppStore.getState().hasMore.c1; i += 1) await c.loadOlder('c1');
    // 머리 1..1000 + T1 머리 + alsoInChannel 답글 하나 + 2001..2450 + T2 머리 + 3451..3500.
    expect(feedRoots()).toBe(1000 + 1 + 1 + 450 + 1 + 50);
    expect(useAppStore.getState().hasMore.c1).toBe(false);
  });

  it('feed 를 모르는 옛 서버에서는 지금 페이지 그대로다(본문 줄이 안 늘 수 있다)', async () => {
    const c = new Controller(fakeApi({ messages: server(false) as never }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    await expect.poll(() => useAppStore.getState().messages.c1?.length).toBe(500);
    // 첫 창 아래 450 행은 T2 의 답글이다 — 본문 줄이 하나도 늘지 않았다.
    expect(feedRoots()).toBe(50);
    await c.loadOlder('c1');
    // 다음 200 행도 답글이다. 화면에 늘어나는 줄이 없으니 스크롤 이벤트도 없다 — 이것이 멈춤의 모양이다.
    expect(feedRoots()).toBe(50);
    expect(useAppStore.getState().messages.c1).toHaveLength(700);
  });
});
