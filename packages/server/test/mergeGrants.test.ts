import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { can, mergeGrantFor } from '../src/auth/permissions.js';
import { mintPat } from '../src/services/pats.js';
import { prepareDenialCard } from '../src/services/mergeDenials.js';
import { MERGE_DENIAL_DAILY_CAP } from '../src/services/mergeGrants.js';
import { linkPermissionCard, oneLineReason, openPermissionRequest, permissionCardBody, permissionCardOptions, releaseGrant } from '../src/services/permissionRequests.js';
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
    await pool.query(`update agent_config set owner_account_id = $2, invoke_scope = 'owner' where account_id = $1`, [agentId, alice.accountId]);
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
    it('묶음 카드 「추천대로 일괄」로 매긴 답(answeredVia)은 소유자 이름이어도 사람이 띄운 턴이 아니다(security F1, #1280)', async () => {
      const card = await askCard(alice.accountId);
      await pool.query(`update message set meta = jsonb_set(meta, '{ask,answeredVia}', '"bundle_bulk"') where id = $1`, [card]);
      const res = await check(await lease(card));
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('cause_not_human');
      // 같은 카드라도 표지가 없으면(줄을 골라 누른 답) 지금처럼 사람의 답이다 — cause 판정은 통과한다.
      const picked = await askCard(alice.accountId);
      expect((await check(await lease(picked))).json().error?.code).not.toBe('cause_not_human');
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
      expect(res.json()).toEqual({ repos: ['izagood/harkroom'], approvals: [] });
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
    it('merge-results queued(merge queue): 「큐에 넣음」 줄·repo.merge.queued 감사, 보고는 한 번뿐이고 카드는 닫지 않는다', async () => {
      const cause = await mention(alice.accountId);
      const l = await lease(cause);
      expect((await check(l, 'izagood/harkroom', { number: 17 })).statusCode).toBe(200);
      const post = (result: string) => app.inject({
        method: 'POST', url: '/agent/merge-results', headers: asAgent(),
        payload: { leaseId: l.id, token: l.token, repo: 'izagood/harkroom', number: 17, headSha: SHA, result, mergeSha: null },
      });
      const obsoletedBefore = (await pool.query(`select 1 from audit_log where action = 'repo.merge.obsoleted'`)).rowCount;
      const res = await post('queued');
      expect(res.statusCode).toBe(201);
      const msg = (await pool.query(`select body, kind, meta from message where id = $1`, [res.json().messageId])).rows[0];
      expect(msg.kind).toBe('system');
      expect(msg.body).toBe(`📥 izagood/harkroom#17 머지 큐에 넣음 · head ${SHA.slice(0, 9)} · 권한: alice (래퍼 보고)`);
      expect(msg.meta.merge).toMatchObject({ result: 'queued', number: 17, mergeSha: null });
      expect(msg.meta.i18n).toMatchObject({ key: 'system.merge.queuedGranted' });
      expect((await pool.query(`select 1 from audit_log where action = 'repo.merge.queued'`)).rowCount).toBe(1);
      expect((await pool.query(`select 1 from audit_log where action = 'repo.merge.obsoleted'`)).rowCount).toBe(obsoletedBefore);
      // 같은 판정으로 또 보고(merged 든 queued 든)하면 거절 — 큐가 나중에 머지한 것은 래퍼가 보고하지 않는다.
      expect((await post('merged')).json().error.code).toBe('already_reported');
      expect((await post('nope')).statusCode).toBe(400);
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
      expect(ok).toMatchObject({ ok: true, meta: { denialId: id, agentId, ownerAccountId: alice.accountId, repo: 'izagood/p3-b', number: 42, count: 1, reason: 'not_granted', headSha: SHA } });
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

    it('준 뒤 카드 meta 에 준 사람·기한이 적힌다', async () => {
      const { cause, body } = await refused('izagood/p3-e');
      const id = body.error.denialId!;
      const thread = await threadOf(cause);
      const p = await prepareDenialCard(pool, { agentId, denialId: id, channelId: ch, threadRootId: thread });
      if (!p.ok) throw new Error('prepare failed');
      const card = (await pool.query(
        `insert into message (channel_id, thread_root_id, author_id, body, kind, meta) values ($1, $2, $3, 'card', 'user', $4) returning id`,
        [ch, thread, agentId, JSON.stringify({ kind: 'ask', ask: { options: [{ id: 'retry', label: 'retry' }, { id: 'later', label: 'later' }] }, mergeDenial: p.meta })])).rows[0].id as string;
      // 옛 카드(이미 세워진 것) — 새 카드는 권한 요청 카드로 서므로 연결은 손으로 한다.
      await pool.query(`update merge_denial set card_message_id = $2 where id = $1`, [id, card]);
      expect((await grantFrom(alice.token, id)).json().cardMessageId).toBe(card);
      const meta = (await pool.query(`select meta from message where id = $1`, [card])).rows[0].meta.mergeDenial;
      expect(meta.granted).toMatchObject({ by: alice.accountId });
      await revoke(alice.token, 'repo:izagood/p3-e');
    });

    it('L2·D1: 같은 (에이전트, 저장소, 스레드, PR, head)의 안 쓴 기록만 다시 쓴다 — 다른 PR 은 새 기록, 기록의 PR·head 는 안 바뀐다', async () => {
      const { cause, body } = await refused('izagood/p4-reuse');
      const thread = await threadOf(cause);
      const again = async (opts: { number?: number; headSha?: string }) => {
        const reply = (await pool.query(
          `insert into message (channel_id, thread_root_id, author_id, body, kind) values ($1, $2, $3, 'again', 'user') returning id`,
          [ch, thread, alice.accountId])).rows[0].id as string;
        await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [agentId, reply]);
        return (await check(await lease(reply), 'izagood/p4-reuse', opts)).json().error;
      };
      expect(await again({ number: 42 })).toMatchObject({ code: 'not_granted', denialId: body.error.denialId });
      const other = await again({ number: 99 });
      expect(other.code).toBe('not_granted');
      expect(other.denialId).not.toBe(body.error.denialId);
      const rows = (await pool.query(
        `select id, pr_number, obsoleted_at is not null as obsolete from merge_denial where agent_id = $1 and scope = 'repo:izagood/p4-reuse'`, [agentId])).rows;
      expect(rows.find((r) => r.id === body.error.denialId)).toMatchObject({ pr_number: 42, obsolete: false });
      expect(rows.find((r) => r.id === other.denialId)).toMatchObject({ pr_number: 99, obsolete: false });
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
      expect(again).toMatchObject({ ok: true });
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
        expect(card.ask.options.map((o: { id: string }) => o.id)).toEqual(['approve_new_mandate', 'deny']);
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

  // 조직 와일드카드(alice 10-09): `owner/*` 는 그 owner 의 저장소 전부 — 다른 owner·`*/*`·부분 패턴·배포 저장소는 아니다.
  describe('1회 승인 merge_approval (스레드 1b75d7a0) — 권한 요청 카드의 [이번 한 번 머지]', () => {
    const SHA2 = 'b'.repeat(40);
    // 앞 시험들이 이 에이전트로 거절 기록을 많이 남겼다 — 하루 상한(L2, 20개)에 걸리지 않게 그 기록을 어제로 민다.
    beforeEach(async () => { await pool.query(`update merge_denial set created_at = created_at - interval '2 days' where agent_id = $1`, [agentId]); });
    /** 카드가 보여 준 PR·head(security F1 대조값) — requestFor 가 채운다. 보내는 쪽 payload 가 덮을 수 있다. */
    const cardOf = new Map<string, { number: number; headSha: string }>();
    const decide = (token: string, requestId: string, payload: Record<string, unknown>, decision = 'approve-once', target = agentId) =>
      app.inject({ method: 'POST', url: `/agents/${target}/permission-requests/${requestId}/${decision}`, headers: auth(token), payload: { ...(cardOf.get(requestId) ?? {}), ...payload } });
    const threadOf = async (cause: string) => (await pool.query(`select coalesce(thread_root_id, id) as t from message where id = $1`, [cause])).rows[0].t as string;
    const leaseInThread = async (thread: string, authorId: string) => {
      const id = (await pool.query(
        `insert into message (channel_id, thread_root_id, author_id, body, kind) values ($1, $2, $3, 'again', 'user') returning id`,
        [ch, thread, authorId])).rows[0].id as string;
      await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [agentId, id]);
      return lease(id);
    };
    /** 거절 → 거절 기록에 묶인 권한 요청(MCP 의 `message.ask`+`mergeDenialId` 가 하는 것과 같다). */
    const requestFor = async (denialId: string, thread: string) => {
      const p = await prepareDenialCard(pool, { agentId, denialId, channelId: ch, threadRootId: thread });
      if (!p.ok) throw new Error(`prepare: ${p.code}`);
      const r = await openPermissionRequest(pool, {
        agentId, kind: 'merge', repo: p.meta.repo, reason: 'refused', channelId: ch, threadRootId: thread,
        denial: { id: p.meta.denialId, number: p.meta.number, headSha: p.meta.headSha!, reason: p.meta.reason! },
      });
      if (!r.ok || !('created' in r)) throw new Error('request not created');
      expect(r.created.meta.once).toEqual({ number: p.meta.number, headSha: p.meta.headSha, reason: p.meta.reason });
      cardOf.set(r.created.requestId, { number: p.meta.number, headSha: p.meta.headSha! });
      return r.created.requestId;
    };

    it('cause_not_human 도 카드가 서고(grant 가 있어도), 1회 승인하면 다음 판정이 한 번만 통과한다', async () => {
      expect((await grant(alice.token, { scope: 'repo:izagood/once-a' })).statusCode).toBe(200);
      const cause = await mention(otherAgentId);
      const thread = await threadOf(cause);
      const denied = (await check(await lease(cause), 'izagood/once-a', { number: 5, headSha: SHA2 })).json();
      expect(denied.error.code).toBe('cause_not_human');
      expect(denied.error.denialId).toMatch(/^[0-9a-f-]{36}$/);
      const rid = await requestFor(denied.error.denialId, thread);

      const ok = await decide(alice.token, rid, { ghUser: 'corp-account', relaxChecks: true });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ status: 'approved_once', grantExpiresAt: null, approvalExpiresAt: expect.any(String) });
      const listed = (await app.inject({ method: 'GET', url: '/agent/merge-grants', headers: asAgent() })).json();
      expect(listed.approvals).toEqual([expect.objectContaining({ repo: 'izagood/once-a', number: 5, headSha: SHA2, ghUser: 'corp-account', relaxChecks: true, channelId: ch, threadRootId: thread })]);

      const res = await check(await leaseInThread(thread, otherAgentId), 'izagood/once-a', { number: 5, headSha: SHA2 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ allowed: true, grantedBy: alice.accountId, causeByHuman: false, approval: { ghUser: 'corp-account', relaxChecks: true } });
      const sys = (await pool.query(`select body from message where thread_root_id = $1 and kind = 'system' and meta ? 'mergeApproval'`, [thread])).rows;
      expect(sys).toHaveLength(1);
      expect(sys[0].body).toContain('머지 시도');
      expect((await check(await leaseInThread(thread, otherAgentId), 'izagood/once-a', { number: 5, headSha: SHA2 })).json().error.code).toBe('cause_not_human');
      expect((await app.inject({ method: 'GET', url: '/agent/merge-grants', headers: asAgent() })).json().approvals).toEqual([]);
    });

    it('G1: 계정을 비운 1회 승인(ghUser 없음·null)도 받고 null 로 저장한다 — 감사에 ghUserChosenBy: operator', async () => {
      for (const [repo, payload] of [['izagood/once-null-a', {}], ['izagood/once-null-b', { ghUser: null }]] as const) {
        const cause = await mention(alice.accountId);
        const thread = await threadOf(cause);
        const denied = (await check(await lease(cause), repo, { number: 21, headSha: SHA2 })).json();
        const rid = await requestFor(denied.error.denialId, thread);
        // 카드와 거울 둘(원본을 보는 것·중립)을 세워 둔다 — 머지 보고 뒤 오퍼레이터가 고른 이름이 카드·보는 거울에만 적혀야 한다.
        const card = (await pool.query<{ id: string }>(
          `insert into message (channel_id, author_id, kind, body, meta) values ($1, $2, 'user', 'card', jsonb_build_object('permissionRequest', jsonb_build_object('requestId', $3::text, 'kind', 'merge'))) returning id`,
          [ch, agentId, rid])).rows[0]!.id;
        await linkPermissionCard(pool, rid, card);
        const mirrorOf = async (neutral: boolean) => (await pool.query<{ id: string }>(
          `insert into message (channel_id, author_id, kind, body, meta) values ($1, $2, 'user', 'mirror', jsonb_build_object('ask', jsonb_build_object('mirrorOf', $3::text), 'permissionMirror', jsonb_build_object('rootId', $3::text, 'neutral', $4::boolean))) returning id`,
          [ch, agentId, card, neutral])).rows[0]!.id;
        const seeing = await mirrorOf(false);
        const neutralMirror = await mirrorOf(true);
        const ok = await decide(alice.token, rid, payload);
        expect(ok.statusCode).toBe(200);
        expect((await pool.query(`select gh_user from merge_approval where denial_id = $1`, [denied.error.denialId])).rows).toEqual([{ gh_user: null }]);
        const audit = (await pool.query(`select detail from audit_log where action = 'repo.merge.approved_once' and target = $1`, [`repo:${repo}`])).rows;
        expect(audit).toHaveLength(1);
        expect(audit[0].detail).toMatchObject({ ghUser: null, ghUserChosenBy: 'operator' });
        const once = (await pool.query(`select meta->'permissionRequest'->'approvedOnce' as a from message where id = $1`, [card])).rows[0]?.a;
        expect(once.ghUser).toBeNull();
        const pl = await leaseInThread(thread, alice.accountId);
        const peek = await app.inject({ method: 'POST', url: '/agent/merge-approvals/peek', headers: asAgent(), payload: { leaseId: pl.id, token: pl.token, repo, number: 21, headSha: SHA2 } });
        expect(peek.json().approval).toMatchObject({ ghUser: null });
        const ml = await leaseInThread(thread, alice.accountId);
        const res = await check(ml, repo, { number: 21, headSha: SHA2 });
        expect(res.json()).toMatchObject({ allowed: true, approval: { ghUser: null } });
        // designer n3: 번역 표지는 OperatorPick 키 — 「operator-chosen」 같은 값이 계정 칸에 서지 않는다.
        const used = (await pool.query(`select body, meta from message where thread_root_id = $1 and kind = 'system' and meta ? 'mergeApproval'`, [thread])).rows;
        expect(used).toHaveLength(1);
        expect(used[0].body).toContain('gh (오퍼레이터가 고름)');
        expect(used[0].meta.i18n.key).toBe('system.merge.approvalUsedOperatorPick');
        expect(used[0].meta.i18n.args).not.toHaveProperty('ghUser');
        // security n6: 래퍼가 실제로 쓴 계정을 보고하면 감사에 남는다.
        const rep = await app.inject({ method: 'POST', url: '/agent/merge-results', headers: asAgent(), payload: { leaseId: ml.id, token: ml.token, repo, number: 21, headSha: SHA2, result: 'merged', mergeSha: SHA, ghUserUsed: 'picked-account' } });
        expect(rep.statusCode).toBe(201);
        const merged = (await pool.query(`select detail from audit_log where action = 'repo.merge.merged' and target = $1`, [`repo:${repo}`])).rows;
        expect(merged).toHaveLength(1);
        expect(merged[0].detail).toMatchObject({ ghUserUsed: 'picked-account', ghUserChosenBy: 'operator' });
        const metaOf = async (id: string) => (await pool.query(`select meta from message where id = $1`, [id])).rows[0]!.meta;
        expect((await metaOf(card)).permissionRequest).toMatchObject({ status: 'approved_once', ghUserUsed: 'picked-account' });
        expect((await metaOf(seeing)).permissionMirror).toMatchObject({ ghUserUsed: 'picked-account' });
        expect((await metaOf(neutralMirror)).permissionMirror).not.toHaveProperty('ghUserUsed');
      }
    });

    it('승인은 그 PR·head·스레드에만 — head 가 다르거나 다른 스레드면 쓰이지 않는다', async () => {
      const cause = await mention(alice.accountId);
      const thread = await threadOf(cause);
      const denied = (await check(await lease(cause), 'izagood/once-b', { number: 9, headSha: SHA2 })).json();
      expect(denied.error.code).toBe('not_granted');
      expect((await decide(alice.token, await requestFor(denied.error.denialId, thread), { ghUser: 'izagood' })).statusCode).toBe(200);
      expect((await check(await leaseInThread(thread, alice.accountId), 'izagood/once-b', { number: 9, headSha: SHA })).json().error.code).toBe('not_granted');
      expect((await check(await lease(await mention(alice.accountId)), 'izagood/once-b', { number: 9, headSha: SHA2 })).json().error.code).toBe('not_granted');
      const ml = await leaseInThread(thread, alice.accountId);
      const res = await check(ml, 'izagood/once-b', { number: 9, headSha: SHA2 });
      expect(res.json()).toMatchObject({ allowed: true, approval: { ghUser: 'izagood', relaxChecks: false } });
      // 계정이 적힌 승인이면 i18n 은 그 계정을 싣고, 래퍼가 보낸 ghUserUsed 는 감사에 따로 남기지 않는다(승인에 이미 있다).
      const used = (await pool.query(`select meta from message where thread_root_id = $1 and kind = 'system' and meta ? 'mergeApproval'`, [thread])).rows;
      expect(used[0].meta.i18n).toMatchObject({ key: 'system.merge.approvalUsed', args: { ghUser: 'izagood' } });
      await app.inject({ method: 'POST', url: '/agent/merge-results', headers: asAgent(), payload: { leaseId: ml.id, token: ml.token, repo: 'izagood/once-b', number: 9, headSha: SHA2, result: 'merged', mergeSha: SHA, ghUserUsed: 'izagood' } });
      const merged = (await pool.query(`select detail from audit_log where action = 'repo.merge.merged' and target = 'repo:izagood/once-b'`)).rows;
      expect(merged).toHaveLength(1);
      expect(merged[0].detail).not.toHaveProperty('ghUserUsed');
    });

    it('소유자 사람 세션만 · 본문은 ghUser·relaxChecks 둘뿐 · 거절에서 온 카드만 · 한 번만', async () => {
      const cause = await mention(alice.accountId);
      const thread = await threadOf(cause);
      const denied = (await check(await lease(cause), 'izagood/once-c', { number: 3 })).json();
      const rid = await requestFor(denied.error.denialId, thread);
      expect((await decide(bob.token, rid, { ghUser: 'izagood' })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/agents/${agentId}/permission-requests/${rid}/approve-once`, headers: asAgent(), payload: { ghUser: 'izagood' } })).statusCode).toBe(403);
      expect((await decide(alice.token, rid, { ghUser: 'izagood', confirmRepo: 'izagood/once-c' })).statusCode).toBe(400);
      expect((await decide(alice.token, rid, { ghUser: 42 })).statusCode).toBe(400);
      expect((await decide(alice.token, rid, { ghUser: '' })).statusCode).toBe(400);
      expect((await decide(alice.token, rid, { ghUser: '-bad' })).json().error.code).toBe('bad_gh_user');
      expect((await decide(alice.token, rid, { ghUser: 'izagood' })).statusCode).toBe(200);
      expect((await decide(alice.token, rid, { ghUser: 'izagood' })).json().error.code).toBe('already_decided');
      const audit = (await pool.query(`select actor_id from audit_log where action = 'repo.merge.approved_once' and target = 'repo:izagood/once-c'`)).rows;
      expect(audit).toEqual([{ actor_id: alice.accountId }]);
      // 거절 기록 없이 열린 권한 요청(`permission.request`)에는 1회 승인이 없다.
      const plain = await openPermissionRequest(pool, { agentId, kind: 'merge', repo: 'izagood/once-plain', reason: 'x', channelId: ch, threadRootId: thread });
      if (!plain.ok || !('created' in plain)) throw new Error('not created');
      expect((await decide(alice.token, plain.created.requestId, { ghUser: 'izagood', number: 1, headSha: SHA })).json().error.code).toBe('not_once');
    });

    it('D1: 카드가 선 뒤 다른 PR 로 다시 거절되면 새 기록·새 카드 — 옛 카드는 그대로 옛 PR 에만 쓰인다', async () => {
      const cause = await mention(alice.accountId);
      const thread = await threadOf(cause);
      const first = (await check(await lease(cause), 'izagood/once-stale', { number: 11, headSha: SHA2 })).json();
      const rid = await requestFor(first.error.denialId, thread);
      const again = (await check(await leaseInThread(thread, alice.accountId), 'izagood/once-stale', { number: 12, headSha: SHA })).json();
      expect(again.error.denialId).not.toBe(first.error.denialId);
      const rid2 = await requestFor(again.error.denialId, thread);
      expect(rid2).not.toBe(rid);
      // 두 카드 다 기다린다 — 옛 카드의 기록은 옛 PR·head 그대로다.
      expect((await pool.query(`select status from permission_request where id = any($1::uuid[]) order by created_at`, [[rid, rid2]])).rows.map((r) => r.status)).toEqual(['pending', 'pending']);
      expect((await pool.query(`select pr_number, head_sha from merge_denial where id = $1`, [first.error.denialId])).rows[0]).toEqual({ pr_number: 11, head_sha: SHA2 });
      // 옛 카드를 새 PR 값으로 승인하려 해도 card_stale — 기록이 바뀌지 않았으니 본 값(11) 그대로만 된다.
      expect((await decide(alice.token, rid, { ghUser: 'izagood', number: 12, headSha: SHA })).json().error.code).toBe('card_stale');
      const ok = await decide(alice.token, rid, { ghUser: 'izagood', number: 11, headSha: SHA2 });
      expect(ok.statusCode).toBe(200);
      expect((await pool.query(`select pr_number, head_sha from merge_approval where denial_id = $1`, [first.error.denialId])).rows[0]).toEqual({ pr_number: 11, head_sha: SHA2 });
      expect((await pool.query(`select count(*)::int as n from merge_approval where denial_id = $1`, [again.error.denialId])).rows[0].n).toBe(0);
    });

    it('D1: 같은 PR 이 새 head 로 다시 거절되면 옛 기록은 닫히고 새 카드가 옛 카드를 대체한다 · 같은 (PR, head)면 그 기록·카드 그대로', async () => {
      const cause = await mention(alice.accountId);
      const thread = await threadOf(cause);
      const first = (await check(await lease(cause), 'izagood/once-head', { number: 13, headSha: SHA2 })).json();
      const rid = await requestFor(first.error.denialId, thread);
      const same = (await check(await leaseInThread(thread, alice.accountId), 'izagood/once-head', { number: 13, headSha: SHA2 })).json();
      expect(same.error.denialId).toBe(first.error.denialId);
      const moved = (await check(await leaseInThread(thread, alice.accountId), 'izagood/once-head', { number: 13, headSha: SHA })).json();
      expect(moved.error.denialId).not.toBe(first.error.denialId);
      expect((await pool.query(`select obsoleted_at is not null as obsolete, head_sha from merge_denial where id = $1`, [first.error.denialId])).rows[0]).toEqual({ obsolete: true, head_sha: SHA2 });
      const stale = await decide(alice.token, rid, { ghUser: 'izagood', number: 13, headSha: SHA2 });
      expect(stale.statusCode).toBe(409);
      // n4: 새 head 로 낡은 카드는 「PR 닫힘」이 아니라 head_moved 로 알린다 — 에이전트가 옛 id 로 카드를 세우려 해도 같다.
      expect(stale.json().error.code).toBe('head_moved');
      expect(await prepareDenialCard(pool, { agentId, denialId: first.error.denialId, channelId: ch, threadRootId: thread })).toEqual({ ok: false, code: 'head_moved' });
      const rid2 = await requestFor(moved.error.denialId, thread);
      expect((await pool.query(`select status, superseded_by from permission_request where id = $1`, [rid])).rows[0]).toEqual({ status: 'superseded', superseded_by: rid2 });
    });

    it('F2: peek 은 이 임대의 스레드에서 판정이 소모할 바로 그 승인을 소모 없이 보여 준다', async () => {
      const cause = await mention(alice.accountId);
      const thread = await threadOf(cause);
      const denied = (await check(await lease(cause), 'izagood/once-peek', { number: 21, headSha: SHA2 })).json();
      expect((await decide(alice.token, await requestFor(denied.error.denialId, thread), { ghUser: 'izagood', relaxChecks: true })).statusCode).toBe(200);
      const peek = (l: { id: string; token: string }) => app.inject({ method: 'POST', url: '/agent/merge-approvals/peek', headers: asAgent(), payload: { leaseId: l.id, token: l.token, repo: 'izagood/once-peek', number: 21, headSha: SHA2 } });
      // 다른 스레드의 임대로는 보이지 않는다.
      expect((await peek(await lease(await mention(alice.accountId)))).json()).toEqual({ approval: null });
      const l = await leaseInThread(thread, alice.accountId);
      const seen = (await peek(l)).json().approval;
      expect(seen).toMatchObject({ ghUser: 'izagood', relaxChecks: true, id: expect.any(String) });
      expect((await pool.query(`select used_at from merge_approval where id = $1`, [seen.id])).rows[0].used_at).toBeNull();
      const res = (await check(l, 'izagood/once-peek', { number: 21, headSha: SHA2 })).json();
      expect(res.approval.id).toBe(seen.id);
    });

    it('배포 저장소도 같은 규칙이다 — 이름 확인 단계가 없다(alice 10-10)', async () => {
      const before = process.env.HARKROOM_MERGE_DEPLOY_REPOS;
      process.env.HARKROOM_MERGE_DEPLOY_REPOS = 'izagood/once-deploy';
      try {
        const cause = await mention(alice.accountId);
        const denied = (await check(await lease(cause), 'izagood/once-deploy', { number: 4 })).json();
        expect((await decide(alice.token, await requestFor(denied.error.denialId, await threadOf(cause)), { ghUser: 'izagood' })).statusCode).toBe(200);
      } finally {
        if (before === undefined) delete process.env.HARKROOM_MERGE_DEPLOY_REPOS; else process.env.HARKROOM_MERGE_DEPLOY_REPOS = before;
      }
    });
  });

  describe('CI 실패 무시 1회 승인 (스레드 1fccc9a5) — 7일 권한이 있어도 CI 거절이면 카드', () => {
    const SHA3 = 'c'.repeat(40);
    beforeEach(async () => { await pool.query(`update merge_denial set created_at = created_at - interval '2 days' where agent_id = $1`, [agentId]); });
    const threadOf = async (cause: string) => (await pool.query(`select coalesce(thread_root_id, id) as t from message where id = $1`, [cause])).rows[0].t as string;
    const leaseInThread = async (thread: string, authorId: string) => {
      const id = (await pool.query(
        `insert into message (channel_id, thread_root_id, author_id, body, kind) values ($1, $2, $3, 'again', 'user') returning id`,
        [ch, thread, authorId])).rows[0].id as string;
      await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [agentId, id]);
      return lease(id);
    };
    const report = (l: { id: string; token: string }, repo: string, number: number, headSha: string, extra: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/agent/merge-results', headers: asAgent(), payload: { leaseId: l.id, token: l.token, repo, number, headSha, ...extra } });
    const decide = (token: string, requestId: string, payload: Record<string, unknown>, decision = 'approve-once') =>
      app.inject({ method: 'POST', url: `/agents/${agentId}/permission-requests/${requestId}/${decision}`, headers: auth(token), payload });
    /** CI 거절까지 — grant 있는 저장소에서 사람 턴이 판정을 통과하고 래퍼가 CI 로 거절했다고 보고한다. */
    const ciRefused = async (repo: string, number: number, checks: string[], thread?: string) => {
      const l = thread ? await leaseInThread(thread, alice.accountId) : await lease(await mention(alice.accountId));
      expect((await check(l, repo, { number, headSha: SHA3 })).statusCode).toBe(200);
      const res = await report(l, repo, number, SHA3, { result: 'failed', error: 'ci_not_green: not green', ciRefusal: { code: 'ci_not_green', mergeState: 'UNSTABLE', checks } });
      expect(res.statusCode).toBe(201);
      return { l, denialId: res.json().denialId as string | undefined };
    };
    const cardFor = async (denialId: string, thread: string) => {
      const p = await prepareDenialCard(pool, { agentId, denialId, channelId: ch, threadRootId: thread });
      if (!p.ok) throw new Error(`prepare: ${p.code}`);
      const r = await openPermissionRequest(pool, {
        agentId, kind: 'merge', repo: p.meta.repo, reason: 'ci', channelId: ch, threadRootId: thread,
        denial: { id: p.meta.denialId, number: p.meta.number, headSha: p.meta.headSha!, reason: p.meta.reason!, failedChecks: p.meta.failedChecks },
      });
      if (!r.ok || !('created' in r)) throw new Error('request not created');
      return { requestId: r.created.requestId, meta: p.meta, once: r.created.meta.once };
    };

    it('CI 거절 보고 → 거절 기록(체크 이름은 서버가 거른다) → 카드 → 7일·relax 끈 승인은 400 → CI 무시 승인', async () => {
      expect((await grant(alice.token, { scope: 'repo:izagood/ci-a' })).statusCode).toBe(200);
      const long = 'x'.repeat(200);
      const names = ['test', 'rev‮iew', '  lint\u0007 ', '@alice ping', long, 'test', ...Array.from({ length: 30 }, (_, i) => `job-${i}`)];
      const { l, denialId } = await ciRefused('izagood/ci-a', 31, names);
      expect(denialId).toMatch(/^[0-9a-f-]{36}$/);
      const row = (await pool.query(`select reason, failed_checks, pr_number, head_sha from merge_denial where id = $1`, [denialId])).rows[0];
      expect(row.reason).toBe('ci_not_green');
      expect(row.failed_checks).toHaveLength(20);
      expect(row.failed_checks.slice(0, 5)).toEqual(['test', 'review', 'lint', '@alice ping', 'x'.repeat(80)]);
      expect({ pr: row.pr_number, head: row.head_sha }).toEqual({ pr: 31, head: SHA3 });
      // 거절 줄 본문은 고정 문구 — 체크 이름이 본문으로 새지 않는다.
      const failLine = (await pool.query(`select body from message where kind = 'system' and meta->'merge'->>'result' = 'failed' and meta->'merge'->>'repo' = 'izagood/ci-a'`)).rows;
      expect(failLine).toHaveLength(1);
      expect(failLine[0].body).not.toContain('alice');
      const audit = (await pool.query(`select detail from audit_log where action = 'repo.merge.failed' and target = 'repo:izagood/ci-a'`)).rows[0].detail;
      expect(audit).toMatchObject({ denialId, ciRefusal: { code: 'ci_not_green', mergeState: 'UNSTABLE' } });

      const thread = l ? (await pool.query(`select thread_root_id from secret_turn_lease where id = $1`, [l.id])).rows[0]?.thread_root_id as string : '';
      const card = await cardFor(denialId!, thread);
      expect(card.meta).toMatchObject({ reason: 'ci_not_green', number: 31, headSha: SHA3 });
      expect(card.once).toEqual({ number: 31, headSha: SHA3, reason: 'ci_not_green', failedChecks: row.failed_checks });

      // D4: 7일 허락은 서버가 막는다(두 길 다), relax 를 끈 1회 승인도.
      const seven = await decide(alice.token, card.requestId, {}, 'approve');
      expect(seven.statusCode).toBe(400);
      expect(seven.json().error.code).toBe('ci_card_once_only');
      const viaDenial = await app.inject({ method: 'POST', url: `/agents/${agentId}/merge-denials/${denialId}/grant`, headers: auth(alice.token) });
      expect(viaDenial.statusCode).toBe(400);
      expect(viaDenial.json().error.code).toBe('ci_card_once_only');
      const noRelax = await decide(alice.token, card.requestId, { ghUser: 'izagood', relaxChecks: false, number: 31, headSha: SHA3 });
      expect(noRelax.statusCode).toBe(400);
      expect(noRelax.json().error.code).toBe('relax_required');
      expect((await pool.query(`select used_at from merge_denial where id = $1`, [denialId])).rows[0].used_at).toBeNull();
      // 소유자가 아닌 사람·에이전트는 403.
      expect((await decide(bob.token, card.requestId, { ghUser: 'izagood', relaxChecks: true, number: 31, headSha: SHA3 })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/agents/${agentId}/permission-requests/${card.requestId}/approve-once`, headers: asAgent(), payload: { ghUser: 'izagood', relaxChecks: true, number: 31, headSha: SHA3 } })).statusCode).toBe(403);

      // n1: 사람이 본 실패 목록이 거절 기록과 다르면(빠졌거나 다르면) card_stale.
      expect((await decide(alice.token, card.requestId, { ghUser: 'izagood', relaxChecks: true, number: 31, headSha: SHA3 })).json().error.code).toBe('card_stale');
      expect((await decide(alice.token, card.requestId, { ghUser: 'izagood', relaxChecks: true, number: 31, headSha: SHA3, failedChecks: ['test'] })).json().error.code).toBe('card_stale');
      const ok = await decide(alice.token, card.requestId, { ghUser: 'izagood', relaxChecks: true, number: 31, headSha: SHA3, failedChecks: [...row.failed_checks].reverse() });
      expect(ok.statusCode).toBe(200);
      const appr = (await pool.query(`select ci_override, relax_checks, approved_checks from merge_approval where denial_id = $1`, [denialId])).rows[0];
      expect(appr).toEqual({ ci_override: true, relax_checks: true, approved_checks: row.failed_checks });
      // grant 는 만들지도 넓히지도 않는다.
      expect((await pool.query(`select allow_agent_cause from account_grant where account_id = $1 and scope = 'repo:izagood/ci-a'`, [agentId])).rows).toEqual([{ allow_agent_cause: false }]);
    });

    it('D3: CI 무시 승인은 사람이 띄운 턴만 쓴다 — 위임 턴에서는 남고, 사람 턴이 쓰면 줄에 승인자·무시한 체크·「승인 뒤 늘어남」', async () => {
      expect((await grant(alice.token, { scope: 'repo:izagood/ci-b' })).statusCode).toBe(200);
      const first = await ciRefused('izagood/ci-b', 32, ['test', 'review']);
      const thread = (await pool.query(`select thread_root_id from secret_turn_lease where id = $1`, [first.l.id])).rows[0].thread_root_id as string;
      const card = await cardFor(first.denialId!, thread);
      expect((await decide(alice.token, card.requestId, { ghUser: 'izagood', relaxChecks: true, number: 32, headSha: SHA3, failedChecks: ['test', 'review'] })).statusCode).toBe(200);
      const peek = (l: { id: string; token: string }) => app.inject({ method: 'POST', url: '/agent/merge-approvals/peek', headers: asAgent(), payload: { leaseId: l.id, token: l.token, repo: 'izagood/ci-b', number: 32, headSha: SHA3 } });

      // 다른 에이전트가 띄운 턴(위임) — peek 도 판정도 승인을 고르지 않는다.
      const delegated = await leaseInThread(thread, otherAgentId);
      expect((await peek(delegated)).json()).toEqual({ approval: null });
      const d = (await check(delegated, 'izagood/ci-b', { number: 32, headSha: SHA3 })).json();
      expect(d.approval).toBeUndefined();
      expect((await pool.query(`select used_at from merge_approval where denial_id = $1`, [first.denialId])).rows[0].used_at).toBeNull();

      const human = await leaseInThread(thread, alice.accountId);
      expect((await peek(human)).json().approval).toMatchObject({ relaxChecks: true });
      const res = await check(human, 'izagood/ci-b', { number: 32, headSha: SHA3 });
      expect(res.json()).toMatchObject({ allowed: true, approval: { relaxChecks: true, ciOverride: true } });
      const used = (await pool.query(`select body, meta from message where thread_root_id = $1 and kind = 'system' and meta ? 'mergeApproval'`, [thread])).rows;
      expect(used).toHaveLength(1);
      expect(used[0].body).toContain('CI 실패 무시 승인으로 머지 시도 · 승인: alice');
      expect(used[0].meta.i18n).toMatchObject({ key: 'system.merge.approvalUsedCiOverride', args: { approverId: alice.accountId, ghUser: 'izagood' } });

      const merged = await report(human, 'izagood/ci-b', 32, SHA3, { result: 'merged', mergeSha: 'd'.repeat(40), ignoredChecks: ['test', 'review', 'late @bob'] });
      expect(merged.statusCode).toBe(201);
      const line = (await pool.query(`select body, meta from message where id = $1`, [merged.json().messageId])).rows[0];
      expect(line.body).toBe(`🔀 izagood/ci-b#32 머지됨 · ddddddddd · 권한: alice · CI 실패 무시 승인 · 무시: \`test\`, \`review\`, \`late ＠bob\` (승인 뒤 늘어남) (래퍼 보고)`);
      expect(line.meta.merge).toMatchObject({ ciOverride: true, ignoredChecks: ['test', 'review', 'late @bob'], grewAfterApproval: true, viaApproval: true });
      expect(line.meta.i18n).toEqual({ key: 'system.merge.mergedCiOverrideGrew', args: { repo: 'izagood/ci-b', number: 32, sha: 'ddddddddd', granterId: alice.accountId, checks: 'test, review, late ＠bob' } });
      const audit = (await pool.query(`select detail from audit_log where action = 'repo.merge.merged' and target = 'repo:izagood/ci-b'`)).rows[0].detail;
      expect(audit).toMatchObject({ approvedBy: alice.accountId, ciOverride: true, ignoredChecks: ['test', 'review', 'late @bob'], grewAfterApproval: true, approvalId: expect.any(String) });
      // 같은 승인은 두 번 쓰이지 않는다.
      expect((await check(await leaseInThread(thread, alice.accountId), 'izagood/ci-b', { number: 32, headSha: SHA3 })).json().approval).toBeUndefined();
    });

    it('카드는 CI 거절에서만 — BLOCKED·판정 없는 보고는 기록을 만들지 않는다 · 같은 (PR, head)면 CI 기록을 다시 쓰고 다른 PR 이면 새로', async () => {
      expect((await grant(alice.token, { scope: 'repo:izagood/ci-c' })).statusCode).toBe(200);
      const before = (await pool.query(`select count(*)::int as n from merge_denial where agent_id = $1`, [agentId])).rows[0].n;
      const l = await lease(await mention(alice.accountId));
      expect((await check(l, 'izagood/ci-c', { number: 33, headSha: SHA3 })).statusCode).toBe(200);
      const blocked = await report(l, 'izagood/ci-c', 33, SHA3, { result: 'failed', ciRefusal: { code: 'not_mergeable', mergeState: 'BLOCKED', checks: ['test'] } });
      expect(blocked.statusCode).toBe(201);
      expect(blocked.json().denialId).toBeUndefined();
      // 판정을 지나지 않은 보고(승인 사전 확인의 DIRTY 거절 등은 판정 전이다)는 받지 않는다 — 기록도 없다.
      const unchecked = await report(await lease(await mention(alice.accountId)), 'izagood/ci-c', 33, SHA3, { result: 'failed', ciRefusal: { code: 'ci_not_green', checks: ['test'] } });
      expect(unchecked.json().error.code).toBe('not_checked');
      expect((await pool.query(`select count(*)::int as n from merge_denial where agent_id = $1`, [agentId])).rows[0].n).toBe(before);

      const a = await ciRefused('izagood/ci-c', 34, ['test']);
      const thread = (await pool.query(`select thread_root_id from secret_turn_lease where id = $1`, [a.l.id])).rows[0].thread_root_id as string;
      // 같은 PR·head 로 다시 막히면 그 기록을 다시 쓴다(체크만 지금 것으로).
      const a2 = await ciRefused('izagood/ci-c', 34, ['lint'], thread);
      expect(a2.denialId).toBe(a.denialId);
      expect((await pool.query(`select pr_number, failed_checks from merge_denial where id = $1`, [a.denialId])).rows[0]).toEqual({ pr_number: 34, failed_checks: ['lint'] });
      // 다른 PR 이면 새 기록이고 옛 기록의 PR 은 그대로다(D1).
      const b = await ciRefused('izagood/ci-c', 35, ['lint'], thread);
      expect(b.denialId).not.toBe(a.denialId);
      expect((await pool.query(`select pr_number from merge_denial where id = $1`, [a.denialId])).rows[0]).toEqual({ pr_number: 34 });
    });

    it('CI 거절 카드는 선택지가 [거절] 하나(이번 한 번은 PermissionOncePanel, 7일 없음) · 본문은 「CI 실패 무시하고 이번 한 번 머지」와 거른 체크 이름(멘션 글자는 바꿔서)', () => {
      expect(permissionCardOptions('merge', { ciOnce: true, once: true }).map((o) => o.id)).toEqual(['deny']);
      expect(permissionCardOptions('merge', { mandate: true }).map((o) => o.id)).toEqual(['approve_mandate', 'deny']);
      const body = permissionCardBody({
        requestId: 'r', agentId, ownerAccountId: alice.accountId, kind: 'merge', target: 'izagood/ci-x', channelId: null, warnings: [], reason: 'fix ci',
        once: { number: 9, headSha: SHA3, reason: 'ci_not_green', failedChecks: ['test', '@channel <@x>'] }, requestedAt: '', expiresAt: '',
      } as Parameters<typeof permissionCardBody>[0], '@tm');
      expect(body).toBe("권한 요청 · @tm\nCI 실패 무시하고 이번 한 번 머지 `izagood/ci-x` PR #9 · head ccccccccc\n실패한 체크: `test`, `＠channel ‹＠x›`\n이유: fix ci");
    });

    it('r2: 줄 없는 옛 카드 본문은 그대로, 줄 있는 카드는 머리+이유 · r4: 이유의 꺾쇠는 글자로 남는다', () => {
      const base = { requestId: 'r', agentId, ownerAccountId: alice.accountId, kind: 'tool', target: 'Bash(ls:*)', channelId: null, warnings: [], reason: '거절 <이 카드 링크>', requestedAt: '', expiresAt: '' };
      const legacy = permissionCardBody(base as Parameters<typeof permissionCardBody>[0], '@tm');
      expect(legacy).toBe('권한 요청 · @tm\n명령 허용 `Bash(ls:*)` — 이 채널의 모든 대화에서 · 승인하면 7일\n이유: 거절 <이 카드 링크>');
      const lined = permissionCardBody({ ...base, line: { cap: 'tool', scope: 'Bash(ls:*)', limits: {} } } as Parameters<typeof permissionCardBody>[0], '@tm');
      expect(lined).toBe('권한 요청 · @tm\n명령 허용 `Bash(ls:*)`\n이유: 거절 <이 카드 링크>');
      // r5(security F1): 머지 줄 카드도 서버가 쓴 대상 줄을 싣는다(「7일」 없이). 경고 줄은 대상 줄 뒤.
      const merge = permissionCardBody({ ...base, kind: 'merge', target: 'izagood/x', warnings: ['executes_in_workload'], line: { cap: 'merge', scope: 'repo:izagood/x', limits: {} } } as Parameters<typeof permissionCardBody>[0], '@tm');
      expect(merge).toBe('권한 요청 · @tm\n머지 `izagood/x`\n⚠ 돌고 있는 서버 안에서 실행한다\n이유: 거절 <이 카드 링크>');
      expect(oneLineReason('> 인용 <a>b> c<')).toBe('인용 <a>b> c<');
      expect(oneLineReason('x\n> y `z`')).toBe('x > y z');
    });

    it('#1396 n1: 승인 없이 비필수 체크를 무시하고 머지했으면 줄·감사에 이름이 남는다', async () => {
      expect((await grant(alice.token, { scope: 'repo:izagood/ci-d' })).statusCode).toBe(200);
      const l = await lease(await mention(alice.accountId));
      expect((await check(l, 'izagood/ci-d', { number: 36, headSha: SHA3 })).statusCode).toBe(200);
      const res = await report(l, 'izagood/ci-d', 36, SHA3, { result: 'queued', ignoredChecks: ['review / review'] });
      const line = (await pool.query(`select body, meta from message where id = $1`, [res.json().messageId])).rows[0];
      expect(line.body).toBe(`📥 izagood/ci-d#36 머지 큐에 넣음 · head ccccccccc · 권한: alice · 무시: \`review / review\` (래퍼 보고)`);
      expect(line.meta.merge.ciOverride).toBeUndefined();
      expect(line.meta.i18n).toMatchObject({ key: 'system.merge.queuedIgnoring', args: { checks: 'review / review' } });
    });

    it('C안(스레드 50324ba9): 체크 0개를 「PR CI 없음」으로 통과한 머지는 meta·감사에 noPrChecks 가 남고 본문은 그대로다 · 실패 보고에는 안 남는다', async () => {
      expect((await grant(alice.token, { scope: 'repo:izagood/no-ci' })).statusCode).toBe(200);
      const l = await lease(await mention(alice.accountId));
      expect((await check(l, 'izagood/no-ci', { number: 37, headSha: SHA3 })).statusCode).toBe(200);
      const res = await report(l, 'izagood/no-ci', 37, SHA3, { result: 'merged', mergeSha: 'd'.repeat(40), noPrChecks: true });
      expect(res.statusCode).toBe(201);
      const line = (await pool.query(`select body, meta from message where id = $1`, [res.json().messageId])).rows[0];
      expect(line.body).toBe('🔀 izagood/no-ci#37 머지됨 · ddddddddd · 권한: alice (래퍼 보고)');
      expect(line.meta.merge.noPrChecks).toBe(true);
      const audit = (await pool.query(`select detail from audit_log where action = 'repo.merge.merged' and target = 'repo:izagood/no-ci'`)).rows[0].detail;
      expect(audit.noPrChecks).toBe(true);
      const l2 = await lease(await mention(alice.accountId));
      expect((await check(l2, 'izagood/no-ci', { number: 38, headSha: SHA3 })).statusCode).toBe(200);
      const failed = await report(l2, 'izagood/no-ci', 38, SHA3, { result: 'failed', error: 'x', noPrChecks: true });
      const fl = (await pool.query(`select meta from message where id = $1`, [failed.json().messageId])).rows[0];
      expect(fl.meta.merge.noPrChecks).toBeUndefined();
    });
  });

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
      for (const scope of ['repo:*', 'repo:*/*', 'repo:*/harkroom', 'repo:acme-org/ab*', 'repo:acme-org/**']) {
        const res = await grant(alice.token, { scope }, orgAgent);
        // `repo:*` 는 본문 검사(zod)에서 먼저 bad_request 로 걸린다 — 어느 쪽이든 400 이고 grant 는 안 생긴다.
        expect(res.statusCode, scope).toBe(400);
        expect(['bad_scope', 'bad_request'], scope).toContain(res.json().error.code);
      }
      const res = await grant(alice.token, { scope: 'repo:Acme-Org/*' }, orgAgent);
      expect(res.statusCode).toBe(200);
      expect(res.json().grants).toEqual([expect.objectContaining({ capability: 'repo.merge', scope: 'repo:acme-org/*' })]);
      // F2 는 그대로다 — 소유자가 아니면 조직 grant 도 못 준다.
      expect((await grant(bob.token, { scope: 'repo:acme-org/*' }, orgAgent)).statusCode).toBe(403);
    });

    it('같은 owner 의 저장소에는 맞고, 다른 owner·저장소 자리의 * 에는 안 맞는다', async () => {
      expect(await mergeGrantFor(pool, orgAgent, 'acme-org/app')).toMatchObject({ scope: 'repo:acme-org/*', grantedBy: alice.accountId });
      expect(await mergeGrantFor(pool, orgAgent, 'Acme-Org/Other')).toMatchObject({ scope: 'repo:acme-org/*' });
      expect(await mergeGrantFor(pool, orgAgent, 'izagood/harkroom')).toBeNull();
      expect(await mergeGrantFor(pool, orgAgent, 'acme-org-evil/app')).toBeNull();
      expect(await mergeGrantFor(pool, orgAgent, 'acme-org/*')).toBeNull();
      const l = await orgLease();
      const ok = await orgCheck(l, 'acme-org/app');
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ allowed: true, repo: 'acme-org/app', grantedBy: alice.accountId });
      // #1255 security n3: 감사에 어느 grant 로 통과했는지 남는다.
      const audit = await pool.query(`select detail from audit_log where action = 'repo.merge.checked' and target = 'repo:acme-org/app' order by id desc limit 1`);
      expect(audit.rows[0].detail.grantScope).toBe('repo:acme-org/*');
      expect((await orgCheck(l, 'izagood/harkroom')).json().error.code).toBe('not_granted');
      // 래퍼가 `*` 를 저장소로 물어도 grant 문자열과 맞지 않는다 — 실제 저장소 자리는 owner/name 하나다.
      expect((await orgCheck(l, 'acme-org/*')).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/agent/merge-grants', headers: asOrg() })).json()).toEqual({ repos: ['acme-org/*'], approvals: [] });
    });

    it('배포 저장소도 따로 빼지 않는다 — 조직 grant 가 덮고, 목록에 배포 표시가 없다(alice 10-10)', async () => {
      const prev = process.env.HARKROOM_MERGE_DEPLOY_REPOS;
      process.env.HARKROOM_MERGE_DEPLOY_REPOS = 'acme-org/deploy';
      try {
        expect(await mergeGrantFor(pool, orgAgent, 'acme-org/deploy')).toMatchObject({ scope: 'repo:acme-org/*' });
        const put = await grant(alice.token, { scope: 'repo:acme-org/deploy' }, orgAgent);
        expect(put.statusCode).toBe(200);
        const rows = put.json().grants as Record<string, unknown>[];
        expect(rows.every((r) => !('deployRepo' in r))).toBe(true);
      } finally {
        if (prev === undefined) delete process.env.HARKROOM_MERGE_DEPLOY_REPOS; else process.env.HARKROOM_MERGE_DEPLOY_REPOS = prev;
        await revoke(alice.token, 'repo:acme-org/deploy', orgAgent);
      }
    });
    it('정확 grant 와 조직 grant 가 둘 다 있으면 allow_agent_cause 가 켜진 쪽을 쓴다', async () => {
      expect((await grant(alice.token, { scope: 'repo:acme-org/app', allowAgentCause: false }, orgAgent)).statusCode).toBe(200);
      expect((await grant(alice.token, { scope: 'repo:acme-org/*', allowAgentCause: true }, orgAgent)).statusCode).toBe(200);
      expect(await mergeGrantFor(pool, orgAgent, 'acme-org/app')).toMatchObject({ scope: 'repo:acme-org/*', allowAgentCause: true });
      expect((await grant(alice.token, { scope: 'repo:acme-org/*', allowAgentCause: false }, orgAgent)).statusCode).toBe(200);
      expect(await mergeGrantFor(pool, orgAgent, 'acme-org/app')).toMatchObject({ scope: 'repo:acme-org/app' });
      expect((await revoke(alice.token, 'repo:acme-org/app', orgAgent)).statusCode).toBe(204);
    });

    it('permission.request 로는 조직 전체를 청하지 못한다(org_wide) — 내려놓기는 된다', async () => {
      const thread = (await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'x', 'user') returning id`, [ch, alice.accountId])).rows[0].id as string;
      const r = await openPermissionRequest(pool, { agentId: orgAgent, kind: 'merge', repo: 'acme-org/*', reason: 'all', channelId: ch, threadRootId: thread });
      expect(r).toMatchObject({ ok: false, refusal: { code: 'org_wide' } });
      expect(await openPermissionRequest(pool, { agentId: orgAgent, kind: 'merge', repo: '*/*', reason: 'all', channelId: ch, threadRootId: thread }))
        .toMatchObject({ ok: false, refusal: { code: 'bad_repo' } });
      expect(await releaseGrant(pool, { agentId: orgAgent, kind: 'merge', repo: 'Acme-Org/*', channelId: ch }))
        .toMatchObject({ ok: true, scope: 'repo:acme-org/*' });
      expect(await mergeGrantFor(pool, orgAgent, 'acme-org/app')).toBeNull();
    });
  });
});
