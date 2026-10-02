// 외부 API 권한(098, C안 P2) — 설계 스레드 07519d86. API 연결 REST · `api.call` grant 의 모양·권한 · 쓰는 순간의
// 사슬 판정(`apiGrantFor`)의 회귀선. jaebin D3(쓰기는 무기한 금지)·E1(루트 사람의 에이전트만)을 시험으로 고정한다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { apiGrantFor, normalizeBaseUrl, parseLimits, pathCovered, safePath } from '../src/auth/apiGrants.js';
import { can, effectiveCapabilities } from '../src/auth/permissions.js';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const inWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

describe('apiGrants 순수 함수', () => {
  it('baseUrl 은 https origin 만', () => {
    expect(normalizeBaseUrl('https://api.example.internal')).toBe('https://api.example.internal');
    expect(normalizeBaseUrl('https://api.example.internal/')).toBe('https://api.example.internal');
    expect(normalizeBaseUrl('http://api.example.internal')).toBeNull();
    expect(normalizeBaseUrl('https://user:pw@api.example.internal')).toBeNull();
    expect(normalizeBaseUrl('https://api.example.internal/v1')).toBeNull();
    expect(normalizeBaseUrl('https://api.example.internal?x=1')).toBeNull();
    expect(normalizeBaseUrl('not a url')).toBeNull();
  });
  it('경로는 접두 검사를 속일 수 있는 모양을 거절한다', () => {
    expect(safePath('/api/clusters')).toBe(true);
    expect(safePath('/api/x?y=1')).toBe(true);
    for (const p of ['api', '//evil.example', '/api/../admin', '/api/./x', '/api/%2e%2e/admin', '/api\\x', '/a b', '/a#b', '/api/%2Fx',
      '/api/..;/admin', '/api;x', '/api/%252e%252e/admin', '/api/%25']) {
      expect(safePath(p), p).toBe(false);
    }
  });
  it('접두는 마디 경계를 본다(F2①)', () => {
    expect(pathCovered('/api', '/api')).toBe(true);
    expect(pathCovered('/api/x', '/api')).toBe(true);
    expect(pathCovered('/api-admin/x', '/api')).toBe(false);
    expect(pathCovered('/apikeys', '/api')).toBe(false);
    expect(pathCovered('/api/x?y=1', '/api/')).toBe(true);
    expect(pathCovered('/apix', '/api/')).toBe(false);
    expect(pathCovered('/anything', '/')).toBe(true);
  });
  it('limits 는 연결이 허용한 메서드의 부분집합', () => {
    expect(parseLimits({ methods: ['GET'], pathPrefix: '/api/' }, ['GET', 'POST'])).toEqual({ methods: ['GET'], pathPrefix: '/api/' });
    expect(parseLimits({ methods: ['DELETE'], pathPrefix: '/api/' }, ['GET'])).toHaveProperty('error');
    expect(parseLimits({ methods: [], pathPrefix: '/' }, ['GET'])).toHaveProperty('error');
    expect(parseLimits({ methods: ['GET'], pathPrefix: 'api' }, ['GET'])).toHaveProperty('error');
    expect(parseLimits({ methods: ['GET'], pathPrefix: '/', extra: 1 }, ['GET'])).toHaveProperty('error');
    expect(parseLimits(null, ['GET'])).toHaveProperty('error');
  });
});

describe('API 연결 · api.call grant', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let agentId: string; let agentPat: string; let bobAgentId: string;
  let secretId: string; let bobSecretId: string;

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    ({ accountId: agentId, pat: agentPat } = await createAgent(app, admin.token, 'ops'));
    bobAgentId = (await createAgent(app, admin.token, 'bobs')).accountId;
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, alice.accountId]);
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [bobAgentId, bob.accountId]);
    // 연결은 비밀의 id 만 가리킨다 — 값이 필요 없으므로 행만 넣는다(보관소 키링 없이).
    secretId = (await pool.query(`insert into secret (name, kind, owner_account_id) values ('api-token', 'text', $1) returning id`, [alice.accountId])).rows[0].id;
    bobSecretId = (await pool.query(`insert into secret (name, kind, owner_account_id) values ('bob-token', 'text', $1) returning id`, [bob.accountId])).rows[0].id;
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  const mkConnector = async (name: string, over: Record<string, unknown> = {}, token = alice.token) => app.inject({
    method: 'POST', url: '/connectors', headers: auth(token),
    payload: { name, baseUrl: 'https://api.example.internal', authKind: 'bearer', secretId, methods: ['GET', 'POST'], ...over },
  });
  const give = (connectorId: string, body: Record<string, unknown>, token = alice.token, target = agentId) => app.inject({
    method: 'PUT', url: `/accounts/${target}/grants`, headers: auth(token),
    payload: { capability: 'api.call', scope: `connector:${connectorId}`, ...body },
  });

  it('연결: https 만, 남의 비밀은 404, 에이전트는 403, 이름 중복은 409', async () => {
    expect((await mkConnector('c-http', { baseUrl: 'http://api.example.internal' })).json().error.code).toBe('bad_base_url');
    expect((await mkConnector('c-bob', { secretId: bobSecretId })).statusCode).toBe(404);
    expect((await mkConnector('c-agent', {}, agentPat)).statusCode).toBe(403);
    expect((await mkConnector('c-hdr', { authKind: 'header', authHeader: 'Host' })).json().error.code).toBe('bad_header');
    const ok = await mkConnector('c-one');
    expect(ok.statusCode).toBe(201);
    expect(ok.json().connector).toMatchObject({ name: 'c-one', baseUrl: 'https://api.example.internal', secretId, grantCount: 0 });
    expect((await mkConnector('c-one')).statusCode).toBe(409);
    const list = await app.inject({ method: 'GET', url: '/connectors', headers: auth(bob.token) });
    expect(list.json().connectors.map((c: { name: string }) => c.name)).not.toContain('c-one');
  });

  it('grant: 소유자만, 내 연결만, 쓰기는 만료 필수(D3), 남의 에이전트는 403(E1)', async () => {
    const c = (await mkConnector('c-two')).json().connector.id as string;
    expect((await give(c, { limits: { methods: ['GET'], pathPrefix: '/api/' } }, bob.token)).statusCode).toBe(403);
    expect((await give(c, { limits: { methods: ['GET'], pathPrefix: '/api/' } }, alice.token, bobAgentId)).statusCode).toBe(403);
    expect((await give(c, { limits: { methods: ['GET'], pathPrefix: '/api/' } }, admin.token)).statusCode).toBe(403);
    expect((await give(c, {})).json().error.code).toBe('bad_limits');
    expect((await give(c, { limits: { methods: ['DELETE'], pathPrefix: '/' } })).json().error.code).toBe('bad_limits');
    expect((await give(c, { limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' } })).json().error.code).toBe('write_needs_expiry');
    const ok = await give(c, { limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' }, expiresAt: inWeek(), delegateDepth: 1 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().grants).toContainEqual(expect.objectContaining({
      capability: 'api.call', scope: `connector:${c}`, delegateDepth: 1, parentGrantId: null,
      limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' },
    }));
    // 전역 api.call 은 없다 — admin 이 빈 scope 로 줘도 거절한다.
    const global = await app.inject({ method: 'PUT', url: `/accounts/${agentId}/grants`, headers: auth(admin.token), payload: { capability: 'api.call' } });
    expect(global.statusCode).toBe(400);
    const anyAccount = { id: agentId, role: 'member' } as unknown as Parameters<typeof can>[1];
    expect(await can(pool, anyAccount, 'api.call')).toBe(false);
    // 쓰기 grant 의 만료 상한 30일(F3). 읽기만은 무기한도 된다(D3).
    const far = new Date(Date.now() + 31 * 86_400_000).toISOString();
    expect((await give(c, { limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' }, expiresAt: far })).json().error.code).toBe('write_expiry_too_long');
    expect((await give(c, { limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' }, expiresAt: '9999-12-31T00:00:00Z' })).json().error.code).toBe('write_expiry_too_long');
    expect((await give(c, { limits: { methods: ['GET'], pathPrefix: '/api/' }, expiresAt: null })).statusCode).toBe(200);
    // owner·admin 의 전역 능력 목록에도 api.call 은 없다(L1).
    const adminView = { id: admin.accountId, role: 'owner' } as unknown as Parameters<typeof effectiveCapabilities>[1];
    expect(await effectiveCapabilities(pool, adminView)).not.toContain('api.call');
  });

  it('판정: 메서드·경로·키 없음·만료·정지·사슬', async () => {
    const c = (await mkConnector('c-three')).json().connector.id as string;
    expect(await apiGrantFor(pool, { agentId, connectorId: c, method: 'GET', path: '/api/x' })).toEqual({ ok: false, code: 'not_granted' });
    await give(c, { limits: { methods: ['GET'], pathPrefix: '/api/' } });
    const hit = await apiGrantFor(pool, { agentId, connectorId: c, method: 'GET', path: '/api/capacity?x=1' });
    expect(hit).toMatchObject({ ok: true, hit: { connectorName: 'c-three', baseUrl: 'https://api.example.internal', authKind: 'bearer', secretId, rootGrantedBy: alice.accountId } });
    expect(await apiGrantFor(pool, { agentId, connectorId: c, method: 'POST', path: '/api/x' })).toEqual({ ok: false, code: 'method_not_allowed' });
    expect(await apiGrantFor(pool, { agentId, connectorId: c, method: 'GET', path: '/admin' })).toEqual({ ok: false, code: 'path_not_allowed' });
    expect(await apiGrantFor(pool, { agentId, connectorId: c, method: 'GET', path: '/api/../admin' })).toEqual({ ok: false, code: 'bad_path' });
    expect(await apiGrantFor(pool, { agentId, connectorId: c, method: 'GET', path: '/api/..;/admin' })).toEqual({ ok: false, code: 'bad_path' });

    // 소유가 바뀌면 사슬이 끊긴다(E1 — 쓰는 순간 판정).
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, bob.accountId]);
    expect(await apiGrantFor(pool, { agentId, connectorId: c, method: 'GET', path: '/api/x' })).toEqual({ ok: false, code: 'chain_broken' });
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, alice.accountId]);

    // 만료는 지우지 않아도 막는다.
    await pool.query(`update account_grant set expires_at = now() - interval '1 minute' where account_id = $1 and scope = $2`, [agentId, `connector:${c}`]);
    expect(await apiGrantFor(pool, { agentId, connectorId: c, method: 'GET', path: '/api/x' })).toEqual({ ok: false, code: 'expired' });
  });

  it('연결의 주소를 바꾸면 grant 가 멈추고, 사람이 다시 주면 풀린다', async () => {
    const c = (await mkConnector('c-four')).json().connector.id as string;
    await give(c, { limits: { methods: ['GET'], pathPrefix: '/' } });
    const patched = await app.inject({ method: 'PATCH', url: `/connectors/${c}`, headers: auth(alice.token), payload: { baseUrl: 'https://other.example.internal' } });
    expect(patched.json().suspendedGrants).toBe(1);
    expect(await apiGrantFor(pool, { agentId, connectorId: c, method: 'GET', path: '/x' })).toEqual({ ok: false, code: 'suspended' });
    await give(c, { limits: { methods: ['GET'], pathPrefix: '/' } });
    expect((await apiGrantFor(pool, { agentId, connectorId: c, method: 'GET', path: '/x' })).ok).toBe(true);
    // 허용 메서드에서 쓰지 않는 메서드를 빼면 멈추지 않는다.
    const narrowed = await app.inject({ method: 'PATCH', url: `/connectors/${c}`, headers: auth(alice.token), payload: { methods: ['GET'] } });
    expect(narrowed.json().suspendedGrants).toBe(0);
  });

  it('위임 사슬: 부모를 거두면 아래도 사라지고, 위 줄이 만료되면 아래도 막힌다', async () => {
    const c = (await mkConnector('c-five')).json().connector.id as string;
    const scope = `connector:${c}`;
    const child = (await createAgent(app, admin.token, 'child')).accountId;
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [child, alice.accountId]);
    await give(c, { limits: { methods: ['GET'], pathPrefix: '/api/' }, delegateDepth: 1 });
    const parentId = (await pool.query(`select id from account_grant where account_id = $1 and scope = $2`, [agentId, scope])).rows[0].id;
    // P5 의 도구가 만들 줄을 손으로 넣는다 — 판정이 사슬을 보는지 재는 것이 목적이다.
    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, limits, parent_grant_id)
       values ($1, 'api.call', $2, $3, $4, $5)`,
      [child, scope, agentId, JSON.stringify({ methods: ['GET'], pathPrefix: '/api/clusters' }), parentId]);
    expect((await apiGrantFor(pool, { agentId: child, connectorId: c, method: 'GET', path: '/api/clusters/1' })).ok).toBe(true);
    // F1: 사람이 부모를 좁혀 다시 주면(줄 id 그대로) 범위 밖의 자식은 막힌다.
    await give(c, { limits: { methods: ['GET'], pathPrefix: '/api/nodes/' }, delegateDepth: 1 });
    expect((await pool.query(`select id from account_grant where account_id = $1 and scope = $2`, [agentId, scope])).rows[0].id).toBe(parentId);
    expect(await apiGrantFor(pool, { agentId: child, connectorId: c, method: 'GET', path: '/api/clusters/1' })).toEqual({ ok: false, code: 'chain_broken' });
    await give(c, { limits: { methods: ['GET'], pathPrefix: '/api/' }, delegateDepth: 1 });
    expect((await apiGrantFor(pool, { agentId: child, connectorId: c, method: 'GET', path: '/api/clusters/1' })).ok).toBe(true);
    // F1: 부모의 다시 줄 단계를 0으로 줄이면 자식은 막힌다.
    await give(c, { limits: { methods: ['GET'], pathPrefix: '/api/' }, delegateDepth: 0 });
    expect(await apiGrantFor(pool, { agentId: child, connectorId: c, method: 'GET', path: '/api/clusters/1' })).toEqual({ ok: false, code: 'chain_broken' });
    await give(c, { limits: { methods: ['GET'], pathPrefix: '/api/' }, delegateDepth: 1 });
    expect((await apiGrantFor(pool, { agentId: child, connectorId: c, method: 'GET', path: '/api/clusters/1' })).ok).toBe(true);
    await pool.query(`update account_grant set expires_at = now() - interval '1 minute' where id = $1`, [parentId]);
    expect(await apiGrantFor(pool, { agentId: child, connectorId: c, method: 'GET', path: '/api/clusters/1' })).toEqual({ ok: false, code: 'expired' });
    const del = await app.inject({ method: 'DELETE', url: `/accounts/${agentId}/grants/api.call?scope=${encodeURIComponent(scope)}`, headers: auth(alice.token) });
    expect(del.statusCode).toBe(204);
    expect((await pool.query(`select 1 from account_grant where account_id = $1 and scope = $2`, [child, scope])).rowCount).toBe(0);
  });

  it('연결을 지우면 그 grant 도 지워진다', async () => {
    const c = (await mkConnector('c-six')).json().connector.id as string;
    await give(c, { limits: { methods: ['GET'], pathPrefix: '/' } });
    expect((await app.inject({ method: 'DELETE', url: `/connectors/${c}`, headers: auth(bob.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/connectors/${c}`, headers: auth(alice.token) })).statusCode).toBe(204);
    expect((await pool.query(`select 1 from account_grant where scope = $1`, [`connector:${c}`])).rowCount).toBe(0);
  });
});
