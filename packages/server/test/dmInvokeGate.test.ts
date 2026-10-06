// DM 도 호출 게이트를 지난다(스펙 2026-09-20 §6). 멘션·스레드 답글과 같은 판정이고, 부를 수 없는
// 에이전트와는 DM 을 새로 열지 않는다. 꺼 두거나 지운 에이전트는 어떤 길로도 부르지 않는다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { createStaleRequestSweeper } from '../src/services/staleRequests.js';

let app: FastifyInstance; let stop: () => Promise<void>; let pool: Pool;
let adminToken: string;
let owner: { token: string; accountId: string }; let stranger: { token: string; accountId: string };
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function agentWith(handle: string, scope: string) {
  const made = await createAgent(app, adminToken, handle);
  const res = await app.inject({
    method: 'PATCH', url: `/accounts/agents/${made.accountId}`, headers: auth(adminToken),
    payload: { ownerAccountId: owner.accountId, invokeScope: scope },
  });
  expect(res.statusCode).toBe(200);
  return made;
}
async function openDm(token: string, otherId: string) {
  return app.inject({ method: 'POST', url: '/dms', headers: auth(token), payload: { accountIds: [otherId] } });
}
async function say(token: string, channelId: string, body: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body } });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}
/** PAT 를 쓰지 않고 DB 로 본다 — 꺼 둔 에이전트는 PAT 가 폐기돼 /inbox 를 못 읽는다. */
async function inboxRows(accountId: string, messageId: string): Promise<number> {
  const res = await pool.query(`select 1 from inbox where account_id = $1 and message_id = $2`, [accountId, messageId]);
  return res.rowCount ?? 0;
}
async function failuresIn(rootId: string): Promise<number> {
  const res = await pool.query(
    `select 1 from message where coalesce(thread_root_id, id) = $1 and id <> $1 and meta->>'kind' = 'failure'`, [rootId]);
  return res.rowCount ?? 0;
}
const sweep = () => createStaleRequestSweeper(pool, {
  presence: { online: () => [], offlineSince: () => null }, staleAfterMs: 0, startupGraceMs: 0,
}).sweep();

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  owner = await createMember(app, adminToken, 'dmowner');
  stranger = await createMember(app, adminToken, 'dmstranger');
});
afterAll(async () => { await app.close(); await stop(); });

describe('DM 호출 게이트', () => {
  it('owner 에이전트: 남은 새 DM 을 못 연다(403), 소유자는 연다', async () => {
    const a = await agentWith('dmprivy', 'owner');
    expect((await openDm(stranger.token, a.accountId)).statusCode).toBe(403);
    expect((await openDm(owner.token, a.accountId)).statusCode).toBe(201);
  });

  it('owner 에이전트: 소유자의 DM 은 inbox 에 들어간다', async () => {
    const a = await agentWith('dmprivy2', 'owner');
    const dm = (await openDm(owner.token, a.accountId)).json().id as string;
    const id = await say(owner.token, dm, '해 줘');
    expect(await inboxRows(a.accountId, id)).toBe(1);
  });

  it('owner 에이전트: 이미 있는 DM 에 남이 써도 inbox 에 안 들어가고 실패 카드도 없다', async () => {
    // 범위가 좁혀지기 전에 열린 DM — 열 때는 community 였다(owner 를 넓히는 것은 막혀 있으니 좁히는 쪽으로).
    const a = await agentWith('dmprivy3', 'community');
    const dm = (await openDm(stranger.token, a.accountId)).json().id as string;
    const narrowed = await app.inject({
      method: 'PATCH', url: `/accounts/agents/${a.accountId}`, headers: auth(adminToken), payload: { invokeScope: 'owner' },
    });
    expect(narrowed.statusCode).toBe(200);
    // 이미 있는 DM 은 다시 열어도 그대로 돌려준다.
    expect((await openDm(stranger.token, a.accountId)).statusCode).toBe(201);
    const id = await say(stranger.token, dm, '해 줘');
    expect(await inboxRows(a.accountId, id)).toBe(0);
    await sweep();
    expect(await failuresIn(id)).toBe(0);
  });

  it('community 에이전트: 누구의 DM 이든 inbox 에 들어간다', async () => {
    const a = await agentWith('dmopen', 'community');
    const dm = (await openDm(stranger.token, a.accountId)).json().id as string;
    const id = await say(stranger.token, dm, '해 줘');
    expect(await inboxRows(a.accountId, id)).toBe(1);
  });

  it('channel 에이전트: DM 멤버십은 범위를 주지 않는다 — 새 DM 403', async () => {
    const a = await agentWith('dmchan', 'channel');
    expect((await openDm(stranger.token, a.accountId)).statusCode).toBe(403);
  });

  it('사람끼리의 DM 은 그대로다', async () => {
    const dm = (await openDm(stranger.token, owner.accountId)).json().id as string;
    const id = await say(stranger.token, dm, '안녕');
    expect(await inboxRows(owner.accountId, id)).toBe(1);
  });
});

describe('꺼 둔 에이전트', () => {
  it('멘션·DM 모두 inbox 에 안 들어가고, 남아 있던 요청에도 실패 카드를 달지 않는다', async () => {
    const a = await agentWith('dmoff', 'community');
    const dm = (await openDm(stranger.token, a.accountId)).json().id as string;
    const before = await say(stranger.token, dm, '먼저 온 요청');
    expect(await inboxRows(a.accountId, before)).toBe(1);

    const off = await app.inject({
      method: 'PATCH', url: `/accounts/agents/${a.accountId}`, headers: auth(adminToken), payload: { disabled: true },
    });
    expect(off.statusCode).toBe(200);

    const after = await say(stranger.token, dm, '꺼진 뒤 요청');
    expect(await inboxRows(a.accountId, after)).toBe(0);
    expect((await openDm(owner.token, a.accountId)).statusCode).toBe(403);

    const chan = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'offgate', visibility: 'public' } });
    const mention = await say(stranger.token, chan.json().id, '@dmoff 해 줘');
    expect(await inboxRows(a.accountId, mention)).toBe(0);

    await sweep();
    expect(await failuresIn(before)).toBe(0);
  });
});
