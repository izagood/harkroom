// 외부 API 호출 라우트(C안 P3, 스레드 07519d86) — 오퍼레이터의 `api` 래퍼가 묻고(api-checks) 알리는(api-results) 자리.
// 지키는 것: 오퍼레이터를 거친 에이전트만 · 판정은 사슬(apiGrantFor) · 키는 통과한 판정에만 실리고 접근 기록이 남는다 ·
// 판정 없는 보고는 받지 않는다 · 시스템 줄 본문에 키가 없다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { createSecretKeyring } from '../src/services/secretKeyring.js';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const KEY = `key_${'a'.repeat(24)}`;

describe('api-checks · api-results', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let agentId: string; let agentPat: string;
  let op: { token: string; operatorId: string };
  let ch: string; let connectorId: string;
  const ring = createSecretKeyring(new Map([['k1', randomBytes(32)]]), 'k1');

  const asAgent = () => ({ ...auth(op.token), 'x-harkroom-agent': agentId });
  const lease = async () => {
    const m = await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'call it', 'user') returning id`, [ch, alice.accountId]);
    const id = m.rows[0].id as string;
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [agentId, id]);
    return (await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: asAgent(), payload: { causeMessageId: id } })).json().lease as { id: string; token: string };
  };
  const check = (l: { id: string; token: string }, method = 'GET', path = '/api/capacity', connector = 'lab') =>
    app.inject({ method: 'POST', url: '/agent/api-checks', headers: asAgent(), payload: { leaseId: l.id, token: l.token, connector, method, path } });
  const report = (l: { id: string; token: string }, method = 'GET', path = '/api/capacity', status = 200) =>
    app.inject({ method: 'POST', url: '/agent/api-results', headers: asAgent(), payload: { leaseId: l.id, token: l.token, connector: 'lab', method, path, status, durationMs: 12, bytes: 34 } });

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool, secretKeyring: ring });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    ({ accountId: agentId, pat: agentPat } = await createAgent(app, admin.token, 'ops'));
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, alice.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [agentId, op.operatorId, admin.accountId]);
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'dev' } })).json().id as string;
    const s = await app.inject({ method: 'POST', url: '/secrets', headers: auth(alice.token), payload: { name: 'lab-token', kind: 'text', value: KEY } });
    expect(s.statusCode).toBe(201);
    const c = await app.inject({ method: 'POST', url: '/connectors', headers: auth(alice.token), payload: { name: 'lab', baseUrl: 'https://api.example.internal', authKind: 'bearer', secretId: s.json().secret.id, methods: ['GET', 'POST'] } });
    connectorId = c.json().connector.id;
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('사람 세션·에이전트 PAT 는 403 — 오퍼레이터를 거친 에이전트만', async () => {
    expect((await app.inject({ method: 'GET', url: '/agent/api-grants', headers: auth(alice.token) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/agent/api-grants', headers: auth(agentPat) })).statusCode).toBe(403);
  });

  it('grant 가 없으면 not_granted, 키는 실리지 않는다', async () => {
    const l = await lease();
    const r = await check(l);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('not_granted');
    expect(r.body).not.toContain(KEY);
    expect((await app.inject({ method: 'GET', url: '/agent/api-grants', headers: asAgent() })).json().connectors).toEqual([]);
  });

  it('grant 가 있으면 키가 오퍼레이터에게만 실리고 접근 기록이 남는다 · 범위 밖은 거절', async () => {
    const g = await app.inject({ method: 'PUT', url: `/accounts/${agentId}/grants`, headers: auth(alice.token), payload: { capability: 'api.call', scope: `connector:${connectorId}`, limits: { methods: ['GET'], pathPrefix: '/api/' } } });
    expect(g.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/agent/api-grants', headers: asAgent() })).json().connectors).toEqual(['lab']);
    const l = await lease();
    const r = await check(l, 'GET', '/api/capacity?token=zzz');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toMatchObject({ allowed: true, baseUrl: 'https://api.example.internal', authKind: 'bearer' });
    expect(Buffer.from(r.json().valueBase64, 'base64').toString('utf8')).toBe(KEY);
    const logRow = (await pool.query(`select result, reason, channel_id from secret_access_log where secret_name = 'lab-token' order by id desc limit 1`)).rows[0];
    expect(logRow).toMatchObject({ result: 'granted', reason: 'api:lab GET /api/capacity', channel_id: ch });
    expect((await check(l, 'POST', '/api/x')).json().error.code).toBe('method_not_allowed');
    expect((await check(l, 'GET', '/admin')).json().error.code).toBe('path_not_allowed');
    expect((await check(l, 'GET', '/api/..;/admin')).json().error.code).toBe('bad_path');
    expect((await check(l, 'GET', '/x', 'nope')).statusCode).toBe(404);
  });

  it('보고는 통과한 판정이 있어야 받고, 한 판정에 한 번이며, 시스템 줄에 키가 없다', async () => {
    const l = await lease();
    expect((await report(l)).json().error.code).toBe('not_checked');
    expect((await check(l)).statusCode).toBe(200);
    const ok = await report(l);
    expect(ok.statusCode).toBe(201);
    const msg = (await pool.query(`select body, kind, thread_root_id from message where id = $1`, [ok.json().messageId])).rows[0];
    expect(msg.kind).toBe('system');
    expect(msg.body).toContain('🔌 lab GET /api/capacity · 200 · 권한: alice');
    expect(msg.body).not.toContain(KEY);
    expect((await report(l)).json().error.code).toBe('not_checked');
  });

  it('만료된 비밀이면 secret_expired 로 거절하고 기록한다', async () => {
    await pool.query(`update secret set expires_at = now() - interval '1 minute' where name = 'lab-token'`);
    const l = await lease();
    expect((await check(l)).json().error.code).toBe('secret_expired');
    await pool.query(`update secret set expires_at = null where name = 'lab-token'`);
  });
});
