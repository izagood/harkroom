import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';
import { principalForAgentPost } from '../src/services/invokePrincipal.js';

// 에이전트 호출 권한 재설계 1단계 — principal(이번 턴을 깨운 사람) 해석. 판정은 바뀌지 않는다.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('invoke principal (152)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let tm: string; let sec: string; let carol: string;
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
    const l = res.json().lease as { id: string; token: string };
    const p = (await pool.query(`select principal_account_id from secret_turn_lease where id = $1`, [l.id])).rows[0].principal_account_id as string | null;
    return { ...l, principal: p };
  };
  const principalOf = async (messageId: string) =>
    (await pool.query(`select principal_account_id from message where id = $1`, [messageId])).rows[0]?.principal_account_id as string | null;
  const raw = async (authorId: string, meta: Record<string, unknown>, inboxFor: string, reason = 'mention') => {
    const id = (await pool.query(
      `insert into message (channel_id, author_id, body, kind, meta) values ($1, $2, 'x', 'user', $3) returning id`,
      [ch, authorId, JSON.stringify(meta)])).rows[0].id as string;
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, $3)`, [inboxFor, id, reason]);
    return id;
  };

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    tm = (await createAgent(app, admin.token, 'tm')).accountId;
    sec = (await createAgent(app, admin.token, 'sec')).accountId;
    carol = (await createAgent(app, admin.token, 'carol')).accountId;
    // 1단계는 판정을 바꾸지 않는다 — 부름이 실제로 닿아야 임대를 받으므로 셋 다 누구나 부를 수 있게 둔다.
    await pool.query(`update agent_config set owner_account_id = $2, invoke_scope = 'community' where account_id = any($1::uuid[])`, [[tm, sec, carol], alice.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    for (const a of [tm, sec, carol]) {
      await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [a, op.operatorId, admin.accountId]);
    }
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'principal' } })).json().id as string;
    await pool.query(
      `insert into channel_member (channel_id, account_id) select $1, unnest($2::uuid[]) on conflict do nothing`,
      [ch, [alice.accountId, bob.accountId, tm, sec, carol]]);
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('사람이 부른 턴은 그 사람이 principal 이다', async () => {
    const m = await post(alice.accountId, '@tm hello');
    expect((await lease(m, tm)).principal).toBe(alice.accountId);
  });

  it('T2 세탁 경로 — 에이전트를 거쳐도 principal 은 맨 처음 사람(bob)이고 소유자(alice)로 바뀌지 않는다', async () => {
    const root = await post(bob.accountId, '@tm please');
    const l = await lease(root, tm);
    expect(l.principal).toBe(bob.accountId);
    const hop = await post(tm, '@sec take over', { threadRootId: root, chainCause: root });
    expect(await principalOf(hop)).toBe(bob.accountId);
    expect((await lease(hop, sec)).principal).toBe(bob.accountId);
  });

  it('T3 편승 — alice 가 연 스레드에 bob 이 답글로 깨우면 principal 은 bob 이다', async () => {
    const root = await post(alice.accountId, '@carol start');
    expect((await lease(root, carol)).principal).toBe(alice.accountId);
    const reply = await post(bob.accountId, '@carol more', { threadRootId: root });
    expect((await lease(reply, carol)).principal).toBe(bob.accountId);
  });

  it('C1 — 임대가 끝났거나 없으면 에이전트 글에 principal 을 적지 않는다', async () => {
    const root = await post(alice.accountId, '@tm one');
    const l = await lease(root, tm);
    await app.inject({ method: 'POST', url: `/agent/turn-leases/${l.id}/end`, headers: asAgent(tm), payload: { token: l.token } });
    expect(await principalOf(await post(tm, 'after end', { threadRootId: root, chainCause: root }))).toBeNull();
    // 다른 턴(sec)의 원인을 골라 넣어도 sec 자신의 임대가 아니면 읽히지 않는다.
    expect(await principalForAgentPost(pool, { agentId: sec, causeMessageId: root })).toBeNull();
  });

  it('C1 — 읽는 순간 사람이 비활성이면 null 이다', async () => {
    const dave = await createMember(app, admin.token, 'dave');
    await pool.query(`insert into channel_member (channel_id, account_id) values ($1, $2) on conflict do nothing`, [ch, dave.accountId]);
    const root = await post(dave.accountId, '@sec hi');
    expect((await lease(root, sec)).principal).toBe(dave.accountId);
    await pool.query(`update account set disabled_at = now() where id = $1`, [dave.accountId]);
    expect(await principalForAgentPost(pool, { agentId: sec, causeMessageId: root })).toBeNull();
  });

  it('C2 — wake 로 깬 턴은 null 이다(원인 글에 principal 이 있어도)', async () => {
    const root = await post(bob.accountId, '@tm wake test');
    await lease(root, tm);
    const own = await post(tm, 'later', { threadRootId: root, chainCause: root });
    expect(await principalOf(own)).toBe(bob.accountId);
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'wake')`, [tm, own]);
    expect((await lease(own, tm)).principal).toBeNull();
  });

  it('C3 — 원본 카드를 사람이 직접 누른 답만 인정한다', async () => {
    const direct = await raw(tm, { ask: { answeredBy: alice.accountId } }, tm);
    expect((await lease(direct, tm)).principal).toBe(alice.accountId);
    for (const extra of [{ mirrorOf: direct }, { answeredVia: 'bundle_bulk' }, { answeredVia: 'chat' }, { closedAt: new Date().toISOString() }]) {
      const card = await raw(tm, { ask: { answeredBy: alice.accountId, ...extra } }, tm);
      expect((await lease(card, tm)).principal).toBeNull();
    }
    // 남의 카드(작성자가 다른 에이전트)의 답은 이 에이전트의 principal 이 아니다.
    const others = await raw(sec, { ask: { answeredBy: alice.accountId } }, tm);
    expect((await lease(others, tm)).principal).toBeNull();
  });

  it('자동화 글은 null 이다', async () => {
    const m = await raw(alice.accountId, { automation: { id: 'x' } }, tm);
    expect((await lease(m, tm)).principal).toBeNull();
  });
});
