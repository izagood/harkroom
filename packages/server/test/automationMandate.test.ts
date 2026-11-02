import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';
import { deleteAutomation, updateAutomation } from '../src/services/automations.js';
import { addMandateLine, findLine } from '../src/services/mandateLines.js';
import { validMandateOwner } from '../src/services/mandates.js';
import { endIdleMandates } from '../src/services/mandateEnd.js';

// 위임장 ⑤b — 자동화당 하나(소유자 결정 2026-11-02 「자동화당 하나」, security 조건 1~5).
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('automation mandate (⑤b)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let tm: string;
  let other: string;
  let op: { token: string; operatorId: string };
  let ch: string;
  let n = 0;

  const asAgent = (id: string) => ({ ...auth(op.token), 'x-harkroom-agent': id });
  const lease = async (cause: string, agent = tm) =>
    (await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: asAgent(agent), payload: { causeMessageId: cause } })).json().lease as { id: string } | undefined;
  const leaseMandate = async (id: string) =>
    (await pool.query(`select mandate_id from secret_turn_lease where id = $1`, [id])).rows[0].mandate_id as string | null;
  const automation = async (ownerId: string, o: { trigger?: object; approved?: boolean } = {}) => (await pool.query(
    `insert into automation (owner_id, channel_id, name, body, trigger, approved_at, enabled) values ($1, $2, 'a', '@tm 주간 점검', $3, $4, true) returning id`,
    [ownerId, ch, JSON.stringify(o.trigger ?? { kind: 'schedule', freq: 'weekly', weekdays: [1], time: '09:00', tz: 'Asia/Seoul' }), o.approved === false ? null : new Date()])).rows[0].id as string;
  /** 회차 하나 — 자동화 소유자 이름의 글(meta.automation) + 회차 행. 회차 글은 사람 세션 글이 아니다. */
  const run = async (automationId: string, ownerId: string, o: { triggerKind?: string; initiatedBy?: string | null } = {}) => {
    n += 1;
    const r = await postMessage(pool, {
      channelId: ch, authorId: ownerId, body: `@tm 주간 점검 ${n}`, threadRootId: null,
      meta: { automation: { id: automationId, name: 'a', trigger: o.triggerKind ?? 'schedule', runId: 'x' } },
    });
    if (r.failure) throw new Error(String(r.failure));
    const mid = r.message.id as string;
    // 부름 상한(같은 글쓴이의 잦은 멘션)에 걸려도 시험이 회차를 볼 수 있게 인박스 줄을 보장한다.
    await pool.query(`insert into inbox (account_id, message_id, reason) select $1, $2, 'mention' where not exists (select 1 from inbox where account_id = $1 and message_id = $2)`, [tm, mid]);
    await pool.query(
      `insert into automation_run (automation_id, event_key, trigger_kind, status, message_id, initiated_by) values ($1, $2, $3, 'sent', $4, $5)`,
      [automationId, `k${n}`, o.triggerKind ?? 'schedule', mid, o.initiatedBy ?? null]);
    return mid;
  };
  const mandateRow = async (id: string) =>
    (await pool.query(`select owner_account_id as owner, delegator_account_id as delegator, automation_id as "automationId", root_message_id as root, ended_at as "endedAt", end_reason as reason from mandate where id = $1`, [id])).rows[0];

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    const admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    tm = (await createAgent(app, admin.token, 'tm')).accountId;
    other = (await createAgent(app, admin.token, 'other')).accountId;
    await pool.query(`update agent_config set owner_account_id = $2, invoke_scope = 'community', user_decide = true where account_id = any($1::uuid[])`, [[tm, other], alice.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    for (const a of [tm, other]) await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [a, op.operatorId, admin.accountId]);
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'auto' } })).json().id as string;
    await pool.query(`insert into channel_member (channel_id, account_id) select $1, unnest($2::uuid[]) on conflict do nothing`, [ch, [alice.accountId, bob.accountId, tm, other]]);
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('scheduled run → the turn lease gets the automation mandate (owner = agent owner, delegator = automation owner); the run post itself has no key', async () => {
    const a = await automation(alice.accountId);
    const m1 = await run(a, alice.accountId);
    const l1 = (await lease(m1))!;
    const md = (await leaseMandate(l1.id))!;
    expect(md).toBeTruthy();
    expect(await mandateRow(md)).toMatchObject({ owner: alice.accountId, delegator: alice.accountId, automationId: a, root: null, endedAt: null });
    expect((await pool.query(`select mandate_id from message where id = $1`, [m1])).rows[0].mandate_id).toBeNull();
    // 다음 회차도 같은 위임장.
    expect(await leaseMandate((await lease(await run(a, alice.accountId)))!.id)).toBe(md);
    expect((await pool.query(`select count(*)::int as n from audit_log where action = 'mandate.created' and target = $1`, [md])).rows[0].n).toBe(1);
  });

  it('security 1·2: manual run only by the delegator; agent/other person runs and outside-event runs get no key', async () => {
    const a = await automation(alice.accountId);
    expect(await leaseMandate((await lease(await run(a, alice.accountId, { triggerKind: 'manual', initiatedBy: alice.accountId })))!.id)).toBeTruthy();
    expect(await leaseMandate((await lease(await run(a, alice.accountId, { triggerKind: 'manual', initiatedBy: bob.accountId })))!.id)).toBeNull();
    expect(await leaseMandate((await lease(await run(a, alice.accountId, { triggerKind: 'manual', initiatedBy: other })))!.id)).toBeNull();
    expect(await leaseMandate((await lease(await run(a, alice.accountId, { triggerKind: 'github' })))!.id)).toBeNull();
    // 승인 안 된(제안) 자동화도 키 없음.
    const p = await automation(alice.accountId, { approved: false });
    expect(await leaseMandate((await lease(await run(p, alice.accountId)))!.id)).toBeNull();
  });

  it('delegator re-judged every run: a user automation gets owner = agent owner, delegator = user, and loses the key once they may no longer decide', async () => {
    const a = await automation(bob.accountId);
    const md = (await leaseMandate((await lease(await run(a, bob.accountId)))!.id))!;
    expect(await mandateRow(md)).toMatchObject({ owner: alice.accountId, delegator: bob.accountId, automationId: a });
    await pool.query(`update agent_config set invoke_scope = 'list' where account_id = $1`, [tm]);
    expect(await leaseMandate((await lease(await run(a, bob.accountId)))!.id)).toBeNull();
    await pool.query(`update agent_config set invoke_scope = 'community' where account_id = $1`, [tm]);
  });

  it('lives with the automation, not 7 days idle; disabling ends it and closes its lines; next run gets a new mandate', async () => {
    const a = await automation(alice.accountId);
    const md = (await leaseMandate((await lease(await run(a, alice.accountId)))!.id))!;
    await addMandateLine(pool, { mandateId: md, cap: 'merge', scope: 'repo:acme-org/auto', grantedBy: alice.accountId, via: 'button' });
    await pool.query(`update mandate set last_activity_at = now() - interval '30 days' where id = $1`, [md]);
    expect(await validMandateOwner(pool, md)).toBe(alice.accountId);
    await endIdleMandates(pool);
    expect((await mandateRow(md)).endedAt).toBeNull();
    expect(await findLine(pool, { mandateId: md, agentId: tm, cap: 'merge', action: { cap: 'merge', repo: 'acme-org/auto' } })).not.toBeNull();
    // 자동 일시정지처럼 행만 꺼져도 판정은 곧바로 막힌다.
    await pool.query(`update automation set enabled = false where id = $1`, [a]);
    expect(await validMandateOwner(pool, md)).toBeNull();
    await pool.query(`update automation set enabled = true where id = $1`, [a]);
    expect(await updateAutomation(pool, a, alice.accountId, { enabled: false })).toBeTruthy();
    expect(await mandateRow(md)).toMatchObject({ reason: 'automation_off' });
    expect((await pool.query(`select count(*)::int as n from mandate_line where mandate_id = $1 and revoked_at is null`, [md])).rows[0].n).toBe(0);
    await updateAutomation(pool, a, alice.accountId, { enabled: true });
    const md2 = (await leaseMandate((await lease(await run(a, alice.accountId)))!.id))!;
    expect(md2).toBeTruthy();
    expect(md2).not.toBe(md);
  });

  it('security 3: editing body/trigger/channel ends the mandate (automation_changed); deleting ends it (automation_off)', async () => {
    const a = await automation(alice.accountId);
    const md = (await leaseMandate((await lease(await run(a, alice.accountId)))!.id))!;
    await updateAutomation(pool, a, alice.accountId, { name: 'renamed' });
    expect((await mandateRow(md)).endedAt).toBeNull();
    await updateAutomation(pool, a, alice.accountId, { body: '@tm 다른 일' });
    expect(await mandateRow(md)).toMatchObject({ reason: 'automation_changed' });
    const md2 = (await leaseMandate((await lease(await run(a, alice.accountId)))!.id))!;
    expect(md2).not.toBe(md);
    expect(await deleteAutomation(pool, a, alice.accountId)).toBe(true);
    expect(await mandateRow(md2)).toMatchObject({ reason: 'automation_off' });
  });

  it('security 4: the run post never becomes a mandate root — owner reply in the run thread keeps it keyless', async () => {
    const a = await automation(alice.accountId);
    const m1 = await run(a, alice.accountId);
    const r = await postMessage(pool, { channelId: ch, authorId: alice.accountId, body: '@tm 이어서', threadRootId: m1, authVia: 'session' });
    if (r.failure) throw new Error(String(r.failure));
    expect((await pool.query(`select mandate_id from message where id = $1`, [m1])).rows[0].mandate_id).toBeNull();
    expect((await pool.query(`select mandate_id from message where id = $1`, [r.message.id])).rows[0].mandate_id).toBeNull();
    expect((await pool.query(`select count(*)::int as n from mandate where root_message_id = $1`, [m1])).rows[0].n).toBe(0);
  });

  it('migration 155: a mandate has exactly one of root message or automation', async () => {
    await expect(pool.query(`insert into mandate (owner_account_id, channel_id) values ($1, $2)`, [alice.accountId, ch])).rejects.toThrow();
    const a = await automation(alice.accountId);
    const root = (await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'x', 'user') returning id`, [ch, alice.accountId])).rows[0].id;
    await expect(pool.query(`insert into mandate (owner_account_id, root_message_id, thread_root_id, automation_id, channel_id) values ($1, $2, $2, $3, $4)`, [alice.accountId, root, a, ch])).rejects.toThrow();
  });
});
