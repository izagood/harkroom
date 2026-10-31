import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { mergeGrantFor } from '../src/auth/permissions.js';
import { PR_STATUS_CHECKS_PATH } from '@harkroom/shared/prStatus';

// `pr.status` 읽기 허락(2026-10-31) — 머지 grant 받은 저장소만, channel.repo 는 근거가 아니다, 거절은 카드·거절 기록을 만들지 않는다.
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
  const giveGrant = (scope: string, expiresAt: string | null = null) =>
    pool.query(`insert into account_grant (account_id, capability, scope, granted_by, expires_at) values ($1, 'repo.merge', $2, $3, $4)`,
      [agentId, scope, alice.accountId, expiresAt]);
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
  beforeEach(async () => { await pool.query(`delete from account_grant where account_id = $1 and capability = 'repo.merge'`, [agentId]); });

  it('정확 grant 면 허락하고, 감사에는 저장소와 번호만 남는다', async () => {
    await giveGrant('repo:example-org/example-repo');
    const res = await check(await lease(), 'Example-Org/Example-Repo', 12);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ allowed: true, repo: 'example-org/example-repo' });
    const a = (await pool.query(`select target, detail from audit_log where action = 'pr.status.checked' order by id desc limit 1`)).rows[0];
    expect(a).toEqual({ target: 'repo:example-org/example-repo', detail: { number: 12 } });
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
});
