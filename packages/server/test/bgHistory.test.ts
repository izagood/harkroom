import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CAUSE_HEADER, TURN_ID_HEADER } from '@harkroom/shared/runnerLink';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { enqueueBgJob, kstDay } from '../src/services/bgJobs.js';

// 백그라운드 회차 히스토리·되돌리기(G1 · BG4 서버) — 전/후·되돌리기 규칙·한 번만·소유자만·토글.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('background history (BG4)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let op: { token: string; operatorId: string };
  let agent: { accountId: string; pat: string };
  let url = '';

  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse((r.content as { text: string }[])[0]!.text);
  };
  const connect = async (headers: Record<string, string>) => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    return client;
  };
  const asAgent = (extra: Record<string, string> = {}) => ({ ...auth(op.token), 'x-harkroom-agent': agent.accountId, ...extra });
  const base = () => `/accounts/agents/${agent.accountId}/background`;

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    agent = await createAgent(app, admin.token, 'bg-hist');
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agent.accountId, alice.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [agent.accountId, op.operatorId, admin.accountId]);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('전/후를 보여 주고, 되돌리기는 회차 직후 판인 것만 — 만든 것은 보관·고친 것은 전 판·보관한 것은 되살림, 한 번만', async () => {
    // 회차 전 상태(일반 턴이 쓴 것).
    const t = await connect(asAgent({ [TURN_ID_HEADER]: randomUUID() }));
    for (const [slug, value] of [['mem/old', 'v0'], ['mem/arch', 'a0'], ['mem/keep', 'k0']]) {
      expect(await call(t, 'memory.set', { slug, value, kind: 'topic' })).toEqual({ ok: true });
    }
    await t.close();
    const runId = (await pool.query(
      `insert into bg_job (account_id, kind, day, status, input, claimed_at) values ($1, 'distill', $2::date, 'running', '{}'::jsonb, now()) returning id`,
      [agent.accountId, kstDay(new Date())],
    )).rows[0].id as string;
    const c = await connect(asAgent({ [CAUSE_HEADER]: `bg:${runId}`, [TURN_ID_HEADER]: randomUUID() }));
    expect(await call(c, 'memory.set', { slug: 'mem/old', value: 'v1', kind: 'topic' })).toEqual({ ok: true });
    expect(await call(c, 'memory.set', { slug: 'mem/new', value: 'n1', kind: 'topic' })).toEqual({ ok: true });
    expect(await call(c, 'memory.archive', { slug: 'mem/arch' })).toMatchObject({ ok: true });
    expect(await call(c, 'memory.merge', { into: 'mem/merged', from: ['mem/keep'], value: 'm1', kind: 'topic' })).toMatchObject({ ok: true });
    expect(await call(c, 'bg.complete', { jobId: runId, status: 'done', summary: '<b>mem/old</b> 갱신' })).toEqual({ ok: true });
    await c.close();

    // 소유자만 본다.
    expect((await app.inject({ method: 'GET', url: base(), headers: auth(bob.token) })).statusCode).toBe(403);
    const list = (await app.inject({ method: 'GET', url: base(), headers: auth(alice.token) })).json();
    expect(list).toMatchObject({ enabled: true, paused: [] });
    expect(list.runs[0]).toMatchObject({ id: runId, status: 'done', summary: '<b>mem/old</b> 갱신', writes: 5, changes: 5, revertedAt: null });

    const details = (await app.inject({ method: 'GET', url: `${base()}/runs/${runId}`, headers: auth(alice.token) })).json().changes as
      { slug: string; ops: string[]; before: { value: string } | null; after: { value: string; archived: boolean } | null }[];
    const by = Object.fromEntries(details.map((d) => [d.slug, d]));
    expect(by['mem/old']).toMatchObject({ ops: ['update'], before: { value: 'v0' }, after: { value: 'v1', archived: false } });
    expect(by['mem/new']).toMatchObject({ ops: ['create'], before: null, after: { value: 'n1' } });
    expect(by['mem/arch']!.after).toMatchObject({ archived: true });
    expect(by['mem/merged']).toMatchObject({ ops: ['merge'], before: null, after: { value: 'm1' } });
    expect((await app.inject({ method: 'GET', url: `${base()}/runs/${randomUUID()}`, headers: auth(alice.token) })).statusCode).toBe(404);

    // 그 사이 사람이 mem/new 를 고쳤다 — 되돌리기는 그것을 건너뛴다.
    await pool.query(`update agent_memory set value = 'human', updated_at = now() + interval '1 second' where account_id = $1 and slug = 'mem/new'`, [agent.accountId]);

    const rv = await app.inject({ method: 'POST', url: `${base()}/runs/${runId}/revert`, headers: auth(alice.token) });
    expect(rv.statusCode).toBe(200);
    expect(rv.json().reverted.sort()).toEqual(['mem/arch', 'mem/keep', 'mem/merged', 'mem/old']);
    expect(rv.json().skipped).toEqual([{ slug: 'mem/new', reason: 'changed_since' }]);
    expect(rv.json().notesReopened).toBe(0);
    const rows = Object.fromEntries((await pool.query(`select slug, value, archived_at from agent_memory where account_id = $1`, [agent.accountId])).rows
      .map((r) => [r.slug, r]));
    expect(rows['mem/old']).toMatchObject({ value: 'v0', archived_at: null });
    expect(rows['mem/arch'].archived_at).toBeNull();
    expect(rows['mem/keep'].archived_at).toBeNull();
    expect(rows['mem/merged'].archived_at).not.toBeNull();
    expect(rows['mem/new']).toMatchObject({ value: 'human', archived_at: null });

    expect((await app.inject({ method: 'POST', url: `${base()}/runs/${runId}/revert`, headers: auth(alice.token) })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `${base()}/runs/${runId}/revert`, headers: auth(bob.token) })).statusCode).toBe(403);
  });

  it('되돌리면 그 회차가 보관한 스레드 메모도 다시 연다(BG3)', async () => {
    const ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'bg-hist-note' } })).json().id as string;
    const root = (await app.inject({ method: 'POST', url: `/channels/${ch}/messages`, headers: auth(admin.token), payload: { body: 'r' } })).json().id as string;
    await pool.query(`insert into thread_note (account_id, thread_root_id, body) values ($1, $2, '메모')`, [agent.accountId, root]);
    const runId = (await pool.query(
      `insert into bg_job (account_id, kind, day, status, input, claimed_at) values ($1, 'distill', '2026-09-01', 'running', $2::jsonb, now()) returning id`,
      [agent.accountId, JSON.stringify({ threadIds: [root] })],
    )).rows[0].id as string;
    const { completeBgJob } = await import('../src/services/bgJobs.js');
    expect(await completeBgJob(pool, agent.accountId, runId, { status: 'done', summary: '없음' })).toBe('ok');
    expect((await pool.query(`select archived_at from thread_note where thread_root_id = $1`, [root])).rows[0].archived_at).not.toBeNull();
    const rv = await app.inject({ method: 'POST', url: `${base()}/runs/${runId}/revert`, headers: auth(alice.token) });
    expect(rv.json()).toMatchObject({ reverted: [], skipped: [], notesReopened: 1 });
    expect((await pool.query(`select archived_at from thread_note where thread_root_id = $1`, [root])).rows[0].archived_at).toBeNull();
  });

  it('도는 회차는 되돌리지 못하고, 토글을 끄면 일감을 넣지 않는다', async () => {
    const running = (await pool.query(
      `insert into bg_job (account_id, kind, day, status, claimed_at) values ($1, 'cleanup', $2::date, 'running', now()) returning id`,
      [agent.accountId, kstDay(new Date())],
    )).rows[0].id as string;
    expect((await app.inject({ method: 'POST', url: `${base()}/runs/${running}/revert`, headers: auth(alice.token) })).json().error.code).toBe('not_finished');
    expect((await app.inject({ method: 'PUT', url: base(), headers: auth(bob.token), payload: { enabled: false } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: base(), headers: auth(alice.token), payload: { enabled: false } })).json()).toEqual({ ok: true, enabled: false });
    expect((await app.inject({ method: 'GET', url: base(), headers: auth(alice.token) })).json().enabled).toBe(false);
    expect(await enqueueBgJob(pool, { accountId: agent.accountId, kind: 'distill', input: {}, now: new Date('2026-12-01T19:00:00Z') }, { HARKROOM_BACKGROUND_ENABLED: '1' } as NodeJS.ProcessEnv))
      .toEqual({ refused: 'agent_off' });
  });
});
