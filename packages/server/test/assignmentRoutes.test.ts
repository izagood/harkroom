// 배정 — 스펙 2026-09-20 §3. 양쪽 동의(서버에서 고름 ∧ 오퍼레이터가 능력으로 등록함),
// 에이전트당 하나, 재배정은 이전 오퍼레이터에 unassign{drain} 뒤 새 곳에 assign,
// 오퍼레이터가 다시 붙으면 자기 배정을 assign 으로 다시 받는다(서버는 끊기면 잊는다).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import type { ServerToOperatorFrame } from '@harkroom/shared/operatorProtocol';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>; let baseUrl: string;
let adminToken: string; let aliceToken: string; let aliceId: string; let bobToken: string;
let agentId: string;
let opA: { token: string; operatorId: string }; let opB: { token: string; operatorId: string };
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

interface Attached { frames: ServerToOperatorFrame[]; ws: WebSocket; close(): Promise<void> }
async function attachOperator(op: { token: string }, agentIds: string[], harnesses: Record<string, { installed: boolean; loggedIn: boolean }> = {}): Promise<Attached> {
  const ws = new WebSocket(`ws://${baseUrl}/operator`, { headers: auth(op.token) });
  const frames: ServerToOperatorFrame[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(String(d)) as ServerToOperatorFrame));
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, capabilities: { agentIds, harnesses }, runners: [], sessions: [] }));
  return {
    frames, ws,
    close: () => new Promise<void>((resolve) => { ws.on('close', () => resolve()); ws.close(); }),
  };
}
const waitFor = async (pred: () => boolean, ms = 4000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};
/** 허브가 hello 를 처리했는지는 능력 조회로 안다 — 고정 지연으로 갈음하지 않는다. */
const waitCapable = async (operatorId: string, agentIds: string[]): Promise<void> => {
  const start = Date.now();
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/operators/${operatorId}/capabilities`, headers: auth(adminToken) });
    if (res.statusCode === 200 && JSON.stringify(res.json().agentIds) === JSON.stringify(agentIds)) return;
    if (Date.now() - start > 4000) throw new Error('capabilities timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop;
  app = await buildServer({ pool: db.pool as Pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: aliceToken, accountId: aliceId } = await createMember(app, adminToken, 'alice'));
  ({ token: bobToken } = await createMember(app, adminToken, 'bob'));
  ({ accountId: agentId } = await createAgent(app, adminToken, 'murmur'));
  await app.inject({ method: 'PATCH', url: `/accounts/agents/${agentId}`, headers: auth(adminToken), payload: { ownerAccountId: aliceId } });
  opA = await registerOperator(app, aliceToken, 'A');
  opB = await registerOperator(app, bobToken, 'B');
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await app.close(); await stop(); });

describe('배정', () => {
  it('능력에 없는 에이전트는 배정할 수 없다 — 양쪽 동의', async () => {
    const a = await attachOperator(opA, []);
    await waitCapable(opA.operatorId, []);
    const res = await app.inject({ method: 'PUT', url: `/accounts/agents/${agentId}/assignment`, headers: auth(aliceToken), payload: { operatorId: opA.operatorId } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_capable');
    await a.close();
  });
  it('소유자가 자기 오퍼레이터에 배정하면 assign 이 push 되고 AgentView 에 실린다', async () => {
    const a = await attachOperator(opA, [agentId]);
    await waitCapable(opA.operatorId, [agentId]);
    const res = await app.inject({ method: 'PUT', url: `/accounts/agents/${agentId}/assignment`, headers: auth(aliceToken), payload: { operatorId: opA.operatorId } });
    expect(res.statusCode).toBe(200);
    expect(res.json().operatorId).toBe(opA.operatorId);
    await waitFor(() => a.frames.some((f) => f.type === 'assign' && f.agentId === agentId));
    const assign = a.frames.find((f) => f.type === 'assign' && f.agentId === agentId)!;
    if (assign.type === 'assign') expect(assign.definition.handle).toBe('murmur');
    const agents = await app.inject({ method: 'GET', url: '/accounts/agents', headers: auth(aliceToken) });
    const mine = (agents.json().agents as { id: string; assignment: { operatorId: string } | null }[]).find((x) => x.id === agentId)!;
    expect(mine.assignment?.operatorId).toBe(opA.operatorId);
    await a.close();
  });
  it('소유자라도 남의 오퍼레이터에 배정하려면 agent.manage 가 필요하다', async () => {
    const b = await attachOperator(opB, [agentId]);
    await waitCapable(opB.operatorId, [agentId]);
    const res = await app.inject({ method: 'PUT', url: `/accounts/agents/${agentId}/assignment`, headers: auth(aliceToken), payload: { operatorId: opB.operatorId } });
    expect(res.statusCode).toBe(403);
    await b.close();
  });
  it('admin 이 재배정하면 이전에 unassign{drain}, 새 곳에 assign', async () => {
    const a = await attachOperator(opA, [agentId]);
    const b = await attachOperator(opB, [agentId]);
    await waitCapable(opA.operatorId, [agentId]);
    await waitCapable(opB.operatorId, [agentId]);
    const res = await app.inject({ method: 'PUT', url: `/accounts/agents/${agentId}/assignment`, headers: auth(adminToken), payload: { operatorId: opB.operatorId } });
    expect(res.statusCode).toBe(200);
    await waitFor(() => a.frames.some((f) => f.type === 'unassign' && f.agentId === agentId && f.drain === true));
    await waitFor(() => b.frames.some((f) => f.type === 'assign' && f.agentId === agentId));
    await a.close(); await b.close();
  });
  it('오퍼레이터가 다시 붙으면 자기 배정을 assign 으로 다시 받는다', async () => {
    const b = await attachOperator(opB, [agentId]);
    await waitFor(() => b.frames.some((f) => f.type === 'assign' && f.agentId === agentId));
    await b.close();
  });
  it('오퍼레이터가 그 하네스를 없다고 했으면 409 harness_missing — 말하지 않았으면 모른다', async () => {
    const a = await attachOperator(opA, [agentId], { 'claude-code': { installed: false, loggedIn: false } });
    await waitCapable(opA.operatorId, [agentId]);
    const res = await app.inject({ method: 'PUT', url: `/accounts/agents/${agentId}/assignment`, headers: auth(aliceToken), payload: { operatorId: opA.operatorId } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('harness_missing');
    await a.close();
  });
  it('personal 자격증명은 소유자 자신의 오퍼레이터에만 — 남의 오퍼레이터면 admin 도 403 (스펙 §7)', async () => {
    const { accountId: privy } = await createAgent(app, adminToken, 'privy');
    const scoped = await app.inject({ method: 'PATCH', url: `/accounts/agents/${privy}`, headers: auth(adminToken),
      payload: { ownerAccountId: aliceId, invokeScope: 'owner', credentialScope: 'personal' } });
    expect(scoped.statusCode).toBe(200);
    const b = await attachOperator(opB, [privy]);
    await waitCapable(opB.operatorId, [privy]);
    const foreign = await app.inject({ method: 'PUT', url: `/accounts/agents/${privy}/assignment`, headers: auth(adminToken), payload: { operatorId: opB.operatorId } });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe('personal_on_foreign_operator');
    await b.close();
    const a = await attachOperator(opA, [privy]);
    await waitCapable(opA.operatorId, [privy]);
    const mine = await app.inject({ method: 'PUT', url: `/accounts/agents/${privy}/assignment`, headers: auth(aliceToken), payload: { operatorId: opA.operatorId } });
    expect(mine.statusCode).toBe(200);
    await a.close();
  });
  it('배정 해제는 unassign{drain} 을 보내고 404 로 두 번 지울 수 없다', async () => {
    const b = await attachOperator(opB, [agentId]);
    await waitCapable(opB.operatorId, [agentId]);
    const del = await app.inject({ method: 'DELETE', url: `/accounts/agents/${agentId}/assignment`, headers: auth(aliceToken) });
    expect(del.statusCode).toBe(204);
    await waitFor(() => b.frames.some((f) => f.type === 'unassign' && f.agentId === agentId));
    const again = await app.inject({ method: 'DELETE', url: `/accounts/agents/${agentId}/assignment`, headers: auth(aliceToken) });
    expect(again.statusCode).toBe(404);
    await b.close();
  });
});
