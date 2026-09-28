import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let baseUrl: string;

const ALLOWED = 'tauri://localhost';

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({
    pool: db.pool,
    corsOrigins: [ALLOWED],
    // 실제 기본은 60초다. 테스트가 재검증 한 바퀴를 실제로 보려면 짧아야 한다.
    wsRevalidateMs: 50,
  });
  ({ token: adminToken } = await bootstrapAdmin(app));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await app.close(); await stop(); });

async function ticket(): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/ws-ticket', headers: { authorization: `Bearer ${adminToken}` },
  });
  return res.json().ticket as string;
}

/** 소켓을 열고, 준비되면 'ready', 서버가 닫으면 'closed:<code>' 로 끝난다. */
function connect(t: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${t}`, { headers });
  const settled = new Promise<string>((resolve) => {
    ws.on('message', (d) => {
      if (JSON.parse(String(d)).type === 'presence.snapshot') resolve('ready');
    });
    ws.on('close', (code) => resolve(`closed:${code}`));
    ws.on('error', () => {});
  });
  return { ws, settled };
}

describe('ws origin allowlist', () => {
  it('accepts a handshake from an allowed origin', async () => {
    const c = connect(await ticket(), { origin: ALLOWED });
    expect(await c.settled).toBe('ready');
    c.ws.close();
  });

  // Origin 검사는 브라우저 전용 방어다. 에이전트·CLI 는 Origin 을 보내지 않으므로,
  // 없다고 막으면 사람이 아닌 참여자가 전부 끊긴다.
  it('accepts a handshake that carries no origin at all', async () => {
    const c = connect(await ticket());
    expect(await c.settled).toBe('ready');
    c.ws.close();
  });

  it('refuses a handshake from an origin outside the list', async () => {
    const c = connect(await ticket(), { origin: 'https://evil.example' });
    expect(await c.settled).toBe('closed:4403');
  });
});

describe('cors allowlist', () => {
  it('reflects an allowed origin', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: ALLOWED } });
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('does not reflect an origin outside the list', async () => {
    const res = await app.inject({
      method: 'GET', url: '/healthz', headers: { origin: 'https://evil.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('socket lifetime follows the credential', () => {
  // 토큰은 연결 시점에만 검증됐다 — 그래서 만료 직전에 열린 소켓이 만료 후에도 계속
  // 이벤트를 받았다. 세션이 죽으면 그 세션으로 연 소켓도 죽어야 한다.
  it('closes a live socket once its session has expired', async () => {
    const c = connect(await ticket());
    expect(await c.settled).toBe('ready');

    const closed = new Promise<number>((resolve) => c.ws.on('close', (code) => resolve(code)));
    await pool.query(`update session set expires_at = now() - interval '1 day'`);

    expect(await closed).toBe(4401);
  });
});
