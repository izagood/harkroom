import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';
import { mintPat } from '../src/services/pats.js';
import { addMandateLine, findLine } from '../src/services/mandateLines.js';
import { endIdleMandates } from '../src/services/mandateEnd.js';
import { upsertWorkItem } from '../src/services/workItems.js';
import { MANDATE_IDLE_MS } from '../src/services/mandates.js';

// 위임 끝(3판) — 소유자 [위임 끝]·7일 idle 스윕·일감 done. 줄 회수·카드 endedAt·되살리지 않음.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const REPO = 'izagood/harkroom';
const ACT = { cap: 'merge' as const, repo: REPO };

describe('mandate end', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let tm: string;
  let op: { token: string; operatorId: string };
  let ch: string;

  const asAgent = (id: string) => ({ ...auth(op.token), 'x-harkroom-agent': id });
  const post = async (authorId: string, body: string, threadRootId: string | null = null) => {
    const r = await postMessage(pool, { channelId: ch, authorId, body, threadRootId, authVia: 'session' });
    if (r.failure) throw new Error(String(r.failure));
    return r.message.id as string;
  };
  const mandateOf = async (messageId: string) =>
    (await pool.query(`select mandate_id from message where id = $1`, [messageId])).rows[0]?.mandate_id as string | null;
  const mandateRow = async (id: string) =>
    (await pool.query(`select ended_at, end_reason from mandate where id = $1`, [id])).rows[0] as { ended_at: Date | null; end_reason: string | null };
  const liveLines = async (id: string) =>
    (await pool.query(`select count(*)::int as n from mandate_line where mandate_id = $1 and revoked_at is null`, [id])).rows[0].n as number;
  const thread = async () => {
    const root = await post(alice.accountId, '@tm go');
    const m = (await mandateOf(root))!;
    expect(m).toBeTruthy();
    const l = await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: `repo:${REPO}`, grantedBy: alice.accountId, via: 'button' });
    expect(l.ok).toBe(true);
    expect(await findLine(pool, { mandateId: m, agentId: tm, cap: 'merge', action: ACT })).toBeTruthy();
    return { root, m };
  };
  const card = async (root: string, m: string, status = 'pending') => {
    const requestId = (await pool.query(
      `insert into permission_request (agent_id, kind, target, reason, warnings, channel_id, thread_root_id, created_at, expires_at, mandate_id, status)
       values ($1, 'merge', $2, 'x', '{}', $3, $4, now(), now() + interval '1 day', $5, $6) returning id`,
      [tm, `repo:${REPO}`, ch, root, m, status])).rows[0].id as string;
    const cardId = (await pool.query(
      `insert into message (channel_id, author_id, body, kind, meta, thread_root_id) values ($1, $2, '카드', 'user', $3, $4) returning id`,
      [ch, tm, JSON.stringify({ permissionRequest: { requestId, status, mandate: { id: m, name: 'x' } } }), root])).rows[0].id as string;
    await pool.query(`update permission_request set card_message_id = $2 where id = $1`, [requestId, cardId]);
    return cardId;
  };
  const cardMandate = async (cardId: string) =>
    (await pool.query(`select meta->'permissionRequest'->'mandate' as m from message where id = $1`, [cardId])).rows[0].m as Record<string, unknown>;

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    tm = (await createAgent(app, admin.token, 'tm')).accountId;
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [tm, alice.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [tm, op.operatorId, admin.accountId]);
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'ending' } })).json().id as string;
    await pool.query(
      `insert into channel_member (channel_id, account_id) select $1, unnest($2::uuid[]) on conflict do nothing`,
      [ch, [alice.accountId, bob.accountId, tm]]);
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('POST /mandates/:id/end: owner session ends it; others 404; lines revoked; card stamped; audit', async () => {
    const { root, m } = await thread();
    const open = await card(root, m);
    const closed = await card(root, m, 'granted');
    const url = `/mandates/${m}/end`;
    expect((await app.inject({ method: 'POST', url, headers: auth(bob.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url, headers: auth(admin.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url, headers: asAgent(tm) })).statusCode).toBe(404);
    const pat = await mintPat(pool, alice.accountId, 'end-pat', { actorId: null, actorHandle: null });
    if (!pat.ok) throw new Error('pat');
    expect([401, 404]).toContain((await app.inject({ method: 'POST', url, headers: auth(pat.token) })).statusCode);
    expect((await app.inject({ method: 'POST', url: '/mandates/nope/end', headers: auth(alice.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url })).statusCode).toBe(401);
    expect((await mandateRow(m)).ended_at).toBeNull();

    const ok = await app.inject({ method: 'POST', url, headers: auth(alice.token) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ended: true, endReason: 'owner', endedAt: expect.any(String) });
    expect((await mandateRow(m)).end_reason).toBe('owner');
    expect(await liveLines(m)).toBe(0);
    expect(await findLine(pool, { mandateId: m, agentId: tm, cap: 'merge', action: ACT })).toBeNull();
    expect((await cardMandate(open)).endedAt).toBe(ok.json().endedAt);
    expect((await cardMandate(closed)).endedAt).toBeUndefined();
    const audit = (await pool.query(`select actor_id, detail from audit_log where action = 'mandate.ended' and target = $1`, [m])).rows;
    expect(audit).toEqual([{ actor_id: alice.accountId, detail: { reason: 'owner' } }]);

    // 멱등 — 다시 눌러도 200, 끝은 그대로.
    const again = await app.inject({ method: 'POST', url, headers: auth(alice.token) });
    expect(again.json()).toMatchObject({ ended: false, endReason: 'owner', endedAt: ok.json().endedAt });
    // 끝난 위임에는 줄을 더하지 않는다.
    expect(await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: `repo:${REPO}`, grantedBy: alice.accountId, via: 'button' }))
      .toMatchObject({ ok: false, code: 'mandate_ended' });

    // 그 스레드의 소유자 답글은 위임을 되살리지 않는다. 새 머리는 새 위임.
    const reply = await post(alice.accountId, '@tm more', root);
    expect(await mandateOf(reply)).toBeNull();
    expect((await mandateRow(m)).ended_at).not.toBeNull();
    const fresh = await post(alice.accountId, '@tm new thread');
    const m2 = await mandateOf(fresh);
    expect(m2).toBeTruthy();
    expect(m2).not.toBe(m);
  });

  it('work item done on the thread root ends its mandate (work_done)', async () => {
    const { root, m } = await thread();
    const open = await card(root, m);
    const active = await upsertWorkItem(pool, { ownerId: alice.accountId, actorId: tm, source: 'github', externalKey: 'izagood/harkroom#1', title: 't', url: null, state: 'active', threadRootId: root });
    expect('item' in active).toBe(true);
    expect((await mandateRow(m)).ended_at).toBeNull();
    const done = await upsertWorkItem(pool, { ownerId: alice.accountId, actorId: tm, source: 'github', externalKey: 'izagood/harkroom#1', title: 't', url: null, state: 'done', threadRootId: root });
    expect('item' in done).toBe(true);
    expect((await mandateRow(m)).end_reason).toBe('work_done');
    expect(await liveLines(m)).toBe(0);
    expect(await findLine(pool, { mandateId: m, agentId: tm, cap: 'merge', action: ACT })).toBeNull();
    expect(typeof (await cardMandate(open)).endedAt).toBe('string');
    expect((await pool.query(`select detail from audit_log where action = 'mandate.ended' and target = $1`, [m])).rows[0].detail).toEqual({ reason: 'work_done' });
  });

  it('a done work item of another owner does not end the mandate', async () => {
    const { root, m } = await thread();
    const out = await upsertWorkItem(pool, { ownerId: bob.accountId, actorId: bob.accountId, source: 'github', externalKey: 'izagood/harkroom#2', title: 't', url: null, state: 'done', threadRootId: root });
    expect('item' in out).toBe(true);
    expect((await mandateRow(m)).ended_at).toBeNull();
  });

  it('idle sweep ends mandates with no owner activity for 7 days', async () => {
    const a = await thread();
    const b = await thread();
    const open = await card(a.root, a.m);
    await pool.query(`update mandate set last_activity_at = $2 where id = $1`, [a.m, new Date(Date.now() - MANDATE_IDLE_MS - 60_000)]);
    expect(await endIdleMandates(pool)).toBeGreaterThanOrEqual(1);
    expect((await mandateRow(a.m)).end_reason).toBe('idle');
    expect((await mandateRow(b.m)).ended_at).toBeNull();
    expect(await liveLines(a.m)).toBe(0);
    expect(await liveLines(b.m)).toBe(1);
    expect(typeof (await cardMandate(open)).endedAt).toBe('string');
    // 다시 돌려도 끝난 것은 다시 끝내지 않는다.
    expect(await endIdleMandates(pool)).toBe(0);
    // idle 로 끝난 스레드의 답글도 되살리지 않는다.
    expect(await mandateOf(await post(alice.accountId, '@tm back', a.root))).toBeNull();
  });
});
