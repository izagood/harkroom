import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let pool: Pool;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool as Pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
});
afterAll(async () => { await app.close(); await stop(); });

describe('invites', () => {
  it('admin invite → register → login works, invite is single-use', async () => {
    const inv = await app.inject({
      method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(inv.statusCode).toBe(201);
    const inviteToken = inv.json().token as string;

    const reg = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { inviteToken, handle: 'friend', loginId: 'friend', displayName: 'Friend', password: 'pw123456' },
    });
    expect(reg.statusCode).toBe(201);

    const again = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { inviteToken, handle: 'other', loginId: 'other', displayName: 'O', password: 'pw123456' },
    });
    expect(again.statusCode).toBe(400);
  });

  // 148: 만료·취소·목록. 새 토큰을 발급해도 앞 토큰은 서버에서 그대로 산다 — 거두는 길은 취소와 만료뿐이다.
  const mint = async () => {
    const res = await app.inject({ method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` } });
    expect(res.statusCode).toBe(201);
    return res.json() as { token: string; id: string; expiresAt: string };
  };
  const register = (inviteToken: string, handle: string) => app.inject({
    method: 'POST', url: '/auth/register',
    payload: { inviteToken, handle, loginId: handle, displayName: handle, password: 'pw123456' },
  });
  const list = async () => {
    const res = await app.inject({ method: 'GET', url: '/invites', headers: { authorization: `Bearer ${adminToken}` } });
    expect(res.statusCode).toBe(200);
    return (res.json() as { invites: { id: string; status: string; usedBy: { handle: string } | null; expiresAt: string | null }[] }).invites;
  };

  it('발급은 7일 뒤 만료를 채우고 id 를 준다', async () => {
    const inv = await mint();
    const days = (Date.parse(inv.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(inv.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('새로 발급해도 앞 토큰은 산다', async () => {
    const first = await mint();
    await mint();
    expect((await register(first.token, 'keepalive')).statusCode).toBe(201);
  });

  it('만료된 초대로는 가입할 수 없다(같은 invalid_invite)', async () => {
    const inv = await mint();
    await pool.query(`update invite set expires_at = now() - interval '1 second' where id = $1`, [inv.id]);
    const res = await register(inv.token, 'lateone');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_invite');
    expect((await list()).find((i) => i.id === inv.id)?.status).toBe('expired');
  });

  it('취소한 초대로는 가입할 수 없고, 두 번 취소해도 204', async () => {
    const inv = await mint();
    const del = () => app.inject({ method: 'DELETE', url: `/invites/${inv.id}`, headers: { authorization: `Bearer ${adminToken}` } });
    expect((await del()).statusCode).toBe(204);
    expect((await del()).statusCode).toBe(204);
    const res = await register(inv.token, 'revokedone');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_invite');
    expect((await list()).find((i) => i.id === inv.id)?.status).toBe('revoked');
    const audit = await pool.query(`select detail from audit_log where action = 'invite.revoked'`);
    expect(audit.rows.map((r) => r.detail)).toContainEqual({ inviteId: inv.id });
  });

  it('가입에 쓰인 초대는 취소가 409 이고 목록에 가입한 사람이 보인다', async () => {
    const inv = await mint();
    expect((await register(inv.token, 'usedone')).statusCode).toBe(201);
    const del = await app.inject({ method: 'DELETE', url: `/invites/${inv.id}`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe('invite_used');
    const row = (await list()).find((i) => i.id === inv.id);
    expect(row?.status).toBe('used');
    expect(row?.usedBy?.handle).toBe('usedone');
  });

  it('없는 초대 취소는 404, 목록에는 토큰·해시가 없다', async () => {
    const del = await app.inject({
      method: 'DELETE', url: '/invites/00000000-0000-0000-0000-000000000000', headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(404);
    const raw = await app.inject({ method: 'GET', url: '/invites', headers: { authorization: `Bearer ${adminToken}` } });
    expect(raw.body).not.toMatch(/hrki|token_hash|tokenHash/);
  });

  it('발급 능력이 없는 사람은 목록·취소 모두 403', async () => {
    const { token: memberToken } = await createMember(app, adminToken, 'noinvite');
    const inv = await mint();
    const get = await app.inject({ method: 'GET', url: '/invites', headers: { authorization: `Bearer ${memberToken}` } });
    expect(get.statusCode).toBe(403);
    const del = await app.inject({ method: 'DELETE', url: `/invites/${inv.id}`, headers: { authorization: `Bearer ${memberToken}` } });
    expect(del.statusCode).toBe(403);
  });
});

describe('agents', () => {
  it('creates agent, PAT authenticates as agent, key registered', async () => {
    const { accountId, pat } = await createAgent(app, adminToken, 'bot1');
    const me = await app.inject({
      method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${pat}` },
    });
    expect(me.json()).toMatchObject({ handle: 'bot1', kind: 'agent', isAdmin: false });

    const key = await app.inject({
      method: 'PUT', url: `/accounts/${accountId}/keys`,
      headers: { authorization: `Bearer ${pat}` },
      payload: { keyId: 'k1', publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCow...\n-----END PUBLIC KEY-----' },
    });
    expect(key.statusCode).toBe(204);
  });

  it('non-admin cannot create agents', async () => {
    const { pat } = await createAgent(app, adminToken, 'bot2');
    const res = await app.inject({
      method: 'POST', url: '/accounts/agents', headers: { authorization: `Bearer ${pat}` },
      payload: { handle: 'bot3', displayName: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('key conflict: cross-account keyId theft prevented, self-update allowed', async () => {
    const { accountId: accA, pat: patA } = await createAgent(app, adminToken, 'bot4');
    const { accountId: accB, pat: patB } = await createAgent(app, adminToken, 'bot5');

    // Account A registers keyId k2
    const regA = await app.inject({
      method: 'PUT', url: `/accounts/${accA}/keys`,
      headers: { authorization: `Bearer ${patA}` },
      payload: { keyId: 'k2', publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCow...\n-----END PUBLIC KEY-----' },
    });
    expect(regA.statusCode).toBe(204);

    // Account B tries to steal k2 → 409
    const steal = await app.inject({
      method: 'PUT', url: `/accounts/${accB}/keys`,
      headers: { authorization: `Bearer ${patB}` },
      payload: { keyId: 'k2', publicKeyPem: '-----BEGIN PUBLIC KEY-----\nOther...\n-----END PUBLIC KEY-----' },
    });
    expect(steal.statusCode).toBe(409);
    expect(steal.json()).toMatchObject({ error: { code: 'key_conflict' } });

    // Account A re-registers k2 (update) → 204
    const reupdate = await app.inject({
      method: 'PUT', url: `/accounts/${accA}/keys`,
      headers: { authorization: `Bearer ${patA}` },
      payload: { keyId: 'k2', publicKeyPem: '-----BEGIN PUBLIC KEY-----\nUpdated...\n-----END PUBLIC KEY-----' },
    });
    expect(reupdate.statusCode).toBe(204);
  });
});
