import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { can, mergeGrantFor } from '../src/auth/permissions.js';

// 에이전트 머지 권한(090) — 설계 스레드 3deac356, security F1·F2·F4 의 회귀선.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const SHA = 'a'.repeat(40);

describe('repo.merge grant', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let agentId: string; let agentPat: string;
  let otherAgentId: string;
  let op: { token: string; operatorId: string };
  let ch: string;

  const asAgent = (o = op, id = agentId) => ({ ...auth(o.token), 'x-harkroom-agent': id });
  const mention = async (authorId: string, forAgent = agentId): Promise<string> => {
    const m = await pool.query(
      `insert into message (channel_id, author_id, body, kind) values ($1, $2, 'merge it', 'user') returning id`, [ch, authorId]);
    const id = m.rows[0].id as string;
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [forAgent, id]);
    return id;
  };
  /** 이 에이전트(또는 다른 에이전트)가 세운 선택 카드에 누군가 답한 상태 — `ask_answered` 로 깨어난 턴의 cause. */
  const askCard = async (answeredBy: string | null, cardAuthor = agentId, forAgent = agentId, mirrorOf: string | null = null): Promise<string> => {
    const ask = { prompt: 'merge?', options: [{ id: 'yes', label: 'yes' }], ...(mirrorOf ? { mirrorOf } : {}), ...(answeredBy ? { answeredWith: 'yes', answeredBy, answeredAt: new Date().toISOString() } : {}) };
    const m = await pool.query(
      `insert into message (channel_id, author_id, body, kind, meta) values ($1, $2, 'merge?', 'user', $3) returning id`,
      [ch, cardAuthor, JSON.stringify({ kind: 'ask', ask })]);
    const id = m.rows[0].id as string;
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'ask_answered')`, [forAgent, id]);
    return id;
  };
  const lease = async (causeMessageId: string) =>
    (await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: asAgent(), payload: { causeMessageId } })).json().lease as { id: string; token: string };
  const check = (l: { id: string; token: string }, repo = 'izagood/harkroom', extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/agent/merge-checks', headers: asAgent(), payload: { leaseId: l.id, token: l.token, repo, number: 7, headSha: SHA, ...extra } });
  const grant = (token: string, payload: Record<string, unknown>, target = agentId) =>
    app.inject({ method: 'PUT', url: `/accounts/${target}/grants`, headers: auth(token), payload: { capability: 'repo.merge', ...payload } });
  const revoke = (token: string, scope: string, target = agentId) =>
    app.inject({ method: 'DELETE', url: `/accounts/${target}/grants/repo.merge?scope=${encodeURIComponent(scope)}`, headers: auth(token) });

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    ({ accountId: agentId, pat: agentPat } = await createAgent(app, admin.token, 'tm'));
    otherAgentId = (await createAgent(app, admin.token, 'other')).accountId;
    // alice 가 tm 의 소유자다 — F2 의 "소유자인 사람"은 admin 과 다른 사람이어야 시험이 뜻을 가진다.
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, alice.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [agentId, op.operatorId, admin.accountId]);
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'dev' } })).json().id as string;
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  describe('F1 — scope 는 repo:<owner>/<name> 하나, 전역은 없다', () => {
    it('빈 scope 는 400 이고, 손으로 넣은 전역 grant 로도 머지할 수 없다', async () => {
      expect((await grant(alice.token, { scope: '' })).statusCode).toBe(400);
      expect((await grant(alice.token, {})).statusCode).toBe(400);
      await pool.query(`insert into account_grant (account_id, capability, scope, granted_by) values ($1, 'repo.merge', '', $2)`, [agentId, admin.accountId]);
      expect(await mergeGrantFor(pool, agentId, 'izagood/harkroom')).toBeNull();
      const l = await lease(await mention(alice.accountId));
      expect((await check(l)).json().error.code).toBe('not_granted');
      // 막힘 카드(P4): 사람 글 턴의 not_granted 는 그 스레드에 머지 카드를 세운다. 본문에 @ 가 없다.
      const card = (await pool.query(`select body, meta from message where meta->'blocked'->>'kind' = 'merge' and meta->'blocked'->>'agentId' = $1`, [agentId])).rows;
      expect(card).toHaveLength(1);
      expect(card[0].meta.blocked).toMatchObject({ repo: 'izagood/harkroom', number: 7, code: 'not_granted', ownerAccountId: alice.accountId });
      expect(card[0].body).not.toContain('@');
      await pool.query(`delete from account_grant where account_id = $1 and scope = ''`, [agentId]);
    });
    it('admin 역할·can() 은 repo.merge 를 열지 않는다', async () => {
      const me = (await app.inject({ method: 'GET', url: '/auth/me', headers: auth(admin.token) })).json();
      expect(me.capabilities ?? []).not.toContain('repo.merge');
      expect(await can(pool, { ...me, role: 'owner' }, 'repo.merge')).toBe(false);
    });
    it('저장소 이름은 소문자로 정규화되고 정확히 그 저장소만 연다', async () => {
      const res = await grant(alice.token, { scope: 'repo:Izagood/Harkroom' });
      expect(res.statusCode).toBe(200);
      expect(res.json().grants).toEqual([expect.objectContaining({ capability: 'repo.merge', scope: 'repo:izagood/harkroom', allowAgentCause: false })]);
      expect(await mergeGrantFor(pool, agentId, 'IZAGOOD/harkroom')).not.toBeNull();
      expect(await mergeGrantFor(pool, agentId, 'izagood/harkroom-gate')).toBeNull();
      expect(await mergeGrantFor(pool, agentId, 'other-org/other-repo')).toBeNull();
    });
    it('repo: scope 와 allowAgentCause 는 다른 capability 에 못 쓴다', async () => {
      const r1 = await app.inject({ method: 'PUT', url: `/accounts/${bob.accountId}/grants`, headers: auth(admin.token), payload: { capability: 'channel.create', scope: 'repo:a/b' } });
      expect(r1.statusCode).toBe(400);
      const r2 = await app.inject({ method: 'PUT', url: `/accounts/${bob.accountId}/grants`, headers: auth(admin.token), payload: { capability: 'channel.create', allowAgentCause: true } });
      expect(r2.statusCode).toBe(400);
      // 일반 grant 는 지금처럼 admin 이 준다 — 관문을 나눴지 넓히지 않았다.
      const r3 = await app.inject({ method: 'PUT', url: `/accounts/${bob.accountId}/grants`, headers: auth(alice.token), payload: { capability: 'channel.create' } });
      expect(r3.statusCode).toBe(403);
    });
  });

  describe('F2 — 그 에이전트의 소유자인 사람만 준다', () => {
    it('admin 이라도 소유자가 아니면 403, 다른 member 도 403, 에이전트 PAT 도 403', async () => {
      expect((await grant(admin.token, { scope: 'repo:izagood/harkroom-gate' })).statusCode).toBe(403);
      expect((await grant(bob.token, { scope: 'repo:izagood/harkroom-gate' })).statusCode).toBe(403);
      expect((await grant(agentPat, { scope: 'repo:izagood/harkroom-gate' })).statusCode).toBe(403);
      expect(await mergeGrantFor(pool, agentId, 'izagood/harkroom-gate')).toBeNull();
    });
    it('사람에게는 줄 수 없다(에이전트에게만)', async () => {
      expect((await grant(alice.token, { scope: 'repo:izagood/harkroom' }, bob.accountId)).statusCode).toBe(404);
    });
    it('거두기는 소유자도 admin 도 되고, 다른 member 는 안 된다 — 감사에 남는다', async () => {
      expect((await grant(alice.token, { scope: 'repo:izagood/harkroom-gate' })).statusCode).toBe(200);
      expect((await revoke(bob.token, 'repo:izagood/harkroom-gate')).statusCode).toBe(403);
      expect((await revoke(alice.token, 'repo:izagood/harkroom-gate')).statusCode).toBe(204);
      expect((await grant(alice.token, { scope: 'repo:izagood/harkroom-gate' })).statusCode).toBe(200);
      expect((await revoke(admin.token, 'Repo:Izagood/harkroom-gate')).statusCode).toBe(204);
      expect(await mergeGrantFor(pool, agentId, 'izagood/harkroom-gate')).toBeNull();
      const audit = await pool.query(`select count(*)::int as n from audit_log where action = 'grant.revoked' and detail->>'capability' = 'repo.merge'`);
      expect(audit.rows[0].n).toBe(2);
    });
  });

  describe('F4 — 턴을 띄운 메시지가 사람 글일 때만 통과', () => {
    it('사람이 띄운 턴은 통과하고 감사에 남는다', async () => {
      const l = await lease(await mention(alice.accountId));
      const res = await check(l);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ allowed: true, repo: 'izagood/harkroom', grantedBy: alice.accountId, causeByHuman: true, channelId: ch });
      expect(res.headers['cache-control']).toBe('no-store');
      expect((await pool.query(`select 1 from audit_log where action = 'repo.merge.checked' and target = 'repo:izagood/harkroom'`)).rowCount).toBe(1);
    });
    it('다른 에이전트가 띄운 턴은 cause_not_human — allow_agent_cause 를 켠 grant 면 통과', async () => {
      const l = await lease(await mention(otherAgentId));
      expect((await check(l)).json().error.code).toBe('cause_not_human');
      expect((await grant(alice.token, { scope: 'repo:izagood/harkroom', allowAgentCause: true })).statusCode).toBe(200);
      const l2 = await lease(await mention(otherAgentId));
      expect((await check(l2)).json()).toMatchObject({ allowed: true, causeByHuman: false });
      expect((await grant(alice.token, { scope: 'repo:izagood/harkroom', allowAgentCause: false })).statusCode).toBe(200);
    });
    it('③ 사람(소유자)이 이 에이전트의 선택 카드에 답해서 뜬 턴은 사람이 띄운 것으로 본다', async () => {
      const l = await lease(await askCard(alice.accountId));
      const res = await check(l);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ allowed: true, causeByHuman: true });
      expect((await pool.query(`select 1 from audit_log where action = 'repo.merge.checked' and (detail->>'viaAskAnswer')::boolean`)).rowCount).toBe(1);
    });
    it('③ 카드에 답한 사람이 소유자가 아니거나, 아직 답이 없거나, 남의 카드면 cause_not_human', async () => {
      // 채널의 다른 사람(bob)이 눌렀다 — 소유자가 아니다.
      expect((await check(await lease(await askCard(bob.accountId)))).json().error.code).toBe('cause_not_human');
      // 답이 없는 카드(닫힘 등으로 깨어난 턴).
      expect((await check(await lease(await askCard(null)))).json().error.code).toBe('cause_not_human');
      // 다른 에이전트가 세운 카드에 소유자가 답했지만 이 에이전트의 카드가 아니다.
      expect((await check(await lease(await askCard(alice.accountId, otherAgentId)))).json().error.code).toBe('cause_not_human');
      // 답한 사람이 사람이 아니면(에이전트 id 를 적어 넣어도) 아니다.
      expect((await check(await lease(await askCard(otherAgentId)))).json().error.code).toBe('cause_not_human');
    });
    it('③ F1: 남의 카드에 건 거울은 cause 가 아니다 — 소유자가 원본에 답해 거울이 answeredBy 를 물려받아도 cause_not_human', async () => {
      // A(otherAgent)의 사람 카드에 B(이 에이전트)가 거울을 걸었다. syncAskMirrors 가 그 모양 그대로 만든다:
      // 거울 작성자 = B, answeredBy = 소유자(원본에서 복사), B 는 거울 id 로 ask_answered 를 받는다.
      const original = await askCard(alice.accountId, otherAgentId, otherAgentId);
      const mirror = await askCard(alice.accountId, agentId, agentId, original);
      const res = await check(await lease(mirror));
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('cause_not_human');
    });
    it('임대가 틀리거나 끝났으면 lease_invalid, 저장소 모양이 틀리면 400, 권한 없는 저장소는 not_granted', async () => {
      const l = await lease(await mention(alice.accountId));
      expect((await check({ id: l.id, token: 'nope' })).json().error.code).toBe('lease_invalid');
      expect((await check(l, 'not a repo')).statusCode).toBe(400);
      expect((await check(l, 'other-org/other-repo')).json().error.code).toBe('not_granted');
      await app.inject({ method: 'POST', url: `/agent/turn-leases/${l.id}/end`, headers: asAgent(), payload: { token: l.token } });
      expect((await check(l)).json().error.code).toBe('lease_invalid');
      expect((await pool.query(`select count(*)::int as n from audit_log where action = 'repo.merge.denied'`)).rows[0].n).toBeGreaterThanOrEqual(4);
    });
    it('사람 세션·PAT 에이전트는 세 라우트 모두 403', async () => {
      for (const h of [auth(alice.token), auth(agentPat)]) {
        expect((await app.inject({ method: 'GET', url: '/agent/merge-grants', headers: h })).statusCode).toBe(403);
        expect((await app.inject({ method: 'POST', url: '/agent/merge-checks', headers: h, payload: {} })).statusCode).toBe(403);
        expect((await app.inject({ method: 'POST', url: '/agent/merge-results', headers: h, payload: {} })).statusCode).toBe(403);
      }
    });
  });

  describe('보고·목록', () => {
    it('소유자는 자기 에이전트의 grant 목록을 본다 — 다른 member 는 403 (PR 3)', async () => {
      const mine = await app.inject({ method: 'GET', url: `/accounts/${agentId}/grants`, headers: auth(alice.token) });
      expect(mine.statusCode).toBe(200);
      expect(mine.json().grants).toEqual([expect.objectContaining({ capability: 'repo.merge', scope: 'repo:izagood/harkroom' })]);
      expect((await app.inject({ method: 'GET', url: `/accounts/${agentId}/grants`, headers: auth(bob.token) })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: `/accounts/${otherAgentId}/grants`, headers: auth(alice.token) })).statusCode).toBe(403);
    });
    it('merge-grants 는 자기 저장소 목록만 준다', async () => {
      const res = await app.inject({ method: 'GET', url: '/agent/merge-grants', headers: asAgent() });
      expect(res.json()).toEqual({ repos: ['izagood/harkroom'] });
    });
    it('merge-results 는 그 턴의 스레드에 시스템 줄을 쓰고(래퍼 보고라고 밝힘) 감사에 남긴다', async () => {
      const cause = await mention(alice.accountId);
      const l = await lease(cause);
      expect((await check(l)).statusCode).toBe(200);
      const res = await app.inject({
        method: 'POST', url: '/agent/merge-results', headers: asAgent(),
        payload: { leaseId: l.id, token: l.token, repo: 'izagood/harkroom', number: 7, headSha: SHA, result: 'merged', mergeSha: 'b'.repeat(40) },
      });
      expect(res.statusCode).toBe(201);
      const msg = (await pool.query(`select body, kind, author_id, thread_root_id, meta from message where id = $1`, [res.json().messageId])).rows[0];
      expect(msg.kind).toBe('system');
      expect(msg.author_id).toBe(agentId);
      expect(msg.thread_root_id).toBe(cause);
      expect(msg.body).toContain('izagood/harkroom#7 머지됨');
      expect(msg.body).toContain('권한: alice');
      expect(msg.body).toContain('(래퍼 보고)');
      expect(msg.meta.merge).toMatchObject({ repo: 'izagood/harkroom', number: 7, result: 'merged', grantedBy: alice.accountId });
      expect((await pool.query(`select 1 from audit_log where action = 'repo.merge.merged'`)).rowCount).toBe(1);
      // 토큰이 틀리면 아무 줄도 쓰지 않는다 — 남의 스레드에 줄을 꽂는 길.
      const bad = await app.inject({
        method: 'POST', url: '/agent/merge-results', headers: asAgent(),
        payload: { leaseId: l.id, token: 'x', repo: 'izagood/harkroom', number: 7, headSha: SHA, result: 'failed', error: 'boom' },
      });
      expect(bad.statusCode).toBe(403);
      expect((await pool.query(`select count(*)::int as n from message where kind = 'system' and thread_root_id = $1`, [cause])).rows[0].n).toBe(1);
      // N1: 같은 (임대, 저장소, PR, head) 로 두 번째 보고는 받지 않는다 — 한 번 쓰면 끝.
      const again = await app.inject({
        method: 'POST', url: '/agent/merge-results', headers: asAgent(),
        payload: { leaseId: l.id, token: l.token, repo: 'izagood/harkroom', number: 7, headSha: SHA, result: 'merged', mergeSha: 'b'.repeat(40) },
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('already_reported');
      expect((await pool.query(`select count(*)::int as n from message where kind = 'system' and thread_root_id = $1`, [cause])).rows[0].n).toBe(1);
    });
    it('N1: 앞선 통과 판정이 없는 보고는 줄을 쓰지 않는다(권한 없는 저장소·다른 PR·다른 head)', async () => {
      const cause = await mention(alice.accountId);
      const l = await lease(cause);
      const post = (payload: Record<string, unknown>) => app.inject({
        method: 'POST', url: '/agent/merge-results', headers: asAgent(),
        payload: { leaseId: l.id, token: l.token, repo: 'izagood/harkroom', number: 8, headSha: SHA, result: 'merged', ...payload },
      });
      // 판정을 한 번도 묻지 않았다.
      let res = await post({});
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('not_checked');
      // 권한 없는 저장소는 판정에서 거절됐으므로 보고도 거절된다.
      expect((await check(l, 'other-org/other-repo', { number: 8 })).statusCode).toBe(403);
      res = await post({ repo: 'other-org/other-repo' });
      expect(res.json().error.code).toBe('not_checked');
      // 통과한 판정과 PR 번호·head 가 다르면 거절된다.
      expect((await check(l, 'izagood/harkroom', { number: 8 })).statusCode).toBe(200);
      expect((await post({ number: 9 })).json().error.code).toBe('not_checked');
      expect((await post({ headSha: 'c'.repeat(40) })).json().error.code).toBe('not_checked');
      expect((await pool.query(`select count(*)::int as n from message where kind = 'system' and thread_root_id = $1`, [cause])).rows[0].n).toBe(0);
      // 같은 것으로는 통과한다.
      expect((await post({})).statusCode).toBe(201);
    });
    it('N2: 실패 보고의 error 는 meta 에만 — 본문에는 고정 문구뿐이라 @ 가 부름이 되지 않는다', async () => {
      const cause = await mention(alice.accountId);
      const l = await lease(cause);
      expect((await check(l, 'izagood/harkroom', { number: 10 })).statusCode).toBe(200);
      const res = await app.inject({
        method: 'POST', url: '/agent/merge-results', headers: asAgent(),
        payload: { leaseId: l.id, token: l.token, repo: 'izagood/harkroom', number: 10, headSha: SHA, result: 'failed', error: '@channel @bob boom\n@alice' },
      });
      expect(res.statusCode).toBe(201);
      const msg = (await pool.query(`select body, meta from message where id = $1`, [res.json().messageId])).rows[0];
      expect(msg.body).not.toContain('@');
      expect(msg.body).toContain('izagood/harkroom#10 머지 실패');
      expect(msg.body).toContain('(래퍼 보고)');
      expect(msg.meta.merge.error).toBe('@channel @bob boom\n@alice');
      // 그 줄로 생긴 멘션 받은편지는 없다(스레드 답 알림은 별개) — bob 은 불리지 않았다.
      expect((await pool.query(`select count(*)::int as n from inbox where message_id = $1 and (reason = 'mention' or account_id = $2)`, [res.json().messageId, bob.accountId])).rows[0].n).toBe(0);
    });
  });
});
