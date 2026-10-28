import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';

// 위임 ⓐ — 위임 없는 머리 아래 소유자 답글이 자기 에이전트를 깨우면 그 머리를 뿌리로 위임을 만든다.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('mandate W1 — owner reply under a keyless root', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let tm: string; let sec: string; let stranger: string;
  let op: { token: string; operatorId: string };
  let ch: string;

  const asAgent = (id: string) => ({ ...auth(op.token), 'x-harkroom-agent': id });
  const post = async (authorId: string, body: string, o: { threadRootId?: string; chainCause?: string; authVia?: 'session' | 'pat' } = {}) => {
    const r = await postMessage(pool, { channelId: ch, authorId, body, threadRootId: o.threadRootId ?? null, chainCause: o.chainCause ?? null, authVia: o.authVia ?? 'session' });
    if (r.failure) throw new Error(String(r.failure));
    return r.message.id as string;
  };
  const mandateOf = async (messageId: string) =>
    (await pool.query(`select mandate_id from message where id = $1`, [messageId])).rows[0]?.mandate_id as string | null;
  const lease = async (causeMessageId: string, agent: string) =>
    (await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: asAgent(agent), payload: { causeMessageId } })).json().lease as { id: string; token: string };
  const leaseMandate = async (id: string) =>
    (await pool.query(`select mandate_id from secret_turn_lease where id = $1`, [id])).rows[0]?.mandate_id as string | null;

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    tm = (await createAgent(app, admin.token, 'tm')).accountId;
    sec = (await createAgent(app, admin.token, 'sec')).accountId;
    stranger = (await createAgent(app, admin.token, 'stranger')).accountId;
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = any($1::uuid[])`, [[tm, sec], alice.accountId]);
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [stranger, bob.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    for (const a of [tm, sec, stranger]) {
      await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [a, op.operatorId, admin.accountId]);
    }
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'mandate' } })).json().id as string;
    await pool.query(
      `insert into channel_member (channel_id, account_id) select $1, unnest($2::uuid[]) on conflict do nothing`,
      [ch, [alice.accountId, bob.accountId, tm, sec, stranger]]);
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  const mandatesFor = async (rootId: string) =>
    (await pool.query(`select id, owner_account_id, ended_at from mandate where root_message_id = $1`, [rootId])).rows as { id: string; owner_account_id: string; ended_at: Date | null }[];

  it('owner reply that wakes own agent under a keyless owner root creates a mandate rooted there; lease and later replies inherit', async () => {
    const root = await post(alice.accountId, 'just talking');
    expect(await mandateOf(root)).toBeNull();
    const reply = await post(alice.accountId, '@tm please look', { threadRootId: root });
    const m = await mandateOf(reply);
    expect(m).toBeTruthy();
    expect(await mandatesFor(root)).toEqual([expect.objectContaining({ id: m, owner_account_id: alice.accountId, ended_at: null })]);
    expect(await mandateOf(root)).toBe(m);
    const l = await lease(reply, tm);
    expect(await leaseMandate(l.id)).toBe(m);
    // 같은 스레드의 다음 소유자 답글은 같은 위임을 잇는다(새로 만들지 않는다).
    expect(await mandateOf(await post(alice.accountId, 'and this', { threadRootId: root }))).toBe(m);
    expect(await mandatesFor(root)).toHaveLength(1);
  });

  it('root by the owner\'s own agent (keyless) → created', async () => {
    const root = await post(tm, 'status update');
    expect(await mandateOf(root)).toBeNull();
    const reply = await post(alice.accountId, '@sec check this', { threadRootId: root });
    const m = await mandateOf(reply);
    expect(m).toBeTruthy();
    expect((await mandatesFor(root))[0]?.owner_account_id).toBe(alice.accountId);
  });

  it('no mandate: root by another human, root by another owner\'s agent, PAT reply, reply waking no own agent', async () => {
    const bobRoot = await post(bob.accountId, 'bob says');
    expect(await mandateOf(await post(alice.accountId, '@tm look', { threadRootId: bobRoot }))).toBeNull();
    expect(await mandatesFor(bobRoot)).toHaveLength(0);

    const strangerRoot = await post(stranger, 'stranger says');
    expect(await mandateOf(await post(alice.accountId, '@tm look', { threadRootId: strangerRoot }))).toBeNull();
    expect(await mandatesFor(strangerRoot)).toHaveLength(0);

    const own = await post(alice.accountId, 'mine');
    expect(await mandateOf(await post(alice.accountId, '@tm look', { threadRootId: own, authVia: 'pat' }))).toBeNull();
    expect(await mandateOf(await post(alice.accountId, 'no mention', { threadRootId: own }))).toBeNull();
    expect(await mandateOf(await post(alice.accountId, '@stranger look', { threadRootId: own }))).toBeNull();
    expect(await mandatesFor(own)).toHaveLength(0);
  });

  it('ended mandate on the root is not revived and no new one is made', async () => {
    const root = await post(alice.accountId, '@tm go');
    const m = await mandateOf(root);
    await pool.query(`update mandate set ended_at = now(), end_reason = 'test' where id = $1`, [m]);
    expect(await mandateOf(await post(alice.accountId, '@tm again', { threadRootId: root }))).toBeNull();
    // 머리의 키가 지워졌어도(행만 남은 경우) 되살리지 않는다.
    await pool.query(`update message set mandate_id = null where id = $1`, [root]);
    expect(await mandateOf(await post(alice.accountId, '@tm again', { threadRootId: root }))).toBeNull();
    const rows = await mandatesFor(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ended_at).not.toBeNull();
  });

  it('two concurrent owner replies make one mandate and both carry it', async () => {
    const root = await post(alice.accountId, 'race');
    const [a, b] = await Promise.all([
      post(alice.accountId, '@tm one', { threadRootId: root }),
      post(alice.accountId, '@sec two', { threadRootId: root }),
    ]);
    const rows = await mandatesFor(root);
    expect(rows).toHaveLength(1);
    expect(await mandateOf(a)).toBe(rows[0]!.id);
    expect(await mandateOf(b)).toBe(rows[0]!.id);
    // 감사도 하나뿐이다 — 기다린 쪽은 먼저 온 쪽의 위임을 이었을 뿐이다.
    expect(await createdAudits(root)).toEqual([expect.objectContaining({ via: 'owner_reply', mandateId: rows[0]!.id })]);
  });

  const createdAudits = async (rootId: string) =>
    (await pool.query(
      `select actor_id, target, detail from audit_log where action = 'mandate.created' and detail->>'rootMessageId' = $1 order by id`,
      [rootId])).rows.map((r) => ({ actorId: r.actor_id as string, target: r.target as string, ...(r.detail as Record<string, unknown>) }));

  it('mandate.created: new owner root → one audit via root; continuing replies add none', async () => {
    const root = await post(alice.accountId, '@tm start');
    const m = await mandateOf(root);
    expect(m).toBeTruthy();
    expect(await createdAudits(root)).toEqual([{
      actorId: alice.accountId, target: m, mandateId: m, rootMessageId: root, channelId: ch, threadRootId: root, via: 'root',
    }]);
    expect(await mandateOf(await post(alice.accountId, '@tm more', { threadRootId: root }))).toBe(m);
    expect(await mandateOf(await post(alice.accountId, 'and more', { threadRootId: root }))).toBe(m);
    expect(await createdAudits(root)).toHaveLength(1);
  });

  it('mandate.created: owner reply under a keyless root → via owner_reply once; no audit when nothing is made', async () => {
    const root = await post(alice.accountId, 'keyless');
    const reply = await post(alice.accountId, '@tm now', { threadRootId: root });
    const m = await mandateOf(reply);
    expect(await createdAudits(root)).toEqual([{
      actorId: alice.accountId, target: m, mandateId: m, rootMessageId: root, channelId: ch, threadRootId: root, via: 'owner_reply',
    }]);
    expect(await mandateOf(await post(alice.accountId, '@sec continue', { threadRootId: root }))).toBe(m);
    expect(await createdAudits(root)).toHaveLength(1);

    const plain = await post(alice.accountId, 'nobody woken');
    expect(await createdAudits(plain)).toHaveLength(0);
    const bobRoot = await post(bob.accountId, 'bob root');
    await post(alice.accountId, '@tm look', { threadRootId: bobRoot });
    expect(await createdAudits(bobRoot)).toHaveLength(0);
  });
});
