// 인박스 「오늘」(C안 P1, 167) — seen 커서·열린 것·끝난 것·ETag 먼저 비교.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { InboxTodayDone, InboxTodayOpen } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let otherToken: string;
let otherId: string;
let botId: string;
let channelId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ token: otherToken, accountId: otherId } = await createMember(app, adminToken, 'other'));
  ({ accountId: botId } = await createAgent(app, adminToken, 'todaybot'));
  const ch = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'today' } });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

async function post(body: string, opts: { root?: string | null; ch?: string; meta?: Record<string, unknown> } = {}) {
  const posted = await postMessage(pool, {
    channelId: opts.ch ?? channelId, authorId: botId, body, threadRootId: opts.root ?? null, meta: opts.meta ?? {},
  });
  return (posted as { message: { id: string } }).message.id;
}
const askMeta = (to: Record<string, unknown> = { kind: 'human' }, prompt = '어느 쪽?') => ({
  kind: 'ask', ask: { prompt, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], to },
});
const getOpen = (token: string, etag?: string) =>
  app.inject({ method: 'GET', url: '/inbox/today/open', headers: { ...auth(token), ...(etag ? { 'if-none-match': etag } : {}) } });
async function open(token: string): Promise<InboxTodayOpen> {
  const res = await getOpen(token);
  expect(res.statusCode).toBe(200);
  return res.json();
}
const getDone = (token: string, qs = '', etag?: string) =>
  app.inject({ method: 'GET', url: `/inbox/today/done${qs}`, headers: { ...auth(token), ...(etag ? { 'if-none-match': etag } : {}) } });
const putSeen = (token: string, upTo: string) =>
  app.inject({ method: 'PUT', url: '/inbox/today/seen', headers: auth(token), payload: { upTo } });

describe('PUT /inbox/today/seen', () => {
  it('greatest 로만 오르고, 미래는 지금으로 잘리고, 계정마다 따로다', async () => {
    const t1 = new Date(Date.now() - 3_600_000).toISOString();
    const r1 = await putSeen(adminToken, t1);
    expect(r1.statusCode).toBe(200);
    expect(Date.parse(r1.json().seenAt)).toBe(Date.parse(t1));
    // 되감기 없음
    const r2 = await putSeen(adminToken, new Date(Date.now() - 7_200_000).toISOString());
    expect(Date.parse(r2.json().seenAt)).toBe(Date.parse(t1));
    // 미래는 지금으로
    const r3 = await putSeen(adminToken, new Date(Date.now() + 86_400_000).toISOString());
    expect(Date.parse(r3.json().seenAt)).toBeLessThanOrEqual(Date.now() + 1000);
    // 남의 줄은 그대로(없음)
    const n = await pool.query('select count(*)::int as n from inbox_view_cursor where account_id = $1', [otherId]);
    expect(n.rows[0].n).toBe(0);
    expect((await putSeen(adminToken, 'yesterday')).statusCode).toBe(400);
    // 뒤 테스트가 isNew 를 보도록 seen 을 아주 옛날로 되돌릴 수는 없다 — 그래서 여기선 1시간 전까지만 올렸다.
  });
});

describe('GET /inbox/today/open', () => {
  it('나를 부른 열린 사람 앞 카드가 서고, 답하면 빠지며 태그가 바뀐다(304 → 200)', async () => {
    const id = await post('@admin 골라 줘', { meta: askMeta() });
    const first = await getOpen(adminToken);
    expect(first.statusCode).toBe(200);
    const item = (first.json() as InboxTodayOpen).items.find((i) => i.messageId === id)!;
    expect(item).toMatchObject({ kind: 'ask', question: '어느 쪽?', isNew: true, ageDays: 0, staleHint: null, authorId: botId });
    expect(item.options).toEqual([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]);
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    expect((await getOpen(adminToken, etag)).statusCode).toBe(304);

    // 다른 사람(other)이 답한다 — admin 의 inbox 에는 새 줄이 생기지 않는다. 그래도 태그는 바뀌어야 한다.
    const ans = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${id}/ask-answer`, headers: auth(otherToken), payload: { optionId: 'a' },
    });
    expect(ans.statusCode).toBe(200);
    const after = await getOpen(adminToken, etag);
    expect(after.statusCode).toBe(200);
    expect((after.json() as InboxTodayOpen).items.some((i) => i.messageId === id)).toBe(false);
    expect(after.headers.etag).not.toBe(etag);
  });

  it('태그는 계정마다 갈린다', async () => {
    const a = await getOpen(adminToken);
    const b = await getOpen(otherToken);
    expect(a.headers.etag).not.toBe(b.headers.etag);
    expect((await getOpen(otherToken, a.headers.etag as string)).statusCode).toBe(200);
  });

  it('볼 수 없는 채널(내가 없는 비공개)의 카드는 나오지 않는다', async () => {
    const priv = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'today-private', visibility: 'private' },
    });
    const privId = priv.json().id as string;
    await app.inject({ method: 'POST', url: `/channels/${privId}/members`, headers: auth(adminToken), payload: { accountId: botId } });
    const id = await post('@other 비밀 질문', { ch: privId, meta: askMeta() });
    // 나간 뒤에도 남은 inbox 줄을 흉내 낸다 — 술어가 걸러야 한다.
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [otherId, id]);
    expect((await open(otherToken)).items.some((i) => i.messageId === id)).toBe(false);
  });

  it('staleHint: 같은 작성자의 더 새 카드 → newer_card, 스레드 ✅ → thread_done', async () => {
    const root = await post('@admin 일');
    const old = await post('@admin 첫 카드', { root, meta: askMeta() });
    await pool.query(`update message set created_at = now() - interval '1 minute' where id = $1`, [old]);
    const newer = await post('@admin 둘째 카드', { root, meta: askMeta() });
    let items = (await open(adminToken)).items;
    expect(items.find((i) => i.messageId === old)?.staleHint).toBe('newer_card');
    expect(items.find((i) => i.messageId === newer)?.staleHint).toBe(null);

    await pool.query(
      `insert into thread_status (root_id, status, emoji) values ($1, 'done', '✅')
       on conflict (root_id) do update set status = 'done', updated_at = now()`, [root]);
    items = (await open(adminToken)).items;
    expect(items.find((i) => i.messageId === newer)?.staleHint).toBe('thread_done');
  });

  it('진행·기다림은 수로만 낸다', async () => {
    const r1 = await post('@admin 도는 일');
    const r2 = await post('@admin 기다리는 일');
    await pool.query(
      `insert into thread_status (root_id, status, emoji) values ($1, 'running', '💬'), ($2, 'waiting', '⏳')
       on conflict (root_id) do update set status = excluded.status, updated_at = now()`, [r1, r2]);
    const o = await open(adminToken);
    expect(o.counts.running).toBeGreaterThanOrEqual(1);
    expect(o.counts.waiting).toBeGreaterThanOrEqual(1);
    expect(o.items.some((i) => i.threadRootId === r1)).toBe(false);
  });
});

describe('GET /inbox/today/done', () => {
  it('보고·끝난 스레드를 since·limit·cursor 로 넘긴다', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const base = await getDone(adminToken, `?since=${Buffer.from(JSON.stringify([since, ''])).toString('base64url')}&limit=50`);
    const before = (base.json() as InboxTodayDone).items.length;
    const reps: string[] = [];
    for (let k = 0; k < 3; k++) reps.push(await post(`@admin 보고 ${k}`, { meta: { kind: 'report', report: { summary: `s${k}` } } }));
    const root = await post('@admin 끝날 일');
    await pool.query(`insert into thread_status (root_id, status, emoji) values ($1, 'done', '✅')`, [root]);

    const cur = Buffer.from(JSON.stringify([since, ''])).toString('base64url');
    const p1 = await getDone(adminToken, `?since=${cur}&limit=2`);
    expect(p1.statusCode).toBe(200);
    const b1 = p1.json() as InboxTodayDone;
    expect(b1.items).toHaveLength(2);
    expect(b1.nextCursor).toBeTruthy();
    const all = [...b1.items];
    let next = b1.nextCursor;
    while (next) {
      const p = (await getDone(adminToken, `?since=${next}&limit=2`)).json() as InboxTodayDone;
      all.push(...p.items);
      next = p.nextCursor;
    }
    expect(all.length).toBe(before + 4);
    expect(new Set(all.map((i) => `${i.kind}${i.messageId}`)).size).toBe(all.length);
    for (const r of reps) expect(all.some((i) => i.kind === 'report' && i.messageId === r)).toBe(true);
    expect(all.some((i) => i.kind === 'thread_done' && i.messageId === root)).toBe(true);
    // 남은 끝난 것은 보이지 않는다
    const others = (await getDone(otherToken, `?since=${cur}`)).json() as InboxTodayDone;
    expect(others.items.some((i) => reps.includes(i.messageId))).toBe(false);

    expect((await getDone(adminToken, '?since=garbage')).statusCode).toBe(400);
    expect((await getDone(adminToken, '?limit=51')).statusCode).toBe(400);
  });

  it('ETag: 그대로면 304, 새 보고가 오면 200', async () => {
    const first = await getDone(adminToken);
    const etag = first.headers.etag as string;
    expect((await getDone(adminToken, '', etag)).statusCode).toBe(304);
    await post('@admin 새 보고', { meta: { kind: 'report', report: { summary: 'x' } } });
    expect((await getDone(adminToken, '', etag)).statusCode).toBe(200);
  });

  it('ETag: 내가 못 보는 채널의 스레드 상태는 태그를 바꾸지 않고, 내 스레드의 상태는 바꾼다', async () => {
    const priv = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'today-done-private', visibility: 'private' },
    });
    const privId = priv.json().id as string;
    await app.inject({ method: 'POST', url: `/channels/${privId}/members`, headers: auth(adminToken), payload: { accountId: botId } });
    const hidden = await post('비공개 스레드', { ch: privId });
    const mine = await post('@other 내가 불린 스레드');
    const first = await getDone(otherToken);
    const etag = first.headers.etag as string;
    expect((await getDone(otherToken, '', etag)).statusCode).toBe(304);
    await pool.query(`insert into thread_status (root_id, status, emoji) values ($1, 'done', '✅')`, [hidden]);
    expect((await getDone(otherToken, '', etag)).statusCode).toBe(304);
    await pool.query(`insert into thread_status (root_id, status, emoji) values ($1, 'done', '✅')`, [mine]);
    expect((await getDone(otherToken, '', etag)).statusCode).toBe(200);
  });
});
