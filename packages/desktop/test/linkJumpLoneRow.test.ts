import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import { fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';
import type { MessageRow } from '@harkroom/shared';

beforeEach(() => useAppStore.getState().reset());

/**
 * 메시지 링크(`harkroom://message/<id>`) 이동이 **외톨이 줄**로 가던 결함(jaebin 보고, 2026-10-06).
 *
 * 스토어의 채널 목록에는 이웃 없이 홀로 선 줄이 생긴다 — 인박스에서 스레드를 열면 `openThread` 가
 * 뿌리를 채널 목록에 넣고(최신 페이지 밖의 옛 뿌리면 앞뒤가 없다), 소켓으로 온 글도 열어 본 적 없는
 * 채널에는 홀로 쌓인다. `openMessage` 가 그것을 "이미 실려 있다"로 읽으면 around 창을 안 받아
 * 그 줄이 목록 **맨 위**에 서고, 거기서 `loadOlder` 가 바로 돌아 과거가 앞에 붙으면서 화면이 되끌려
 * 갔다(실브라우저 탐침). 판정은 "스토어에 있는가"가 아니라 **"그 이웃을 받아 왔는가"** 여야 한다.
 */
describe('링크 이동 — 외톨이 줄은 이웃을 받아 온다', () => {
  const latest = Array.from({ length: 10 }, (_, i) => msg(`m${1001 + i}`, 'c1', 1001 + i, `최신 ${i}`, 'u2'));
  const old = msg('m300', 'c1', 300, '옛 뿌리', 'u2', { replyCount: 1 });
  const reply = msg('r1', 'c1', 1700, '답글', 'u2', { threadRootId: 'm300' });
  const window = [msg('m299', 'c1', 299, '앞', 'u2'), old, msg('m301', 'c1', 301, '뒤', 'u2')];

  const makeApi = () => {
    const messages = vi.fn(async (_id: string, o?: { since?: number; around?: number; thread?: string; before?: number }) => {
      if (o?.thread === 'm300') return { messages: [old, reply], hasMore: false };
      // 서버는 around 창의 hasMore 를 늘 false 로 준다 — 과거를 말할 자격이 없는 조회다.
      if (o?.around === 300) return { messages: window, hasMore: false };
      if (o?.since === 0) return { messages: latest, hasMore: true };
      return { messages: [], hasMore: false };
    });
    return { messages, api: fakeApi({ messages, message: vi.fn(async () => old) }) };
  };

  it('인박스로 연 스레드의 뿌리(채널 목록에 홀로 선 줄)로 링크를 따라가면 around 창을 받는다', async () => {
    const { messages, api } = makeApi();
    const c = new Controller(api, fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    // 인박스에서 스레드를 연 것과 같다 — 뿌리 m300 이 채널 목록에 홀로 들어간다.
    await c.openThread('m300', { channelId: 'c1' });
    c.closeThread();
    expect(useAppStore.getState().messages.c1!.some((m) => m.id === 'm300')).toBe(true);

    await c.openMessage('m300');

    expect(messages.mock.calls.some(([, o]) => o?.around === 300)).toBe(true);
    const ids = useAppStore.getState().messages.c1!.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['m299', 'm300', 'm301']));
    expect(useAppStore.getState().highlightedMessageId).toBe('m300');
  });

  it('around 창의 hasMore(늘 false)로 채널의 "과거가 더 있다"를 덮지 않는다', async () => {
    const { api } = makeApi();
    const c = new Controller(api, fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    expect(useAppStore.getState().hasMore.c1).toBe(true);

    await c.openMessage('m300');

    // 점프 뒤에도 위로 올리면 과거가 이어져야 한다.
    expect(useAppStore.getState().hasMore.c1).toBe(true);
  });

  it('열어 본 적 없는 채널에 소켓으로만 쌓인 글도 이웃을 받는다', async () => {
    const { messages, api } = makeApi();
    const c = new Controller(api, fakeWsFactory().makeWs);
    await c.start();
    // 앱이 켜져 있는 동안 소켓으로 온 글 — 채널은 아직 열지 않았다.
    useAppStore.getState().upsertMessages('c1', [old]);

    await c.openMessage('m300');

    expect(messages.mock.calls.some(([, o]) => o?.around === 300)).toBe(true);
    expect(useAppStore.getState().messages.c1!.map((m) => m.id)).toContain('m299');
  });

  it('최신 페이지 안의 글에는 여전히 창을 받지 않는다(쓸데없는 왕복 금지)', async () => {
    const { messages, api } = makeApi();
    const c = new Controller(api, fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');

    await c.openMessage('m1005');

    expect(messages.mock.calls.every(([, o]) => o?.around === undefined)).toBe(true);
    expect(useAppStore.getState().highlightedMessageId).toBe('m1005');
  });
});

/**
 * 받아 온 구간은 **채널 전환·재연결을 지나서도** 참이어야 한다(task_manager·security n1, 2026-10-06).
 * 구간은 채널별로 남는 것이 맞다(옮겼다 돌아와도 이웃은 그대로 있다). 재연결은 다르다 — 서버의 증분
 * 조회는 `order by seq limit 200` 이라 끊긴 사이에 그보다 많이 쌓이면 한 번으로는 뒤가 잘리고, 열린
 * 구간이 그 틈을 "받았다"고 거짓말하게 된다. 그래서 증분은 꽉 찬 페이지가 올 때마다 끝까지 받는다.
 */
describe('받아 온 구간 — 채널 전환·재연결', () => {
  const rows = (lo: number, hi: number, ch = 'c1'): MessageRow[] =>
    Array.from({ length: hi - lo + 1 }, (_, i) => msg(`${ch}-m${lo + i}`, ch, lo + i, `글 ${lo + i}`, 'u2'));
  const PAGE = 200;

  /** 채널의 전체 글을 들고 서버처럼 답한다 — since 는 seq 오름차순 limit 개, around 는 앞뒤 절반. */
  const serverLike = (all: Record<string, MessageRow[]>) => vi.fn(async (ch: string, o?: { since?: number; around?: number; limit?: number; before?: number; thread?: string }) => {
    const list = (all[ch] ?? []).slice().sort((a, b) => a.seq - b.seq);
    const limit = o?.limit ?? PAGE;
    if (o?.around !== undefined) {
      const half = Math.ceil(limit / 2);
      const up = list.filter((m) => m.seq <= o.around!).slice(-half);
      const dn = list.filter((m) => m.seq > o.around!).slice(0, half);
      return { messages: [...up, ...dn], hasMore: false };
    }
    if (o?.since !== undefined && o.since > 0) return { messages: list.filter((m) => m.seq > o.since!).slice(0, limit), hasMore: false };
    return { messages: list.slice(-limit), hasMore: list.length > limit };
  });

  it('재연결 때 끊긴 사이 글이 한 페이지(200)를 넘으면 끝까지 받아, 그 자리로 점프해도 틈이 없다', async () => {
    const all = { c1: rows(1, 1010) };
    const messages = serverLike(all);
    const api = fakeApi({ messages, message: vi.fn(async (id: string) => all.c1.find((m) => m.id === id)!) });
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    await c.openChannel('c1');
    expect(useAppStore.getState().messages.c1!.length).toBe(500);
    // 끊긴 사이에 450개가 쌓였다.
    all.c1 = rows(1, 1460);
    messages.mockClear();
    callbacks.current!.onOpen();
    await vi.waitFor(() => expect(useAppStore.getState().messages.c1!.some((m) => m.id === 'c1-m1460')).toBe(true));
    // 세 페이지(200·200·50)로 받았고, 사이가 비지 않았다.
    const since = messages.mock.calls.filter(([, o]) => o?.since !== undefined && o.since > 0).map(([, o]) => o!.since);
    expect(since).toEqual([1010, 1210, 1410]);
    const seqs = useAppStore.getState().messages.c1!.map((m) => m.seq);
    expect(seqs.length).toBe(1460 - 511 + 1);
    // 예전엔 두 번째 페이지가 없어 비던 자리 — 창 없이도 그 줄이 있고, 창을 또 받지 않는다.
    messages.mockClear();
    await c.openMessage('c1-m1300');
    expect(messages.mock.calls.some(([, o]) => o?.around !== undefined)).toBe(false);
    expect(useAppStore.getState().highlightedMessageId).toBe('c1-m1300');
  });

  it('채널을 옮겼다 돌아와도 구간은 채널별로 남는다 — 안의 글은 창 없이, 밖의 글은 창을 받는다', async () => {
    const all = { c1: rows(1, 1010), c2: rows(1, 30, 'c2') };
    const messages = serverLike(all);
    const api = fakeApi({ messages, message: vi.fn(async (id: string) => [...all.c1, ...all.c2].find((m) => m.id === id)!) });
    const c = new Controller(api, fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    await c.openChannel('c2');
    messages.mockClear();
    await c.openMessage('c1-m1005');
    expect(messages.mock.calls.some(([, o]) => o?.around !== undefined)).toBe(false);
    expect(useAppStore.getState().activeChannelId).toBe('c1');
    await c.openChannel('c2');
    messages.mockClear();
    await c.openMessage('c1-m300');
    expect(messages.mock.calls.some(([ch, o]) => ch === 'c1' && o?.around === 300)).toBe(true);
    expect(useAppStore.getState().messages.c1!.some((m) => m.id === 'c1-m299')).toBe(true);
  });
});
