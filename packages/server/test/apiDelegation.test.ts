// 위임(외부 API 권한 C안 P5, 스레드 07519d86) — `delegateApiGrant`·`decideDelegation`·`revokeDelegation` 과 사슬 판정.
// security 가 P5 조건으로 적어 둔 다섯(parent.w ⇒ child.w · depth 보존 · parent_grant_id · E2 사람 확인 · 머지 위임 없음)과
// E1(루트 사람의 에이전트만)·30일·범위 ⊆ 를 고정한다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { apiGrantFor } from '../src/auth/apiGrants.js';
import { decideDelegation, delegateApiGrant, listDelegations, revokeDelegation } from '../src/services/apiDelegation.js';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

describe('위임', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let a: string; let b: string; let c: string; let bobs: string;
  let connectorId: string; let ch: string; let other: string;

  /** 원인 메시지 — 기본은 위임하는 에이전트(a)를 깨운 글(inbox 있음). `woke: false` 면 깨우지 않은 글. */
  const msgBy = async (authorId: string, o: { woke?: boolean; forAgent?: string; channel?: string } = {}) => {
    const id = (await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'go', 'user') returning id`, [o.channel ?? ch, authorId])).rows[0].id as string;
    if (o.woke !== false) await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [o.forAgent ?? a, id]);
    return id;
  };
  const give = (agent: string, body: Record<string, unknown>) => app.inject({
    method: 'PUT', url: `/accounts/${agent}/grants`, headers: auth(alice.token),
    payload: { capability: 'api.call', scope: `connector:${connectorId}`, ...body },
  });
  const grantOf = async (agent: string) => (await pool.query(
    `select id, parent_grant_id, delegate_depth, write_needs_human_cause, suspend_reason, limits from account_grant
      where account_id = $1 and capability = 'api.call'`, [agent])).rows[0];
  const base = (over: Record<string, unknown> = {}) => ({
    fromAgentId: a, to: b, connector: 'lab-api', methods: ['GET'], pathPrefix: '/api/clusters', expiresAt: days(3), delegateDepth: 0, causeMessageId: null as string | null, ...over,
  });

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    const admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    a = (await createAgent(app, admin.token, 'lead')).accountId;
    b = (await createAgent(app, admin.token, 'worker')).accountId;
    c = (await createAgent(app, admin.token, 'helper')).accountId;
    bobs = (await createAgent(app, admin.token, 'bobs')).accountId;
    for (const x of [a, b, c]) await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [x, alice.accountId]);
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [bobs, bob.accountId]);
    const secretId = (await pool.query(`insert into secret (name, kind, owner_account_id) values ('lab-token', 'text', $1) returning id`, [alice.accountId])).rows[0].id;
    connectorId = (await app.inject({ method: 'POST', url: '/connectors', headers: auth(alice.token),
      payload: { name: 'lab-api', baseUrl: 'https://api.example.internal', authKind: 'bearer', secretId, methods: ['GET', 'POST', 'PUT'] } })).json().connector.id;
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'deleg' } })).json().id as string;
    other = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'elsewhere' } })).json().id as string;
    // 사람이 a 에게: GET·POST /api/ · 7일 · 한 단계 더 · 쓰기는 사람 글 턴만.
    expect((await give(a, { limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' }, expiresAt: days(7), delegateDepth: 1, writeNeedsHumanCause: true })).statusCode).toBe(200);
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('범위·단계·만료·대상이 어긋나면 거절한다', async () => {
    const human = await msgBy(alice.accountId);
    expect(await delegateApiGrant(pool, base({ methods: ['PUT'], causeMessageId: human }))).toMatchObject({ ok: false, code: 'wider_than_parent' });
    expect(await delegateApiGrant(pool, base({ pathPrefix: '/', causeMessageId: human }))).toMatchObject({ ok: false, code: 'wider_than_parent' });
    expect(await delegateApiGrant(pool, base({ pathPrefix: '/api-admin', causeMessageId: human }))).toMatchObject({ ok: false, code: 'wider_than_parent' });
    expect(await delegateApiGrant(pool, base({ delegateDepth: 1, causeMessageId: human }))).toMatchObject({ ok: false, code: 'depth_too_deep' });
    expect(await delegateApiGrant(pool, base({ expiresAt: days(8), causeMessageId: human }))).toMatchObject({ ok: false, code: 'bad_expiry' });
    expect(await delegateApiGrant(pool, base({ expiresAt: days(31), causeMessageId: human }))).toMatchObject({ ok: false, code: 'bad_expiry' });
    expect(await delegateApiGrant(pool, base({ to: bobs, causeMessageId: human }))).toMatchObject({ ok: false, code: 'not_root_owner_agent' });
    expect(await delegateApiGrant(pool, base({ to: a, causeMessageId: human }))).toMatchObject({ ok: false, code: 'self' });
    expect(await delegateApiGrant(pool, base({ fromAgentId: c, to: b, causeMessageId: human }))).toMatchObject({ ok: false, code: 'not_granted' });
  });

  it('사람 글 턴: 바로 쓰이고, parent·depth 가 서고, 「쓰기는 사람 글 턴만」을 물려받는다', async () => {
    const human = await msgBy(alice.accountId);
    const r = await delegateApiGrant(pool, base({ methods: ['GET', 'POST'], writeNeedsHumanCause: false, causeMessageId: human }));
    expect(r).toMatchObject({ ok: true, pending: false });
    const parent = await grantOf(a); const child = await grantOf(b);
    expect(child).toMatchObject({ parent_grant_id: parent.id, delegate_depth: 0, write_needs_human_cause: true, suspend_reason: null });
    expect((await apiGrantFor(pool, { agentId: b, connectorId, method: 'GET', path: '/api/clusters/1' })).ok).toBe(true);
    expect(await apiGrantFor(pool, { agentId: b, connectorId, method: 'GET', path: '/api/nodes' })).toEqual({ ok: false, code: 'path_not_allowed' });
    // 받은 쪽(depth 0)은 다시 주지 못한다.
    expect(await delegateApiGrant(pool, base({ fromAgentId: b, to: c, causeMessageId: human }))).toMatchObject({ ok: false, code: 'no_delegate_depth' });
    // 루트 사람을 부르는 시스템 줄.
    const sys = (await pool.query(`select body, meta from message where meta->'delegation'->>'grantId' = $1`, [r.ok ? r.grantId : ''])).rows[0];
    // 본문 멘션은 저장 때 id 토큰이 된다 — 루트 사람을 부른 것이다(알림).
    expect(sys.body).toContain(`<@${alice.accountId}>`);
    expect(sys.meta.delegation).toMatchObject({ pending: false, rootAccountId: alice.accountId, toAgentId: b });
    expect((await listDelegations(pool, a)).given).toEqual([expect.objectContaining({ to: 'worker', connector: 'lab-api' })]);
  });

  it('사슬 판정: 부모가 칸을 켰는데 자식이 끄면 chain_broken(parent.w ⇒ child.w)', async () => {
    await pool.query(`update account_grant set write_needs_human_cause = false where account_id = $1 and capability = 'api.call'`, [b]);
    expect(await apiGrantFor(pool, { agentId: b, connectorId, method: 'GET', path: '/api/clusters/1' })).toEqual({ ok: false, code: 'chain_broken' });
    await pool.query(`update account_grant set write_needs_human_cause = true where account_id = $1 and capability = 'api.call'`, [b]);
  });

  it('E2: 에이전트 글 턴이면 대기 — 쓰이지 않다가 루트 사람이 허락하면 쓰인다 · 남은 허락 못 한다 · 거절하면 지워진다', async () => {
    const byAgent = await msgBy(a);
    const r = await delegateApiGrant(pool, base({ to: c, causeMessageId: byAgent }));
    expect(r).toMatchObject({ ok: true, pending: true });
    if (!r.ok) return;
    expect(await apiGrantFor(pool, { agentId: c, connectorId, method: 'GET', path: '/api/clusters' })).toEqual({ ok: false, code: 'suspended' });
    expect(await decideDelegation(pool, { grantId: r.grantId, humanId: bob.accountId, approve: true })).toMatchObject({ ok: false, status: 403 });
    const viaRest = await app.inject({ method: 'POST', url: `/grants/${r.grantId}/approve`, headers: auth(alice.token) });
    expect(viaRest.statusCode).toBe(204);
    expect((await apiGrantFor(pool, { agentId: c, connectorId, method: 'GET', path: '/api/clusters' })).ok).toBe(true);
    const card = (await pool.query(`select meta from message where meta->'delegation'->>'grantId' = $1`, [r.grantId])).rows[0];
    expect(card.meta.delegation).toMatchObject({ pending: false, decision: 'approved' });
    expect((await app.inject({ method: 'POST', url: `/grants/${r.grantId}/approve`, headers: auth(alice.token) })).statusCode).toBe(409);

    await revokeDelegation(pool, { agentId: a, grantId: r.grantId });
    const r2 = await delegateApiGrant(pool, base({ to: c, causeMessageId: await msgBy(a) }));
    if (!r2.ok) throw new Error('expected ok');
    expect((await app.inject({ method: 'POST', url: `/grants/${r2.grantId}/decline`, headers: auth(alice.token) })).statusCode).toBe(204);
    expect(await grantOf(c)).toBeUndefined();
  });

  it('F1: 이 에이전트를 깨우지 않은 사람 글을 원인으로 대면 대기이고, 그 채널에는 글이 생기지 않는다', async () => {
    const notMine = await msgBy(alice.accountId, { woke: false, channel: other });
    const r = await delegateApiGrant(pool, base({ to: c, causeMessageId: notMine }));
    expect(r).toMatchObject({ ok: true, pending: true });
    expect((await pool.query(`select 1 from message where channel_id = $1 and meta ? 'delegation'`, [other])).rowCount).toBe(0);
    if (r.ok) await revokeDelegation(pool, { agentId: a, grantId: r.grantId });
  });

  it('F2: 루트 사람이 아닌 사람(다른 멤버)의 글로 띄운 턴이면 대기', async () => {
    const r = await delegateApiGrant(pool, base({ to: c, causeMessageId: await msgBy(bob.accountId) }));
    expect(r).toMatchObject({ ok: true, pending: true });
    if (r.ok) await revokeDelegation(pool, { agentId: a, grantId: r.grantId });
  });

  it('L1: 같은 위임이 다시 오면 아무것도 하지 않는다 — 줄·알림이 새로 생기지 않는다', async () => {
    const first = await delegateApiGrant(pool, base({ to: c, causeMessageId: await msgBy(alice.accountId) }));
    if (!first.ok) throw new Error('expected ok');
    const lines = async () => (await pool.query(`select 1 from message where meta->'delegation'->>'toAgentId' = $1`, [c])).rowCount;
    const before = await lines();
    const again = await delegateApiGrant(pool, base({ to: c, causeMessageId: await msgBy(alice.accountId) }));
    expect(again).toMatchObject({ ok: true, grantId: first.grantId, pending: false });
    expect(await lines()).toBe(before);
    await revokeDelegation(pool, { agentId: a, grantId: first.grantId });
  });

  it('덮지 않는다: 사람이 직접 준 줄이 있으면 already_granted', async () => {
    expect((await give(c, { limits: { methods: ['GET'], pathPrefix: '/' } })).statusCode).toBe(200);
    expect(await delegateApiGrant(pool, base({ to: c, causeMessageId: await msgBy(alice.accountId) }))).toMatchObject({ ok: false, code: 'already_granted' });
    await pool.query(`delete from account_grant where account_id = $1 and capability = 'api.call'`, [c]);
  });

  it('사람이 부모를 거두면 아래도 사라진다 · 에이전트는 자기가 준 것만 거둔다', async () => {
    expect((await revokeDelegation(pool, { agentId: c, grantId: (await grantOf(b)).id })).ok).toBe(false);
    const del = await app.inject({ method: 'DELETE', url: `/accounts/${a}/grants/api.call?scope=${encodeURIComponent(`connector:${connectorId}`)}`, headers: auth(alice.token) });
    expect(del.statusCode).toBe(204);
    expect(await grantOf(b)).toBeUndefined();
  });
});
