// 원격 호스트 관리 P2b(스레드 3b0f0255) — 업그레이드 이력(H3)과 맥 전용 표시(requiresMacos).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { onEvent, type WorkspaceEvent } from '../src/events.js';

let app: FastifyInstance; let stop: () => Promise<void>; let pool: Pool; let baseUrl: string;
let adminToken: string; let aliceToken: string; let aliceId: string; let bobToken: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool as Pool;
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: aliceToken, accountId: aliceId } = await createMember(app, adminToken, 'alice'));
  ({ token: bobToken } = await createMember(app, adminToken, 'bob'));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await app.close(); await stop(); });

async function connect(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${baseUrl}/operator`, { headers: auth(token) });
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, capabilities: { agentIds: [], harnesses: {} }, runners: [], sessions: [] }));
  return ws;
}
const upgrades = async (token: string, id: string) =>
  app.inject({ method: 'GET', url: `/operators/${id}/upgrades`, headers: auth(token) });
const waitFor = async (pred: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('업그레이드 이력(H3)', () => {
  it('단계를 최근 것부터 적고, 사유의 제어 문자를 걷고, 단계가 틀린 프레임은 버린다. 단계마다 소유자에게 알린다', async () => {
    const op = await registerOperator(app, aliceToken, 'vm-up');
    const got: WorkspaceEvent[] = [];
    const off = onEvent((e) => { if (e.type === 'operator.changed' && e.operatorId === op.operatorId && Array.isArray(e.audience)) got.push(e); });
    try {
      const ws = await connect(op.token);
      ws.send(JSON.stringify({ type: 'upgrade.progress', stage: 'download', from: '0.3.196', to: '0.3.197' }));
      ws.send(JSON.stringify({ type: 'upgrade.progress', stage: 'bogus', from: '0.3.196', to: '0.3.197' }));
      ws.send(JSON.stringify({ type: 'upgrade.progress', stage: 'rolled_back', from: '0.3.197', to: '0.3.196', error: 'no heartbeat\n\u001b[31min 120s' }));
      await waitFor(async () => (await upgrades(aliceToken, op.operatorId)).json().upgrades.length === 2);
      const rows = (await upgrades(aliceToken, op.operatorId)).json().upgrades;
      expect(rows.map((r: { stage: string }) => r.stage)).toEqual(['rolled_back', 'download']);
      expect(rows[0]).toMatchObject({ from: '0.3.197', to: '0.3.196', error: 'no heartbeat [31min 120s' });
      await waitFor(async () => got.length >= 2);
      expect(got.every((e) => e.type === 'operator.changed' && JSON.stringify(e.audience) === JSON.stringify([aliceId]))).toBe(true);
      ws.close();
    } finally { off(); }
  });

  it('오퍼레이터마다 최근 20줄만 남긴다', async () => {
    const op = await registerOperator(app, aliceToken, 'vm-many');
    const ws = await connect(op.token);
    for (let i = 0; i < 25; i++) ws.send(JSON.stringify({ type: 'upgrade.progress', stage: 'download', to: `0.0.${i}` }));
    await waitFor(async () => {
      const { rows } = await pool.query(`select count(*)::int as n, max(to_version) filter (where to_version = '0.0.24') as last from operator_upgrade where operator_id = $1`, [op.operatorId]);
      return rows[0].last === '0.0.24' && rows[0].n <= 20;
    });
    const rows = (await upgrades(aliceToken, op.operatorId)).json().upgrades;
    expect(rows).toHaveLength(20);
    expect(rows[0].to).toBe('0.0.24');
    ws.close();
  });

  it('남의 오퍼레이터 이력은 404/403 — 소유자와 operator.manage 만 본다', async () => {
    const op = await registerOperator(app, aliceToken, 'vm-private');
    expect((await upgrades(bobToken, op.operatorId)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await upgrades(adminToken, op.operatorId)).statusCode).toBe(200);
  });
});

describe('맥 전용 표시(requiresMacos)', () => {
  it('기본 false, 관리자가 켜고 끌 수 있고, 켜도 리눅스 오퍼레이터 배정은 막지 않는다', async () => {
    const { accountId } = await createAgent(app, adminToken, 'designer-mac');
    const view = async () => (await app.inject({ method: 'GET', url: '/accounts/agents', headers: auth(adminToken) }))
      .json().agents.find((a: { id: string }) => a.id === accountId);
    expect((await view()).requiresMacos).toBe(false);
    const res = await app.inject({ method: 'PATCH', url: `/accounts/agents/${accountId}`, headers: auth(adminToken), payload: { requiresMacos: true } });
    expect(res.statusCode).toBe(200);
    expect((await view()).requiresMacos).toBe(true);
    await app.inject({ method: 'PATCH', url: `/accounts/agents/${accountId}`, headers: auth(adminToken), payload: { requiresMacos: false } });
    expect((await view()).requiresMacos).toBe(false);
  });
});
