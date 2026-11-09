// A1·A2(2026-11): `GET /inbox` 전체 조회는 최신 200줄 + `before` 커서, `/inbox/board` 의 ETag 는 본문보다 먼저 잰다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { InboxEntry } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { postMessage, INBOX_PAGE_LIMIT } from '../src/services/messages.js';
import { refreshThreadStatus } from '../src/services/threadStatus.js';

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
  ({ accountId: botId } = await createAgent(app, adminToken, 'capbot'));
  const ch = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'cap' } });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

async function post(authorId: string, body: string, threadRootId: string | null = null, meta: Record<string, unknown> = {}) {
  const posted = await postMessage(pool, { channelId, authorId, body, threadRootId, meta });
  return (posted as { message: { id: string } }).message.id;
}

async function inbox(qs: string) {
  const res = await app.inject({ method: 'GET', url: `/inbox${qs}`, headers: auth(adminToken) });
  expect(res.statusCode).toBe(200);
  return res.json() as { entries: InboxEntry[]; truncated?: boolean; threads?: unknown[] };
}

async function boardEtag(etag?: string) {
  const res = await app.inject({
    method: 'GET', url: '/inbox/board', headers: { ...auth(adminToken), ...(etag ? { 'if-none-match': etag } : {}) },
  });
  return { status: res.statusCode, etag: res.headers.etag as string };
}

describe('GET /inbox 상한(A1)', () => {
  it('since·unread 없으면 최신 200줄, 오름차순, truncated, before 로 이어 받는다', async () => {
    const root = await post(botId, '많은 부름의 머리');
    // 직접 행을 넣는다 — 부름 경로 250번은 느리다. 줄 모양은 같다.
    await pool.query(
      `insert into inbox (account_id, message_id, reason) select $1, $2, 'mention' from generate_series(1, 250)`,
      [adminId, root],
    );
    const { rows } = await pool.query<{ n: number }>('select count(*)::int as n from inbox where account_id = $1', [adminId]);
    const total = rows[0]!.n;
    expect(total).toBeGreaterThan(INBOX_PAGE_LIMIT);

    const first = await inbox('');
    expect(first.entries).toHaveLength(INBOX_PAGE_LIMIT);
    expect(first.truncated).toBe(true);
    const ids = first.entries.map((e) => e.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    const { rows: maxRow } = await pool.query<{ m: number }>('select max(id)::int as m from inbox where account_id = $1', [adminId]);
    expect(ids[ids.length - 1]).toBe(maxRow[0]!.m);

    const second = await inbox(`?before=${ids[0]}`);
    expect(second.entries).toHaveLength(total - INBOX_PAGE_LIMIT);
    expect(second.truncated).toBe(false);
    expect(Math.max(...second.entries.map((e) => e.id))).toBeLessThan(ids[0]!);

    // threads=1 은 잘린 줄 위에서 그대로 돈다.
    const withThreads = await inbox('?threads=1');
    expect(withThreads.entries).toHaveLength(INBOX_PAGE_LIMIT);
    expect(withThreads.truncated).toBe(true);
    expect(Array.isArray(withThreads.threads)).toBe(true);
  });

  it('unread=1 과 since 는 예전처럼 다 준다(상한·truncated 없음)', async () => {
    const unread = await inbox('?unread=1');
    expect(unread.entries.length).toBeGreaterThan(INBOX_PAGE_LIMIT);
    expect(unread.truncated).toBeUndefined();
    const since = await inbox('?since=0');
    expect(since.entries.length).toBeGreaterThan(INBOX_PAGE_LIMIT);
    expect(since.truncated).toBeUndefined();
  });

  it('보드는 여전히 inbox 전부를 받는다', async () => {
    const res = await app.inject({ method: 'GET', url: '/inbox/board', headers: auth(adminToken) });
    expect((res.json().entries as unknown[]).length).toBeGreaterThan(INBOX_PAGE_LIMIT);
  });
});

describe('/inbox/board ETag 먼저(A2)', () => {
  let root: string;
  let askId: string;

  beforeAll(async () => {
    root = await post(adminId, '@capbot 보드 일');
    askId = await post(botId, '어느 쪽?', root, { kind: 'ask', ask: { question: '어느 쪽?', options: ['a', 'b'] } });
    await refreshThreadStatus(pool, root, null);
  });

  async function expectChanged(change: () => Promise<unknown>) {
    const before = await boardEtag();
    expect(before.status).toBe(200);
    const same = await boardEtag(before.etag);
    expect(same.status).toBe(304);
    await change();
    const after = await boardEtag(before.etag);
    expect(after.status).toBe(200);
    expect(after.etag).not.toBe(before.etag);
  }

  it('바뀐 것이 없으면 304 이고 태그는 그대로다', async () => {
    const a = await boardEtag();
    expect((await boardEtag(a.etag)).status).toBe(304);
    expect((await boardEtag()).etag).toBe(a.etag);
  });

  it('보드 스레드에 새 답글', () => expectChanged(() => post(botId, '진행 중', root)));

  it('물음 카드 답 — meta 만 jsonb_set 으로 바뀌어도', () => expectChanged(() => pool.query(
    `update message set meta = jsonb_set(meta, '{ask,answeredWith}', '"a"'::jsonb) where id = $1`, [askId],
  )));

  it('읽음 상태', () => expectChanged(() => pool.query(
    'update inbox set read_at = now() where id = (select max(id) from inbox where account_id = $1)', [adminId],
  )));

  it('읽음 되돌리기', () => expectChanged(() => pool.query(
    'update inbox set read_at = null where id = (select max(id) from inbox where account_id = $1)', [adminId],
  )));

  it('리액션', () => expectChanged(() => pool.query(
    `insert into message_reaction (message_id, account_id, emoji) values ($1, $2, '👍')`, [root, botId],
  )));

  it('스레드 처리 상태(PUT /inbox/threads/:rootId)', () => expectChanged(async () => {
    const res = await app.inject({
      method: 'PUT', url: `/inbox/threads/${root}`, headers: auth(adminToken), payload: { state: 'done' },
    });
    expect(res.statusCode).toBeLessThan(300);
  }));

  it('thread_status 갱신', () => expectChanged(() => pool.query(
    `update thread_status set updated_at = now() + interval '1 second' where root_id = $1`, [root],
  )));
});
