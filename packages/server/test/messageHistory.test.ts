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

/**
 * 검색 결과로 **점프**할 때 쓰는 창. before·since 는 한쪽 방향만 주므로, 옛 메시지 하나를
 * 화면에 세우려면 앞뒤가 함께 와야 한다 — 앞만 오면 그 말이 화면 맨 아래에 홀로 선다.
 */
describe('around window', () => {
  it('brings the target with context on both sides', async () => {
    const all = await listMessages(pool, channelId, { limit: 500 });
    const target = all.find((m) => m.body === 'm6')!;

    const win = await listMessages(pool, channelId, { around: target.seq, limit: 4 });
    const bodies = win.map((m) => m.body);

    expect(bodies).toContain('m6');
    // 위·아래를 절반씩 — 대상 자신은 위쪽(seq <= around)에 든다.
    expect(bodies).toEqual(['m5', 'm6', 'm7', 'm8']);
  });

  /**
   * 스레드 안에서도 같아야 한다. 이 분기가 없으면 스레드 분기가 '최신 limit 개'를 주므로
   * 답글이 그보다 많은 스레드에서는 옛 답글이 창에 아예 없고, 스레드 패널에는 위로 더
   * 읽는 길도 없어 그 말에 닿을 방법이 사라진다(⌘F 의 스레드 스코프가 바로 그 길이다).
   */
  it('windows inside a thread too, root always included', async () => {
    const root = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { body: 'thread root' },
    });
    const rootId = root.json().id;
    for (let i = 1; i <= 10; i += 1) {
      await app.inject({
        method: 'POST', url: `/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { body: `r${i}`, threadRootId: rootId },
      });
    }
    const whole = await listMessages(pool, channelId, { threadRootId: rootId, limit: 500 });
    const target = whole.find((m) => m.body === 'r2')!;

    // limit 4 면 기본 분기는 최신 넷(r7..r10)만 준다 — r2 는 거기 없다.
    const latest = await listMessages(pool, channelId, { threadRootId: rootId, limit: 4 });
    expect(latest.map((m) => m.body)).not.toContain('r2');

    const win = await listMessages(pool, channelId, { threadRootId: rootId, around: target.seq, limit: 4 });
    const bodies = win.map((m) => m.body);
    expect(bodies).toContain('r2');
    expect(bodies).toContain('thread root');
    // 창이지 스레드 전체가 아니다 — 맨 끝 답글까지 딸려 오면 창의 뜻이 없다.
    expect(bodies).not.toContain('r10');
  });
});
