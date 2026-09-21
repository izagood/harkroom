/**
 * 가짜 오퍼레이터 링크(스펙 2026-09-20 §5). `HarkroomAgentClient` 가 서버 대신 보는 유일한 상대다 —
 * 옛 테스트들이 `globalThis.fetch` 를 갈아 끼우던 자리를 이것이 대신한다.
 *
 * `mcp` 는 JSON-RPC 메시지 하나를 받아 서버가 돌려줄 메시지들(또는 HTTP 거절)을 내고, `http` 는
 * `http.forward` 하나를 받아 상태·본문을 낸다. 둘 다 프로덕션 링크(`relay.ts::request`)와 같은
 * 응답 프레임을 돌려주므로 클라이언트의 판정(status 태깅)이 그대로 지나간다.
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { RunnerLink } from '../../src/harkroom.js';
import type { LinkHttpRequest } from '../../src/relay.js';

export type FakeMcp = (payload: JSONRPCMessage) => { messages: unknown[] } | { status: number; message: string };
export type FakeHttp = (req: LinkHttpRequest) => { status: number; body: string };

/** MCP 도구 호출에 `result` 를 JSON 텍스트로 답하는 가장 흔한 모양. initialize 도 처리한다. */
export function toolServer(handle: (name: string, args: Record<string, unknown>) => unknown): FakeMcp {
  return (payload) => {
    const msg = payload as { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (msg.method === 'initialize') {
      return { messages: [{ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } }] };
    }
    if (msg.id === undefined) return { messages: [] };
    if (msg.method === 'tools/call') {
      const result = handle(msg.params?.name ?? '', msg.params?.arguments ?? {});
      return { messages: [{ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }] };
    }
    return { messages: [{ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown ${msg.method}` } }] };
  };
}

export function fakeLink(opts: { mcp?: FakeMcp; http?: FakeHttp } = {}): RunnerLink & { requests: LinkHttpRequest[] } {
  const requests: LinkHttpRequest[] = [];
  const mcp: FakeMcp = opts.mcp ?? (() => ({ status: 0, message: 'no mcp' }));
  const http: FakeHttp = opts.http ?? (() => ({ status: 0, body: 'no http' }));
  const link = {
    requests,
    request: (async (req: LinkHttpRequest | { type: 'mcp.request'; payload: unknown }) => {
      if (req.type === 'mcp.request') {
        const res = mcp(req.payload as JSONRPCMessage);
        return 'messages' in res
          ? { type: 'mcp.response', id: 'x', messages: res.messages }
          : { type: 'mcp.error', id: 'x', status: res.status, message: res.message };
      }
      requests.push(req);
      const res = http(req);
      return { type: 'http.response', id: 'x', status: res.status, body: res.body };
    }) as RunnerLink['request'],
    mcpTransport(): Transport {
      const self: Transport = {
        async start() {},
        async send(message) {
          const res = mcp(message);
          if (!('messages' in res)) throw Object.assign(new Error(res.message), { status: res.status });
          for (const m of res.messages) self.onmessage?.(m as JSONRPCMessage);
        },
        async close() { self.onclose?.(); },
      };
      return self;
    },
  };
  return link;
}
