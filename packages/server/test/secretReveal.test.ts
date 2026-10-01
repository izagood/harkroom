import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { createSecretKeyring } from '../src/services/secretKeyring.js';
import { RevealLimiter } from '../src/services/secretAccess.js';

// 비밀 보관소 PR 2 — 턴 임대(H1)와 reveal 의 판정(L2·L3). 스레드 bc98df3a.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
// 실제 토큰 형식의 리터럴을 저장소에 두지 않는다(보안 검토 L1) — 런타임에 조립한다.
const VALUE = `ghp_${'a'.repeat(36)}`;

describe('턴 임대·reveal (086)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let agentId: string;
  let otherAgentId: string;
  let op: { token: string; operatorId: string };
  let op2: { token: string; operatorId: string };
  let privCh: string;
  let pubCh: string;
  let secretId: string;
  const ring = createSecretKeyring(new Map([['k1', randomBytes(32)]]), 'k1');
  const limiter = new RevealLimiter(1000, 60_000);

  const asAgent = (o: { token: string }, id = agentId) => ({ ...auth(o.token), 'x-harkroom-agent': id });
  const mention = async (channelId: string, forAgent = agentId, ageMs = 0): Promise<string> => {
    const m = await pool.query(
      `insert into message (channel_id, author_id, body, kind) values ($1, $2, 'hi', 'user') returning id`,
      [channelId, alice.accountId]);
    const id = m.rows[0].id as string;
    await pool.query(
      `insert into inbox (account_id, message_id, reason, created_at) values ($1, $2, 'mention', now() - ($3 || ' milliseconds')::interval)`,
      [forAgent, id, String(ageMs)]);
    return id;
  };
  const lease = async (causeMessageId: string, o = op, id = agentId) =>
    app.inject({ method: 'POST', url: '/agent/turn-leases', headers: asAgent(o, id), payload: { causeMessageId } });
  const reveal = (l: { id: string; token: string }, name = 'gh', o = op) =>
    app.inject({ method: 'POST', url: '/agent/secrets/reveal', headers: asAgent(o), payload: { leaseId: l.id, token: l.token, name } });
  const grant = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/secrets/${secretId}/grants`, headers: auth(alice.token), payload: { agentId, ...payload } });
  const lastReason = async () =>
    (await pool.query(`select result, reason from secret_access_log order by id desc limit 1`)).rows[0];

  beforeAll(async () => {
    db = await startTestDb();
    pool = db.pool;
    app = await buildServer({ pool, secretKeyring: ring, secretRevealLimiter: limiter });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    agentId = (await createAgent(app, admin.token, 'worker')).accountId;
    otherAgentId = (await createAgent(app, admin.token, 'other')).accountId;
    op = await registerOperator(app, admin.token, 'mac');
    op2 = await registerOperator(app, admin.token, 'mac2');
    for (const [a, o] of [[agentId, op.operatorId], [otherAgentId, op2.operatorId]] as const) {
      await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [a, o, admin.accountId]);
    }
    const mk = async (name: string) => (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name } })).json().id as string;
    privCh = await mk('private-ops');
    pubCh = await mk('public-talk');
    secretId = (await app.inject({
      method: 'POST', url: '/secrets', headers: auth(alice.token), payload: { name: 'gh', kind: 'text', value: VALUE },
    })).json().secret.id as string;
    expect((await grant({ channelId: privCh })).statusCode).toBe(200);
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('임대는 불린 멘션에만 — 채널은 서버가 메시지에서 읽는다', async () => {
    const res = await lease(await mention(privCh));
    expect(res.statusCode).toBe(200);
    expect(res.json().lease.channelId).toBe(privCh);
    expect(res.headers['cache-control']).toBe('no-store');
    // 남의 멘션·오래된 멘션에는 안 준다.
    expect((await lease(await mention(privCh, otherAgentId))).statusCode).toBe(403);
    expect((await lease(await mention(privCh, agentId, 2 * 60 * 60_000))).json().error.code).toBe('not_invoked');
  });

  it('같은 멘션에 살아 있는 임대는 하나 — 두 번째는 409 이고 감사에 남는다. 끝내면 다시 받는다', async () => {
    const m = await mention(privCh);
    const first = (await lease(m)).json().lease;
    const second = await lease(m);
    expect(second.statusCode).toBe(409);
    expect((await pool.query(`select 1 from audit_log where action = 'secret.lease.conflict'`)).rowCount).toBeGreaterThan(0);
    // 토큰이 틀리면 끝내지 못한다.
    expect((await app.inject({ method: 'POST', url: `/agent/turn-leases/${first.id}/end`, headers: asAgent(op), payload: { token: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/agent/turn-leases/${first.id}/end`, headers: asAgent(op), payload: { token: first.token } })).statusCode).toBe(204);
    expect((await lease(m)).statusCode).toBe(200);
    // 끝난 임대로는 받지 못한다.
    expect((await reveal(first)).json().error.code).toBe('lease_invalid');
  });

  it('사람·PAT 에이전트는 임대도 reveal 도 못 한다', async () => {
    const m = await mention(privCh);
    expect((await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: auth(alice.token), payload: { causeMessageId: m } })).statusCode).toBe(403);
    const pat = (await createAgent(app, admin.token, 'patty')).pat;
    expect((await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: auth(pat), payload: { causeMessageId: m } })).statusCode).toBe(403);
  });

  it('비공개 채널 턴은 값을 받는다 — 값은 응답에만, 감사에는 granted 와 판만', async () => {
    const l = (await lease(await mention(privCh))).json().lease;
    const res = await reveal(l);
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.json().valueBase64, 'base64').toString()).toBe(VALUE);
    expect(res.json().secret).toMatchObject({ name: 'gh', kind: 'text', version: 1 });
    const row = await pool.query(`select * from secret_access_log order by id desc limit 1`);
    expect(row.rows[0]).toMatchObject({ result: 'granted', version: 1, channel_id: privCh, turn_id: l.id });
    expect(JSON.stringify(row.rows[0])).not.toContain('ghp_');
  });

  it('H1: 공개 채널 턴은 channelId 를 무엇으로 주장해도 못 받는다', async () => {
    const l = (await lease(await mention(pubCh))).json().lease;
    const res = await app.inject({
      method: 'POST', url: '/agent/secrets/reveal', headers: asAgent(op),
      payload: { leaseId: l.id, token: l.token, name: 'gh', channelId: privCh },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('wrong_channel');
    expect(res.body).not.toContain('ghp_');
  });

  it('임대는 그 에이전트·그 오퍼레이터의 것만 — 토큰이 틀려도 거절', async () => {
    const l = (await lease(await mention(privCh))).json().lease;
    expect((await reveal({ id: l.id, token: 'wrong' })).json().error.code).toBe('lease_invalid');
    const otherOp = await app.inject({ method: 'POST', url: '/agent/secrets/reveal', headers: { ...auth(op2.token), 'x-harkroom-agent': otherAgentId }, payload: { leaseId: l.id, token: l.token, name: 'gh' } });
    expect(otherOp.json().error.code).toBe('lease_invalid');
  });

  it('L2: 만료된 비밀 — reveal 거절, 새 부여도 409', async () => {
    const l = (await lease(await mention(privCh))).json().lease;
    await pool.query(`update secret set expires_at = now() - interval '1 minute' where id = $1`, [secretId]);
    try {
      expect((await reveal(l)).json().error.code).toBe('secret_expired');
      expect(await lastReason()).toEqual({ result: 'denied', reason: 'secret_expired' });
      const g = await grant({ channelId: pubCh });
      expect(g.statusCode).toBe(409);
      expect(g.json().error.code).toBe('secret_expired');
    } finally {
      await pool.query(`update secret set expires_at = null where id = $1`, [secretId]);
    }
  });

  it('L2: 정지된 grant — 거절. 소유자가 다시 주면 풀린다', async () => {
    const l = (await lease(await mention(privCh))).json().lease;
    await pool.query(`update secret_grant set suspended_at = now(), suspend_reason = 'test' where secret_id = $1`, [secretId]);
    expect((await reveal(l)).json().error.code).toBe('grant_suspended');
    await grant({ channelId: privCh });
    expect((await reveal(l)).statusCode).toBe(200);
  });

  it('L2: 지워진 판(revoked_at·sealed null) — 거절', async () => {
    const l = (await lease(await mention(privCh))).json().lease;
    await pool.query(`update secret_version set revoked_at = now(), sealed = null where secret_id = $1`, [secretId]);
    try {
      expect((await reveal(l)).json().error.code).toBe('no_value');
    } finally {
      await app.inject({ method: 'PUT', url: `/secrets/${secretId}/value`, headers: auth(alice.token), payload: { value: VALUE } });
    }
    expect((await reveal(l)).json().secret.version).toBe(2);
  });

  it('L2: grant.operator_id 가 요청 오퍼레이터와 다르면 거절, null(any)이면 통과', async () => {
    // 같은 에이전트를 op2 로 옮긴다 — 배정 라우트가 하는 정지를 일부러 피하려고 DB 로 옮긴다.
    await pool.query(`update agent_assignment set operator_id = $2 where agent_id = $1`, [agentId, op2.operatorId]);
    try {
      const l = (await lease(await mention(privCh), op2)).json().lease;
      expect((await reveal(l, 'gh', op2)).json().error.code).toBe('wrong_operator');
      await grant({ channelId: privCh, operator: 'any' });
      expect((await reveal(l, 'gh', op2)).statusCode).toBe(200);
    } finally {
      await pool.query(`update agent_assignment set operator_id = $2 where agent_id = $1`, [agentId, op.operatorId]);
      await grant({ channelId: privCh });
    }
  });

  it('L3: 비밀 소유자가 비활성·삭제되면 받지 못하고 목록에서도 빠진다', async () => {
    const l = (await lease(await mention(privCh))).json().lease;
    await pool.query(`update account set disabled_at = now() where id = $1`, [alice.accountId]);
    try {
      expect((await reveal(l)).json().error.code).toBe('owner_inactive');
    } finally {
      await pool.query(`update account set disabled_at = null where id = $1`, [alice.accountId]);
    }
  });

  it('정지 훅: 배정이 다른 오퍼레이터로 바뀌거나 지시문·하네스가 바뀌면 grant 가 선다', async () => {
    const live = async () => (await pool.query(`select count(*)::int as n from secret_grant where agent_id = $1 and suspended_at is null`, [agentId])).rows[0].n as number;
    expect(await live()).toBe(1);
    const patch = await app.inject({ method: 'PATCH', url: `/accounts/agents/${agentId}`, headers: auth(admin.token), payload: { instructions: 'new job' } });
    expect(patch.statusCode).toBe(200);
    expect(await live()).toBe(0);
    expect((await pool.query(`select suspend_reason from secret_grant where agent_id = $1`, [agentId])).rows[0].suspend_reason).toBe('definition_changed');
    await grant({ channelId: privCh });
    // 같은 값으로 다시 저장하면 세우지 않는다.
    await app.inject({ method: 'PATCH', url: `/accounts/agents/${agentId}`, headers: auth(admin.token), payload: { instructions: 'new job' } });
    expect(await live()).toBe(1);
  });

  it('속도 제한 — 창 안의 상한을 넘으면 429 이고 감사에 남는다', async () => {
    const tight = await buildServer({ pool, secretKeyring: ring, secretRevealLimiter: new RevealLimiter(1, 60_000) });
    try {
      const l = (await lease(await mention(privCh))).json().lease;
      const call = () => tight.inject({ method: 'POST', url: '/agent/secrets/reveal', headers: asAgent(op), payload: { leaseId: l.id, token: l.token, name: 'gh' } });
      expect((await call()).statusCode).toBe(200);
      expect((await call()).statusCode).toBe(429);
      expect(await lastReason()).toEqual({ result: 'denied', reason: 'rate_limited' });
    } finally {
      await tight.close();
    }
  });

  it('secret.list 계약 — 이름만, 정지·만료된 것은 빠진다', async () => {
    const { listGrantedSecrets } = await import('../src/services/secretAccess.js');
    const list = await listGrantedSecrets(pool, agentId);
    expect(list).toEqual([{ name: 'gh', kind: 'text', filename: null, description: '', channelIds: [privCh] }]);
    expect(JSON.stringify(list)).not.toContain('ghp_');
    await pool.query(`update secret_grant set suspended_at = now() where agent_id = $1`, [agentId]);
    expect(await listGrantedSecrets(pool, agentId)).toEqual([]);
    await grant({ channelId: privCh });
  });
});
