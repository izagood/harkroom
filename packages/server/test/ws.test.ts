import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let botPat: string;
let channelId: string;
let baseUrl: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
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

async function ticketFor(token: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/ws-ticket', headers: { authorization: `Bearer ${token}` },
  });
  return res.json().ticket as string;
}

function collectWithTicket(ticket: string): { events: unknown[]; ready: Promise<void>; close(): void } {
  const events: unknown[] = [];
  const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${ticket}`);
  ws.on('message', (data) => events.push(JSON.parse(String(data))));
  // 'open'은 핸드셰이크가 끝났다는 뜻일 뿐, 서버가 이벤트 버스를 구독했다는 뜻이 아니다 —
  // 그 사이에 토큰 조회(DB 왕복)가 있고, 버스는 fire-and-forget이라 그 창에 발행된 이벤트는
  // 구독자가 없어 영구히 사라진다. presence.snapshot은 서버가 구독을 마친 뒤에만 보내므로
  // 이것이 실제 준비 신호다. (제품에서는 클라이언트가 onOpen에서 REST 리컨실로 이 창을 메운다.)
  const ready = new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (data) => {
      if ((JSON.parse(String(data)) as { type?: string }).type === 'presence.snapshot') resolve();
    });
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
  const collect = async (token: string) => collectWithTicket(await ticketFor(token));

  it('rejects a fabricated ticket', async () => {
    const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=murt_bogus`);
    ws.on('error', () => {});
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));
  });

  // 장기 토큰이 URL 에 실리는 경로를 남겨두면 그 자체가 우회로다.
  it('no longer accepts a long-lived token in the query string', async () => {
    const ws = new WebSocket(`ws://${baseUrl}/ws?token=${adminToken}`);
    ws.on('error', () => {});
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4401);
  });

  it('refuses to issue a ticket without credentials', async () => {
    const res = await app.inject({ method: 'POST', url: '/ws-ticket' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a ticket that was already spent', async () => {
    const ticket = await ticketFor(adminToken);
    const first = collectWithTicket(ticket);
    await first.ready;

    const second = new WebSocket(`ws://${baseUrl}/ws?ticket=${ticket}`);
    second.on('error', () => {});
    const code = await new Promise<number>((resolve) => second.on('close', (c) => resolve(c)));

    expect(code).toBe(4401);
    first.close();
  });

  it('pushes message.created to all and inbox.updated to mentioned account', async () => {
    const admin = await collect(adminToken);
    const bot = await collect(botPat);
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

  it('sends presence.snapshot on connect and gates presence.changed by transition', async () => {
    const a = await collect(adminToken);
    await a.ready;
    await waitFor(() => a.events.some((e: any) => e.type === 'presence.snapshot'));
    const snap = a.events.find((e: any) => e.type === 'presence.snapshot') as any;
    expect(Array.isArray(snap.online)).toBe(true);

    // presence.changed 는 전원에게 브로드캐스트된다(visibleTo 가 true 를 돌려준다) — 그래서
    // 검사 대상 계정으로 범위를 좁히지 않으면 다른 테스트가 남긴 소켓의 정리가 이 창에 끼어든다.
    const adminPresence = () =>
      a.events.filter((e: any) => e.type === 'presence.changed' && e.accountId === adminId);

    // 같은 계정 두 번째 연결 → 첫 소켓에 presence.changed(online:true)가 다시 오지 않는다
    const before = adminPresence().length;
    const a2 = await collect(adminToken);
    await a2.ready;
    await waitFor(() => a2.events.some((e: any) => e.type === 'presence.snapshot'));
    const after = adminPresence().length;
    expect(after).toBe(before); // 전이 없음(이미 online)
    a2.close();
    await new Promise((r) => setTimeout(r, 100));
    // 아직 첫 연결이 남아 있으므로 offline 전이도 없다
    expect(adminPresence().filter((e: any) => e.online === false)).toHaveLength(0);
    a.close();
  });
});
