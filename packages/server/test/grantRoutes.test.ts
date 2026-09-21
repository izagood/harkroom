// grant 부여·회수·역할 변경 라우트 — 스펙 2026-09-20 §6 (1)·(2). 권한을 준 기록이 없으면
// 사고를 못 되짚으므로 감사까지 함께 잰다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>; let pool: Pool;
let adminToken: string; let memberToken: string; let memberId: string;
let secondAdminToken: string; let secondAdminId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool as Pool;
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: memberToken, accountId: memberId } = await createMember(app, adminToken, 'grantee'));
  ({ token: secondAdminToken, accountId: secondAdminId } = await createMember(app, adminToken, 'deputy'));
});
afterAll(async () => { await app.close(); await stop(); });

describe('grant 라우트', () => {
  it('admin 이 준 grant 로 member 가 채널을 만든다', async () => {
    const before = await app.inject({ method: 'POST', url: '/channels', headers: auth(memberToken), payload: { name: 'x' } });
    expect(before.statusCode).toBe(403);
    const put = await app.inject({ method: 'PUT', url: `/accounts/${memberId}/grants`, headers: auth(adminToken), payload: { capability: 'channel.create' } });
    expect(put.statusCode).toBe(200);
    expect(put.json().grants).toEqual([expect.objectContaining({ capability: 'channel.create', scope: '' })]);
    const after = await app.inject({ method: 'POST', url: '/channels', headers: auth(memberToken), payload: { name: 'granted' } });
    expect(after.statusCode).toBe(201);
  });
  it('본인은 자기 grant 를 보고, 남의 것은 admin 만 본다', async () => {
    const mine = await app.inject({ method: 'GET', url: `/accounts/${memberId}/grants`, headers: auth(memberToken) });
    expect(mine.statusCode).toBe(200);
    const theirs = await app.inject({ method: 'GET', url: `/accounts/${memberId}/grants`, headers: auth(secondAdminToken) });
    expect(theirs.statusCode).toBe(403);
  });
  it('member 는 grant 를 줄 수 없다', async () => {
    const res = await app.inject({ method: 'PUT', url: `/accounts/${memberId}/grants`, headers: auth(memberToken), payload: { capability: 'agent.create' } });
    expect(res.statusCode).toBe(403);
  });
  it('회수하면 다시 거절되고 감사에 남는다', async () => {
    const del = await app.inject({ method: 'DELETE', url: `/accounts/${memberId}/grants/channel.create`, headers: auth(adminToken) });
    expect(del.statusCode).toBe(204);
    const res = await app.inject({ method: 'POST', url: '/channels', headers: auth(memberToken), payload: { name: 'y' } });
    expect(res.statusCode).toBe(403);
    const audit = await pool.query(`select action from audit_log where action in ('grant.given','grant.revoked') order by id`);
    expect(audit.rows.map((r) => r.action)).toEqual(['grant.given', 'grant.revoked']);
  });
  it('없는 grant 를 회수하면 404', async () => {
    const del = await app.inject({ method: 'DELETE', url: `/accounts/${memberId}/grants/channel.create`, headers: auth(adminToken) });
    expect(del.statusCode).toBe(404);
  });
  it('모르는 capability 는 400', async () => {
    const res = await app.inject({ method: 'PUT', url: `/accounts/${memberId}/grants`, headers: auth(adminToken), payload: { capability: 'nope' } });
    expect(res.statusCode).toBe(400);
  });
  it('owner 만 admin 을 임명한다 — isAdmin 도 함께 바뀐다', async () => {
    const res = await app.inject({ method: 'PUT', url: `/accounts/${secondAdminId}/role`, headers: auth(adminToken), payload: { role: 'admin' } });
    expect(res.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(secondAdminToken) });
    expect(me.json().role).toBe('admin');
    expect(me.json().isAdmin).toBe(true);
  });
  it('admin 은 admin 을 임명·해제할 수 없다', async () => {
    const promote = await app.inject({ method: 'PUT', url: `/accounts/${memberId}/role`, headers: auth(secondAdminToken), payload: { role: 'admin' } });
    expect(promote.statusCode).toBe(403);
    const demote = await app.inject({ method: 'PUT', url: `/accounts/${secondAdminId}/role`, headers: auth(secondAdminToken), payload: { role: 'member' } });
    expect(demote.statusCode).toBe(403);
  });
  it('owner 를 이 라우트로 정하거나 바꿀 수 없다', async () => {
    const asOwner = await app.inject({ method: 'PUT', url: `/accounts/${memberId}/role`, headers: auth(adminToken), payload: { role: 'owner' } });
    expect(asOwner.statusCode).toBe(400);
  });
});
