import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { can, mergeGrantFor } from '../src/auth/permissions.js';
import { mintPat } from '../src/services/pats.js';
import { bumpDenialCard, linkDenialCard, prepareDenialCard } from '../src/services/mergeDenials.js';
import { MERGE_DENIAL_DAILY_CAP } from '../src/services/mergeGrants.js';
import { openPermissionRequest, releaseGrant } from '../src/services/permissionRequests.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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

  describe('P3 — 거절 카드 [7일 주기] (스레드 febe9ff8, security C1~C6)', () => {
    const grantFrom = (token: string, denialId: string, target = agentId, payload: Record<string, unknown> = {}) =>
      app.inject({ method: 'POST', url: `/agents/${target}/merge-denials/${denialId}/grant`, headers: auth(token), payload });
    const threadOf = async (cause: string) => (await pool.query(`select coalesce(thread_root_id, id) as t from message where id = $1`, [cause])).rows[0].t as string;
    const refused = async (repo: string, causeAuthor = alice.accountId) => {
      const cause = await mention(causeAuthor);
      const l = await lease(cause);
      const res = await check(l, repo, { number: 42 });
      return { cause, res, body: res.json() as { error: { code: string; denialId?: string } } };
    };

    it('C2: not_granted 이고 사람이 띄운 턴이면 denialId 를 준다 — 에이전트가 띄운 턴의 not_granted 에는 없다', async () => {
      const { body } = await refused('izagood/p3-a');
      expect(body.error.code).toBe('not_granted');
      expect(body.error.denialId).toMatch(/^[0-9a-f-]{36}$/);
      const row = (await pool.query(`select agent_id, scope, pr_number from merge_denial where id = $1`, [body.error.denialId])).rows[0];
      expect(row).toEqual({ agent_id: agentId, scope: 'repo:izagood/p3-a', pr_number: 42 });
      // 에이전트(다른 에이전트)의 글로 뜬 턴
      const byAgent = await refused('izagood/p3-a', otherAgentId);
      expect(byAgent.body.error.code).toBe('not_granted');
      expect(byAgent.body.error.denialId).toBeUndefined();
    });

    it('C1: 카드는 그 거절의 에이전트·스레드·안 씀·안 만료일 때만 — 권한 칸은 기록에서 채운다', async () => {
      const { cause, body } = await refused('izagood/p3-b');
      const id = body.error.denialId!;
      const thread = await threadOf(cause);
      expect(await prepareDenialCard(pool, { agentId: otherAgentId, denialId: id, channelId: ch, threadRootId: thread })).toEqual({ ok: false, code: 'denial_other_agent' });
      expect(await prepareDenialCard(pool, { agentId, denialId: id, channelId: ch, threadRootId: await mention(alice.accountId) })).toEqual({ ok: false, code: 'denial_other_thread' });
      expect(await prepareDenialCard(pool, { agentId, denialId: '00000000-0000-4000-8000-000000000000', channelId: ch, threadRootId: thread })).toEqual({ ok: false, code: 'denial_not_found' });
      const later = new Date(Date.now() + 25 * 3_600_000);
      expect(await prepareDenialCard(pool, { agentId, denialId: id, channelId: ch, threadRootId: thread, now: later })).toEqual({ ok: false, code: 'denial_expired' });
      const ok = await prepareDenialCard(pool, { agentId, denialId: id, channelId: ch, threadRootId: thread });
      expect(ok).toMatchObject({ ok: true, existingCardId: null, meta: { denialId: id, agentId, ownerAccountId: alice.accountId, repo: 'izagood/p3-b', number: 42, deployRepo: false, count: 1 } });
    });

    it('C3: 같은 날 같은 저장소·스레드는 카드 한 장 — 다시 막히면 횟수와 버튼의 거절 기록만 바뀐다', async () => {
      const first = await refused('izagood/p3-c');
      const thread = await threadOf(first.cause);
      const p1 = await prepareDenialCard(pool, { agentId, denialId: first.body.error.denialId!, channelId: ch, threadRootId: thread });
      if (!p1.ok) throw new Error('prepare failed');
      const card = (await pool.query(
        `insert into message (channel_id, thread_root_id, author_id, body, kind, meta) values ($1, $2, $3, 'card', 'user', $4) returning id`,
        [ch, thread, agentId, JSON.stringify({ kind: 'ask', ask: { options: [{ id: 'retry', label: 'retry' }, { id: 'later', label: 'later' }] }, mergeDenial: p1.meta })])).rows[0].id as string;
      await linkDenialCard(pool, p1.meta.denialId, card);
      // 같은 스레드에서 다시 막힘 — 그 스레드의 새 사람 글로 뜬 턴(임대는 cause 마다 하나다)
      const reply = (await pool.query(
        `insert into message (channel_id, thread_root_id, author_id, body, kind) values ($1, $2, $3, 'again', 'user') returning id`,
        [ch, thread, alice.accountId])).rows[0].id as string;
      await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [agentId, reply]);
      const l = await lease(reply);
      const again = (await check(l, 'izagood/p3-c', { number: 43 })).json().error.denialId as string;
      const p2 = await prepareDenialCard(pool, { agentId, denialId: again, channelId: ch, threadRootId: thread });
      expect(p2).toMatchObject({ ok: true, existingCardId: card });
      if (!p2.ok) throw new Error('prepare failed');
      await bumpDenialCard(pool, card, p2.meta);
      const meta = (await pool.query(`select meta from message where id = $1`, [card])).rows[0].meta.mergeDenial;
      expect(meta).toMatchObject({ count: 2, denialId: again, number: 43, repo: 'izagood/p3-c' });
    });

    it('C4·C5: 소유자 사람 세션만, :id 가 기록의 에이전트와 같을 때, 한 번만 — scope·기한은 본문에서 받지 않는다', async () => {
      const { body } = await refused('izagood/p3-d');
      const id = body.error.denialId!;
      // 에이전트 토큰·사람 PAT·소유자 아닌 사람·admin 은 403
      expect((await app.inject({ method: 'POST', url: `/agents/${agentId}/merge-denials/${id}/grant`, headers: asAgent() })).statusCode).toBe(403);
      const pat = await mintPat(pool, alice.accountId, 'p3-pat', { actorId: null, actorHandle: null });
      if (!pat.ok) throw new Error('mint failed');
      // 사람 PAT: 지금은 인증 단계에서 401(사람 PAT 경로가 없다). 그 경로가 생겨도 이 라우트는 세션만 받는다(403).
      expect([401, 403]).toContain((await grantFrom(pat.token, id)).statusCode);
      expect((await grantFrom(bob.token, id)).statusCode).toBe(403);
      expect((await grantFrom(admin.token, id)).statusCode).toBe(403);
      // 남의 에이전트 경로에 이 거절 id — alice 가 other 의 소유자여도 404
      await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [otherAgentId, alice.accountId]);
      expect((await grantFrom(alice.token, id, otherAgentId)).statusCode).toBe(404);
      await pool.query(`update agent_config set owner_account_id = null where account_id = $1`, [otherAgentId]);
      expect(await mergeGrantFor(pool, agentId, 'izagood/p3-d')).toBeNull();
      // 소유자 세션 — 본문에 다른 scope·기한을 실어도 무시된다
      const before = Date.now();
      const ok = await grantFrom(alice.token, id, agentId, { scope: 'repo:izagood/other', expiresAt: null });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().repo).toBe('izagood/p3-d');
      const g = await mergeGrantFor(pool, agentId, 'izagood/p3-d');
      expect(g).not.toBeNull();
      expect(await mergeGrantFor(pool, agentId, 'izagood/other')).toBeNull();
      const row = (await pool.query(`select expires_at, allow_agent_cause, granted_by from account_grant where account_id = $1 and scope = 'repo:izagood/p3-d'`, [agentId])).rows[0];
      const days = (new Date(row.expires_at).getTime() - before) / 86_400_000;
      expect(days).toBeGreaterThan(6.99); expect(days).toBeLessThan(7.01);
      expect(row.allow_agent_cause).toBe(false);
      expect(row.granted_by).toBe(alice.accountId);
      // 한 번만
      expect((await grantFrom(alice.token, id)).json().error.code).toBe('denial_used');
      // 감사
      const audit = (await pool.query(`select detail from audit_log where action = 'grant.given' and detail->>'denialId' = $1`, [id])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].detail).toMatchObject({ via: 'merge_denial', scope: 'repo:izagood/p3-d' });
      await revoke(alice.token, 'repo:izagood/p3-d');
    });

    it('C6: 배포 저장소는 카드에 deployRepo 로 표시되고, REST 는 거절하며 기록을 쓰지 않는다', async () => {
      const prev = process.env.HARKROOM_MERGE_DEPLOY_REPOS;
      process.env.HARKROOM_MERGE_DEPLOY_REPOS = 'Izagood/Homelab, bad name';
      try {
        const { cause, body } = await refused('izagood/homelab');
        const id = body.error.denialId!;
        const p = await prepareDenialCard(pool, { agentId, denialId: id, channelId: ch, threadRootId: await threadOf(cause) });
        expect(p).toMatchObject({ ok: true, meta: { deployRepo: true } });
        const res = await grantFrom(alice.token, id);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('deploy_repo');
        expect((await pool.query(`select used_at from merge_denial where id = $1`, [id])).rows[0].used_at).toBeNull();
        expect(await mergeGrantFor(pool, agentId, 'izagood/homelab')).toBeNull();
      } finally {
        if (prev === undefined) delete process.env.HARKROOM_MERGE_DEPLOY_REPOS; else process.env.HARKROOM_MERGE_DEPLOY_REPOS = prev;
      }
    });

    it('준 뒤 카드 meta 에 준 사람·기한이 적힌다', async () => {
      const { cause, body } = await refused('izagood/p3-e');
      const id = body.error.denialId!;
      const thread = await threadOf(cause);
      const p = await prepareDenialCard(pool, { agentId, denialId: id, channelId: ch, threadRootId: thread });
      if (!p.ok) throw new Error('prepare failed');
      const card = (await pool.query(
        `insert into message (channel_id, thread_root_id, author_id, body, kind, meta) values ($1, $2, $3, 'card', 'user', $4) returning id`,
        [ch, thread, agentId, JSON.stringify({ kind: 'ask', ask: { options: [{ id: 'retry', label: 'retry' }, { id: 'later', label: 'later' }] }, mergeDenial: p.meta })])).rows[0].id as string;
      await linkDenialCard(pool, id, card);
      expect((await grantFrom(alice.token, id)).json().cardMessageId).toBe(card);
      const meta = (await pool.query(`select meta from message where id = $1`, [card])).rows[0].meta.mergeDenial;
      expect(meta.granted).toMatchObject({ by: alice.accountId });
      await revoke(alice.token, 'repo:izagood/p3-e');
    });

    it('L2: 같은 (에이전트, 저장소, 스레드)의 안 쓴 기록은 다시 쓴다 — PR 번호만 지금 것으로', async () => {
      const { cause, body } = await refused('izagood/p4-reuse');
      const thread = await threadOf(cause);
      const reply = (await pool.query(
        `insert into message (channel_id, thread_root_id, author_id, body, kind) values ($1, $2, $3, 'again', 'user') returning id`,
        [ch, thread, alice.accountId])).rows[0].id as string;
      await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [agentId, reply]);
      const again = (await check(await lease(reply), 'izagood/p4-reuse', { number: 99 })).json().error;
      expect(again).toMatchObject({ code: 'not_granted', denialId: body.error.denialId });
      const rows = (await pool.query(`select pr_number from merge_denial where agent_id = $1 and scope = 'repo:izagood/p4-reuse'`, [agentId])).rows;
      expect(rows).toEqual([{ pr_number: 99 }]);
    });

    it('L2: 에이전트마다 24시간 새 기록 상한 — 넘으면 not_granted 는 그대로, denialId 는 없다', async () => {
      const capAgent = (await createAgent(app, admin.token, 'capbot')).accountId;
      const have = (await pool.query(`select count(*)::int as n from merge_denial where agent_id = $1`, [capAgent])).rows[0].n as number;
      expect(have).toBe(0);
      // 상한까지는 손으로 채운다(임대·스레드는 아무 기록의 것을 빌린다 — 상한은 에이전트 단위다)
      const src = (await pool.query(`select channel_id, thread_root_id, lease_id from merge_denial limit 1`)).rows[0];
      for (let i = 0; i < MERGE_DENIAL_DAILY_CAP; i++) {
        await pool.query(
          `insert into merge_denial (agent_id, scope, pr_number, head_sha, channel_id, thread_root_id, lease_id, expires_at)
           values ($1, $2, 1, $3, $4, $5, $6, now() + interval '1 day')`,
          [capAgent, `repo:izagood/cap-${i}`, SHA, src.channel_id, src.thread_root_id, src.lease_id]);
      }
      await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [capAgent, alice.accountId]);
      await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [capAgent, op.operatorId, admin.accountId]);
      const cause = await mention(alice.accountId, capAgent);
      const l = (await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: asAgent(op, capAgent), payload: { causeMessageId: cause } })).json().lease as { id: string; token: string };
      const res = await app.inject({ method: 'POST', url: '/agent/merge-checks', headers: asAgent(op, capAgent), payload: { leaseId: l.id, token: l.token, repo: 'izagood/cap-over', number: 1, headSha: SHA } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('not_granted');
      expect(res.json().error.denialId).toBeUndefined();
      expect((await pool.query(`select count(*)::int as n from merge_denial where agent_id = $1`, [capAgent])).rows[0].n).toBe(MERGE_DENIAL_DAILY_CAP);
    });

    it('n1: 있던 카드는 그 에이전트가 쓴 글에서만 찾는다 — 같은 key 의 남의 글은 무시', async () => {
      const { cause, body } = await refused('izagood/p4-n1');
      const thread = await threadOf(cause);
      const p = await prepareDenialCard(pool, { agentId, denialId: body.error.denialId!, channelId: ch, threadRootId: thread });
      if (!p.ok) throw new Error('prepare failed');
      await pool.query(
        `insert into message (channel_id, thread_root_id, author_id, body, kind, meta) values ($1, $2, $3, 'fake', 'user', $4)`,
        [ch, thread, otherAgentId, JSON.stringify({ mergeDenial: p.meta })]);
      const again = await prepareDenialCard(pool, { agentId, denialId: body.error.denialId!, channelId: ch, threadRootId: thread });
      expect(again).toMatchObject({ ok: true, existingCardId: null });
    });

    describe('n2: MCP 경로 message.ask + mergeDenialId', () => {
      let client: Client;
      const text = (r: Awaited<ReturnType<Client['callTool']>>): any =>
        JSON.parse((r.content as { type: string; text: string }[])[0]!.text);
      beforeAll(async () => {
        await app.listen({ port: 0, host: '127.0.0.1' });
        const addr = app.server.address();
        const url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
        client = new Client({ name: 'test', version: '0.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${agentPat}` } } }));
      });
      afterAll(async () => { await client.close(); });
      const ask = (args: Record<string, unknown>) => client.callTool({ name: 'message.ask', arguments: {
        channelId: ch, body: 'merge refused', options: [{ id: 'retry', label: '다시 머지' }, { id: 'later', label: '나중에' }], ...args,
      } }).then(text);

      it('to·mirrorOf 를 실으면 merge_denial_audience 로 거절되고 카드가 서지 않는다', async () => {
        const { cause, body } = await refused('izagood/p4-mcp-a');
        const thread = await threadOf(cause);
        const denialId = body.error.denialId!;
        expect((await ask({ threadRootId: thread, mergeDenialId: denialId, to: 'alice' })).error.code).toBe('merge_denial_audience');
        expect((await ask({ threadRootId: thread, mergeDenialId: denialId, mirrorOf: cause })).error.code).toBe('merge_denial_audience');
        expect((await pool.query(`select count(*)::int as n from message where meta ? 'mergeDenial' and coalesce(thread_root_id, id) = $1`, [thread])).rows[0].n).toBe(0);
      });

      it('P4: 머지 거절 카드는 권한 카드로 선다 — 저장소는 거절 기록 값, 같은 스레드 두 번째 ask 는 있던 요청을 가리킨다', async () => {
        const { cause, body } = await refused('izagood/p4-mcp-b');
        const thread = await threadOf(cause);
        const first = await ask({ threadRootId: thread, mergeDenialId: body.error.denialId! });
        expect(first.error).toBeUndefined();
        expect(first).toMatchObject({ pending: true, requestId: expect.any(String), cardMessageId: expect.any(String) });
        const card = (await pool.query(`select meta from message where id = $1`, [first.cardMessageId])).rows[0].meta;
        expect(card.permissionRequest).toMatchObject({ kind: 'merge', target: 'izagood/p4-mcp-b', agentId, ownerAccountId: alice.accountId });
        expect(card.mergeDenial).toBeUndefined();
        expect(card.ask.options.map((o: { id: string }) => o.id)).toEqual(['approve', 'deny']);
        const second = await ask({ threadRootId: thread, mergeDenialId: body.error.denialId!, body: 'again' });
        expect(second).toMatchObject({ pending: true, requestId: first.requestId, cardMessageId: first.cardMessageId });
        // 소유자가 일반 ask-answer(모바일 경로)로 승인하면 그 저장소 grant 가 생긴다.
        const res = await app.inject({ method: 'POST', url: `/channels/${ch}/messages/${first.cardMessageId}/ask-answer`, headers: auth(alice.token), payload: { optionId: 'approve' } });
        expect(res.statusCode).toBe(200);
        expect(await mergeGrantFor(pool, agentId, 'izagood/p4-mcp-b')).toMatchObject({ grantedBy: alice.accountId });
      });

      it('다른 스레드에서 세우면 denial_other_thread', async () => {
        const { body } = await refused('izagood/p4-mcp-c');
        const elsewhere = await mention(alice.accountId);
        expect((await ask({ threadRootId: elsewhere, mergeDenialId: body.error.denialId! })).error.code).toBe('denial_other_thread');
      });
    });
  });

  // 조직 와일드카드(jaebin 10-09): `owner/*` 는 그 owner 의 저장소 전부 — 다른 owner·`*/*`·부분 패턴·배포 저장소는 아니다.
  describe('조직 grant owner/*', () => {
    let orgAgent: string;
    const asOrg = () => ({ ...auth(op.token), 'x-harkroom-agent': orgAgent });
    const orgLease = async (): Promise<{ id: string; token: string }> => {
      const m = await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'merge it', 'user') returning id`, [ch, alice.accountId]);
      await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [orgAgent, m.rows[0].id]);
      return (await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: asOrg(), payload: { causeMessageId: m.rows[0].id } })).json().lease;
    };
    const orgCheck = (l: { id: string; token: string }, repo: string) =>
      app.inject({ method: 'POST', url: '/agent/merge-checks', headers: asOrg(), payload: { leaseId: l.id, token: l.token, repo, number: 9, headSha: SHA } });

    beforeAll(async () => {
      orgAgent = (await createAgent(app, admin.token, 'orgtm')).accountId;
      await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [orgAgent, alice.accountId]);
      await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [orgAgent, op.operatorId, admin.accountId]);
    });

    it('* 하나·*/*·owner 자리의 *·부분 패턴은 400, owner/* 는 소문자로 저장된다', async () => {
      for (const scope of ['repo:*', 'repo:*/*', 'repo:*/harkroom', 'repo:rebellions-sw/ab*', 'repo:rebellions-sw/**']) {
        const res = await grant(alice.token, { scope }, orgAgent);
        // `repo:*` 는 본문 검사(zod)에서 먼저 bad_request 로 걸린다 — 어느 쪽이든 400 이고 grant 는 안 생긴다.
        expect(res.statusCode, scope).toBe(400);
        expect(['bad_scope', 'bad_request'], scope).toContain(res.json().error.code);
      }
      const res = await grant(alice.token, { scope: 'repo:Rebellions-SW/*' }, orgAgent);
      expect(res.statusCode).toBe(200);
      expect(res.json().grants).toEqual([expect.objectContaining({ capability: 'repo.merge', scope: 'repo:rebellions-sw/*' })]);
      // F2 는 그대로다 — 소유자가 아니면 조직 grant 도 못 준다.
      expect((await grant(bob.token, { scope: 'repo:rebellions-sw/*' }, orgAgent)).statusCode).toBe(403);
    });

    it('같은 owner 의 저장소에는 맞고, 다른 owner·저장소 자리의 * 에는 안 맞는다', async () => {
      expect(await mergeGrantFor(pool, orgAgent, 'rebellions-sw/npu')).toMatchObject({ scope: 'repo:rebellions-sw/*', grantedBy: alice.accountId });
      expect(await mergeGrantFor(pool, orgAgent, 'Rebellions-SW/Other')).toMatchObject({ scope: 'repo:rebellions-sw/*' });
      expect(await mergeGrantFor(pool, orgAgent, 'izagood/harkroom')).toBeNull();
      expect(await mergeGrantFor(pool, orgAgent, 'rebellions-sw-evil/npu')).toBeNull();
      expect(await mergeGrantFor(pool, orgAgent, 'rebellions-sw/*')).toBeNull();
      const l = await orgLease();
      const ok = await orgCheck(l, 'rebellions-sw/npu');
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ allowed: true, repo: 'rebellions-sw/npu', grantedBy: alice.accountId });
      // #1255 security n3: 감사에 어느 grant 로 통과했는지 남는다.
      const audit = await pool.query(`select detail from audit_log where action = 'repo.merge.checked' and target = 'repo:rebellions-sw/npu' order by id desc limit 1`);
      expect(audit.rows[0].detail.grantScope).toBe('repo:rebellions-sw/*');
      expect((await orgCheck(l, 'izagood/harkroom')).json().error.code).toBe('not_granted');
      // 래퍼가 `*` 를 저장소로 물어도 grant 문자열과 맞지 않는다 — 실제 저장소 자리는 owner/name 하나다.
      expect((await orgCheck(l, 'rebellions-sw/*')).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/agent/merge-grants', headers: asOrg() })).json()).toEqual({ repos: ['rebellions-sw/*'] });
    });

    it('배포 저장소는 조직 grant 가 덮지 않는다 — 정확한 이름 grant 로만 열린다', async () => {
      const prev = process.env.HARKROOM_MERGE_DEPLOY_REPOS;
      process.env.HARKROOM_MERGE_DEPLOY_REPOS = 'rebellions-sw/deploy';
      try {
        expect(await mergeGrantFor(pool, orgAgent, 'rebellions-sw/deploy')).toBeNull();
        expect(await mergeGrantFor(pool, orgAgent, 'rebellions-sw/npu')).not.toBeNull();
        expect((await grant(alice.token, { scope: 'repo:rebellions-sw/deploy' }, orgAgent)).statusCode).toBe(200);
        expect(await mergeGrantFor(pool, orgAgent, 'rebellions-sw/deploy')).toMatchObject({ scope: 'repo:rebellions-sw/deploy' });
      } finally {
        if (prev === undefined) delete process.env.HARKROOM_MERGE_DEPLOY_REPOS; else process.env.HARKROOM_MERGE_DEPLOY_REPOS = prev;
        await revoke(alice.token, 'repo:rebellions-sw/deploy', orgAgent);
      }
    });

    it('정확 grant 와 조직 grant 가 둘 다 있으면 allow_agent_cause 가 켜진 쪽을 쓴다', async () => {
      expect((await grant(alice.token, { scope: 'repo:rebellions-sw/npu', allowAgentCause: false }, orgAgent)).statusCode).toBe(200);
      expect((await grant(alice.token, { scope: 'repo:rebellions-sw/*', allowAgentCause: true }, orgAgent)).statusCode).toBe(200);
      expect(await mergeGrantFor(pool, orgAgent, 'rebellions-sw/npu')).toMatchObject({ scope: 'repo:rebellions-sw/*', allowAgentCause: true });
      expect((await grant(alice.token, { scope: 'repo:rebellions-sw/*', allowAgentCause: false }, orgAgent)).statusCode).toBe(200);
      expect(await mergeGrantFor(pool, orgAgent, 'rebellions-sw/npu')).toMatchObject({ scope: 'repo:rebellions-sw/npu' });
      expect((await revoke(alice.token, 'repo:rebellions-sw/npu', orgAgent)).statusCode).toBe(204);
    });

    it('permission.request 로는 조직 전체를 청하지 못한다(org_wide) — 내려놓기는 된다', async () => {
      const thread = (await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'x', 'user') returning id`, [ch, alice.accountId])).rows[0].id as string;
      const r = await openPermissionRequest(pool, { agentId: orgAgent, kind: 'merge', repo: 'rebellions-sw/*', reason: 'all', channelId: ch, threadRootId: thread });
      expect(r).toMatchObject({ ok: false, refusal: { code: 'org_wide' } });
      expect(await openPermissionRequest(pool, { agentId: orgAgent, kind: 'merge', repo: '*/*', reason: 'all', channelId: ch, threadRootId: thread }))
        .toMatchObject({ ok: false, refusal: { code: 'bad_repo' } });
      expect(await releaseGrant(pool, { agentId: orgAgent, kind: 'merge', repo: 'Rebellions-SW/*', channelId: ch }))
        .toMatchObject({ ok: true, scope: 'repo:rebellions-sw/*' });
      expect(await mergeGrantFor(pool, orgAgent, 'rebellions-sw/npu')).toBeNull();
    });
  });
});
