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

/**
 * **피드 페이지**(`feed=1`) — 채널 본문에 서는 줄(머리·alsoInChannel 답글)만으로 옛 페이지를 채운다.
 *
 * 기본 갈래는 답글까지 섞어 limit 을 채운다. 답글이 많은 채널은 그 페이지가 답글뿐이라 화면에 늘어나는 줄이
 * 없고, 화면은 다음 페이지를 부를 스크롤 이벤트를 다시 받지 못해 맨 위에서 멈췄다(스레드 36caac7a).
 */
describe('feed page (feed=1)', () => {
  let feedChannel: string;
  const post = async (payload: Record<string, unknown>) => {
    const res = await app.inject({
      method: 'POST', url: `/channels/${feedChannel}/messages`,
      headers: { authorization: `Bearer ${adminToken}` }, payload,
    });
    return res.json() as { id: string; seq: number };
  };
  const page = async (query: string) => {
    const res = await app.inject({
      method: 'GET', url: `/channels/${feedChannel}/messages?${query}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    return res;
  };
  let top: { id: string; seq: number };
  let busy: { id: string; seq: number };

  beforeAll(async () => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'feed-history' },
    });
    feedChannel = ch.json().id;
    await post({ body: 'root-1' });
    busy = await post({ body: 'root-2' });
    // root-2 의 스레드가 길다 — 기본 갈래의 옛 페이지는 이 답글들로 다 찬다.
    for (let i = 1; i <= 6; i += 1) {
      await post({ body: `reply-${i}`, threadRootId: busy.id, alsoInChannel: i === 3 });
    }
    top = await post({ body: 'root-3' });
  });

  it('fills the older page with channel-feed rows only — roots and alsoInChannel replies', async () => {
    const res = await page(`before=${top.seq}&limit=2&feed=1`);
    expect(res.statusCode).toBe(200);
    expect(res.json().messages.map((m: { body: string }) => m.body)).toEqual(['root-2', 'reply-3']);
    // root-1 이 남았다 — 「본문에 설 줄이 더 있나」로 답한다.
    expect(res.json().hasMore).toBe(true);
  });

  it('says hasMore=false when no feed row is older, even though replies are', async () => {
    const res = await page(`before=${busy.seq}&limit=5&feed=1`);
    expect(res.json().messages.map((m: { body: string }) => m.body)).toEqual(['root-1']);
    expect(res.json().hasMore).toBe(false);
    // 비어 오면 끝이다.
    const none = await page(`before=${res.json().messages[0].seq}&feed=1`);
    expect(none.json()).toEqual({ messages: [], hasMore: false });
  });

  it('keeps the default page unchanged — replies still fill it', async () => {
    const res = await page(`before=${top.seq}&limit=2`);
    expect(res.json().messages.map((m: { body: string }) => m.body)).toEqual(['reply-5', 'reply-6']);
    const direct = await listMessages(pool, feedChannel, { before: top.seq, limit: 2, feed: true });
    expect(direct.map((m) => m.body)).toEqual(['root-2', 'reply-3']);
  });

  it('still shows a deleted root that has live replies (tombstone), and counts it for hasMore', async () => {
    const lone = await post({ body: 'root-4' });
    await post({ body: 'keeps-root-4', threadRootId: lone.id });
    const del = await app.inject({
      method: 'DELETE', url: `/channels/${feedChannel}/messages/${lone.id}`, headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBeLessThan(300);
    const last = await post({ body: 'root-5' });
    const res = await page(`before=${last.seq}&limit=1&feed=1`);
    const rows = res.json().messages as Array<{ id: string; deletedAt: string | null }>;
    expect(rows.map((m) => m.id)).toEqual([lone.id]);
    expect(rows[0]!.deletedAt).not.toBeNull();
    expect(res.json().hasMore).toBe(true);
  });

  it('refuses feed=1 without before, or with thread — it only means a channel older page', async () => {
    expect((await page('feed=1')).statusCode).toBe(400);
    expect((await page('since=0&feed=1')).statusCode).toBe(400);
    expect((await page(`around=${top.seq}&feed=1`)).statusCode).toBe(400);
    expect((await page(`before=${top.seq}&thread=${busy.id}&feed=1`)).statusCode).toBe(400);
    expect((await page(`before=${top.seq}&feed=true`)).statusCode).toBe(400);
  });
});
