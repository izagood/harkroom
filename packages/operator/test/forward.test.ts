// 오퍼레이터의 전달(스펙 2026-09-20 §5 MCP 행). 러너 대신 서버에 말하되 **인증만 바꾼다** —
// Authorization 을 오퍼레이터 토큰으로, X-Harkroom-Agent 를 그 러너의 에이전트로. MCP 와 REST 는
// 프레임이 다르고 규칙은 하나다. 여기서 재는 것은 그 헤더 둘·경로·본문의 왕복이다.
import { describe, it, expect } from 'vitest';
import { createForwarder } from '../src/forward.js';

const target = { baseUrl: 'https://example.com', token: 'hkop_t', agentId: 'agent-a' };

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('forward — MCP', () => {
  it('JSON-RPC 요청을 /mcp 에 POST 하고, 헤더 둘을 바꿔 단다', async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const fw = createForwarder({ fetchImpl: f.fetchImpl });
    const res = await fw.forward(target, { type: 'mcp.request', id: 'q1', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(f.calls[0]!.url).toBe('https://example.com/mcp');
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer hkop_t');
    expect(headers['x-harkroom-agent']).toBe('agent-a');
    expect(headers.accept).toContain('text/event-stream');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res).toEqual({ type: 'mcp.response', id: 'q1', messages: [{ jsonrpc: '2.0', id: 1, result: { ok: true } }] });
  });

  it('SSE 로 온 답도 메시지 목록으로 푼다 — Streamable HTTP 서버는 둘 다 낼 수 있다', async () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/x"}\n\n';
    const f = fakeFetch(() => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const fw = createForwarder({ fetchImpl: f.fetchImpl });
    const res = await fw.forward(target, { type: 'mcp.request', id: 'q1', payload: { jsonrpc: '2.0', id: 1, method: 'x' } });
    expect(res).toEqual({ type: 'mcp.response', id: 'q1', messages: [
      { jsonrpc: '2.0', id: 1, result: { a: 1 } }, { jsonrpc: '2.0', method: 'notifications/x' },
    ] });
  });

  it('알림(202)은 빈 목록이다', async () => {
    const f = fakeFetch(() => new Response(null, { status: 202 }));
    const fw = createForwarder({ fetchImpl: f.fetchImpl });
    const res = await fw.forward(target, { type: 'mcp.request', id: 'q1', payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    expect(res).toEqual({ type: 'mcp.response', id: 'q1', messages: [] });
  });

  it('서버가 HTTP 로 거절하면 mcp.error 에 status 가 실린다 — 러너의 자격증명 판정이 그것을 읽는다', async () => {
    const f = fakeFetch(() => new Response('{"error":{"code":"not_assigned","message":"배정 없음"}}', { status: 403 }));
    const fw = createForwarder({ fetchImpl: f.fetchImpl });
    const res = await fw.forward(target, { type: 'mcp.request', id: 'q1', payload: { jsonrpc: '2.0', id: 1, method: 'x' } });
    expect(res).toMatchObject({ type: 'mcp.error', id: 'q1', status: 403 });
    expect((res as { message: string }).message).toContain('not_assigned');
  });

  it('네트워크 실패도 mcp.error 다 — status 0', async () => {
    const fw = createForwarder({ fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch });
    const res = await fw.forward(target, { type: 'mcp.request', id: 'q1', payload: {} });
    expect(res).toMatchObject({ type: 'mcp.error', id: 'q1', status: 0 });
  });
});

describe('forward — REST', () => {
  it('경로·메서드·본문을 그대로 넘기고 같은 헤더 둘을 단다', async () => {
    const f = fakeFetch(() => new Response('{"id":"agent-a"}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const fw = createForwarder({ fetchImpl: f.fetchImpl });
    const res = await fw.forward(target, { type: 'http.forward', id: 'r1', method: 'POST', path: '/agent/activity', body: '{}', contentType: 'application/json' });
    expect(f.calls[0]!.url).toBe('https://example.com/agent/activity');
    expect(f.calls[0]!.init.method).toBe('POST');
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer hkop_t');
    expect(headers['x-harkroom-agent']).toBe('agent-a');
    expect(headers['content-type']).toBe('application/json');
    expect(res).toEqual({ type: 'http.response', id: 'r1', status: 200, body: '{"id":"agent-a"}' });
  });

  it('베이스 밖으로 나가는 경로는 서버에 닿기 전에 막는다 — 오퍼레이터는 열린 프록시가 아니다', async () => {
    const f = fakeFetch(() => new Response('x'));
    const fw = createForwarder({ fetchImpl: f.fetchImpl });
    const res = await fw.forward(target, { type: 'http.forward', id: 'r1', method: 'GET', path: 'https://evil.example/x' });
    expect(res).toMatchObject({ type: 'http.response', id: 'r1', status: 400 });
    expect(f.calls).toHaveLength(0);
  });
});
