import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let botPat: string;
let channelId: string;
let baseUrl: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ pat: botPat } = await createAgent(app, adminToken, 'wsbot'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'live' },
  });
  channelId = ch.json().id;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await app.close(); await stop(); });

function collect(token: string): { events: unknown[]; ready: Promise<void>; close(): void } {
  const events: unknown[] = [];
  const ws = new WebSocket(`ws://${baseUrl}/ws?token=${token}`);
  ws.on('message', (data) => events.push(JSON.parse(String(data))));
  const ready = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  return { events, ready, close: () => ws.close() };
}

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('websocket', () => {
  it('rejects bad token', async () => {
    const ws = new WebSocket(`ws://${baseUrl}/ws?token=bogus`);
    ws.on('error', () => {});
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));
  });

  it('pushes message.created to all and inbox.updated to mentioned account', async () => {
    const admin = collect(adminToken);
    const bot = collect(botPat);
    await admin.ready; await bot.ready;

    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: '@wsbot ping' },
    });

    await waitFor(() =>
      admin.events.some((e: any) => e.type === 'message.created' && e.message.body === '@wsbot ping') &&
      bot.events.some((e: any) => e.type === 'inbox.updated'));
    admin.close(); bot.close();
  });
});
