// 「내 작업」 보드 간추림(2026-10-12) — `GET /inbox/board?compact=1` 은 스레드마다 보드가 읽는 줄만 싣고 본문은
// 앞부분만 싣는다. 바뀐 것이 없으면 304. 예전 응답은 큰 계정에서 13.5MB·평균 10초였고 신호마다 다시 받았다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { InboxEntry } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { BOARD_COMPACT_BODY_CHARS, BOARD_COMPACT_LATEST } from '../src/services/messages.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let botId: string;
let channelId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ accountId: botId } = await createAgent(app, adminToken, 'compactbot'));
  channelId = (await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'compact-board' },
  })).json().id;
});
afterAll(async () => { await app.close(); await stop(); });

/** 메시지 하나를 바로 심고 admin 의 inbox 에 건다. 시각은 `ageSec` 초 전 — 순서를 시험이 정한다. */
async function seed(opts: {
  root?: string | null; body?: string; meta?: Record<string, unknown>; reason?: string; ageSec: number;
}): Promise<{ messageId: string; inboxId: number }> {
  const m = await pool.query<{ id: string }>(
    `insert into message (channel_id, author_id, body, kind, thread_root_id, meta, created_at)
     values ($1, $2, $3, 'user', $4, $5, now() - make_interval(secs => $6)) returning id`,
    [channelId, botId, opts.body ?? 'line', opts.root ?? null, JSON.stringify(opts.meta ?? {}), opts.ageSec]);
  const i = await pool.query<{ id: number }>(
    `insert into inbox (account_id, message_id, reason) values ($1, $2, $3) returning id::int`,
    [adminId, m.rows[0]!.id, opts.reason ?? 'thread_reply']);
  return { messageId: m.rows[0]!.id, inboxId: i.rows[0]!.id };
}

async function board(query = '', headers: Record<string, string> = {}, token = adminToken) {
  return app.inject({ method: 'GET', url: `/inbox/board${query}`, headers: { ...auth(token), ...headers } });
}

describe('GET /inbox/board?compact=1', () => {
  it('스레드마다 최신 줄·열린 물음·실패·사유마다 한 줄만 싣고, 본문은 앞부분만 싣는다', async () => {
    const root = await seed({ body: '@admin 이 스레드', reason: 'mention', ageSec: 1000 });
    const ask = await seed({ root: root.messageId, ageSec: 900,
      meta: { kind: 'ask', ask: { prompt: '골라', options: [{ id: 'a', label: 'A' }], to: { kind: 'human' } } } });
    const answered = await seed({ root: root.messageId, ageSec: 880,
      meta: { kind: 'ask', ask: { prompt: '끝남', options: [{ id: 'a', label: 'A' }], to: { kind: 'human' }, answeredWith: 'a' } } });
    const failure = await seed({ root: root.messageId, ageSec: 800,
      meta: { kind: 'failure', failure: { retryable: true, reason: 'x' } } });
    const replies = [];
    for (let k = 0; k < 8; k++) replies.push(await seed({ root: root.messageId, ageSec: 700 - k * 10 }));
    const long = await seed({ root: root.messageId, body: '가'.repeat(BOARD_COMPACT_BODY_CHARS + 500), ageSec: 1 });

    const full = (await board()).json().entries as InboxEntry[];
    const res = await board('?compact=1');
    expect(res.statusCode).toBe(200);
    const compact = res.json().entries as InboxEntry[];

    const ids = new Set(compact.map((e) => e.id));
    const latest = [long, ...replies.slice().reverse()].slice(0, BOARD_COMPACT_LATEST);
    for (const kept of [...latest, root, ask, failure]) expect(ids.has(kept.inboxId)).toBe(true);
    // 정해진 물음·중간의 평범한 답글은 빠진다.
    expect(ids.has(answered.inboxId)).toBe(false);
    expect(ids.has(replies[0]!.inboxId)).toBe(false);

    // 간추림은 전체의 **부분집합**이다 — 더 넓은 것(남의 줄·못 보는 채널)을 싣지 않는다. 본문 말고는 같다.
    const byId = new Map(full.map((e) => [e.id, e]));
    for (const e of compact) {
      const f = byId.get(e.id);
      expect(f).toBeDefined();
      const { body: _b, bodyTruncated: _t, ...rest } = e;
      const { body: _fb, ...frest } = f!;
      expect(rest).toEqual(frest);
      expect(f!.body.startsWith(e.body)).toBe(true);
    }
    const cut = compact.find((e) => e.id === long.inboxId)!;
    expect(cut.body.length).toBe(BOARD_COMPACT_BODY_CHARS);
    expect(cut.bodyTruncated).toBe(true);
    expect(compact.find((e) => e.id === root.inboxId)!.bodyTruncated).toBeUndefined();
    // 옛 응답은 그대로다 — 자르지 않고 표지도 없다.
    expect(byId.get(long.inboxId)!.body.length).toBe(BOARD_COMPACT_BODY_CHARS + 500);
    expect(full.some((e) => 'bodyTruncated' in e)).toBe(false);
  });

  it('바뀐 것이 없으면 304, 바뀌면 새 태그. 태그는 계정마다 갈리고 공유 캐시를 막는다', async () => {
    const first = await board('?compact=1');
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(first.headers['cache-control']).toBe('private, no-cache');

    const again = await board('?compact=1', { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');

    await seed({ body: '새 일', reason: 'mention', ageSec: 0 });
    const changed = await board('?compact=1', { 'if-none-match': etag });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);

    // 빈 보드 둘(서로 다른 계정)도 태그가 다르다 — 태그로 남의 판을 맞혀 볼 수 없다.
    const { pat: p1 } = await createAgent(app, adminToken, 'emptyone');
    const { pat: p2 } = await createAgent(app, adminToken, 'emptytwo');
    const e1 = await board('?compact=1', {}, p1);
    const e2 = await board('?compact=1', {}, p2);
    expect(e1.json()).toEqual(e2.json());
    expect(e1.headers.etag).not.toBe(e2.headers.etag);
    expect((await board('?compact=1', { 'if-none-match': e1.headers.etag as string }, p2)).statusCode).toBe(200);
  });

  /**
   * 큰 인박스에서 30초 상한(#1328) 안에 끝나는가. 운영 큰 계정(인박스 약 6천 줄, 에이전트 스레드에 답글이 몰린다)을 흉내 낸다:
   * 스레드 300 × 줄 20 = 6,300 줄, 본문 1,200자. 숫자는 로그로 남긴다(PR 본문 근거).
   */
  it('큰 인박스(6,300 줄)에서도 간추린 보드가 상한 안에 끝나고 응답이 훨씬 작다', async () => {
    await pool.query(
      `with roots as (
         insert into message (channel_id, author_id, body, kind, created_at)
         select $1, $2, repeat('본문 ', 400), 'user', now() - make_interval(secs => g * 600)
           from generate_series(1, 300) g
         returning id, created_at),
       replies as (
         insert into message (channel_id, author_id, body, kind, thread_root_id, created_at)
         select $1, $2, repeat('답글 ', 400), 'user', r.id, r.created_at + make_interval(secs => k)
           from roots r, generate_series(1, 20) k
         returning id)
       insert into inbox (account_id, message_id, reason)
       select $3::uuid, id, 'thread_reply' from replies
       union all select $3::uuid, id, 'mention' from roots`,
      [channelId, botId, adminId]);
    await pool.query('analyze inbox');
    await pool.query('analyze message');

    const t0 = Date.now();
    const full = await board();
    const fullMs = Date.now() - t0;
    const t1 = Date.now();
    const compact = await board('?compact=1');
    const compactMs = Date.now() - t1;
    console.log(`board full: ${full.json().entries.length} entries, ${full.rawPayload.length} bytes, ${fullMs}ms · `
      + `compact: ${compact.json().entries.length} entries, ${compact.rawPayload.length} bytes, ${compactMs}ms`);
    expect(compact.statusCode).toBe(200);
    expect(compactMs).toBeLessThan(30_000);
    expect(compact.rawPayload.length).toBeLessThan(full.rawPayload.length / 5);
  });
});
