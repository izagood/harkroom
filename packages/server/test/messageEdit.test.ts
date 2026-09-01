import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let botPat: string;
let channelId: string;
let baseUrl: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
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

const post = async (token: string, body: string, extra: object = {}) => {
  const res = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`,
    headers: { authorization: `Bearer ${token}` }, payload: { body, ...extra },
  });
  return res.json();
};
const edit = (token: string, id: string, body: string) =>
  app.inject({
    method: 'PATCH', url: `/channels/${channelId}/messages/${id}`,
    headers: { authorization: `Bearer ${token}` }, payload: { body },
  });
const remove = (token: string, id: string) =>
  app.inject({
    method: 'DELETE', url: `/channels/${channelId}/messages/${id}`,
    headers: { authorization: `Bearer ${token}` },
  });
const list = async (token: string) => {
  const res = await app.inject({
    method: 'GET', url: `/channels/${channelId}/messages?since=0`,
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json().messages as { id: string; body: string }[];
};

/** 티켓으로 소켓을 열고 이벤트를 모은다. presence.snapshot 이 오면 구독 완료다. */
async function watch(token: string) {
  const t = await app.inject({
    method: 'POST', url: '/ws-ticket', headers: { authorization: `Bearer ${token}` },
  });
  const events: Record<string, unknown>[] = [];
  const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${t.json().ticket}`);
  ws.on('message', (d) => events.push(JSON.parse(String(d))));
  await new Promise<void>((resolve) => {
    ws.on('message', (d) => {
      if (JSON.parse(String(d)).type === 'presence.snapshot') resolve();
    });
  });
  const waitFor = async (pred: () => boolean, ms = 5000) => {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { events, waitFor, close: () => ws.close() };
}

describe('message edit', () => {
  it('lets the author rewrite their own message and marks it edited', async () => {
    const m = await post(adminToken, '오타가 있는 문장');

    const res = await edit(adminToken, m.id, '고친 문장');

    expect(res.statusCode).toBe(200);
    expect(res.json().body).toBe('고친 문장');
    expect(res.json().editedAt).not.toBeNull();
  });

  // 남의 말을 고치는 것은 되돌릴 수 없는 왜곡이다 — 삭제(가림)와 달리 admin 에게도 열지 않는다.
  it('refuses an edit by anyone but the author, admin included', async () => {
    const mine = await post(botPat, '에이전트가 쓴 문장');

    expect((await edit(adminToken, mine.id, '관리자가 고친다')).statusCode).toBe(403);
  });

  // system 메시지는 avcs 투영의 산물이다 — 사람이 고치면 저장소 이력과 채널이 어긋난다.
  it('refuses to edit a projected system message', async () => {
    const inserted = await pool.query(
      `insert into message (channel_id, author_id, body, kind)
       select $1, id, '투영된 시스템 메시지', 'system' from account where handle = 'admin'
       returning id`,
      [channelId],
    );
    const sysId = inserted.rows[0].id as string;

    expect((await edit(adminToken, sysId, '사람이 고친다')).statusCode).toBe(403);
  });

  it('pushes message.updated to connected clients', async () => {
    const w = await watch(adminToken);
    const m = await post(adminToken, '푸시 확인 전');

    await edit(adminToken, m.id, '푸시 확인 후');
    await w.waitFor(() => w.events.some((e) => e.type === 'message.updated'));

    const ev = w.events.find((e) => e.type === 'message.updated') as { message: { id: string; body: string } };
    expect(ev.message.id).toBe(m.id);
    expect(ev.message.body).toBe('푸시 확인 후');
    w.close();
  });
});

describe('message delete', () => {
  it('lets the author remove their own message from the channel', async () => {
    const m = await post(adminToken, '지울 문장');

    expect((await remove(adminToken, m.id)).statusCode).toBe(204);
    expect((await list(adminToken)).map((x) => x.id)).not.toContain(m.id);
  });

  // 삭제는 가리는 일이라 운영자에게 열어둔다 — 수정과 달리 원문을 왜곡하지 않는다.
  it('lets an admin remove someone else message', async () => {
    const theirs = await post(botPat, '에이전트 문장');

    expect((await remove(adminToken, theirs.id)).statusCode).toBe(204);
  });

  it('refuses a delete by someone who is neither author nor admin', async () => {
    const mine = await post(adminToken, '관리자 문장');

    expect((await remove(botPat, mine.id)).statusCode).toBe(403);
  });

  it('pushes message.deleted to connected clients', async () => {
    const w = await watch(adminToken);
    const m = await post(adminToken, '삭제 푸시 확인');

    await remove(adminToken, m.id);
    await w.waitFor(() => w.events.some((e) => e.type === 'message.deleted'));

    const ev = w.events.find((e) => e.type === 'message.deleted') as { messageId: string; channelId: string };
    expect(ev.messageId).toBe(m.id);
    expect(ev.channelId).toBe(channelId);
    w.close();
  });

  it('refuses to edit a message that was already deleted', async () => {
    const m = await post(adminToken, '지우고 나서 고치기');
    await remove(adminToken, m.id);

    expect((await edit(adminToken, m.id, '되살리기')).statusCode).toBe(404);
  });

  it('404s for a message that belongs to another channel', async () => {
    const other = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'elsewhere-edits' },
    });
    const otherId = other.json().id as string;
    const there = await app.inject({
      method: 'POST', url: `/channels/${otherId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { body: '저쪽 문장' },
    });

    expect((await edit(adminToken, there.json().id, '이쪽에서 고치기')).statusCode).toBe(404);
  });
});
