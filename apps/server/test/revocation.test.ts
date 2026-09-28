import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
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

// sweep 을 실제로 관측하려고 짧게 준다. 프로덕션 기본값은 60초다.
const REVALIDATE_MS = 100;
const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

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

const loginAdmin = async (): Promise<string> => (await app.inject({
  method: 'POST', url: '/auth/login', payload: { loginId: 'admin', password: 'pw123456' },
})).json().token as string;

const me = (token: string): Promise<{ statusCode: number }> => app.inject({
  method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` },
});

const agentWithPat = async (handle: string): Promise<{ id: string; pat: string }> => {
  const { accountId, pat } = await createAgent(app, adminToken, handle);
  return { id: accountId, pat };
};

/** 소켓을 열고 구독 완료(presence.snapshot)까지 기다린 뒤 종료 코드 약속을 함께 돌려준다. */
async function openSocket(token: string): Promise<{ closed: Promise<number>; ws: WebSocket }> {
  const res = await app.inject({
    method: 'POST', url: '/ws-ticket', headers: { authorization: `Bearer ${token}` },
  });
  const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${res.json().ticket}`);
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (data) => {
      if ((JSON.parse(String(data)) as { type?: string }).type === 'presence.snapshot') resolve();
    });
  });
  return { closed, ws };
}

describe('자격증명 폐기 표면', () => {
  it('POST /auth/logout invalidates that session token only', async () => {
    const token = await loginAdmin();
    expect((await me(token)).statusCode).toBe(200);

    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${token}` } });
    expect(out.statusCode).toBe(204);
    expect((await me(token)).statusCode).toBe(401);
    // 로그아웃은 이 토큰만 끊는다 — 다른 기기의 세션은 살아 있어야 한다.
    expect((await me(adminToken)).statusCode).toBe(200);
  });

  it('DELETE /accounts/:id/pats/:label revokes the agent PAT', async () => {
    const doomed = await agentWithPat('doomedbot');
    expect((await me(doomed.pat)).statusCode).toBe(200);

    const del = await app.inject({
      method: 'DELETE', url: `/accounts/${doomed.id}/pats/test`, headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ revoked: 1 });
    expect((await me(doomed.pat)).statusCode).toBe(401);
  });

  it('rejects PAT revocation from a non-admin', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/accounts/${botId}/pats/test`, headers: { authorization: `Bearer ${botPat}` },
    });
    expect(res.statusCode).toBe(403);
    expect((await me(botPat)).statusCode).toBe(200);
  });
});

describe('폐기가 열린 소켓까지 끊는다', () => {
  it('closes a live socket after its own session is logged out', async () => {
    const token = await loginAdmin();
    const { closed } = await openSocket(token);
    await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${token}` } });
    expect(await closed).toBe(4401);
  });

  // PR #34 가 세션 만료까지 잡고 PAT 폐기는 "폐기 엔드포인트가 생기는 날"로 미뤄 둔 경로.
  it('closes a live socket after its PAT is revoked', async () => {
    const sock = await agentWithPat('sockbot');
    const { closed } = await openSocket(sock.pat);
    await app.inject({
      method: 'DELETE', url: `/accounts/${sock.id}/pats/test`, headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(await closed).toBe(4401);
  });

  it('keeps a socket open across sweeps while its credential is valid', async () => {
    const { closed, ws } = await openSocket(await loginAdmin());
    let closedEarly = false;
    void closed.then(() => { closedEarly = true; });
    await new Promise((r) => setTimeout(r, REVALIDATE_MS * 5));
    expect(closedEarly).toBe(false);
    ws.close();
  });
});

describe('findInvalidCredentials', () => {
  it('reports revoked hashes in one round trip and spares valid ones', async () => {
    const sweep = await agentWithPat('sweepbot');
    const live = await loginAdmin();
    await app.inject({
      method: 'DELETE', url: `/accounts/${sweep.id}/pats/test`, headers: { authorization: `Bearer ${adminToken}` },
    });

    const invalid = await findInvalidCredentials(pool, [hashOf(sweep.pat), hashOf(live), hashOf('never-issued')]);

    expect(invalid.has(hashOf(sweep.pat))).toBe(true);
    expect(invalid.has(hashOf('never-issued'))).toBe(true);
    expect(invalid.has(hashOf(live))).toBe(false);
  });

  // DB 왕복 실패로 전원을 끊으면 일시적 장애가 강제 로그아웃 사고가 된다. 그리고 sweep 루프
  // 안에서 던지면 unhandled rejection 이라 프로세스가 죽는다 — 판정을 여기서 삼킨다.
  it('spares everyone when the database round trip fails', async () => {
    const broken = { query: async () => { throw new Error('connection terminated'); } } as unknown as Pool;
    expect((await findInvalidCredentials(broken, ['a', 'b'])).size).toBe(0);
  });
});
