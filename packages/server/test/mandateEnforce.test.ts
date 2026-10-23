import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';
import { mintPat } from '../src/services/pats.js';
import { addMandateLine } from '../src/services/mandateLines.js';
import { mandateEnforced } from '../src/services/mergeGrants.js';

// 위임(mandate) W3 — `HARKROOM_MANDATE_ENFORCE=on` 일 때 머지 판정은 위임장의 merge 줄로 한다.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const SHA = 'd'.repeat(40);

describe('mandate enforcement flag', () => {
  it('defaults off; only "on" turns it on', () => {
    expect(mandateEnforced({})).toBe(false);
    expect(mandateEnforced({ HARKROOM_MANDATE_ENFORCE: 'off' })).toBe(false);
    expect(mandateEnforced({ HARKROOM_MANDATE_ENFORCE: 'yes' })).toBe(false);
    expect(mandateEnforced({ HARKROOM_MANDATE_ENFORCE: ' ON ' })).toBe(true);
  });
});

describe('mandate enforcement (db)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let tm: string;
  let op: { token: string; operatorId: string };
  let ch: string;
  let n = 100;

  const asAgent = (id: string) => ({ ...auth(op.token), 'x-harkroom-agent': id });
  const post = async (authorId: string, body: string, o: { threadRootId?: string; authVia?: 'session' | 'pat' | 'operator' | null } = {}) => {
    const r = await postMessage(pool, { channelId: ch, authorId, body, threadRootId: o.threadRootId ?? null, ...('authVia' in o ? { authVia: o.authVia } : { authVia: 'session' as const }) });
    if (r.failure) throw new Error(String(r.failure));
    return r.message.id as string;
  };
  const mandateOf = async (messageId: string) =>
    (await pool.query(`select mandate_id from message where id = $1`, [messageId])).rows[0]?.mandate_id as string | null;
  const lease = async (causeMessageId: string, agent: string) =>
    (await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: asAgent(agent), payload: { causeMessageId } })).json().lease as { id: string; token: string };
  const check = (l: { id: string; token: string }, repo: string, extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/agent/merge-checks', headers: asAgent(tm), payload: { leaseId: l.id, token: l.token, repo, number: n++, headSha: SHA, ...extra } });
  const shadowOf = async (leaseId: string) =>
    (await pool.query(`select detail from audit_log where action = 'mandate.shadow' and detail->>'leaseId' = $1 order by id desc limit 1`, [leaseId])).rows[0]?.detail;

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    tm = (await createAgent(app, admin.token, 'tm')).accountId;
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [tm, alice.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [tm, op.operatorId, admin.accountId]);
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'enforce' } })).json().id as string;
    await pool.query(`insert into channel_member (channel_id, account_id) select $1, unnest($2::uuid[]) on conflict do nothing`, [ch, [alice.accountId, tm]]);
  });
  afterEach(() => { delete process.env.HARKROOM_MANDATE_ENFORCE; });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('off: stored line does not allow (chain verdict stands); shadow says enforced=chain', async () => {
    const root = await post(alice.accountId, '@tm off');
    const m = (await mandateOf(root))!;
    await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/offline', grantedBy: alice.accountId, via: 'chat' });
    const l = await lease(root, tm);
    const res = await check(l, 'izagood/offline');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_granted');
    expect(await shadowOf(l.id)).toMatchObject({ enforced: 'chain', chainVerdict: 'not_granted', mandateVerdict: 'allowed' });
  });

  it('on: allowed via a stored line, and via a standing line', async () => {
    process.env.HARKROOM_MANDATE_ENFORCE = 'on';
    const root = await post(alice.accountId, '@tm stored');
    const m = (await mandateOf(root))!;
    const added = await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/stored', grantedBy: alice.accountId, via: 'chat' });
    const l = await lease(root, tm);
    const res = await check(l, 'izagood/stored');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ allowed: true, grantedBy: alice.accountId, mandateLine: { id: added.ok && added.line.id, via: 'chat', ghUser: null, ciOverride: false } });
    expect(await shadowOf(l.id)).toMatchObject({ enforced: 'mandate', chainVerdict: null, mandateVerdict: 'allowed', lineVia: 'chat' });

    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at) values ($1, 'repo.merge', 'repo:izagood/standing3', $2, $3)`,
      [tm, alice.accountId, new Date(Date.now() + 7 * 86_400_000)]);
    const res2 = await check(l, 'izagood/standing3');
    expect(res2.statusCode).toBe(200);
    expect(res2.json().mandateLine).toMatchObject({ via: 'standing' });
  });

  it('on: refused without a mandate line → no_mandate_line with a denialId (even with a grant but no mandate)', async () => {
    process.env.HARKROOM_MANDATE_ENFORCE = 'on';
    const root = await post(alice.accountId, '@tm nothing');
    const l = await lease(root, tm);
    const res = await check(l, 'izagood/nothing');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('no_mandate_line');
    const denialId = res.json().error.denialId as string;
    expect(denialId).toBeTruthy();
    expect((await pool.query(`select reason from merge_denial where id = $1`, [denialId])).rows[0].reason).toBe('no_mandate_line');
    expect(await shadowOf(l.id)).toMatchObject({ enforced: 'mandate', mandateVerdict: 'no_mandate_line' });

    // 사람 세션이 아닌 글(PAT)로 띄운 턴: 위임이 없다 → grant 가 있어도 거절.
    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at) values ($1, 'repo.merge', 'repo:izagood/grantonly', $2, $3)`,
      [tm, alice.accountId, new Date(Date.now() + 7 * 86_400_000)]);
    const patRoot = await post(alice.accountId, '@tm via pat', { authVia: 'pat' });
    expect(await mandateOf(patRoot)).toBeNull();
    const l2 = await lease(patRoot, tm);
    const res2 = await check(l2, 'izagood/grantonly');
    expect(res2.json().error.code).toBe('no_mandate_line');
    // 끄면 같은 턴이 grant 로 지나간다(오늘 판정).
    delete process.env.HARKROOM_MANDATE_ENFORCE;
    expect((await check(l2, 'izagood/grantonly')).statusCode).toBe(200);
  });

  it('on: uses:1 is consumed atomically — two concurrent checks, one passes', async () => {
    process.env.HARKROOM_MANDATE_ENFORCE = 'on';
    const root = await post(alice.accountId, '@tm once');
    const m = (await mandateOf(root))!;
    const added = await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/once', grantedBy: alice.accountId, via: 'button', limits: { uses: 1 } });
    const l = await lease(root, tm);
    const [a, b] = await Promise.all([check(l, 'izagood/once'), check(l, 'izagood/once')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 403]);
    expect([a, b].find((r) => r.statusCode === 403)!.json().error.code).toBe('no_mandate_line');
    expect((await pool.query(`select used_count from mandate_line where id = $1`, [added.ok && added.line.id])).rows[0].used_count).toBe(1);
  });

  it('on: ghUser and ciOverride are part of matching; bypass lines never allow a merge', async () => {
    process.env.HARKROOM_MANDATE_ENFORCE = 'on';
    const root = await post(alice.accountId, '@tm gh');
    const m = (await mandateOf(root))!;
    await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/gh', grantedBy: alice.accountId, via: 'button', limits: { ghUser: 'work-bot' } });
    const l = await lease(root, tm);
    // 래퍼가 계정을 알려 주지 않으면 계정이 박힌 줄은 맞지 않는다(보수).
    expect((await check(l, 'izagood/gh')).json().error.code).toBe('no_mandate_line');
    expect((await check(l, 'izagood/gh', { ghUser: 'someone-else' })).json().error.code).toBe('no_mandate_line');
    const ok = await check(l, 'izagood/gh', { ghUser: 'Work-Bot' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().mandateLine).toMatchObject({ ghUser: 'work-bot', ciOverride: false });

    await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/ci', grantedBy: alice.accountId, via: 'button', limits: { ciOverride: true } });
    expect((await check(l, 'izagood/ci')).json().mandateLine).toMatchObject({ ciOverride: true });

    await addMandateLine(pool, { mandateId: m, cap: 'bypass', scope: 'gh pr merge', grantedBy: alice.accountId, via: 'button' });
    expect((await check(l, 'izagood/bypassonly')).json().error.code).toBe('no_mandate_line');
  });

  it('on: one-time approval still works first', async () => {
    process.env.HARKROOM_MANDATE_ENFORCE = 'on';
    const root = await post(alice.accountId, '@tm approval');
    const l = await lease(root, tm);
    const num = 9001;
    const refused = await app.inject({ method: 'POST', url: '/agent/merge-checks', headers: asAgent(tm), payload: { leaseId: l.id, token: l.token, repo: 'izagood/appr', number: num, headSha: SHA } });
    const denialId = refused.json().error.denialId as string;
    expect(denialId).toBeTruthy();
    await pool.query(
      `insert into merge_approval (denial_id, agent_id, scope, pr_number, head_sha, gh_user, channel_id, thread_root_id, approved_by, approved_at, expires_at)
       values ($7, $1, 'repo:izagood/appr', $2, $3, null, $4, $5, $6, now(), now() + interval '1 hour')`,
      [tm, num, SHA, ch, root, alice.accountId, denialId]);
    const res = await app.inject({ method: 'POST', url: '/agent/merge-checks', headers: asAgent(tm), payload: { leaseId: l.id, token: l.token, repo: 'izagood/appr', number: num, headSha: SHA } });
    expect(res.statusCode).toBe(200);
    expect(res.json().approval).toMatchObject({ ghUser: null });
  });

  it('n5: posts without a session (PAT, operator, none) issue no mandate', async () => {
    for (const authVia of ['pat', 'operator', null] as const) {
      expect(await mandateOf(await post(alice.accountId, `@tm ${authVia}`, { authVia }))).toBeNull();
    }
    const pat = await mintPat(pool, alice.accountId, 'w3-pat', { actorId: null, actorHandle: null });
    if (!pat.ok) throw new Error('pat');
    const res = await app.inject({ method: 'POST', url: `/channels/${ch}/messages`, headers: auth(pat.token), payload: { body: '@tm via http pat' } });
    if (res.statusCode < 300) expect(await mandateOf(res.json().message?.id ?? res.json().id)).toBeNull();
    else expect([401, 403]).toContain(res.statusCode);
    // 세션 글은 위임을 만든다.
    const sess = await app.inject({ method: 'POST', url: `/channels/${ch}/messages`, headers: auth(alice.token), payload: { body: '@tm via session' } });
    expect(sess.statusCode).toBeLessThan(300);
    expect(await mandateOf(sess.json().message?.id ?? sess.json().id)).toBeTruthy();
  });
});
