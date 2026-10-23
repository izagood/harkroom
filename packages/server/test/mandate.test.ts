import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';
import { scheduleWake } from '../src/services/agentWakes.js';

// 위임(mandate) W1 — 키 적기와 그림자 기록. 판정은 바뀌지 않는다.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const SHA = 'c'.repeat(40);
const REPO = 'izagood/harkroom';

describe('mandate W1', () => {
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
  const post = async (authorId: string, body: string, o: { threadRootId?: string; chainCause?: string } = {}) => {
    const r = await postMessage(pool, { channelId: ch, authorId, body, threadRootId: o.threadRootId ?? null, chainCause: o.chainCause ?? null, authVia: 'session' });
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

  it('owner new thread that wakes own agent creates a mandate; owner reply reuses it and bumps activity', async () => {
    const root = await post(alice.accountId, '@tm please look');
    const m = await mandateOf(root);
    expect(m).toBeTruthy();
    const before = (await pool.query(`select owner_account_id, root_message_id, last_activity_at from mandate where id = $1`, [m])).rows[0];
    expect(before).toMatchObject({ owner_account_id: alice.accountId, root_message_id: root });
    const reply = await post(alice.accountId, 'also this', { threadRootId: root });
    expect(await mandateOf(reply)).toBe(m);
    const after = (await pool.query(`select last_activity_at from mandate where id = $1`, [m])).rows[0];
    expect(after.last_activity_at.getTime()).toBeGreaterThanOrEqual(before.last_activity_at.getTime());
  });

  it('no mandate: other human reply, owner mentioning someone else\'s agent, owner thread with no agent', async () => {
    const root = await post(alice.accountId, '@tm go');
    expect(await mandateOf(await post(bob.accountId, 'me too', { threadRootId: root }))).toBeNull();
    expect(await mandateOf(await post(alice.accountId, '@stranger go'))).toBeNull();
    expect(await mandateOf(await post(alice.accountId, 'just talking'))).toBeNull();
    // bob 이 자기 에이전트를 불러도 alice 의 위임은 아니다 — bob 의 위임이다.
    const bobRoot = await post(bob.accountId, '@stranger go');
    const bm = await mandateOf(bobRoot);
    expect((await pool.query(`select owner_account_id from mandate where id = $1`, [bm])).rows[0].owner_account_id).toBe(bob.accountId);
  });

  it('lease inherits; agent post inherits from lease (same owner only)', async () => {
    const root = await post(alice.accountId, '@tm @stranger go');
    const m = await mandateOf(root);
    const l = await lease(root, tm);
    expect(await leaseMandate(l.id)).toBe(m);
    // 다른 소유자의 에이전트 임대는 물려받지 않는다.
    const ls = await lease(root, stranger);
    expect(await leaseMandate(ls.id)).toBeNull();
    // tm 의 글(원인 = root) → 임대의 위임.
    const hop = await post(tm, '@sec take over', { threadRootId: root, chainCause: root });
    expect(await mandateOf(hop)).toBe(m);
    // 같은 소유자 sec 이 그 글로 받은 임대·글도 잇는다.
    const ls2 = await lease(hop, sec);
    expect(await leaseMandate(ls2.id)).toBe(m);
    // stranger 의 글은 null.
    expect(await mandateOf(await post(stranger, 'hi', { threadRootId: root, chainCause: root }))).toBeNull();
    // 임대가 없는 원인은 null.
    expect(await mandateOf(await post(tm, 'no lease', { threadRootId: root, chainCause: hop }))).toBeNull();
  });

  it('wake row stores the mandate and the woken lease inherits it', async () => {
    const root = await post(alice.accountId, '@tm wait for CI');
    const m = await mandateOf(root);
    await lease(root, tm);
    const w = await scheduleWake(pool, { accountId: tm, channelId: ch, threadRootId: root, notBeforeSec: 60, reason: 'ci', chainCause: root });
    expect(w.wake).toBeTruthy();
    expect((await pool.query(`select mandate_id from agent_wake where id = $1`, [w.wake!.id])).rows[0].mandate_id).toBe(m);
    // 깨움이 울린 것처럼 inbox 를 만든다.
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'wake')`, [tm, w.wake!.messageId]);
    const wl = await lease(w.wake!.messageId, tm);
    expect(await leaseMandate(wl.id)).toBe(m);
  });

  it('merge check writes mandate.shadow and keeps the real verdict', async () => {
    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at) values ($1, 'repo.merge', $2, $3, $4)`,
      [tm, `repo:${REPO}`, alice.accountId, new Date(Date.now() + 7 * 86_400_000)]);
    const root = await post(alice.accountId, '@tm merge it');
    const m = await mandateOf(root);
    const l = await lease(root, tm);
    const res = await app.inject({ method: 'POST', url: '/agent/merge-checks', headers: asAgent(tm), payload: { leaseId: l.id, token: l.token, repo: REPO, number: 9, headSha: SHA } });
    expect(res.statusCode).toBe(200);
    const shadow = (await pool.query(`select detail from audit_log where action = 'mandate.shadow' and detail->>'leaseId' = $1`, [l.id])).rows[0]?.detail;
    expect(shadow).toMatchObject({ chainVerdict: 'allowed', mandateVerdict: 'allowed', mandateId: m, agentId: tm });

    // 사슬로는 끊기는 턴(stranger 위임 → tm): 실제 판정은 그대로 cause_not_human, 그림자는 위임 없음.
    const sroot = await post(bob.accountId, '@stranger hi');
    await lease(sroot, stranger);
    const shop = await post(stranger, '@tm do it', { threadRootId: sroot, chainCause: sroot });
    const l2 = await lease(shop, tm);
    const res2 = await app.inject({ method: 'POST', url: '/agent/merge-checks', headers: asAgent(tm), payload: { leaseId: l2.id, token: l2.token, repo: REPO, number: 10, headSha: SHA } });
    expect(res2.statusCode).toBe(403);
    expect(res2.json().error.code).toBe('cause_not_human');
    const s2 = (await pool.query(`select detail from audit_log where action = 'mandate.shadow' and detail->>'leaseId' = $1`, [l2.id])).rows[0]?.detail;
    expect(s2).toMatchObject({ chainVerdict: 'cause_not_human', mandateVerdict: 'denied', mandateId: null });
  });
});
