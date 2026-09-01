import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import type { WsServerEvent } from '@murmur/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let botPat: string;
let botId: string;
let baseUrl: string;

const HEARTBEAT_MS = 120;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool as Pool, wsHeartbeatMs: HEARTBEAT_MS });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ pat: botPat, accountId: botId } = await createAgent(app, adminToken, 'wedgedbot'));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await app.close(); await stop(); });

async function connect(token: string): Promise<WebSocket> {
  const ticket = (await app.inject({
    method: 'POST', url: '/ws-ticket', headers: { authorization: `Bearer ${token}` },
  })).json().ticket;
  const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${ticket}`);
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (d) => {
      if ((JSON.parse(String(d)) as { type?: string }).type === 'presence.snapshot') resolve();
    });
  });
  return ws;
}

const waitFor = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('presence 는 하트비트를 따른다', () => {
  it('keeps a responsive client online across several heartbeat periods', async () => {
    const watcher = await connect(adminToken);
    const events: WsServerEvent[] = [];
    watcher.on('message', (d) => events.push(JSON.parse(String(d)) as WsServerEvent));

    const client = await connect(botPat);
    await waitFor(() => events.some((e) => e.type === 'presence.changed' && e.accountId === botId && e.online));
    await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 5));

    // ws 클라이언트는 ping 에 자동으로 pong 한다 — 정상 연결은 끊기지 않아야 한다.
    expect(client.readyState).toBe(WebSocket.OPEN);
    expect(events.some((e) => e.type === 'presence.changed' && e.accountId === botId && !e.online)).toBe(false);

    client.close();
    watcher.close();
  });

  // 죽은 연결은 close 를 주지 않는다. 소켓 읽기를 멈춘 클라이언트는 ping 을 못 받으므로
  // pong 도 못 보낸다 — 케이블이 뽑힌 피어와 서버에게 구분되지 않는다.
  it('drops a wedged client and marks it offline', async () => {
    const watcher = await connect(adminToken);
    const events: WsServerEvent[] = [];
    watcher.on('message', (d) => events.push(JSON.parse(String(d)) as WsServerEvent));

    const wedged = await connect(botPat);
    await waitFor(() => events.some((e) => e.type === 'presence.changed' && e.accountId === botId && e.online));

    // 읽기를 멈춘다 → ping 이 도착해도 처리되지 않아 pong 이 나가지 않는다.
    (wedged as unknown as { _socket: { pause(): void } })._socket.pause();

    await waitFor(
      () => events.some((e) => e.type === 'presence.changed' && e.accountId === botId && !e.online),
      5000,
    );

    watcher.close();
  });
});
