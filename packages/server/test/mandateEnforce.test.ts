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

// 위임(mandate) W3·J1 — `HARKROOM_MANDATE_ENFORCE=on` 일 때 머지 판정은 합집합: 위임장의 merge 줄이 맞으면 통과, 아니면 사슬 판정 그대로.
// 켰을 때 사슬이 통과시키던 것이 막히지 않는지는 `mergeUnionParity.test.ts` 가 사슬 시험 두 벌을 켠 채 다시 돌려 본다.
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
    expect(await shadowOf(l.id)).toMatchObject({ enforced: 'union', allowedBy: 'line', chainVerdict: null, mandateVerdict: 'allowed', lineVia: 'chat' });

    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at) values ($1, 'repo.merge', 'repo:izagood/standing3', $2, $3)`,
      [tm, alice.accountId, new Date(Date.now() + 7 * 86_400_000)]);
    const res2 = await check(l, 'izagood/standing3');
    expect(res2.statusCode).toBe(200);
    expect(res2.json().mandateLine).toMatchObject({ via: 'standing' });
  });

  it('on: no matching line → the chain verdict, same code and card as off (never no_mandate_line)', async () => {
    const root = await post(alice.accountId, '@tm nothing');
    const l = await lease(root, tm);
    const num = 7001;
    const off = await check(l, 'izagood/nothing', { number: num });
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe('not_granted');
    process.env.HARKROOM_MANDATE_ENFORCE = 'on';
    const res = await check(l, 'izagood/nothing', { number: num });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_granted');
    const denialId = res.json().error.denialId as string;
    expect(denialId).toBeTruthy();
    // 같은 (PR, head, 스레드) — 꺼졌을 때 세운 카드를 그대로 다시 쓴다.
    expect(denialId).toBe(off.json().error.denialId);
    expect((await pool.query(`select reason from merge_denial where id = $1`, [denialId])).rows[0].reason).toBe('not_granted');
    expect(await shadowOf(l.id)).toMatchObject({ enforced: 'union', allowedBy: null, chainVerdict: 'not_granted', mandateVerdict: 'denied' });

    // 사람 세션이 아닌 글(PAT)로 띄운 턴: 위임이 없다 → 줄은 없지만 grant 로 사슬 판정이 통과시킨다(켜도 좁아지지 않는다).
    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at) values ($1, 'repo.merge', 'repo:izagood/grantonly', $2, $3)`,
      [tm, alice.accountId, new Date(Date.now() + 7 * 86_400_000)]);
    const patRoot = await post(alice.accountId, '@tm via pat', { authVia: 'pat' });
    expect(await mandateOf(patRoot)).toBeNull();
    const l2 = await lease(patRoot, tm);
    const res2 = await check(l2, 'izagood/grantonly');
    expect(res2.statusCode).toBe(200);
    expect(res2.json().mandateLine).toBeUndefined();
    expect(await shadowOf(l2.id)).toMatchObject({ enforced: 'union', allowedBy: 'chain', chainVerdict: 'allowed', mandateVerdict: 'denied', lineId: null });
    delete process.env.HARKROOM_MANDATE_ENFORCE;
    expect((await check(l2, 'izagood/grantonly')).statusCode).toBe(200);
    expect(await pool.query(`select 1 from merge_denial where reason = 'no_mandate_line'`).then((r) => r.rowCount)).toBe(0);
  });

  /** 사람이 띄우지 않은 턴(다른 소유자 에이전트의 글) — 사슬 판정은 `cause_not_human`. `mandateId` 를 주면 그 글에 위임을 단다. */
  const agentCausedLease = async (mandateId: string | null) => {
    const other = (await createAgent(app, admin.token, `other${n++}`)).accountId;
    const id = (await pool.query(
      `insert into message (channel_id, author_id, body, kind, mandate_id) values ($1, $2, '@tm agent asks', 'user', $3) returning id`,
      [ch, other, mandateId])).rows[0].id as string;
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [tm, id]);
    return lease(id, tm);
  };

  it('on: chain refuses (cause_not_human) but a line exists → allowed via the line, uses consumed once', async () => {
    const root = await post(alice.accountId, '@tm union');
    const m = (await mandateOf(root))!;
    const added = await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/union', grantedBy: alice.accountId, via: 'button', limits: { uses: 1 } });
    const lineId = added.ok && added.line.id;
    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at) values ($1, 'repo.merge', 'repo:izagood/union', $2, $3)`,
      [tm, alice.accountId, new Date(Date.now() + 7 * 86_400_000)]);
    const l = await agentCausedLease(m);
    const off = await check(l, 'izagood/union');
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe('cause_not_human');
    expect((await pool.query(`select used_count from mandate_line where id = $1`, [lineId])).rows[0].used_count).toBe(0);
    process.env.HARKROOM_MANDATE_ENFORCE = 'on';
    const on = await check(l, 'izagood/union');
    expect(on.statusCode).toBe(200);
    expect(on.json().mandateLine).toMatchObject({ id: lineId, via: 'button' });
    expect((await pool.query(`select used_count from mandate_line where id = $1`, [lineId])).rows[0].used_count).toBe(1);
    expect(await shadowOf(l.id)).toMatchObject({ enforced: 'union', allowedBy: 'line', chainVerdict: null, mandateVerdict: 'allowed', lineId });
  });

  it('on: no line + chain refuses (cause_not_human) → same code and card as off', async () => {
    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at) values ($1, 'repo.merge', 'repo:izagood/nochain', $2, $3)`,
      [tm, alice.accountId, new Date(Date.now() + 7 * 86_400_000)]);
    const l = await agentCausedLease(null);
    const num = 7002;
    const off = await check(l, 'izagood/nochain', { number: num });
    expect(off.json().error.code).toBe('cause_not_human');
    process.env.HARKROOM_MANDATE_ENFORCE = 'on';
    const on = await check(l, 'izagood/nochain', { number: num });
    expect(on.statusCode).toBe(403);
    expect(on.json().error).toMatchObject({ code: 'cause_not_human', denialId: off.json().error.denialId });
    expect((await pool.query(`select reason from merge_denial where id = $1`, [on.json().error.denialId])).rows[0].reason).toBe('cause_not_human');
    expect(await shadowOf(l.id)).toMatchObject({ enforced: 'union', allowedBy: null, chainVerdict: 'cause_not_human', mandateVerdict: 'denied' });
  });

  it('on: uses:1 is consumed atomically — two concurrent checks, one passes', async () => {
    process.env.HARKROOM_MANDATE_ENFORCE = 'on';
    const root = await post(alice.accountId, '@tm once');
    const m = (await mandateOf(root))!;
    const added = await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/once', grantedBy: alice.accountId, via: 'button', limits: { uses: 1 } });
    const l = await lease(root, tm);
    const [a, b] = await Promise.all([check(l, 'izagood/once'), check(l, 'izagood/once')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 403]);
    // 진 쪽은 사슬 판정으로 간다(grant 없음 → not_granted) — no_mandate_line 이 아니다.
    expect([a, b].find((r) => r.statusCode === 403)!.json().error.code).toBe('not_granted');
    expect((await pool.query(`select used_count from mandate_line where id = $1`, [added.ok && added.line.id])).rows[0].used_count).toBe(1);
  });

  it('n11: a ghUser line matches the login the operator states in merge-checks; off ignores ghUser', async () => {
    const root = await post(alice.accountId, '@tm stated login');
    const m = (await mandateOf(root))!;
    await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/stated', grantedBy: alice.accountId, via: 'button', limits: { ghUser: 'repo-account' } });
    const l = await lease(root, tm);
    // off: the stated login changes nothing — the chain verdict stands, no 400.
    const off = await check(l, 'izagood/stated', { ghUser: 'repo-account' });
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe('not_granted');
    process.env.HARKROOM_MANDATE_ENFORCE = 'on';
    const on = await check(l, 'izagood/stated', { ghUser: 'repo-account' });
    expect(on.statusCode).toBe(200);
    expect(on.json().mandateLine).toMatchObject({ ghUser: 'repo-account', ciOverride: false });
  });

  it('on: ghUser and ciOverride are part of matching (mismatch falls back to the chain); bypass lines never allow a merge', async () => {
    process.env.HARKROOM_MANDATE_ENFORCE = 'on';
    const root = await post(alice.accountId, '@tm gh');
    const m = (await mandateOf(root))!;
    await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/gh', grantedBy: alice.accountId, via: 'button', limits: { ghUser: 'work-bot' } });
    const l = await lease(root, tm);
    // 래퍼가 계정을 알려 주지 않거나 다른 계정이면 계정이 박힌 줄은 맞지 않는다(보수) → 사슬 판정(grant 없음 → not_granted).
    expect((await check(l, 'izagood/gh')).json().error.code).toBe('not_granted');
    expect((await check(l, 'izagood/gh', { ghUser: 'someone-else' })).json().error.code).toBe('not_granted');
    const ok = await check(l, 'izagood/gh', { ghUser: 'Work-Bot' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().mandateLine).toMatchObject({ ghUser: 'work-bot', ciOverride: false });

    await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/ci', grantedBy: alice.accountId, via: 'button', limits: { ciOverride: true } });
    expect((await check(l, 'izagood/ci')).json().mandateLine).toMatchObject({ ciOverride: true });

    await addMandateLine(pool, { mandateId: m, cap: 'bypass', scope: 'gh pr merge', grantedBy: alice.accountId, via: 'button' });
    expect((await check(l, 'izagood/bypassonly')).json().error.code).toBe('not_granted');

    // 계정이 안 맞는 줄은 버려지고 사슬 판정이 그대로 나간다 — grant 가 있으면 사슬로 통과(줄은 쓰지 않는다).
    // grant 는 관리자가 준 것(소유자가 준 grant 는 상시 줄로도 펼쳐져 줄 쪽이 통과시키므로, 사슬 갈래를 보려고 피한다).
    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at) values ($1, 'repo.merge', 'repo:izagood/ghchain', $2, $3)`,
      [tm, admin.accountId, new Date(Date.now() + 7 * 86_400_000)]);
    const ghLine = await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/ghchain', grantedBy: alice.accountId, via: 'button', limits: { ghUser: 'work-bot', uses: 1 } });
    const viaChain = await check(l, 'izagood/ghchain', { ghUser: 'someone-else' });
    expect(viaChain.statusCode).toBe(200);
    expect(viaChain.json().mandateLine).toBeUndefined();
    expect(viaChain.json().grantedBy).toBe(admin.accountId);
    expect(await shadowOf(l.id)).toMatchObject({ enforced: 'union', allowedBy: 'chain', chainVerdict: 'allowed', mandateVerdict: 'denied' });
    expect((await pool.query(`select used_count from mandate_line where id = $1`, [ghLine.ok && ghLine.line.id])).rows[0].used_count).toBe(0);
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
