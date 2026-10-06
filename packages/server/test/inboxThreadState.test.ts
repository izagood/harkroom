// Inbox 보드 2/2 — 스레드 하나에 대한 **나만의** 완료·나중에(089).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { InboxThreadState } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';
import { removeChannelMember } from '../src/services/channels.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let otherToken: string;
let botId: string;
let channelId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ token: otherToken } = await createMember(app, adminToken, 'other'));
  ({ accountId: botId } = await createAgent(app, adminToken, 'statebot'));
  const ch = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'inbox-state' } });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

async function post(body: string, threadRootId: string | null = null, ch = channelId) {
  const posted = await postMessage(pool, { channelId: ch, authorId: botId, body, threadRootId, meta: {} });
  return (posted as { message: { id: string } }).message.id;
}
const put = (token: string, rootId: string, payload: object) =>
  app.inject({ method: 'PUT', url: `/inbox/threads/${rootId}`, headers: auth(token), payload });
async function states(token: string): Promise<InboxThreadState[]> {
  const res = await app.inject({ method: 'GET', url: '/inbox?threads=1', headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json().threadStates;
}
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

describe('PUT /inbox/threads/:rootId', () => {
  it('완료·나중에·되돌리기가 내 보드에 실린다', async () => {
    const root = await post('@admin 일 하나');
    expect((await put(adminToken, root, { state: 'done' })).statusCode).toBe(200);
    expect((await states(adminToken)).find((s) => s.rootId === root)).toMatchObject({ state: 'done', until: null });

    const until = inAnHour();
    expect((await put(adminToken, root, { state: 'later', until })).statusCode).toBe(200);
    const later = (await states(adminToken)).find((s) => s.rootId === root)!;
    expect(later.state).toBe('later');
    expect(Date.parse(later.until!)).toBe(Date.parse(until));

    expect((await put(adminToken, root, { state: null })).statusCode).toBe(200);
    expect((await states(adminToken)).some((s) => s.rootId === root)).toBe(false);
  });

  it('바꾸는 것은 언제나 내 행이다 — 남이 정해도 내 보드는 그대로다', async () => {
    const root = await post('@admin @other 둘이 같이 볼 일');
    expect((await put(otherToken, root, { state: 'done' })).statusCode).toBe(200);
    expect((await states(adminToken)).some((s) => s.rootId === root)).toBe(false);
    expect((await states(otherToken)).find((s) => s.rootId === root)?.state).toBe('done');
  });

  it('볼 수 없는 채널의 루트는 403 이고 행이 생기지 않는다', async () => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'state-private', visibility: 'private' },
    });
    const root = await post('비공개 일', null, ch.json().id);
    expect((await put(otherToken, root, { state: 'done' })).statusCode).toBe(403);
    const n = await pool.query('select count(*)::int as n from inbox_thread_state where root_id = $1', [root]);
    expect(n.rows[0].n).toBe(0);
  });

  it('나간 채널의 상태는 응답에 실리지 않는다', async () => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'state-leave', visibility: 'private' },
    });
    const privateId = ch.json().id as string;
    const root = await post('@admin 나갈 채널의 일', null, privateId);
    expect((await put(adminToken, root, { state: 'done' })).statusCode).toBe(200);
    expect((await states(adminToken)).some((s) => s.rootId === root)).toBe(true);
    await removeChannelMember(pool, privateId, adminId);
    expect((await states(adminToken)).some((s) => s.rootId === root)).toBe(false);
  });

  it('답글·없는 메시지·잘못된 나중에는 거절한다', async () => {
    const root = await post('@admin 머리');
    const reply = await post('@admin 답글', root);
    expect((await put(adminToken, reply, { state: 'done' })).statusCode).toBe(400);
    expect((await put(adminToken, '00000000-0000-4000-8000-000000000000', { state: 'done' })).statusCode).toBe(404);
    expect((await put(adminToken, root, { state: 'later' })).statusCode).toBe(400);
    expect((await put(adminToken, root, { state: 'later', until: new Date(Date.now() - 1000).toISOString() })).statusCode).toBe(400);
    expect((await put(adminToken, root, { state: 'later', until: new Date(Date.now() + 91 * 86_400_000).toISOString() })).statusCode).toBe(400);
  });
});
