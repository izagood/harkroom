import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import type { WsServerEvent } from '@murmur/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let botPat: string;
let channelId: string;
let baseUrl: string;

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ pat: botPat } = await createAgent(app, adminToken, 'editbot'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'edits' },
  });
  channelId = ch.json().id;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await app.close(); await stop(); });

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function post(token: string, body: string, threadRootId?: string): Promise<{ id: string; seq: number }> {
  const res = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token),
    payload: { body, ...(threadRootId ? { threadRootId } : {}) },
  });
  return res.json();
}

const listBodies = async (): Promise<string[]> => (await app.inject({
  method: 'GET', url: `/channels/${channelId}/messages`, headers: auth(adminToken),
})).json().messages.map((m: { body: string }) => m.body);

/** 소켓을 열고 구독 완료까지 기다린 뒤, 도착한 이벤트를 모으는 배열을 돌려준다. */
async function listen(): Promise<{ events: WsServerEvent[]; ws: WebSocket }> {
  const ticket = (await app.inject({ method: 'POST', url: '/ws-ticket', headers: auth(adminToken) })).json().ticket;
  const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${ticket}`);
  const events: WsServerEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (data) => {
      const e = JSON.parse(String(data)) as WsServerEvent;
      if (e.type === 'presence.snapshot') { resolve(); return; }
      events.push(e);
    });
  });
  return { events, ws };
}

const waitFor = async (pred: () => boolean, ms = 4000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('메시지 수정', () => {
  it('PATCH rewrites the body, stamps editedAt, and keeps seq', async () => {
    const m = await post(adminToken, 'typo heer');
    const res = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/messages/${m.id}`,
      headers: auth(adminToken), payload: { body: 'typo here' },
    });

    expect(res.statusCode).toBe(200);
    const updated = res.json();
    expect(updated.body).toBe('typo here');
    expect(updated.seq).toBe(m.seq); // 수정은 순서를 바꾸지 않는다
    expect(updated.editedAt).toBeTruthy();
    expect(await listBodies()).toContain('typo here');
  });

  it('refuses to edit a message written by someone else', async () => {
    const mine = await post(adminToken, 'admin wrote this');
    const res = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/messages/${mine.id}`,
      headers: auth(botPat), payload: { body: 'bot rewrote it' },
    });

    expect(res.statusCode).toBe(403);
    expect(await listBodies()).toContain('admin wrote this');
  });

  // 투영된 system 메시지는 avcs 로그의 사본이다. 사람이 고치면 원본과 어긋난 거짓이 남는다.
  it('refuses to edit a system message even for an admin', async () => {
    const sys = await pool.query(
      `insert into message (channel_id, author_id, body, kind)
       select $1, id, 'projected op', 'system' from account where handle = 'admin' returning id`,
      [channelId],
    );
    const res = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/messages/${sys.rows[0].id}`,
      headers: auth(adminToken), payload: { body: 'rewritten history' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('pushes message.updated over the socket', async () => {
    const m = await post(adminToken, 'before');
    const { events, ws } = await listen();
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/messages/${m.id}`,
      headers: auth(adminToken), payload: { body: 'after' },
    });

    await waitFor(() => events.some((e) => e.type === 'message.updated'));
    const evt = events.find((e) => e.type === 'message.updated') as
      Extract<WsServerEvent, { type: 'message.updated' }>;
    expect(evt.message.body).toBe('after');
    ws.close();
  });
});

describe('메시지 삭제', () => {
  it('DELETE hides the message from listings', async () => {
    const m = await post(adminToken, 'oops sent to the wrong channel');
    const res = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${m.id}`, headers: auth(adminToken),
    });

    expect(res.statusCode).toBe(204);
    expect(await listBodies()).not.toContain('oops sent to the wrong channel');
  });

  // 삭제는 soft delete 다 — 스레드 답글이 루트와 함께 사라지면 대화가 통째로 날아간다.
  it('keeps thread replies reachable after the root is deleted', async () => {
    const root = await post(adminToken, 'root to be deleted');
    await post(adminToken, 'reply that must survive', root.id);
    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${root.id}`, headers: auth(adminToken),
    });

    const thread = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages?thread=${root.id}`, headers: auth(adminToken),
    });
    expect(thread.json().messages.map((m: { body: string }) => m.body)).toContain('reply that must survive');
  });

  it('lets an admin delete another account message but blocks a non-admin', async () => {
    const byBot = await post(botPat, 'bot message removed by admin');
    const byAdmin = await post(adminToken, 'admin message the bot may not remove');

    const asAdmin = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${byBot.id}`, headers: auth(adminToken),
    });
    const asBot = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${byAdmin.id}`, headers: auth(botPat),
    });

    expect(asAdmin.statusCode).toBe(204);
    expect(asBot.statusCode).toBe(403);
    expect(await listBodies()).toContain('admin message the bot may not remove');
  });

  it('pushes message.deleted over the socket', async () => {
    const m = await post(adminToken, 'to be deleted live');
    const { events, ws } = await listen();
    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${m.id}`, headers: auth(adminToken),
    });

    await waitFor(() => events.some((e) => e.type === 'message.deleted'));
    const evt = events.find((e) => e.type === 'message.deleted') as
      Extract<WsServerEvent, { type: 'message.deleted' }>;
    expect(evt).toMatchObject({ channelId, messageId: m.id });
    ws.close();
  });

  it('refuses to edit or delete an already deleted message', async () => {
    const m = await post(adminToken, 'gone');
    await app.inject({ method: 'DELETE', url: `/channels/${channelId}/messages/${m.id}`, headers: auth(adminToken) });

    const patch = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/messages/${m.id}`,
      headers: auth(adminToken), payload: { body: 'resurrected' },
    });
    const del = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${m.id}`, headers: auth(adminToken),
    });

    expect(patch.statusCode).toBe(404);
    expect(del.statusCode).toBe(404);
  });
});
