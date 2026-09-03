import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiClient } from '../src/lib/api';

describe('setAgentDisabled', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'a1', disabled: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('sends only { disabled } to PATCH /accounts/agents/:id', async () => {
    const api = new ApiClient('http://x:3400', 'tok');
    await api.setAgentDisabled('a1', true);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('http://x:3400/accounts/agents/a1');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ disabled: true });
    expect(Object.keys(body)).toHaveLength(1);
  });

  it('sends false when re-enabling', async () => {
    const api = new ApiClient('http://x:3400', 'tok');
    await api.setAgentDisabled('a1', false);
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ disabled: false });
  });
});