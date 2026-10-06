// 오퍼레이터 박동(원격 호스트 관리 P2a, 스레드 3b0f0255) — H1 상태·H2 codeId·H8 머신 묶음표.
// 실제 소켓을 태운다(operatorChannel.test 와 같은 이유: 박동은 소켓 → 허브 → 라우트를 지난다).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import type { OperatorView } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember, registerOperator } from './helpers/fixtures.js';
import { onEvent, type WorkspaceEvent } from '../src/events.js';

let app: FastifyInstance; let stop: () => Promise<void>; let pool: Pool; let baseUrl: string;
let adminToken: string; let aliceToken: string; let aliceId: string; let bobToken: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const DIGEST = 'a'.repeat(64);

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
const mine = async (token: string, id: string): Promise<OperatorView> =>
  ((await app.inject({ method: 'GET', url: '/operators', headers: auth(token) })).json().operators as OperatorView[])
    .find((o) => o.id === id)!;
const waitFor = async (pred: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const beat = (ws: WebSocket, status: unknown, machine?: string) => ws.send(JSON.stringify({ type: 'status', status, machine }));

describe('박동 상태(H1·H5)', () => {
  it('허용한 칸만 목록에 실린다 — 모르는 키(토큰 같은 것)는 서버가 들지 않는다. 끊기면 null', async () => {
    const op = await registerOperator(app, aliceToken, 'vm');
    const ws = await connect(op.token);
    beat(ws, {
      turns: { running: 2, max: 16 }, memory: { totalBytes: 64e9, freeBytes: 40e9, turnRssBytes: 1e9 },
      credentials: [{ kind: 'mcp', name: 'jira', state: 'expired', agentIds: ['x'], token: 'secret-value', expiresAt: '2026-10-07' }],
      token: 'secret-value',
    });
    await waitFor(async () => (await mine(aliceToken, op.operatorId)).status != null);
    const view = await mine(aliceToken, op.operatorId);
    expect(view.status).toMatchObject({ turns: { running: 2, max: 16 }, credentials: [{ kind: 'mcp', name: 'jira', state: 'expired', agentIds: ['x'] }] });
    expect(JSON.stringify(view)).not.toContain('secret-value');
    expect(JSON.stringify(view)).not.toContain('2026-10-07');
    ws.close();
    await waitFor(async () => (await mine(aliceToken, op.operatorId)).status === null);
  });

  it('턴 수·자격 상태가 바뀔 때만 소유자에게 operator.changed — 같은 박동은 다시 알리지 않는다', async () => {
    const op = await registerOperator(app, aliceToken, 'vm-events');
    const got: WorkspaceEvent[] = [];
    const off = onEvent((e) => { if (e.type === 'operator.changed' && e.operatorId === op.operatorId) got.push(e); });
    try {
      const ws = await connect(op.token);
      await waitFor(async () => got.length >= 1); // 접속 알림(전원)
      got.length = 0;
      beat(ws, { turns: { running: 1, max: 16 } });
      await waitFor(async () => got.length >= 1);
      expect(got[0]).toMatchObject({ audience: [aliceId] });
      beat(ws, { turns: { running: 1, max: 16 }, memory: { totalBytes: 10, freeBytes: 5 } });
      beat(ws, { turns: { running: 2, max: 16 } });
      await waitFor(async () => got.length >= 2);
      await new Promise((r) => setTimeout(r, 100));
      expect(got).toHaveLength(2);
      ws.close();
    } finally { off(); }
  });
});

describe('머신 묶음표(H8)', () => {
  it('같은 소유자의 같은 머신이면 machineId 가 같고, 소유자가 다르면 같은 digest 여도 다르다. 원래 digest 는 싣지 않는다', async () => {
    const a1 = await registerOperator(app, aliceToken, 'udc-work');
    const a2 = await registerOperator(app, aliceToken, 'udc-personal');
    const b1 = await registerOperator(app, bobToken, 'udc-bob');
    const sockets = await Promise.all([a1, a2, b1].map((o) => connect(o.token)));
    for (const ws of sockets) beat(ws, { turns: { running: 0, max: null } }, DIGEST);
    await waitFor(async () => (await mine(bobToken, b1.operatorId)).machineId != null
      && (await mine(aliceToken, a2.operatorId)).machineId != null && (await mine(aliceToken, a1.operatorId)).machineId != null);
    const [v1, v2, v3] = [await mine(aliceToken, a1.operatorId), await mine(aliceToken, a2.operatorId), await mine(bobToken, b1.operatorId)];
    expect(v1.machineId).toBe(v2.machineId);
    expect(v3.machineId).not.toBe(v1.machineId);
    expect(v1.machineId).not.toBe(DIGEST);
    for (const ws of sockets) ws.close();
  });

  it('64자 hex 가 아닌 머신 값(원래 machine-id 를 그대로 보낸 것 등)은 적지 않는다', async () => {
    const op = await registerOperator(app, aliceToken, 'raw-machine');
    const ws = await connect(op.token);
    beat(ws, { turns: { running: 0 } }, '3f2a9c0d4e5b6a7f8091a2b3c4d5e6f7');
    await waitFor(async () => (await mine(aliceToken, op.operatorId)).status != null);
    await new Promise((r) => setTimeout(r, 100));
    expect((await mine(aliceToken, op.operatorId)).machineId).toBeNull();
    ws.close();
  });
});

describe('등록 코드 codeId(H2)', () => {
  it('register-codes 가 codeId 를 주고, 그 코드로 claim 하면 소유자에게 같은 codeId 가 실린 operator.changed 가 간다', async () => {
    const issued = (await app.inject({ method: 'POST', url: '/operators/register-codes', headers: auth(aliceToken) })).json();
    expect(issued.codeId).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(issued.code).not.toContain(issued.codeId);
    const got: WorkspaceEvent[] = [];
    const off = onEvent((e) => { if (e.type === 'operator.changed' && e.codeId) got.push(e); });
    try {
      const res = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code: issued.code, name: 'paired' } });
      expect(res.statusCode).toBe(200);
      expect(got).toEqual([expect.objectContaining({ operatorId: res.json().operator.id, codeId: issued.codeId, audience: [aliceId] })]);
    } finally { off(); }
  });
});
