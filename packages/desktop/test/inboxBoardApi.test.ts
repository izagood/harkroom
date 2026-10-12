// 「내 작업」 보드 조회(2026-10-12, 서버 #1329) — 간추린 판(`compact=1`)을 받고, 들고 있는 판의 태그를
// `If-None-Match` 로 보내 그대로면 304 로 본문 없이 끝낸다. 디스크 캐시는 쓰지 않는다(no-store).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient, dropCutMention } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());

const BOARD = {
  entries: [
    { id: 1, messageId: 'm1', reason: 'mention', readAt: null, channelId: 'c', authorId: 'a', body: '해 줘 <@3f2a', meta: {}, createdAt: 't', threadRootId: null, bodyTruncated: true },
    { id: 2, messageId: 'm2', reason: 'mention', readAt: null, channelId: 'c', authorId: 'a', body: '온전한 <@abc>', meta: {}, createdAt: 't', threadRootId: null },
  ],
  threads: [{ id: 'm1', body: '머리 <@ab' }],
  threadStates: [],
  truncated: false,
};

function queue(...responses: (() => Response)[]) {
  const fn = vi.fn(async () => responses.shift()!());
  vi.stubGlobal('fetch', fn);
  return fn;
}
const ok = (etag: string | null) => () => new Response(JSON.stringify(BOARD), {
  status: 200, headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) },
});
const notModified = () => new Response(null, { status: 304 });
const call = (fn: ReturnType<typeof queue>, i: number) => fn.mock.calls[i]! as unknown as [string, RequestInit];

describe('ApiClient.inboxBoard', () => {
  it('간추린 판을 디스크 캐시 없이 받고, 그대로면 304 로 들고 있던 판을 돌려준다', async () => {
    const fn = queue(ok('"t1"'), notModified, ok('"t2"'));
    const api = new ApiClient('http://x:3400', 'tok');

    const first = await api.inboxBoard();
    const [url, init] = call(fn, 0);
    expect(url).toBe('http://x:3400/inbox/board?compact=1');
    expect(init.cache).toBe('no-store');
    expect((init.headers as Record<string, string>)['if-none-match']).toBeUndefined();

    const second = await api.inboxBoard();
    expect((call(fn, 1)[1].headers as Record<string, string>)['if-none-match']).toBe('"t1"');
    expect(second).toBe(first); // 같은 판 — 컨트롤러가 다시 그리지 않는다

    const third = await api.inboxBoard();
    expect((call(fn, 2)[1].headers as Record<string, string>)['if-none-match']).toBe('"t1"');
    expect(third).not.toBe(first);
    await api.inboxBoard().catch(() => {}); // 큐가 비어 던져도 상관없다 — 태그만 본다
    expect((call(fn, 3)[1].headers as Record<string, string>)['if-none-match']).toBe('"t2"');
  });

  it('계정(토큰)이 바뀌면 앞 판의 태그를 보내지 않는다', async () => {
    const fn = queue(ok('"t1"'), ok('"t9"'));
    const api = new ApiClient('http://x:3400', 'tok-a');
    await api.inboxBoard();
    api.setToken('tok-b');
    await api.inboxBoard();
    expect((call(fn, 1)[1].headers as Record<string, string>)['if-none-match']).toBeUndefined();
  });

  it('옛 서버(태그 없음)에는 조건부로 묻지 않는다', async () => {
    const fn = queue(ok(null), ok(null));
    const api = new ApiClient('http://x:3400', 'tok');
    await api.inboxBoard();
    await api.inboxBoard();
    expect((call(fn, 1)[1].headers as Record<string, string>)['if-none-match']).toBeUndefined();
  });

  it('잘린 본문 끝의 반쪽 멘션 토큰을 떼고, 온전한 본문은 그대로 둔다', async () => {
    queue(ok('"t1"'));
    const data = await new ApiClient('http://x:3400', 'tok').inboxBoard();
    expect(data.entries[0]!.body).toBe('해 줘 ');
    expect(data.entries[1]!.body).toBe('온전한 <@abc>');
    expect(data.threads![0]!.body).toBe('머리 ');
    expect(dropCutMention('끝 <@')).toBe('끝 ');
    expect(dropCutMention('<@a> 안 잘림')).toBe('<@a> 안 잘림');
  });
});
