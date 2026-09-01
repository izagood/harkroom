import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { findInvalidCredentials } from '../src/ws/credentials.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let botId: string;
let botPat: string;
let baseUrl: string;

// 재검증 주기를 짧게 줘서 sweep을 실제로 관측한다. 프로덕션 기본값은 15초다.
const REVALIDATE_MS = 100;

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  app = await buildServer({ pool, wsRevalidateMs: REVALIDATE_MS });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ accountId: botId, pat: botPat } = await createAgent(app, adminToken, 'revokebot'));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await app.close(); await stop(); });

async function loginAdmin(): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/auth/login', payload: { handle: 'admin', password: 'pw123456' },
  });
  return res.json().token as string;
}

async function ticketFor(token: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/ws-ticket', headers: { authorization: `Bearer ${token}` },
  });
  return res.json().ticket as string;
}

/** 소켓을 열고 구독 완료(presence.snapshot)까지 기다린 뒤, 종료 코드를 약속으로 돌려준다. */
async function openSocket(token: string): Promise<{ closed: Promise<number>; ws: WebSocket }> {
  const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${await ticketFor(token)}`);
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (data) => {
      if ((JSON.parse(String(data)) as { type?: string }).type === 'presence.snapshot') resolve();
    });
  });
  return { closed, ws };
}

describe('자격증명 폐기가 실제 폐기가 된다', () => {
  it('POST /auth/logout invalidates that session token only', async () => {
    const token = await loginAdmin();
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);

    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${token}` } });
    expect(out.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(after.statusCode).toBe(401);
    // 다른 기기의 세션은 살아 있어야 한다 — 로그아웃은 이 토큰만 끊는다.
    const other = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${adminToken}` } });
    expect(other.statusCode).toBe(200);
  });

  it('DELETE /accounts/:id/pats/:label revokes the agent PAT', async () => {
    const { pat } = await createAgent(app, adminToken, 'doomedbot');
    const doomedId = (await pool.query(`select id from account where handle = 'doomedbot'`)).rows[0].id;
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${pat}` } })).statusCode).toBe(200);

    const del = await app.inject({
      method: 'DELETE', url: `/accounts/${doomedId}/pats/test`, headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ revoked: 1 });

    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${pat}` } });
    expect(after.statusCode).toBe(401);
  });

  it('rejects PAT revocation from a non-admin', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/accounts/${botId}/pats/test`, headers: { authorization: `Bearer ${botPat}` },
    });
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${botPat}` } })).statusCode).toBe(200);
  });

  it('closes a live socket after its own session is logged out', async () => {
    const token = await loginAdmin();
    const { closed } = await openSocket(token);
    await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${token}` } });
    expect(await closed).toBe(4401);
  });

  it('closes a live socket after its PAT is revoked', async () => {
    const { pat } = await createAgent(app, adminToken, 'sockbot');
    const sockId = (await pool.query(`select id from account where handle = 'sockbot'`)).rows[0].id;
    const { closed } = await openSocket(pat);
    await app.inject({
      method: 'DELETE', url: `/accounts/${sockId}/pats/test`, headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(await closed).toBe(4401);
  });

  it('keeps a socket open across sweeps while its credential is valid', async () => {
    const token = await loginAdmin();
    const { closed, ws } = await openSocket(token);
    let closedEarly = false;
    void closed.then(() => { closedEarly = true; });
    await new Promise((r) => setTimeout(r, REVALIDATE_MS * 5));
    expect(closedEarly).toBe(false);
    ws.close();
  });

  it('findInvalidCredentials reports revoked hashes and spares valid ones', async () => {
    const { pat } = await createAgent(app, adminToken, 'sweepbot');
    const sweepId = (await pool.query(`select id from account where handle = 'sweepbot'`)).rows[0].id;
    const live = await loginAdmin();
    const hash = (t: string) => createHash('sha256').update(t).digest('hex');

    await app.inject({
      method: 'DELETE', url: `/accounts/${sweepId}/pats/test`, headers: { authorization: `Bearer ${adminToken}` },
    });
    const invalid = await findInvalidCredentials(pool, [hash(pat), hash(live), hash('never-existed')]);

    expect(invalid.has(hash(pat))).toBe(true);
    expect(invalid.has(hash('never-existed'))).toBe(true);
    expect(invalid.has(hash(live))).toBe(false);
  });

  // DB 왕복이 실패했을 때 전원을 끊으면 일시적 장애가 강제 로그아웃 사고가 된다. fail-open.
  it('findInvalidCredentials spares everyone when the database round trip fails', async () => {
    const broken = { query: async () => { throw new Error('connection terminated'); } } as unknown as Pool;
    const invalid = await findInvalidCredentials(broken, ['a', 'b']);
    expect(invalid.size).toBe(0);
  });
});
