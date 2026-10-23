// gh 계정 보고(D1) — 오퍼레이터 프레임으로 받아 한 줄을 덮고, 그 에이전트의 소유자에게만 읽힌다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { mintPat } from '../src/services/pats.js';

let app: FastifyInstance; let stop: () => Promise<void>; let pool: Pool; let baseUrl: string;
let admin: { token: string; accountId: string }; let alice: { token: string; accountId: string }; let bob: { token: string; accountId: string };
let agentId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool as Pool;
  app = await buildServer({ pool });
  admin = await bootstrapAdmin(app);
  alice = await createMember(app, admin.token, 'alice');
  bob = await createMember(app, admin.token, 'bob');
  agentId = (await createAgent(app, admin.token, 'ghr')).accountId;
  await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, alice.accountId]);
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
const waitFor = async (pred: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const read = (token: string, id = agentId) => app.inject({ method: 'GET', url: `/agents/${id}/merge-accounts`, headers: auth(token) });

describe('operator gh report (D1)', () => {
  it('보고를 덮어 적고, 소유자에게 그 에이전트를 도는 오퍼레이터의 줄을 준다 · 모르는 칸(토큰)은 버린다', async () => {
    const op = await registerOperator(app, alice.token, 'mac');
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [agentId, op.operatorId, alice.accountId]);
    expect((await read(alice.token)).json()).toEqual({ operatorId: op.operatorId, report: null });

    const ws = await connect(op.token);
    ws.send(JSON.stringify({ type: 'gh.report', report: {
      logins: ['work-admin', 'me'], byScope: { 'work-org/*': 'work-admin' }, defaultGhUser: null,
      reach: [{ scope: 'work-org/app', login: 'work-admin', reachable: true }], token: 'ghp_SECRET', email: 'me@example.com',
    } }));
    await waitFor(async () => (await read(alice.token)).json().report !== null);
    const first = (await read(alice.token)).json();
    expect(first.report).toMatchObject({ logins: ['work-admin', 'me'], byScope: { 'work-org/*': 'work-admin' }, defaultGhUser: null, reach: [{ scope: 'work-org/app', login: 'work-admin', reachable: true }] });
    expect(JSON.stringify(first)).not.toMatch(/ghp_SECRET|example\.com/);

    ws.send(JSON.stringify({ type: 'gh.report', report: { logins: ['me'], byScope: {}, defaultGhUser: 'me', reach: [] } }));
    await waitFor(async () => (await read(alice.token)).json().report?.defaultGhUser === 'me');
    expect((await pool.query(`select count(*)::int as n from operator_gh_report where operator_id = $1`, [op.operatorId])).rows[0].n).toBe(1);
    expect((await read(alice.token)).json().report).toMatchObject({ logins: ['me'], byScope: {} });
    ws.close();
  });

  it('소유자가 아니면 404 — 다른 사람·admin·PAT·없는 에이전트', async () => {
    expect((await read(bob.token)).statusCode).toBe(404);
    expect((await read(admin.token)).statusCode).toBe(404);
    const pat = await mintPat(pool, alice.accountId, 'gh-report-pat', { actorId: null, actorHandle: null });
    if (!pat.ok) throw new Error('pat');
    expect([401, 404]).toContain((await read(pat.token)).statusCode);
    expect((await read(alice.token, '00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
    expect((await read(alice.token, 'not-a-uuid')).statusCode).toBe(400);
  });
});
