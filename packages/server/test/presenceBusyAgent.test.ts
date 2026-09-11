/**
 * **일하는 중인 에이전트를 죽었다고 말하지 않는다.**
 *
 * `presence.mark()` 가 `inbox.poll` 한 곳에만 있으면, 턴을 도는 동안(러너 루프는 단일
 * 스레드라 폴이 나가지 않는다) 30초 TTL 이 만료돼 에이전트가 `online` 에서 빠진다.
 * 그러면 화면의 `decide()` 가 "마지막 말이 진행인데 저자가 살아 있지 않다"로 읽어
 * 스레드를 **'막힘'** 으로 칠한다 — 실패한 적이 없는데도.
 *
 * 그래서 presence 의 정의를 "inbox 를 폴한다"에서 **"서버가 이 에이전트로부터 최근에
 * 무언가를 받았다"** 로 넓힌다. 두 신호를 함께 쓰는 이유가 서로를 메우는 데 있다:
 * 조용한 턴은 relay 프레임이 받치고(PTY 바이트가 초 단위로 온다), relay 를 안 붙인
 * 러너는 MCP 도구 호출이 받친다.
 *
 * **'프레임 도착'이지 '소켓 열림'이 아니다.** relay 소켓은 heartbeat 추적을 받지 않으므로
 * (`heartbeat` 는 `wsPlugin` 에만 배선돼 있다) 소켓 존재를 생존으로 읽으면 wedge 된 러너가
 * 영원히 온라인으로 남는다 — "없는 것을 있다고 표시하지 않는다"가 그 자리에서 깨진다.
 * 프레임을 신호로 잡으면 TTL 만료가 그대로 wedge 감지가 된다.
 *
 * **에이전트를 테스트마다 새로 만든다.** presence 는 TTL 30초짜리 인메모리 장부라, 한 번
 * 온라인이 된 계정을 다음 테스트가 재사용하면 그 테스트는 무엇도 검증하지 않는다.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { WsServerEvent } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let base: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '127.0.0.1';
  ({ token: adminToken } = await bootstrapAdmin(app));
});
afterAll(async () => { await app.close(); await stop(); });

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

/** 지금 서버가 온라인으로 아는 계정들. 사람이 새로 붙을 때 받는 스냅샷이 진실이다. */
async function onlineNow(): Promise<string[]> {
  const ticketRes = await app.inject({
    method: 'POST', url: '/ws-ticket', headers: { authorization: `Bearer ${adminToken}` },
  });
  const ticket = ticketRes.json().ticket as string;
  const ws = new WebSocket(`ws://${base}/ws?ticket=${encodeURIComponent(ticket)}`);
  try {
    return await new Promise<string[]>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('message', (raw) => {
        const e = JSON.parse(String(raw)) as WsServerEvent;
        if (e.type === 'presence.snapshot') resolve(e.online);
      });
    });
  } finally {
    ws.close();
  }
}

const waitForOnline = async (accountId: string, ms = 4000): Promise<string[]> => {
  const until = Date.now() + ms;
  let online = await onlineNow();
  while (!online.includes(accountId) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
    online = await onlineNow();
  }
  return online;
};

describe('일하는 중인 에이전트의 presence', () => {
  it('inbox.poll 이 아닌 MCP 도구를 불러도 온라인이 된다', async () => {
    const agent = await createAgent(app, adminToken, 'busy-mcp-agent');
    const client = await mcpClient(agent.pat);
    // 턴 중에 에이전트가 실제로 하는 일이다 — 폴은 못 하지만 말은 한다.
    await client.callTool({ name: 'channel.list', arguments: {} });
    await client.close();

    expect(await onlineNow()).toContain(agent.accountId);
  });

  it('relay 프레임이 도착하면 온라인이 된다', async () => {
    const agent = await createAgent(app, adminToken, 'busy-relay-agent');
    const ws = new WebSocket(`ws://${base}/agent-relay`, {
      headers: { authorization: `Bearer ${agent.pat}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    // 러너가 붙자마자 보내는 첫 프레임. 세션이 없어도 '나 여기 있다'는 사실은 같다.
    ws.send(JSON.stringify({ type: 'announce', sessions: [], caps: [] }));

    // 프레임 처리는 소켓 이벤트라 send 반환과 순서가 보장되지 않는다.
    const online = await waitForOnline(agent.accountId);
    ws.close();

    expect(online).toContain(agent.accountId);
  });
});
