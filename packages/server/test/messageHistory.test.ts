import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import { listMessages } from '../src/services/messages.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'history' },
  });
  channelId = ch.json().id;
  for (let i = 1; i <= 12; i += 1) {
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { body: `m${i}` },
    });
  }
});
afterAll(async () => { await app.close(); await stop(); });

const get = async (query: string) => {
  const res = await app.inject({
    method: 'GET', url: `/channels/${channelId}/messages?${query}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  return res;
};

describe('backward history cursor', () => {
  // 전방 커서(since)만 있으면 최신 창 밖으로 밀려난 대화에 도달할 경로가 없다.
  it('returns the page immediately before a given seq, in ascending order', async () => {
    const latest = await listMessages(pool, channelId, { limit: 4 });
    const oldestShown = latest[0]!.seq;

    const older = await listMessages(pool, channelId, { before: oldestShown, limit: 4 });

    expect(older.map((m) => m.body)).toEqual(['m5', 'm6', 'm7', 'm8']);
    expect(older.every((m) => m.seq < oldestShown)).toBe(true);
  });

  it('reports whether older messages remain', async () => {
    const res = await get('limit=4');
    expect(res.json().hasMore).toBe(true);

    const first = await listMessages(pool, channelId, { limit: 4 });
    let cursor = first[0]!.seq;
    for (let page = 0; page < 3; page += 1) {
      const older = await get(`before=${cursor}&limit=4`);
      if (older.json().messages.length) cursor = older.json().messages[0].seq;
      else break;
    }
    const exhausted = await get(`before=${cursor}&limit=4`);
    expect(exhausted.json().messages).toHaveLength(0);
    expect(exhausted.json().hasMore).toBe(false);
  });

  it('walks the whole channel backwards without gaps or repeats', async () => {
    const seen: string[] = [];
    let cursor: number | null = null;
    for (let page = 0; page < 10; page += 1) {
      const res = await get(cursor === null ? 'limit=5' : `before=${cursor}&limit=5`);
      const rows = res.json().messages as { seq: number; body: string }[];
      if (!rows.length) break;
      seen.unshift(...rows.map((r) => r.body));
      cursor = rows[0]!.seq;
    }
    expect(seen).toEqual(['m1','m2','m3','m4','m5','m6','m7','m8','m9','m10','m11','m12']);
  });

  it('refuses before and since together — they are opposite directions', async () => {
    expect((await get('before=5&since=2')).statusCode).toBe(400);
  });
});
