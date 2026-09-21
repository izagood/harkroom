// 배정이 곧 인가(스펙 2026-09-20 §5). 오퍼레이터 토큰 + `X-Harkroom-Agent` 로 온 요청은 그
// (오퍼레이터, 에이전트) 쌍이 `agent_assignment` 에 있을 때만 **그 에이전트로** 선다. 러너가
// PAT 을 들지 않게 되는 근거가 이 한 층이다 — 에이전트가 무엇을 할 수 있는지는 그대로이고
// (같은 `req.account`), 바뀐 것은 그 계정을 세우는 자격증명뿐이다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, registerOperator } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>;
let adminToken: string; let opToken: string; let operatorId: string;
let assignedId: string; let otherId: string; let baseUrl: string;
const auth = (t: string, agent?: string) => ({ authorization: `Bearer ${t}`, ...(agent ? { 'x-harkroom-agent': agent } : {}) });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop;
  app = await buildServer({ pool: db.pool as Pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: opToken, operatorId } = await registerOperator(app, adminToken, 'box'));
  ({ accountId: assignedId } = await createAgent(app, adminToken, 'assigned'));
  ({ accountId: otherId } = await createAgent(app, adminToken, 'other'));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
  // 배정하려면 오퍼레이터가 붙어 능력을 말해야 한다(409 not_capable).
  const ws = new WebSocket(`ws://${baseUrl}/operator`, { headers: auth(opToken) });
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, capabilities: { agentIds: [assignedId], harnesses: {} }, runners: [], sessions: [] }));
  const start = Date.now();
  for (;;) {
    const caps = await app.inject({ method: 'GET', url: `/operators/${operatorId}/capabilities`, headers: auth(adminToken) });
    if (caps.statusCode === 200) break;
    if (Date.now() - start > 4000) throw new Error('hello timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
  const put = await app.inject({ method: 'PUT', url: `/accounts/agents/${assignedId}/assignment`, headers: auth(adminToken), payload: { operatorId } });
  expect(put.statusCode).toBe(200);
});
afterAll(async () => { await app.close(); await stop(); });

describe('오퍼레이터 토큰 + X-Harkroom-Agent', () => {
  it('배정된 에이전트면 그 에이전트로 선다 — /agent/config 가 그 정의를 준다', async () => {
    const res = await app.inject({ method: 'GET', url: '/agent/config', headers: auth(opToken, assignedId) });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(assignedId);
  });

  it('MCP 도 같은 자격으로 연다 — initialize 가 200 이다', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { ...auth(opToken, assignedId), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    });
    expect(res.statusCode).toBe(200);
  });

  it('배정되지 않은 에이전트는 403 not_assigned 다 — 즉시, 라우트에 닿기 전에', async () => {
    const res = await app.inject({ method: 'GET', url: '/agent/config', headers: auth(opToken, otherId) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_assigned');
  });

  it('헤더 없이 오퍼레이터 토큰만으로는 계정이 서지 않는다 — /agent/config 는 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/agent/config', headers: auth(opToken) });
    expect(res.statusCode).toBe(401);
  });

  it('사람 세션에 이 헤더를 붙여도 무시된다 — 사람은 사람이다', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(adminToken, assignedId) });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe('human');
  });

  it('폐기된 오퍼레이터의 토큰은 아무것도 세우지 않는다', async () => {
    const { token, operatorId: gone } = await registerOperator(app, adminToken, 'gone');
    await app.inject({ method: 'DELETE', url: `/operators/${gone}`, headers: auth(adminToken) });
    const res = await app.inject({ method: 'GET', url: '/agent/config', headers: auth(token, assignedId) });
    expect(res.statusCode).toBe(401);
  });
});
