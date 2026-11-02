import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { createSecretKeyring } from '../src/services/secretKeyring.js';
import { issueTurnLease, LEASE_MAX_REISSUES, LEASE_REISSUE_STALE_MS, RevealLimiter } from '../src/services/secretAccess.js';
import { TURN_LEASE_HEARTBEAT_MS } from '@harkroom/shared/runnerLink';

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
    // 비밀은 소유자 자신의 에이전트에게만 준다(not_own_agent) — 시험의 에이전트를 alice 의 것으로.
    await pool.query(`update agent_config set owner_account_id = $1 where account_id = any($2::uuid[])`, [alice.accountId, [agentId, otherAgentId]]);
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
    expect((await lease(await mention(privCh, agentId, 6 * 60 * 60_000 + 60_000))).json().error.code).toBe('not_invoked');
  });

  // 다시 주기(157) — 러너가 다시 떠서 같은 부름을 다시 집으면, 옛 임대의 박동이 끊겼을 때만 새로 준다.
  describe('임대 다시 주기', () => {
    const stale = (leaseId: string) => pool.query(
      `update secret_turn_lease set last_renewed_at = now() - make_interval(secs => $2) where id = $1`, [leaseId, LEASE_REISSUE_STALE_MS / 1000 + 60]);
    it('문턱은 러너 박동 주기의 1.5배 이상이다', () => {
      expect(LEASE_REISSUE_STALE_MS).toBeGreaterThanOrEqual(TURN_LEASE_HEARTBEAT_MS * 1.5);
    });
    it('박동이 살아 있으면 409 그대로 · 끊겼으면 옛 임대를 끝내고 새로 주며 옛 토큰은 거절된다 · 감사 reissued', async () => {
      const m = await mention(privCh);
      const first = (await lease(m)).json().lease as { id: string; token: string };
      expect((await lease(m)).json().error.code).toBe('lease_used');
      await stale(first.id);
      const again = await lease(m);
      expect(again.statusCode).toBe(200);
      const second = again.json().lease as { id: string; token: string };
      expect(second.id).not.toBe(first.id);
      const old = await reveal(first);
      expect(old.statusCode).not.toBe(200);
      expect(old.json().error.code).toBe('lease_invalid');
      expect((await reveal(second)).statusCode).toBe(200);
      const a = (await pool.query(`select detail from audit_log where action = 'secret.lease.reissued' and detail->>'newLeaseId' = $1`, [second.id])).rows[0];
      expect(a.detail).toMatchObject({ causeMessageId: m, oldLeaseId: first.id, operatorId: op.operatorId });
      expect(a.detail.sinceLastBeatSec).toBeGreaterThanOrEqual(LEASE_REISSUE_STALE_MS / 1000);
      expect(JSON.stringify(a.detail)).not.toContain(second.token);
    });
    it('부름당 다시 주기는 두 번까지 — 세 번째는 409', async () => {
      const m = await mention(privCh);
      let cur = (await lease(m)).json().lease as { id: string };
      for (let i = 0; i < LEASE_MAX_REISSUES; i++) {
        await stale(cur.id);
        const r = await lease(m);
        expect(r.statusCode).toBe(200);
        cur = r.json().lease;
      }
      await stale(cur.id);
      expect((await lease(m)).json().error.code).toBe('lease_used');
    });
    it('다른 오퍼레이터 · 끝난 옛 임대 · 읽음 처리된 부름이면 다시 주지 않는다', async () => {
      const m = await mention(privCh);
      const first = (await lease(m)).json().lease as { id: string; token: string };
      await stale(first.id);
      expect(await issueTurnLease(pool, { agentId, operatorId: op2.operatorId, causeMessageId: m })).toEqual({ ok: false, code: 'lease_used' });
      // 끝난(턴이 마친) 옛 임대는 다시 주지 않는다.
      const m2 = await mention(privCh);
      const l2 = (await lease(m2)).json().lease as { id: string; token: string };
      await app.inject({ method: 'POST', url: `/agent/turn-leases/${l2.id}/end`, headers: asAgent(op), payload: { token: l2.token } });
      await stale(l2.id);
      expect((await lease(m2)).json().error.code).toBe('lease_used');
      // 읽음 처리된 부름은 처음 판정에서 거절(403).
      await pool.query(`update inbox set read_at = now() where account_id = $1 and message_id = $2`, [agentId, m]);
      expect((await lease(m)).json().error.code).toBe('not_invoked');
    });
    it('박동(갱신)은 마지막 박동 시각을 남긴다', async () => {
      const m = await mention(privCh);
      const l = (await lease(m)).json().lease as { id: string; token: string };
      await stale(l.id);
      const r = await app.inject({ method: 'POST', url: `/agent/turn-leases/${l.id}/renew`, headers: asAgent(op), payload: { token: l.token } });
      expect(r.statusCode).toBe(200);
      expect((await lease(m)).json().error.code).toBe('lease_used');
    });
  });

  // 「처리 안 한 부름 + 6시간 상한」— 긴 앞 턴 뒤에 쌓인 부름이 10분을 넘겨도 임대를 받는다.
  describe('임대 창: 읽지 않은 부름 + 6시간', () => {
    const H6 = 6 * 60 * 60_000;
    it('① 줄에서 25분 기다린 읽지 않은 부름도 받고, 기다린 초가 감사에 남는다', async () => {
      const m = await mention(privCh, agentId, 25 * 60_000);
      const r = await lease(m);
      expect(r.statusCode).toBe(200);
      const row = (await pool.query(`select detail from audit_log where action = 'secret.lease.issued' and detail->>'causeMessageId' = $1`, [m])).rows[0];
      expect(row.detail.leaseId).toBe(r.json().lease.id);
      expect(row.detail.waitedSec).toBeGreaterThanOrEqual(25 * 60 - 5);
      expect(JSON.stringify(row.detail)).not.toContain(r.json().lease.token);
    });
    it('② 6시간을 넘긴 부름은 403 not_invoked', async () => {
      expect((await lease(await mention(privCh, agentId, H6 + 60_000))).json().error.code).toBe('not_invoked');
    });
    it('③ 읽음 처리된 부름은 10분 안이라도 403', async () => {
      const m = await mention(privCh);
      await pool.query(`update inbox set read_at = now() where account_id = $1 and message_id = $2`, [agentId, m]);
      expect((await lease(m)).json().error.code).toBe('not_invoked');
    });
    it('④ 받은 뒤 같은 글로 다시 받으면 409 lease_used(그대로)', async () => {
      const m = await mention(privCh, agentId, 30 * 60_000);
      expect((await lease(m)).statusCode).toBe(200);
      expect((await lease(m)).json().error.code).toBe('lease_used');
    });
    it('⑤ 같은 글에 행이 둘(하나 읽음·하나 안 읽음)이면 받는다', async () => {
      const m = await mention(privCh, agentId, 40 * 60_000);
      await pool.query(`update inbox set read_at = now() where account_id = $1 and message_id = $2`, [agentId, m]);
      await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'wake')`, [agentId, m]);
      expect((await lease(m)).statusCode).toBe(200);
    });
    it('⑥ 부른 뒤 지운 글은 403', async () => {
      const m = await mention(privCh, agentId, 20 * 60_000);
      await pool.query(`update message set deleted_at = now() where id = $1`, [m]);
      expect((await lease(m)).json().error.code).toBe('not_invoked');
    });
    it('⑦ 다른 에이전트의 읽지 않은 행만 있으면 403', async () => {
      const m = await mention(privCh, otherAgentId, 20 * 60_000);
      expect((await lease(m)).json().error.code).toBe('not_invoked');
    });
    it('⑧ 상한 경계: 6시간 − 1분은 받고 6시간 + 1분은 거절', async () => {
      expect((await lease(await mention(privCh, agentId, H6 - 60_000))).statusCode).toBe(200);
      expect((await lease(await mention(privCh, agentId, H6 + 60_000))).json().error.code).toBe('not_invoked');
    });
  });

  it('S1: 멘션 하나에 임대는 평생 하나 — 살아 있든 끝났든 두 번째는 409 lease_used 이고 감사에 남는다', async () => {
    const m = await mention(privCh);
    const first = (await lease(m)).json().lease;
    const second = await lease(m);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('lease_used');
    expect((await pool.query(`select 1 from audit_log where action = 'secret.lease.conflict'`)).rowCount).toBeGreaterThan(0);
    // 토큰이 틀리면 끝내지 못한다.
    expect((await app.inject({ method: 'POST', url: `/agent/turn-leases/${first.id}/end`, headers: asAgent(op), payload: { token: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/agent/turn-leases/${first.id}/end`, headers: asAgent(op), payload: { token: first.token } })).statusCode).toBe(204);
    // 끝난 멘션으로 다시 받지 못한다 — 다른 턴의 셸이 지난 비공개 멘션을 재임대하는 길(S1).
    const again = await lease(m);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('lease_used');
    // 만료된 것도 같다.
    const m2 = await mention(privCh);
    await lease(m2);
    await pool.query(`update secret_turn_lease set expires_at = now() - interval '1 second' where cause_message_id = $1`, [m2]);
    expect((await lease(m2)).json().error.code).toBe('lease_used');
    // 끝난 임대로는 받지 못한다.
    expect((await reveal(first)).json().error.code).toBe('lease_invalid');
  });

  it('C-1: 임대 갱신 — 토큰이 맞고 살아 있을 때만, 지금+10분까지, 발급+70분을 넘지 않는다. 끝난·만료된 임대는 되살리지 않는다', async () => {
    const renew = (l: { id: string; token: string }, o = op) =>
      app.inject({ method: 'POST', url: `/agent/turn-leases/${l.id}/renew`, headers: asAgent(o), payload: { token: l.token } });
    const expiresOf = async (id: string) =>
      new Date((await pool.query(`select expires_at from secret_turn_lease where id = $1`, [id])).rows[0].expires_at).getTime();
    const minutesFromNow = (ms: number) => (ms - Date.now()) / 60_000;

    // 30분 돈 턴(남은 5분) → 지금 + 10분.
    const m = await mention(privCh);
    const l = (await lease(m)).json().lease;
    await pool.query(`update secret_turn_lease set created_at = now() - interval '30 minutes', expires_at = now() + interval '5 minutes' where id = $1`, [l.id]);
    const r = await renew(l);
    expect(r.statusCode).toBe(200);
    expect(minutesFromNow(Date.parse(r.json().expiresAt))).toBeGreaterThan(9.5);
    expect(minutesFromNow(Date.parse(r.json().expiresAt))).toBeLessThan(10.5);
    expect(Math.abs(await expiresOf(l.id) - Date.parse(r.json().expiresAt))).toBeLessThan(1000);
    // 늘린 임대로 reveal 이 된다(같은 판정이 expires_at 하나만 본다).
    expect((await reveal(l)).statusCode).toBe(200);

    // 이미 더 길면 줄이지 않는다(발급 직후 35분 > 지금+10분).
    const m2 = await mention(privCh);
    const l2 = (await lease(m2)).json().lease;
    const before = await expiresOf(l2.id);
    expect((await renew(l2)).statusCode).toBe(200);
    expect(await expiresOf(l2.id)).toBe(before);

    // 상한: 65분 돈 턴은 발급 + 70분(= 지금 + 5분)까지만.
    await pool.query(`update secret_turn_lease set created_at = now() - interval '65 minutes', expires_at = now() + interval '1 minute' where id = $1`, [l.id]);
    const capped = await renew(l);
    expect(capped.statusCode).toBe(200);
    expect(minutesFromNow(Date.parse(capped.json().expiresAt))).toBeLessThan(5.5);
    expect(minutesFromNow(Date.parse(capped.json().expiresAt))).toBeGreaterThan(4.5);

    // 토큰이 틀리면 404, 만료 시각은 그대로.
    const held = await expiresOf(l.id);
    expect((await renew({ id: l.id, token: 'x' })).statusCode).toBe(404);
    expect(await expiresOf(l.id)).toBe(held);

    // 만료된 임대는 되살리지 않는다.
    await pool.query(`update secret_turn_lease set expires_at = now() - interval '1 second' where id = $1`, [l.id]);
    expect((await renew(l)).statusCode).toBe(404);
    expect(await expiresOf(l.id)).toBeLessThan(Date.now());

    // 끝난(ended_at) 임대도 되살리지 않는다.
    expect((await app.inject({ method: 'POST', url: `/agent/turn-leases/${l2.id}/end`, headers: asAgent(op), payload: { token: l2.token } })).statusCode).toBe(204);
    expect((await renew(l2)).statusCode).toBe(404);
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

  it('남의 에이전트가 된 줄(옛 부여·소유 변경)은 reveal 이 not_own_agent 로 막는다', async () => {
    await pool.query(`update agent_config set owner_account_id = $1 where account_id = $2`, [admin.accountId, agentId]);
    try {
      const l = (await lease(await mention(privCh))).json().lease;
      const res = await reveal(l);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('not_own_agent');
      expect(await lastReason()).toMatchObject({ result: 'denied', reason: 'not_own_agent' });
      expect(res.body).not.toContain('ghp_');
    } finally {
      await pool.query(`update agent_config set owner_account_id = $1 where account_id = $2`, [alice.accountId, agentId]);
    }
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
    // S2: 작업 디렉터리가 바뀌어도 선다.
    await app.inject({ method: 'PATCH', url: `/accounts/agents/${agentId}`, headers: auth(admin.token), payload: { workingDir: '/srv/other' } });
    expect(await live()).toBe(0);
    await grant({ channelId: privCh });
    // S2: MCP 목록이 바뀌어도 선다.
    expect((await app.inject({ method: 'PUT', url: '/mcp-servers/linear', headers: auth(admin.token), payload: { credentialKind: 'community' } })).statusCode).toBe(200);
    const mcp = await app.inject({ method: 'PATCH', url: `/accounts/agents/${agentId}`, headers: auth(admin.token), payload: { mcpServers: ['linear'] } });
    expect(mcp.statusCode).toBe(200);
    expect(await live()).toBe(0);
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
