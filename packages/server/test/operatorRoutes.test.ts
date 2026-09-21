// 오퍼레이터 신원 — 스펙 2026-09-20-operator-and-permissions §3. 오퍼레이터는 사람의 기기다:
// 등록 코드(1회용·5분) → 장기 토큰 교환 → 폐기. 오퍼레이터 토큰은 계정이 아니므로
// `req.account` 가 서지 않고 `req.operator` 만 선다 — 그 경계를 여기서 잰다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>; let pool: Pool;
let adminToken: string; let memberToken: string; let otherToken: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool as Pool;
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: memberToken } = await createMember(app, adminToken, 'mac'));
  ({ token: otherToken } = await createMember(app, adminToken, 'other'));
});
afterAll(async () => { await app.close(); await stop(); });

describe('오퍼레이터 등록', () => {
  let code: string; let operatorId: string; let opToken: string;
  it('member 는 기본 capability 로 등록 코드를 받는다', async () => {
    const res = await app.inject({ method: 'POST', url: '/operators/register-codes', headers: auth(memberToken) });
    expect(res.statusCode).toBe(200);
    code = res.json().code; expect(code).toMatch(/^hkreg_/);
    expect(typeof res.json().expiresAt).toBe('string');
  });
  it('코드로 토큰을 교환한다 — 인증 없이', async () => {
    const res = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code, name: '맥북' } });
    expect(res.statusCode).toBe(200);
    opToken = res.json().token; operatorId = res.json().operator.id;
    expect(opToken).toMatch(/^hkop_/);
    expect(res.json().operator.name).toBe('맥북');
    expect(res.json().operator.online).toBe(false);
  });
  it('코드는 1회용이다', async () => {
    const res = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code, name: '또' } });
    expect(res.statusCode).toBe(401);
  });
  it('소유자는 자기 오퍼레이터를 본다, 남은 못 본다, admin 은 전부 본다', async () => {
    const mine = await app.inject({ method: 'GET', url: '/operators', headers: auth(memberToken) });
    expect(mine.json().operators.map((o: { id: string }) => o.id)).toEqual([operatorId]);
    const theirs = await app.inject({ method: 'GET', url: '/operators', headers: auth(otherToken) });
    expect(theirs.json().operators).toEqual([]);
    const admin = await app.inject({ method: 'GET', url: '/operators', headers: auth(adminToken) });
    expect(admin.json().operators).toHaveLength(1);
  });
  it('오퍼레이터 토큰으로 요청하면 req.operator 가 서고 req.account 는 비어 있다', async () => {
    const res = await app.inject({ method: 'GET', url: '/operators/self', headers: auth(opToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(operatorId);
    const asHuman = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(opToken) });
    expect(asHuman.statusCode).toBe(401);
  });
  it('남은 남의 오퍼레이터를 폐기할 수 없다', async () => {
    const del = await app.inject({ method: 'DELETE', url: `/operators/${operatorId}`, headers: auth(otherToken) });
    expect(del.statusCode).toBe(403);
  });
  it('소유자가 폐기하면 토큰이 죽고 감사에 남는다', async () => {
    const del = await app.inject({ method: 'DELETE', url: `/operators/${operatorId}`, headers: auth(memberToken) });
    expect(del.statusCode).toBe(204);
    const res = await app.inject({ method: 'GET', url: '/operators/self', headers: auth(opToken) });
    expect(res.statusCode).toBe(401);
    const gone = await app.inject({ method: 'GET', url: '/operators', headers: auth(memberToken) });
    expect(gone.json().operators).toEqual([]);
  });
  it('모르는 코드는 401, 이름 없는 claim 은 400', async () => {
    const bad = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code: 'hkreg_nope', name: 'x' } });
    expect(bad.statusCode).toBe(401);
    const noName = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code: 'hkreg_nope' } });
    expect(noName.statusCode).toBe(400);
  });
});
