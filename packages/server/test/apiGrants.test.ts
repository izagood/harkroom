// 외부 API 권한(098, C안 P2) — 설계 스레드 07519d86. API 연결 REST · `api.call` grant 의 모양·권한 · 쓰는 순간의
// 사슬 판정(`apiGrantFor`)의 회귀선. 쓰기 만료(날짜는 30일 안, 무기한은 null 을 명시 — 소유자 결정·security 설계 판정, 2026-11-02)·E1(루트 사람의 에이전트만)을
// 시험으로 고정한다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { apiGrantFor, decodeSlashes, normalizeBaseUrl, normalizeTokenUrl, parseLimits, pathCovered, safePath, wirePath } from '../src/auth/apiGrants.js';
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
  it('토큰 주소: base_url 과 같은 검사 + 경로 허용(156, security 조건 1)', () => {
    expect(normalizeTokenUrl('https://auth.example.com/realms/x/token')).toBe('https://auth.example.com/realms/x/token');
    expect(normalizeTokenUrl('https://auth.example.com')).toBe('https://auth.example.com');
    for (const bad of ['http://auth.example.com/t', 'https://u:p@auth.example.com/t', 'https://auth.example.com/t?x=1', 'https://auth.example.com/t#f',
      'https://auth.example.com/a/%2e%2e/t', 'https://auth.example.com/a%2Fb', 'nope']) expect(normalizeTokenUrl(bad), bad).toBeNull();
  });
  it('%2F 는 받고 두 번 잰다(156, security S3·조건 8·9)', () => {
    expect(safePath('/api/catalog/models/org%2Fname/versions')).toBe(true);
    expect(safePath('/api/catalog/models/org%2fname')).toBe(true);
    expect(safePath('/api/x/')).toBe(true);
    for (const p of ['/api/a/..%2F..%2Fadmin', '/api/a%2F..', '/api/a%2F%2E%2E/x', '/api/a%252F..', '/api/a%2F%2Fb', '/api/.%2Fx',
      '/api/x%2F', '/api/%2F', '/api/a%2F.%2Fb']) {
      expect(safePath(p), p).toBe(false);
    }
    expect(decodeSlashes('/a%2Fb?q=%2F')).toBe('/a/b?q=%2F');
    // 접두 경계 — 원문과 푼 꼴 둘 다 접두 안이어야 한다.
    expect(pathCovered('/api%2Fx', '/api/')).toBe(false);
    expect(pathCovered('/api%2Fx', '/api')).toBe(false);
    expect(pathCovered('/api/m/org%2Fname', '/api/m/')).toBe(true);
    expect(pathCovered('/api/m/org%2Fname', '/api/m')).toBe(true);
    expect(pathCovered('/api/morg%2Fname', '/api/m')).toBe(false);
  });
  it('보낼 경로는 URL 짓기 뒤의 꼴이다(security 조건 7)', () => {
    expect(wirePath('https://api.example.com', '/api/m/org%2Fname?x=1')).toBe('/api/m/org%2Fname?x=1');
    expect(wirePath('https://api.example.com', '/api/é')).toBe('/api/%C3%A9');
    expect(wirePath('https://api.example.com', '//evil.example.com/x')).toBeNull();
  });
  it('limits 는 연결이 허용한 메서드의 부분집합', () => {
    expect(parseLimits({ methods: ['GET'], pathPrefix: '/api%2F' }, ['GET'])).toHaveProperty('error');
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

  it('토큰 교환 연결(156): 같은 비밀 소유 검사 · form 칸 검사 · 주소·form 을 바꾸면 grant 가 멈춘다', async () => {
    const tx = { authKind: 'token_exchange', tokenUrl: 'https://auth.example.com/token', tokenForm: { grantType: 'password', clientId: 'cli', keyField: 'api_key' } };
    expect((await mkConnector('t-bob', { ...tx, secretId: bobSecretId })).statusCode).toBe(404);
    expect((await mkConnector('t-nourl', { ...tx, tokenUrl: null })).json().error.code).toBe('bad_token_url');
    expect((await mkConnector('t-http', { ...tx, tokenUrl: 'http://auth.example.com/token' })).json().error.code).toBe('bad_token_url');
    expect((await mkConnector('t-q', { ...tx, tokenUrl: 'https://auth.example.com/token?x=1' })).json().error.code).toBe('bad_token_url');
    expect((await mkConnector('t-dup', { ...tx, tokenForm: { ...tx.tokenForm, keyField: 'client_id' } })).json().error.code).toBe('bad_token_form');
    expect((await mkConnector('t-ctl', { ...tx, tokenForm: { ...tx.tokenForm, clientId: 'a\nb' } })).statusCode).toBe(400);
    expect((await mkConnector('t-long', { ...tx, tokenForm: { ...tx.tokenForm, grantType: 'x'.repeat(201) } })).statusCode).toBe(400);
    expect((await mkConnector('t-extra', { ...tx, tokenForm: { ...tx.tokenForm, scope: 'all' } })).statusCode).toBe(400);
    expect((await mkConnector('t-bearer', { tokenUrl: 'https://auth.example.com/token' })).statusCode).toBe(400);
    const ok = await mkConnector('t-one', tx);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().connector).toMatchObject({ authKind: 'token_exchange', tokenUrl: 'https://auth.example.com/token', tokenForm: tx.tokenForm });
    const id = ok.json().connector.id as string;
    expect((await give(id, { limits: { methods: ['GET'], pathPrefix: '/api/' } })).statusCode).toBe(200);
    const hit = await apiGrantFor(pool, { agentId, connectorId: id, method: 'GET', path: '/api/m/org%2Fname' });
    expect(hit).toMatchObject({ ok: true, hit: { authKind: 'token_exchange', tokenUrl: 'https://auth.example.com/token', path: '/api/m/org%2Fname' } });
    expect(await apiGrantFor(pool, { agentId, connectorId: id, method: 'GET', path: '/api/a/..%2F..%2Fadmin' })).toEqual({ ok: false, code: 'bad_path' });
    const p = await app.inject({ method: 'PATCH', url: `/connectors/${id}`, headers: auth(alice.token), payload: { tokenUrl: 'https://auth2.example.com/token' } });
    expect(p.json().suspendedGrants).toBe(1);
    await give(id, { limits: { methods: ['GET'], pathPrefix: '/api/' } });
    const f = await app.inject({ method: 'PATCH', url: `/connectors/${id}`, headers: auth(alice.token), payload: { tokenForm: { ...tx.tokenForm, clientId: 'other' } } });
    expect(f.json().suspendedGrants).toBe(1);
    // 다른 꼴로 바꾸면 토큰 칸이 비워진다.
    const b = await app.inject({ method: 'PATCH', url: `/connectors/${id}`, headers: auth(alice.token), payload: { authKind: 'bearer' } });
    expect(b.json().connector).toMatchObject({ authKind: 'bearer', tokenUrl: null, tokenForm: null });
  });

  it('grant: 소유자만, 내 연결만, 쓰기 무기한은 null 명시로만, 남의 에이전트는 403(E1)', async () => {
    const c = (await mkConnector('c-two')).json().connector.id as string;
    expect((await give(c, { limits: { methods: ['GET'], pathPrefix: '/api/' } }, bob.token)).statusCode).toBe(403);
    expect((await give(c, { limits: { methods: ['GET'], pathPrefix: '/api/' } }, alice.token, bobAgentId)).statusCode).toBe(403);
    expect((await give(c, { limits: { methods: ['GET'], pathPrefix: '/api/' } }, admin.token)).statusCode).toBe(403);
    expect((await give(c, {})).json().error.code).toBe('bad_limits');
    expect((await give(c, { limits: { methods: ['DELETE'], pathPrefix: '/' } })).json().error.code).toBe('bad_limits');
    // 무기한 쓰기는 사람 세션 + 그 에이전트 소유자만(security 조건 1) — 에이전트 PAT·남·admin 은 거절.
    expect((await give(c, { limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' }, expiresAt: null }, agentPat)).statusCode).toBe(403);
    expect((await give(c, { limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' }, expiresAt: null }, bob.token)).statusCode).toBe(403);
    expect((await give(c, { limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' }, expiresAt: null }, admin.token)).statusCode).toBe(403);
    // 만료 칸을 빠뜨리면 무기한이 아니라 거절이다(security 막음 1).
    expect((await give(c, { limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' } })).json().error.code).toBe('write_needs_expiry');
    const forever = await give(c, { limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' }, expiresAt: null, writeNeedsHumanCause: false });
    expect(forever.statusCode).toBe(200);
    expect(forever.json().grants).toContainEqual(expect.objectContaining({ scope: `connector:${c}`, expiresAt: null }));
    const audit = (await pool.query(`select detail from audit_log where action in ('grant.given', 'grant.updated') and detail->>'scope' = $1 order by id desc limit 1`, [`connector:${c}`])).rows[0];
    expect(audit.detail.writeNoExpiry).toBe(true);
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
    // 쓰기 grant 의 날짜 만료 상한 30일(F3) — 먼 날짜로 무기한을 흉내 내지 못한다. 무기한은 위처럼 null 로만.
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

  it('무기한 쓰기에도 안전장치는 그대로 — 연결의 토큰 설정·주소가 바뀌면 멈추고, 연결을 지우면 사라진다(security 조건 6)', async () => {
    const c = (await mkConnector('c-forever')).json().connector.id as string;
    expect((await give(c, { limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' }, expiresAt: null })).statusCode).toBe(200);
    expect((await apiGrantFor(pool, { agentId, connectorId: c, method: 'POST', path: '/api/x' })).ok).toBe(true);
    const p = await app.inject({ method: 'PATCH', url: `/connectors/${c}`, headers: auth(alice.token), payload: { baseUrl: 'https://other.example.com' } });
    expect(p.json().suspendedGrants).toBe(1);
    expect(await apiGrantFor(pool, { agentId, connectorId: c, method: 'POST', path: '/api/x' })).toEqual({ ok: false, code: 'suspended' });
    expect((await app.inject({ method: 'DELETE', url: `/connectors/${c}`, headers: auth(alice.token) })).statusCode).toBe(204);
    expect((await pool.query(`select 1 from account_grant where scope = $1`, [`connector:${c}`])).rowCount).toBe(0);
  });

  it('고치기: 같은 부여 id 가 남고, 감사는 grant.updated 에 바뀐 칸만 [전, 후] · 멈춘 부여를 고치면 다시 켜짐도 남는다', async () => {
    const c = (await mkConnector('c-edit')).json().connector.id as string;
    const first = await give(c, { limits: { methods: ['GET'], pathPrefix: '/api/' }, expiresAt: inWeek() });
    const id0 = first.json().grants.find((g: { scope: string }) => g.scope === `connector:${c}`).id as string;
    const given = (await pool.query(`select action from audit_log where target = $1 and detail->>'scope' = $2 order by id desc limit 1`, [agentId, `connector:${c}`])).rows[0];
    expect(given.action).toBe('grant.given');
    // 경로를 좁히고 쓰기로 넓힌다(소유자 사람 세션 — 같은 판정을 탄다).
    const exp = inWeek();
    const edited = await give(c, { limits: { methods: ['GET', 'POST'], pathPrefix: '/api/catalog/' }, expiresAt: exp, writeNeedsHumanCause: true });
    expect(edited.statusCode).toBe(200);
    const row = edited.json().grants.find((g: { scope: string }) => g.scope === `connector:${c}`);
    expect(row.id).toBe(id0);
    const upd = (await pool.query(`select detail from audit_log where action = 'grant.updated' and detail->>'scope' = $1 order by id desc limit 1`, [`connector:${c}`])).rows[0];
    expect(upd.detail.changed.limits).toEqual([{ methods: ['GET'], pathPrefix: '/api/' }, { methods: ['GET', 'POST'], pathPrefix: '/api/catalog/' }]);
    expect(upd.detail.changed.writeNeedsHumanCause).toEqual([false, true]);
    expect(Object.keys(upd.detail.changed)).not.toContain('delegateDepth');
    // 넓히는 고치기도 소유자만 — 남은 403.
    expect((await give(c, { limits: { methods: ['GET', 'POST'], pathPrefix: '/' }, expiresAt: exp, writeNeedsHumanCause: true }, bob.token)).statusCode).toBe(403);
    // 연결이 바뀌어 멈춘 부여를 고치면 다시 켜진다 — 감사에 남는다.
    await app.inject({ method: 'PATCH', url: `/connectors/${c}`, headers: auth(alice.token), payload: { baseUrl: 'https://moved.example.com' } });
    await give(c, { limits: { methods: ['GET', 'POST'], pathPrefix: '/api/catalog/' }, expiresAt: exp, writeNeedsHumanCause: true });
    const resumed = (await pool.query(`select detail from audit_log where action = 'grant.updated' and detail->>'scope' = $1 order by id desc limit 1`, [`connector:${c}`])).rows[0];
    expect(resumed.detail.changed.suspended).toEqual([true, false]);
  });
});
