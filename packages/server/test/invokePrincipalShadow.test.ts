import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { editMessage, postMessage } from '../src/services/messages.js';
import { PRINCIPAL_SHADOW_REPORT_SQL } from '../src/services/invokePrincipal.js';

// 에이전트 호출 권한 재설계 2단계 — 그림자 판정. 막힌 부름은 그대로 막히고, principal 이 부를 수 있었던 것만 meta 에 남는다.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('invoke principal shadow (2단계)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let tm: string; let sec: string; let zed: string;
  let op: { token: string; operatorId: string };
  let ch: string;

  const asAgent = (id: string) => ({ ...auth(op.token), 'x-harkroom-agent': id });
  const post = async (authorId: string, body: string, o: { threadRootId?: string; chainCause?: string } = {}) => {
    const r = await postMessage(pool, { channelId: ch, authorId, body, threadRootId: o.threadRootId ?? null, chainCause: o.chainCause ?? null, authVia: 'session' });
    if (r.failure) throw new Error(String(r.failure));
    return r.message.id as string;
  };
  const lease = async (causeMessageId: string, agent: string) => {
    const res = await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: asAgent(agent), payload: { causeMessageId } });
    expect(res.statusCode).toBe(200);
  };
  const metaOf = async (id: string) =>
    (await pool.query(`select meta from message where id = $1`, [id])).rows[0].meta as Record<string, unknown> | null;
  const inboxCount = async (accountId: string, messageId: string) =>
    Number((await pool.query(`select count(*) from inbox where account_id = $1 and message_id = $2`, [accountId, messageId])).rows[0].count);
  /** tm 이 `cause` 로 깬 턴에서 `@sec @zed` 를 부른다. */
  const hop = async (cause: string, threadRootId: string) => post(tm, '@sec @zed review', { threadRootId, chainCause: cause });

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    tm = (await createAgent(app, admin.token, 'tm')).accountId;
    sec = (await createAgent(app, admin.token, 'sec')).accountId;
    zed = (await createAgent(app, admin.token, 'zed')).accountId;
    // tm 은 누구나 부른다(community) · sec 는 alice 만(owner) · zed 는 admin 만(owner).
    // tm→sec 는 지금 규칙으로 막힌다(호출자 tm 이 owner 범위가 아님) — alice 가 principal 이면 그림자에 「열렸을 부름」으로 남는다.
    await pool.query(`update agent_config set owner_account_id = $2, invoke_scope = 'community' where account_id = $1`, [tm, alice.accountId]);
    await pool.query(`update agent_config set owner_account_id = $2, invoke_scope = 'owner' where account_id = $1`, [sec, alice.accountId]);
    await pool.query(`update agent_config set owner_account_id = $2, invoke_scope = 'owner' where account_id = $1`, [zed, admin.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    for (const a of [tm, sec, zed]) {
      await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [a, op.operatorId, admin.accountId]);
    }
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'shadow' } })).json().id as string;
    await pool.query(
      `insert into channel_member (channel_id, account_id) select $1, unnest($2::uuid[]) on conflict do nothing`,
      [ch, [alice.accountId, bob.accountId, tm, sec, zed]]);
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('alice 가 깨운 턴 — sec 는 그림자에 남고 zed 는 남지 않는다. 동작은 그대로(둘 다 막힘)', async () => {
    const root = await post(alice.accountId, '@tm go');
    await lease(root, tm);
    const m = await hop(root, root);
    const meta = await metaOf(m);
    expect(meta?.mentionDenied).toEqual(['sec', 'zed']);
    expect(meta?.mentionPrincipalShadow).toEqual({ principalId: alice.accountId, handles: ['sec'], ids: [sec], causeReasons: ['mention'] });
    expect(await inboxCount(sec, m)).toBe(0);
    expect(await inboxCount(zed, m)).toBe(0);
  });

  it('T2 세탁 경로 — bob 이 깨운 턴은 그림자도 열리지 않는다', async () => {
    const root = await post(bob.accountId, '@tm go');
    await lease(root, tm);
    const meta = await metaOf(await hop(root, root));
    expect(meta?.mentionDenied).toEqual(['sec', 'zed']);
    expect(meta?.mentionPrincipalShadow).toBeUndefined();
  });

  it('T3 편승 — alice 의 스레드에 bob 이 답글로 깨운 턴은 bob 기준이다', async () => {
    const root = await post(alice.accountId, '@tm start');
    await lease(root, tm);
    const reply = await post(bob.accountId, '@tm more', { threadRootId: root });
    await lease(reply, tm);
    expect((await metaOf(await hop(reply, root)))?.mentionPrincipalShadow).toBeUndefined();
  });

  it('C1 — 임대 없이 원인 헤더만 있으면 그림자가 없다', async () => {
    const root = await post(alice.accountId, '@tm no lease');
    expect((await metaOf(await hop(root, root)))?.mentionPrincipalShadow).toBeUndefined();
  });

  it('C2 — wake 로 깬 턴은 그림자가 없다', async () => {
    const root = await post(alice.accountId, '@tm wake');
    await lease(root, tm);
    const own = await post(tm, 'later', { threadRootId: root, chainCause: root });
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'wake')`, [tm, own]);
    await lease(own, tm);
    expect((await metaOf(await hop(own, root)))?.mentionPrincipalShadow).toBeUndefined();
  });

  it('C3 — 거울 카드의 답으로 깬 턴은 그림자가 없다', async () => {
    const card = (await pool.query(
      `insert into message (channel_id, author_id, body, kind, meta) values ($1, $2, 'card', 'user', $3) returning id`,
      [ch, tm, JSON.stringify({ ask: { answeredBy: alice.accountId, mirrorOf: tm } })])).rows[0].id as string;
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [tm, card]);
    await lease(card, tm);
    expect((await metaOf(await hop(card, card)))?.mentionPrincipalShadow).toBeUndefined();
  });

  it('C4 — 수정은 저장된 principal 을 쓰지 않는다', async () => {
    const root = await post(alice.accountId, '@tm edit');
    await lease(root, tm);
    const own = await post(tm, 'plain', { threadRootId: root, chainCause: root });
    const r = await editMessage(pool, { channelId: ch, messageId: own, actorId: tm, body: '@sec now' });
    expect(typeof r).toBe('object');
    expect((await metaOf(own))?.mentionPrincipalShadow).toBeUndefined();
    expect(await inboxCount(sec, own)).toBe(0);
  });

  it('3일 집계 쿼리 — 하루별로 막힘·열렸을 부름·원인 사유를 센다', async () => {
    const rows = (await pool.query(PRINCIPAL_SHADOW_REPORT_SQL, [72])).rows as {
      denied_posts: number; opened_posts: number; opened_calls: number; no_principal_posts: number; principals: number; by_cause: Record<string, number>;
    }[];
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.opened_posts).toBe(1);
    expect(r.opened_calls).toBe(1);
    expect(r.principals).toBe(1);
    expect(r.by_cause).toEqual({ mention: 1 });
    expect(r.denied_posts).toBeGreaterThanOrEqual(6);
    expect(r.no_principal_posts).toBeGreaterThanOrEqual(3);
  });
});
