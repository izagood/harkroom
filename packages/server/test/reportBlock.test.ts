// 신고와 차단(109). 신고는 볼 수 있는 메시지만, 관리자가 큐에서 처리를 적는다. 차단한 사람에게 상대의
// 글이 부름(inbox)을 만들지 않고, 둘 사이에 새 DM 을 열 수 없다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>; let pool: Pool;
let adminToken: string; let adminId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
async function openDm(token: string, otherId: string) {
  return app.inject({ method: 'POST', url: '/dms', headers: auth(token), payload: { accountIds: [otherId] } });
}
async function say(token: string, channelId: string, body: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body } });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}
const report = (token: string, messageId: string, payload: object = { reason: 'abuse' }) =>
  app.inject({ method: 'POST', url: `/messages/${messageId}/report`, headers: auth(token), payload });
async function inboxRows(accountId: string, messageId: string): Promise<number> {
  const res = await pool.query(`select 1 from inbox where account_id = $1 and message_id = $2`, [accountId, messageId]);
  return res.rowCount ?? 0;
}

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool;
  app = await buildServer({
    pool: db.pool, rateLimits: { login: { windowMs: 60_000, max: 1000 }, signup: { windowMs: 60_000, max: 1000 } },
  });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
});
afterAll(async () => { await app.close(); await stop(); });

describe('신고', () => {
  it('볼 수 있는 메시지를 신고하면 관리자 큐에 오른다; 다시 신고해도 하나다', async () => {
    const a = await createMember(app, adminToken, 'repa');
    const b = await createMember(app, adminToken, 'repb');
    const dm = (await openDm(a.token, b.accountId)).json().id as string;
    const id = await say(b.token, dm, '나쁜 글');
    const first = await report(a.token, id, { reason: 'abuse', note: '욕설' });
    expect(first.statusCode).toBe(201);
    const again = await report(a.token, id);
    expect(again.statusCode).toBe(200);
    expect(again.json().duplicate).toBe(true);

    const queue = await app.inject({ method: 'GET', url: '/admin/reports', headers: auth(adminToken) });
    expect(queue.statusCode).toBe(200);
    const mine = queue.json().reports.filter((r: { messageId: string }) => r.messageId === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ reason: 'abuse', note: '욕설', reporterId: a.accountId, authorId: b.accountId, body: '나쁜 글' });
  });

  it('신고 당시 본문을 남긴다 — 작성자가 고치거나 지워도 관리자는 처음 것을 본다', async () => {
    const a = await createMember(app, adminToken, 'reps1');
    const b = await createMember(app, adminToken, 'reps2');
    const dm = (await openDm(a.token, b.accountId)).json().id as string;
    const id = await say(b.token, dm, '원래 글');
    expect((await report(a.token, id)).statusCode).toBe(201);
    const edited = await app.inject({
      method: 'PATCH', url: `/channels/${dm}/messages/${id}`, headers: auth(b.token), payload: { body: '고친 글' },
    });
    expect(edited.statusCode).toBe(200);
    const row = (await app.inject({ method: 'GET', url: '/admin/reports', headers: auth(adminToken) }))
      .json().reports.find((r: { messageId: string }) => r.messageId === id);
    expect(row).toMatchObject({ bodyAtReport: '원래 글', body: '고친 글', editedAtReport: null });
    expect(row.editedAt).not.toBeNull();
    const gone = await app.inject({ method: 'DELETE', url: `/channels/${dm}/messages/${id}`, headers: auth(b.token) });
    expect(gone.statusCode).toBeLessThan(300);
    const after = (await app.inject({ method: 'GET', url: '/admin/reports', headers: auth(adminToken) }))
      .json().reports.find((r: { messageId: string }) => r.messageId === id);
    expect(after).toMatchObject({ bodyAtReport: '원래 글', body: null, messageDeleted: true });
  });

  it('신고자마다 시간당 상한이 있고, 큐는 after 로 쪽을 넘긴다', async () => {
    const a = await createMember(app, adminToken, 'reprate');
    const b = await createMember(app, adminToken, 'reprate2');
    const dm = (await openDm(a.token, b.accountId)).json().id as string;
    let last = 0;
    for (let i = 0; i < 31; i += 1) last = (await report(a.token, await say(b.token, dm, `글 ${i}`))).statusCode;
    expect(last).toBe(429);

    const seen = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const url: string = `/admin/reports?status=all&limit=7${after ? `&after=${after}` : ''}`;
      const res = await app.inject({ method: 'GET', url, headers: auth(adminToken) });
      expect(res.statusCode).toBe(200);
      for (const r of res.json().reports as { id: string }[]) {
        expect(seen.has(r.id)).toBe(false);
        seen.add(r.id);
      }
      after = res.json().nextAfter;
      if (!after) break;
    }
    const total = await pool.query(`select count(*)::int as n from message_report`);
    expect(seen.size).toBe(total.rows[0].n);
  });

  it('볼 수 없는 메시지는 404, 내 글은 400, 사람이 아닌 것은 관리자 큐를 못 본다', async () => {
    const a = await createMember(app, adminToken, 'repc');
    const b = await createMember(app, adminToken, 'repd');
    const outsider = await createMember(app, adminToken, 'repe');
    const dm = (await openDm(a.token, b.accountId)).json().id as string;
    const id = await say(b.token, dm, '둘만의 글');
    expect((await report(outsider.token, id)).statusCode).toBe(404);
    expect((await report(b.token, id)).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/admin/reports', headers: auth(a.token) })).statusCode).toBe(403);
  });

  it('관리자가 처리를 적으면 열린 큐에서 빠지고, 두 번 처리할 수 없다', async () => {
    const a = await createMember(app, adminToken, 'repf');
    const b = await createMember(app, adminToken, 'repg');
    const dm = (await openDm(a.token, b.accountId)).json().id as string;
    const id = await say(b.token, dm, '스팸');
    const reportId = (await report(a.token, id, { reason: 'spam' })).json().report.id as string;
    const resolve = (token: string) => app.inject({
      method: 'POST', url: `/admin/reports/${reportId}/resolve`, headers: auth(token), payload: { resolution: 'dismissed' },
    });
    expect((await resolve(a.token)).statusCode).toBe(403);
    expect((await resolve(adminToken)).statusCode).toBe(204);
    expect((await resolve(adminToken)).statusCode).toBe(404);
    const open = (await app.inject({ method: 'GET', url: '/admin/reports', headers: auth(adminToken) })).json().reports;
    expect(open.some((r: { id: string }) => r.id === reportId)).toBe(false);
    const done = (await app.inject({ method: 'GET', url: '/admin/reports?status=resolved', headers: auth(adminToken) })).json().reports;
    expect(done.find((r: { id: string }) => r.id === reportId)).toMatchObject({ resolution: 'dismissed', resolvedBy: adminId });
  });
});

describe('차단', () => {
  it('차단하면 상대의 DM·멘션이 inbox 에 들어오지 않고, 풀면 다시 들어온다', async () => {
    const me = await createMember(app, adminToken, 'blkme');
    const them = await createMember(app, adminToken, 'blkthem');
    const dm = (await openDm(them.token, me.accountId)).json().id as string;
    expect(await inboxRows(me.accountId, await say(them.token, dm, '전'))).toBe(1);
    const pre = (await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'blkpre', visibility: 'public' },
    })).json().id as string;
    for (const who of [me.accountId, them.accountId]) {
      await app.inject({ method: 'POST', url: `/channels/${pre}/members`, headers: auth(adminToken), payload: { accountId: who } });
    }
    expect(await inboxRows(me.accountId, await say(them.token, pre, '@blkme 전'))).toBe(1);

    expect((await app.inject({ method: 'PUT', url: `/accounts/me/blocks/${them.accountId}`, headers: auth(me.token) })).statusCode).toBe(204);
    const list = (await app.inject({ method: 'GET', url: '/accounts/me/blocks', headers: auth(me.token) })).json().blocks;
    expect(list.map((b: { accountId: string }) => b.accountId)).toEqual([them.accountId]);
    expect(await inboxRows(me.accountId, await say(them.token, dm, '후'))).toBe(0);
    // 멘션 길 — 둘 다 채널 멤버로 두고 잰다(아니면 차단이 없어도 0 이다).
    const chan = (await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'blkchan', visibility: 'public' },
    })).json().id as string;
    for (const who of [me.accountId, them.accountId]) {
      const added = await app.inject({
        method: 'POST', url: `/channels/${chan}/members`, headers: auth(adminToken), payload: { accountId: who },
      });
      expect(added.statusCode).toBeLessThan(300);
    }
    expect(await inboxRows(me.accountId, await say(them.token, chan, '@blkme 봐'))).toBe(0);
    // 차단은 한쪽만이다 — 내가 쓴 글은 상대에게 그대로 간다.
    expect(await inboxRows(them.accountId, await say(me.token, dm, '나는'))).toBe(1);

    expect((await app.inject({ method: 'DELETE', url: `/accounts/me/blocks/${them.accountId}`, headers: auth(me.token) })).statusCode).toBe(204);
    expect(await inboxRows(me.accountId, await say(them.token, dm, '풀린 뒤'))).toBe(1);
  });

  it('어느 쪽이 막았든 새 DM 은 열 수 없다; 자기 자신은 막을 수 없다', async () => {
    const me = await createMember(app, adminToken, 'blkme2');
    const them = await createMember(app, adminToken, 'blkthem2');
    await app.inject({ method: 'PUT', url: `/accounts/me/blocks/${them.accountId}`, headers: auth(me.token) });
    const theirs = await openDm(them.token, me.accountId);
    expect(theirs.statusCode).toBe(403);
    expect(theirs.json().error.code).toBe('dm_unavailable');
    expect((await openDm(me.token, them.accountId)).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `/accounts/me/blocks/${me.accountId}`, headers: auth(me.token) })).statusCode).toBe(400);
  });
});
