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
});
