// 다른 기기에서 gh 줄 고치기(D3) — 소유자 사람 세션만, 오퍼레이터가 알린 로그인만, 오퍼레이터의 답을 기다린다.
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
let agentId: string; let op: { operatorId: string; token: string };
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool as Pool;
  app = await buildServer({ pool, ghLinesTimeoutMs: 400 });
  admin = await bootstrapAdmin(app);
  alice = await createMember(app, admin.token, 'alice');
  bob = await createMember(app, admin.token, 'bob');
  agentId = (await createAgent(app, admin.token, 'ghl')).accountId;
  await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, alice.accountId]);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
  op = await registerOperator(app, alice.token, 'mac');
  await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [agentId, op.operatorId, alice.accountId]);
});
afterAll(async () => { await app.close(); await stop(); });

type Frame = Record<string, unknown>;
async function connect(token: string, onFrame: (ws: WebSocket, f: Frame) => void = () => {}): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${baseUrl}/operator`, { headers: auth(token) });
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  ws.on('message', (raw) => onFrame(ws, JSON.parse(String(raw)) as Frame));
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
const read = (token: string) => app.inject({ method: 'GET', url: `/agents/${agentId}/merge-accounts`, headers: auth(token) });
const put = (token: string, body: unknown, id = agentId) =>
  app.inject({ method: 'PUT', url: `/agents/${id}/merge-accounts/lines`, headers: auth(token), payload: body as object });
const audits = async () => (await pool.query(`select detail from audit_log where action = 'operator.merge_line.set_remote' order by id`)).rows.map((r) => r.detail);

describe('PUT /agents/:id/merge-accounts/lines (D3)', () => {
  it('소유자 사람 세션이 아니면 404 — 다른 사람·admin·PAT·없는 에이전트 · 틀린 범위는 400', async () => {
    expect((await put(bob.token, { scope: 'acme/app', ghUser: 'me' })).statusCode).toBe(404);
    expect((await put(admin.token, { scope: 'acme/app', ghUser: 'me' })).statusCode).toBe(404);
    const pat = await mintPat(pool, alice.accountId, 'gh-lines-pat', { actorId: null, actorHandle: null });
    if (!pat.ok) throw new Error('pat');
    expect([401, 404]).toContain((await put(pat.token, { scope: 'acme/app', ghUser: 'me' })).statusCode);
    expect((await put(alice.token, { scope: 'acme/app', ghUser: 'me' }, '00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
    expect((await put(alice.token, { scope: '*', ghUser: 'me' })).json().error.code).toBe('bad_scope');
    expect((await put(alice.token, { scope: 'acme/ab*', ghUser: 'me' })).statusCode).toBe(400);
    expect((await put(alice.token, { scope: 'acme/app' })).statusCode).toBe(400);
  });

  it('오퍼레이터가 알린 로그인이 아니면 unknown_login(보내지 않는다) · 오퍼레이터가 꺼져 있거나 답이 없으면 504', async () => {
    // 보고가 아직 없다 — 어떤 이름도 모른다.
    expect((await put(alice.token, { scope: 'acme/app', ghUser: 'me' })).json().error.code).toBe('unknown_login');
    const got: Frame[] = [];
    const ws = await connect(op.token, (_ws, f) => { got.push(f); });
    ws.send(JSON.stringify({ type: 'gh.report', report: { logins: ['work-admin', 'me'], byScope: {}, defaultGhUser: null, reach: [] } }));
    await waitFor(async () => (await read(alice.token)).json().report !== null);
    const stranger = await put(alice.token, { scope: 'acme/app', ghUser: 'stranger' });
    expect(stranger.statusCode).toBe(409);
    expect(stranger.json().error.code).toBe('unknown_login');
    expect(got.filter((f) => f.type === 'gh.lines.set')).toEqual([]);
    // 답하지 않는 (옛) 오퍼레이터 — 시간 초과.
    const silent = await put(alice.token, { scope: 'acme/app', ghUser: 'me' });
    expect(silent.statusCode).toBe(504);
    expect(silent.json().error.code).toBe('operator_unreachable');
    expect(got.filter((f) => f.type === 'gh.lines.set')).toMatchObject([{ scope: 'acme/app', ghUser: 'me' }]);
    await new Promise<void>((r) => { ws.on('close', () => r()); ws.close(); });
    await new Promise((r) => setTimeout(r, 100));
    // 연결이 없다 — 곧바로 504.
    const offline = await put(alice.token, { scope: 'acme/app', ghUser: 'me' });
    expect(offline.statusCode).toBe(504);
    expect((await audits()).map((d) => d.outcome)).toEqual(['operator_unreachable', 'operator_unreachable']);
  });

  it('오퍼레이터가 ok 로 답하면 200 · 저장된 보고가 바뀌고 감사가 남는다 · 거절은 409 code · 다른 오퍼레이터의 답은 받지 않는다', async () => {
    const other = await registerOperator(app, alice.token, 'other-mac');
    const otherWs = await connect(other.token);
    let mode: 'ok' | 'refuse' | 'impostor' = 'ok';
    const ws = await connect(op.token, (sock, f) => {
      if (f.type !== 'gh.lines.set') return;
      if (mode === 'impostor') { otherWs.send(JSON.stringify({ type: 'gh.lines.result', requestId: f.requestId, ok: true })); return; }
      if (mode === 'refuse') { sock.send(JSON.stringify({ type: 'gh.lines.result', requestId: f.requestId, ok: false, code: 'unknown_login' })); return; }
      sock.send(JSON.stringify({ type: 'gh.lines.result', requestId: f.requestId, ok: true }));
    });
    ws.send(JSON.stringify({ type: 'gh.report', report: { logins: ['work-admin', 'me'], byScope: { 'acme/*': 'me' }, defaultGhUser: null, reach: [] } }));
    await waitFor(async () => (await read(alice.token)).json().report?.byScope?.['acme/*'] === 'me');

    const ok = await put(alice.token, { scope: 'Acme/App', ghUser: 'work-admin' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect((await read(alice.token)).json().report.byScope).toEqual({ 'acme/*': 'me', 'acme/app': 'work-admin' });

    const removed = await put(alice.token, { scope: 'acme/*', ghUser: null });
    expect(removed.statusCode).toBe(200);
    expect((await read(alice.token)).json().report.byScope).toEqual({ 'acme/app': 'work-admin' });

    mode = 'refuse';
    const refused = await put(alice.token, { scope: 'acme/app', ghUser: 'me' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('unknown_login');
    expect((await read(alice.token)).json().report.byScope).toEqual({ 'acme/app': 'work-admin' });

    mode = 'impostor';
    expect((await put(alice.token, { scope: 'acme/app', ghUser: 'me' })).statusCode).toBe(504);

    const last = (await audits()).slice(-4);
    expect(last[0]).toEqual({ operatorId: op.operatorId, agentId, scope: 'acme/app', ghUser: 'work-admin', by: alice.accountId, outcome: 'ok' });
    expect(last.map((d) => d.outcome)).toEqual(['ok', 'ok', 'unknown_login', 'operator_unreachable']);
    ws.close(); otherWs.close();
  });
});
