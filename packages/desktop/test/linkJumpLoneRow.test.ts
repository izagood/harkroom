import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import { fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

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
