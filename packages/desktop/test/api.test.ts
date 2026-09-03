import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient, ApiError } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('ApiClient', () => {
  it('sends bearer token and parses success body', async () => {
    const fn = stubFetch(200, { channels: [{ id: 'c1', name: 'dev', topic: '', kind: 'standard', repo: null }] });
    const api = new ApiClient('http://x:3400', 'tok-1');
    const channels = await api.channels();
    expect(channels[0]!.name).toBe('dev');
    const [url, init] = fn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://x:3400/channels');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
  });

  it('throws ApiError with server error contract', async () => {
    stubFetch(403, { error: { code: 'forbidden', message: 'nope' } });
    const api = new ApiClient('http://x:3400', 'tok');
    await expect(api.channels()).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    await expect(api.channels()).rejects.toBeInstanceOf(ApiError);
  });

  it('builds message query and idempotency header', async () => {
    const fn = stubFetch(201, { id: 'm1', seq: 1, channelId: 'c1', threadRootId: null, authorId: 'a', body: 'hi', kind: 'user', meta: {}, createdAt: 'now' });
    const api = new ApiClient('http://x:3400', 'tok');
    await api.postMessage('c1', 'hi', undefined, 'idem-1');
    const [, init] = fn.mock.calls[0]! as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('idem-1');

    await api.messages('c1', { since: 5 });
    const [url2] = fn.mock.calls[1]! as unknown as [string];
    expect(url2).toBe('http://x:3400/channels/c1/messages?since=5');
  });

  /**
   * #221 — 스코프가 실제로 **선을 타는지** 본다. 팔레트 테스트는 `api.search` 를 목으로
   * 바꾸므로 URL 조립을 하나도 지키지 않는다. 여기가 그 배선을 지키는 유일한 자리다.
   */
  it('puts the channel scope on the search query string', async () => {
    const fn = stubFetch(200, { messages: [] });
    const api = new ApiClient('http://x:3400', 'tok');

    await api.search('needle');
    expect((fn.mock.calls[0]! as unknown as [string])[0]).toBe('http://x:3400/search?q=needle');

    await api.search('needle', 'c1');
    expect((fn.mock.calls[1]! as unknown as [string])[0]).toBe('http://x:3400/search?q=needle&channelId=c1');

    // null 은 "스코프 없음"이지 빈 스코프가 아니다 — 빈 channelId 가 붙으면 서버가 400 이다.
    await api.search('needle', null);
    expect((fn.mock.calls[2]! as unknown as [string])[0]).toBe('http://x:3400/search?q=needle');
  });
});
