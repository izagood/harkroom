import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { mergeGrantFor, readGrantFor } from '../src/auth/permissions.js';
import { PR_STATUS_CHECKS_PATH } from '@harkroom/shared/prStatus';

// `pr.status` 읽기 허락(2026-10-31) — 머지 grant 받은 저장소만, channel.repo 는 근거가 아니다, 거절은 카드·거절 기록을 만들지 않는다.
// 2026-11-02: 읽기 grant(`repo.read`)도 연다 — 읽기를 머지에서 떼어 냈다. 읽기 grant 는 머지(`merge-checks`)를 열지 않는다.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('POST /agent/pr-status-checks', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let agentId: string; let agentPat: string;
  let op: { token: string; operatorId: string };
  let ch: string;

  const asAgent = () => ({ ...auth(op.token), 'x-harkroom-agent': agentId });
  const lease = async (): Promise<{ id: string; token: string }> => {
    const m = await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'ci?', 'user') returning id`, [ch, alice.accountId]);
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [agentId, m.rows[0].id]);
    return (await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: asAgent(), payload: { causeMessageId: m.rows[0].id } })).json().lease;
  };
  const check = (l: { id: string; token: string }, repo = 'example-org/example-repo', number = 7, headers: Record<string, string> = asAgent()) =>
    app.inject({ method: 'POST', url: PR_STATUS_CHECKS_PATH, headers, payload: { leaseId: l.id, token: l.token, repo, number } });
  const giveGrant = (scope: string, expiresAt: string | null = null, capability: 'repo.merge' | 'repo.read' = 'repo.merge') =>
    pool.query(`insert into account_grant (account_id, capability, scope, granted_by, expires_at) values ($1, $5, $2, $3, $4)`,
      [agentId, scope, alice.accountId, expiresAt, capability]);
  const giveRead = (scope: string, expiresAt: string | null = null) => giveGrant(scope, expiresAt, 'repo.read');
  const denials = async () => (await pool.query(`select count(*)::int as n from merge_denial where agent_id = $1`, [agentId])).rows[0].n as number;
  const cards = async () => (await pool.query(`select count(*)::int as n from message where meta ? 'ask' or meta ? 'permission'`)).rows[0].n as number;

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    ({ accountId: agentId, pat: agentPat } = await createAgent(app, admin.token, 'reader'));
    await pool.query(`update agent_config set owner_account_id = $2, invoke_scope = 'owner' where account_id = $1`, [agentId, alice.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [agentId, op.operatorId, admin.accountId]);
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'dev' } })).json().id as string;
  });
  afterAll(async () => { await app.close(); await db.stop(); });
  beforeEach(async () => { await pool.query(`delete from account_grant where account_id = $1 and capability in ('repo.merge', 'repo.read')`, [agentId]); });

  it('정확 grant 면 허락하고, 감사에는 저장소와 번호만 남는다', async () => {
    await giveGrant('repo:example-org/example-repo');
    const res = await check(await lease(), 'Example-Org/Example-Repo', 12);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ allowed: true, repo: 'example-org/example-repo' });
    const a = (await pool.query(`select target, detail from audit_log where action = 'pr.status.checked' order by id desc limit 1`)).rows[0];
    expect(a).toEqual({ target: 'repo:example-org/example-repo', detail: { number: 12, via: 'merge' } });
    // 다른 저장소는 안 열린다.
    expect((await check(await lease(), 'example-org/other-repo')).json().error.code).toBe('not_granted');
  });

  it('조직 grant(owner/*)는 그 owner 의 저장소를 연다 — 다른 owner 는 안 된다', async () => {
    await giveGrant('repo:example-org/*');
    const l = await lease();
    expect((await check(l, 'example-org/app')).json()).toEqual({ allowed: true, repo: 'example-org/app' });
    expect((await check(l, 'other-org/app')).json().error.code).toBe('not_granted');
    // `*` 를 저장소로 물어도 grant 문자열과 정확 일치하지 않는다.
    expect((await check(l, 'example-org/*')).statusCode).toBe(400);
  });

  it('배포 저장소 취급은 머지와 같다 — 머지가 조직 grant 로 허락하는 저장소만 읽힌다(mergeGrantFor 를 그대로 쓴다)', async () => {
    const prev = process.env.HARKROOM_MERGE_DEPLOY_REPOS;
    process.env.HARKROOM_MERGE_DEPLOY_REPOS = 'example-org/deploy';
    try {
      await giveGrant('repo:example-org/*');
      const merge = await mergeGrantFor(pool, agentId, 'example-org/deploy');
      const res = await check(await lease(), 'example-org/deploy');
      expect(res.statusCode === 200).toBe(merge !== null);
    } finally {
      if (prev === undefined) delete process.env.HARKROOM_MERGE_DEPLOY_REPOS; else process.env.HARKROOM_MERGE_DEPLOY_REPOS = prev;
    }
  });

  it('만료된 grant 는 안 연다', async () => {
    await giveGrant('repo:example-org/example-repo', new Date(Date.now() - 60_000).toISOString());
    await giveGrant('repo:example-org/*', new Date(Date.now() - 60_000).toISOString());
    const res = await check(await lease());
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_granted');
  });

  it('channel.repo 만 맞으면 거절한다 — 채널에 묶인 저장소는 근거가 아니다', async () => {
    await pool.query(`update channel set repo = 'example-org/example-repo' where id = $1`, [ch]);
    try {
      const res = await check(await lease());
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('not_granted');
    } finally {
      await pool.query(`update channel set repo = null where id = $1`, [ch]);
    }
  });

  it('임대가 틀리거나 끝났으면 lease_invalid — merge-checks 와 같은 판정', async () => {
    await giveGrant('repo:example-org/example-repo');
    const l = await lease();
    expect((await check({ id: l.id, token: 'nope' })).json().error.code).toBe('lease_invalid');
    expect((await check({ id: '00000000-0000-4000-8000-000000000000', token: 'x' })).json().error.code).toBe('lease_invalid');
    await app.inject({ method: 'POST', url: `/agent/turn-leases/${l.id}/end`, headers: asAgent(), payload: { token: l.token } });
    const ended = await check(l);
    expect(ended.statusCode).toBe(403);
    expect(ended.json().error.code).toBe('lease_invalid');
  });

  it('사람 세션·PAT 에이전트는 403 forbidden, 본문이 틀리면 400', async () => {
    const l = await lease();
    for (const h of [auth(alice.token), auth(agentPat)]) {
      const res = await check(l, 'example-org/example-repo', 7, h);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    }
    const bad = await app.inject({ method: 'POST', url: PR_STATUS_CHECKS_PATH, headers: asAgent(), payload: { leaseId: l.id, token: l.token, repo: 'example-org/example-repo', number: 0 } });
    expect(bad.statusCode).toBe(400);
  });

  it('거절은 merge_denial·카드·머지 감사를 만들지 않는다', async () => {
    const [d0, c0] = [await denials(), await cards()];
    const mergeAudit0 = (await pool.query(`select count(*)::int as n from audit_log where action like 'repo.merge.%'`)).rows[0].n;
    const res = await check(await lease(), 'example-org/not-granted');
    expect(res.json().error.code).toBe('not_granted');
    expect(res.json().error).not.toHaveProperty('denialId');
    expect(await denials()).toBe(d0);
    expect(await cards()).toBe(c0);
    expect((await pool.query(`select count(*)::int as n from audit_log where action like 'repo.merge.%'`)).rows[0].n).toBe(mergeAudit0);
    expect((await pool.query(`select count(*)::int as n from permission_request`)).rows[0].n).toBe(0);
    const a = (await pool.query(`select target, detail from audit_log where action = 'pr.status.denied' order by id desc limit 1`)).rows[0];
    expect(a).toEqual({ target: 'repo:example-org/not-granted', detail: { number: 7, code: 'not_granted' } });
  });

  describe('읽기 grant(repo.read, 2026-11-02)', () => {
    const mergeCheck = (l: { id: string; token: string }, repo = 'example-org/example-repo') =>
      app.inject({ method: 'POST', url: '/agent/merge-checks', headers: asAgent(), payload: { leaseId: l.id, token: l.token, repo, number: 7, headSha: 'a'.repeat(40) } });
    const put = (payload: Record<string, unknown>, token = alice.token) =>
      app.inject({ method: 'PUT', url: `/accounts/${agentId}/grants`, headers: auth(token), payload: { capability: 'repo.read', ...payload } });

    it('읽기 grant 만 있어도 pr-status-checks 는 허락하고, 감사에 via=read 가 남는다 — 응답에는 싣지 않는다', async () => {
      await giveRead('repo:example-org/example-repo');
      const res = await check(await lease(), 'example-org/example-repo', 3);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ allowed: true, repo: 'example-org/example-repo' });
      const a = (await pool.query(`select target, detail from audit_log where action = 'pr.status.checked' order by id desc limit 1`)).rows[0];
      expect(a).toEqual({ target: 'repo:example-org/example-repo', detail: { number: 3, via: 'read' } });
    });

    it('읽기는 머지가 아니다 — 읽기 grant 만으로는 mergeGrantFor 가 null 이고 merge-checks 는 not_granted', async () => {
      await giveRead('repo:example-org/example-repo');
      await giveRead('repo:example-org/*');
      expect(await readGrantFor(pool, agentId, 'example-org/example-repo')).toMatchObject({ scope: 'repo:example-org/example-repo' });
      expect(await mergeGrantFor(pool, agentId, 'example-org/example-repo')).toBeNull();
      const res = await mergeCheck(await lease());
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('not_granted');
    });

    it('둘 다 없으면 거절한다', async () => {
      const res = await check(await lease());
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('not_granted');
    });

    it('만료된 읽기 grant 는 안 연다', async () => {
      await giveRead('repo:example-org/example-repo', new Date(Date.now() - 60_000).toISOString());
      await giveRead('repo:example-org/*', new Date(Date.now() - 60_000).toISOString());
      expect(await readGrantFor(pool, agentId, 'example-org/example-repo')).toBeNull();
      const res = await check(await lease());
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('not_granted');
    });

    it('조직 읽기 grant(owner/*)는 그 owner 의 저장소만 연다', async () => {
      await giveRead('repo:example-org/*');
      const l = await lease();
      expect((await check(l, 'Example-Org/app')).json()).toEqual({ allowed: true, repo: 'example-org/app' });
      expect((await check(l, 'other-org/app')).json().error.code).toBe('not_granted');
      expect((await check(l, 'example-org-evil/app')).json().error.code).toBe('not_granted');
    });

    it('머지 grant 만 있어도 그대로 읽힌다(이전 동작 유지)', async () => {
      await giveGrant('repo:example-org/example-repo');
      expect(await readGrantFor(pool, agentId, 'example-org/example-repo')).toBeNull();
      expect((await check(await lease())).json()).toEqual({ allowed: true, repo: 'example-org/example-repo' });
    });

    it('읽기 grant 도 준 사람이 그 채널에서 정할 수 없게 되면 세지 않는다 — 머지와 같은 맞춤', async () => {
      // 소유자가 아닌 사람(admin 계정)이 준 줄. 에이전트가 owner 만 부를 수 있으니(invoke_scope=owner) admin 은 정할 수 없다.
      await pool.query(`insert into account_grant (account_id, capability, scope, granted_by) values ($1, 'repo.read', 'repo:example-org/example-repo', $2)`,
        [agentId, admin.accountId]);
      const viaChannel = await readGrantFor(pool, agentId, 'example-org/example-repo', { channelId: ch });
      // 같은 줄을 repo.merge 로 넣었을 때의 mergeGrantFor 판정과 같아야 한다.
      await pool.query(`insert into account_grant (account_id, capability, scope, granted_by) values ($1, 'repo.merge', 'repo:example-org/example-repo', $2)`,
        [agentId, admin.accountId]);
      const mergeViaChannel = await mergeGrantFor(pool, agentId, 'example-org/example-repo', { channelId: ch });
      expect(viaChannel).toBeNull();
      expect(mergeViaChannel).toBeNull();
      // 채널을 안 주면(판정 문맥 없음) 줄 자체는 보인다 — 거른 것은 「정할 수 있나」다.
      expect(await readGrantFor(pool, agentId, 'example-org/example-repo')).toMatchObject({ grantedBy: admin.accountId });
      expect((await check(await lease())).json().error.code).toBe('not_granted');
    });

    it('PUT /accounts/:id/grants 는 repo.read 를 repo.merge 와 같은 scope 규칙으로 받는다', async () => {
      const ok = await put({ scope: 'repo:Example-Org/Example-Repo' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().grants).toEqual(expect.arrayContaining([expect.objectContaining({ capability: 'repo.read', scope: 'repo:example-org/example-repo', allowAgentCause: false })]));
      expect((await put({ scope: 'repo:example-org/*' })).statusCode).toBe(200);
      for (const scope of ['', 'repo:*', 'repo:*/*', 'repo:*/app', 'repo:example-org/ab*', `channel:${ch}`]) {
        const res = await put({ scope });
        expect(res.statusCode, scope).toBe(400);
        expect(['bad_scope', 'bad_request'], scope).toContain(res.json().error.code);
      }
      // allowAgentCause 는 머지 전용이다.
      expect((await put({ scope: 'repo:example-org/x', allowAgentCause: true })).statusCode).toBe(400);
      // 소유자가 아니면 못 준다 — admin 역할도 마찬가지(repo.merge 와 같은 F2).
      expect((await put({ scope: 'repo:example-org/x' }, admin.token)).statusCode).toBe(403);
      expect((await check(await lease())).json()).toEqual({ allowed: true, repo: 'example-org/example-repo' });
      // 준 줄은 머지를 열지 않는다.
      expect(await mergeGrantFor(pool, agentId, 'example-org/example-repo')).toBeNull();
      // 거두기도 같은 정규화로 맞춘다.
      const del = await app.inject({ method: 'DELETE', url: `/accounts/${agentId}/grants/repo.read?scope=${encodeURIComponent('repo:Example-Org/Example-Repo')}`, headers: auth(alice.token) });
      expect(del.statusCode).toBe(204);
      expect(await readGrantFor(pool, agentId, 'example-org/example-repo')).toMatchObject({ scope: 'repo:example-org/*' });
    });
  });
});
