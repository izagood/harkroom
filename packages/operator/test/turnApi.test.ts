import { describe, it, expect, beforeEach } from 'vitest';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import { createTurnApi, parseApiArgs, scrubValue, type TurnApi } from '../src/turnApi.js';

// 외부 API 래퍼(C안 P3, 스레드 07519d86) — 오퍼레이터 쪽. 지키는 것: 키는 결과에 안 나간다 · 리다이렉트는 안 따라간다 ·
// origin 을 다시 잰다 · 서버에 닿지 않으면 부르지 않는다 · 호출마다 보고한다.
const KEY = `key_${'a'.repeat(24)}`;
const BASE = 'https://api.example.internal';

const call = (args: Record<string, unknown>, cause: string | undefined = 'cause-1'): RunnerLinkRequest => ({
  type: 'mcp.request', id: 'link-1', cause,
  payload: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'api.call', arguments: args } },
});
const resultOf = (res: RunnerLinkResponse | null) => {
  if (!res || res.type !== 'mcp.response') throw new Error('expected mcp.response');
  const msg = res.messages[0] as { result: { content: { text: string }[]; isError?: boolean } };
  return { isError: msg.result.isError === true, text: msg.result.content[0]!.text, body: JSON.parse(msg.result.content[0]!.text) };
};
const noFile = () => { throw new Error('no'); };

describe('parseApiArgs', () => {
  it('연결·메서드·경로와 --data·--content-type 만 받는다', () => {
    expect(parseApiArgs(['lab', 'get', '/api/x?y=1'], noFile)).toEqual({ connector: 'lab', method: 'GET', path: '/api/x?y=1', body: null, contentType: null });
    expect(parseApiArgs(['lab', 'POST', '/api/x', '--data', '{"a":1}'], noFile)).toMatchObject({ body: '{"a":1}', contentType: 'application/json' });
    expect(parseApiArgs(['lab', 'POST', '/api/x', '--data', '@b.json'], () => Buffer.from('{"f":1}'))).toMatchObject({ body: '{"f":1}' });
    for (const bad of [
      ['lab', 'GET', 'https://evil.example/x'],
      ['lab', 'TRACE', '/x'],
      ['Lab!', 'GET', '/x'],
      ['lab', 'GET', '/x', '--header', 'Authorization: x'],
      ['lab', 'GET', '/x', '--data', '{}'],
      ['lab', 'POST', '/x', '--data'],
      ['lab', 'POST', '/x', '--data', '@missing.json'],
      ['lab'],
    ]) expect(parseApiArgs(bad, noFile), bad.join(' ')).toHaveProperty('error');
  });
});

describe('scrubValue', () => {
  it('값 그대로와 base64 꼴을 가린다, 짧은 값은 건드리지 않는다', () => {
    expect(scrubValue(`echo ${KEY} done`, KEY)).toBe('echo [REDACTED] done');
    const b64 = Buffer.from(KEY).toString('base64').replace(/=+$/, '');
    expect(scrubValue(`x ${b64} y`, KEY)).toBe('x [REDACTED] y');
    expect(scrubValue('abc', 'abc')).toBe('abc');
  });
});

describe('turnApi', () => {
  let forwards: { path: string; body: Record<string, unknown> }[];
  let checkStatus: number; let checkBody: Record<string, unknown>;
  let fetches: { url: string; init: RequestInit }[];
  let respond: () => Response;
  let lease: { leaseId: string; token: string; agentId: string } | null;
  let ta: TurnApi;

  beforeEach(() => {
    forwards = []; fetches = [];
    lease = { leaseId: 'lease-1', token: 'tok-1', agentId: 'a1' };
    checkStatus = 200;
    checkBody = { allowed: true, connector: 'lab', baseUrl: BASE, authKind: 'bearer', authHeader: null, valueBase64: Buffer.from(KEY).toString('base64') };
    respond = () => new Response(JSON.stringify({ ok: true, echo: KEY }), { status: 200, headers: { 'content-type': 'application/json' } });
    ta = createTurnApi({
      forward: async (_agentId, req) => {
        if (req.type !== 'http.forward') throw new Error('unexpected');
        const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
        forwards.push({ path: req.path, body });
        if (req.path === '/agent/api-checks') return { type: 'http.response', id: req.id, status: checkStatus, body: checkStatus === 200 ? JSON.stringify(checkBody) : JSON.stringify({ error: { code: 'not_granted' } }) };
        return { type: 'http.response', id: req.id, status: 201, body: '{}' };
      },
      lookupLease: () => lease,
      log: () => {},
      fetch: (async (url: URL | string, init: RequestInit) => { fetches.push({ url: String(url), init }); return respond(); }) as unknown as typeof fetch,
    });
  });

  it('통과하면 키를 헤더에 붙여 부르고, 결과에는 키가 없고, 보고한다', async () => {
    const r = resultOf(await ta.maybeHandle('r1', 'a1', call({ connector: 'lab', method: 'GET', path: '/api/capacity' })));
    expect(r.isError).toBe(false);
    expect(r.body.status).toBe(200);
    expect(r.text).not.toContain(KEY);
    expect(r.body.body).toContain('[REDACTED]');
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.url).toBe(`${BASE}/api/capacity`);
    expect((fetches[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(fetches[0]!.init.redirect).toBe('manual');
    expect(forwards.map((f) => f.path)).toEqual(['/agent/api-checks', '/agent/api-results']);
    expect(forwards[1]!.body).toMatchObject({ connector: 'lab', method: 'GET', path: '/api/capacity', status: 200 });
    expect(JSON.stringify(forwards[1]!.body)).not.toContain(KEY);
  });

  it('header 종류는 그 헤더에 붙인다', async () => {
    checkBody = { ...checkBody, authKind: 'header', authHeader: 'X-Api-Key' };
    await ta.maybeHandle('r1', 'a1', call({ connector: 'lab', method: 'GET', path: '/x' }));
    const h = fetches[0]!.init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe(KEY);
    expect(h.authorization).toBeUndefined();
  });

  it('리다이렉트는 따라가지 않고 상태와 location 만 돌려준다', async () => {
    respond = () => new Response(null, { status: 302, headers: { location: 'https://other.example/x' } });
    const r = resultOf(await ta.maybeHandle('r1', 'a1', call({ connector: 'lab', method: 'GET', path: '/x' })));
    expect(r.body).toMatchObject({ status: 302, location: 'https://other.example/x', note: 'redirects are not followed' });
    expect(fetches).toHaveLength(1);
  });

  it('서버가 거절하면 부르지 않고 코드를 돌려준다', async () => {
    checkStatus = 403;
    const r = resultOf(await ta.maybeHandle('r1', 'a1', call({ connector: 'lab', method: 'GET', path: '/x' })));
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('not_granted');
    expect(fetches).toHaveLength(0);
  });

  it('origin 이 연결과 다르면 부르지 않는다', async () => {
    checkBody = { ...checkBody, baseUrl: 'https://api.example.internal:8443' };
    const r = resultOf(await ta.maybeHandle('r1', 'a1', call({ connector: 'lab', method: 'GET', path: '//evil.example/x' })));
    expect(r.isError).toBe(true);
    expect(fetches).toHaveLength(0);
  });

  it('임대가 없으면 서버에도 묻지 않는다', async () => {
    lease = null;
    const r = resultOf(await ta.maybeHandle('r1', 'a1', call({ connector: 'lab', method: 'GET', path: '/x' })));
    expect(r.body.error.code).toBe('no_lease');
    expect(forwards).toHaveLength(0);
  });

  it('소켓으로 온 인자도 다시 잰다 — 모르는 칸·GET 본문은 거절', async () => {
    expect(resultOf(await ta.maybeHandle('r1', 'a1', call({ connector: 'lab', method: 'GET', path: '/x', headers: { a: 1 } }))).body.error.code).toBe('bad_request');
    expect(resultOf(await ta.maybeHandle('r1', 'a1', call({ connector: 'lab', method: 'GET', path: '/x', body: '{}' }))).body.error.code).toBe('bad_request');
    expect(forwards).toHaveLength(0);
  });

  it('호출이 실패한 오류 문구에서도 키를 가린다', async () => {
    respond = () => { throw new Error(`connect failed with ${KEY}`); };
    const r = resultOf(await ta.maybeHandle('r1', 'a1', call({ connector: 'lab', method: 'GET', path: '/x' })));
    expect(r.body.error.code).toBe('unreachable');
    expect(r.text).not.toContain(KEY);
    expect(JSON.stringify(forwards)).not.toContain(KEY);
  });

  it('api.call 이 아닌 요청은 건드리지 않는다', async () => {
    expect(await ta.maybeHandle('r1', 'a1', { type: 'mcp.request', id: 'x', payload: { method: 'tools/call', params: { name: 'message.post' } } })).toBeNull();
  });
});
