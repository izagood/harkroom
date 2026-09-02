import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { WsServerEvent } from '@murmur/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let botPat: string;
let botId: string;
let baseUrl: string;
let mcpUrl: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool as Pool, wsHeartbeatMs: 30_000 });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ pat: botPat, accountId: botId } = await createAgent(app, adminToken, 'pollbot'));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
  mcpUrl = `http://${baseUrl}/mcp`;
});

afterAll(async () => { await app.close(); await stop(); });

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

async function wsForToken(token: string): Promise<WebSocket> {
  const ticketRes = await app.inject({
    method: 'POST', url: '/ws-ticket', headers: { authorization: `Bearer ${token}` },
  });
  const ticket = ticketRes.json().ticket as string;
  const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${ticket}`);
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (data) => {
      if ((JSON.parse(String(data)) as { type?: string }).type === 'presence.snapshot') resolve();
    });
  });
  return ws;
}

const text = (r: Awaited<ReturnType<Client['callTool']>>): unknown =>
  JSON.parse((r.content as { type: string; text: string }[])[0]!.text);

const waitFor = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('agent presence via inbox.poll', () => {
  it('에이전트가 inbox.poll 을 부르면 presence.changed 로 온라인이 된다', async () => {
    const watcher = await wsForToken(adminToken);
    const events: WsServerEvent[] = [];
    watcher.on('message', (d) => events.push(JSON.parse(String(d)) as WsServerEvent));

    const client = await mcpClient(botPat);
    await client.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } });

    await waitFor(() => events.some((e) => e.type === 'presence.changed' && e.accountId === botId && e.online));

    const presenceChanged = events.find((e) => e.type === 'presence.changed' && e.accountId === botId && e.online);
    expect(presenceChanged?.type).toBe('presence.changed');
    expect(presenceChanged?.online).toBe(true);

    watcher.close();
  });

  it('사람 계정의 presence 가 이 변경으로 바뀌지 않는다 (회귀)', async () => {
    const watcher = await wsForToken(adminToken);
    const events: WsServerEvent[] = [];
    watcher.on('message', (d) => events.push(JSON.parse(String(d)) as WsServerEvent));

    const client = await mcpClient(botPat);
    await client.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } });

    await waitFor(() => events.some((e) => e.type === 'presence.changed' && e.accountId === botId && e.online));

    const adminPresence = events.filter((e) => e.type === 'presence.changed' && e.accountId === adminId);
    expect(adminPresence.length).toBe(0);

    watcher.close();
  });

  it('폴을 부른 뒤 새 연결은 에이전트를 온라인으로 본다', async () => {
    const client = await mcpClient(botPat);
    await client.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } });

    const watcher = await wsForToken(adminToken);
    const events: WsServerEvent[] = [];
    watcher.on('message', (d) => events.push(JSON.parse(String(d)) as WsServerEvent));

    await waitFor(() => events.some((e) => e.type === 'presence.changed' && e.accountId === botId && e.online));

    const snapshot = events.find((e) => e.type === 'presence.snapshot');
    expect(snapshot?.type).toBe('presence.snapshot');
    expect((snapshot as { online: string[] })?.online).toContain(botId);

    watcher.close();
  });
});