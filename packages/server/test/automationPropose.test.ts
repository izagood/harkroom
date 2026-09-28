/**
 * 071 — 에이전트는 자동화를 **제안만** 한다. 승인 전에는 아무것도 돌지 않고, 승인하면
 * 글은 승인한 사람 이름으로 나간다.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { createAutomationSweeper } from '../src/services/automations.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let agentPat: string;
let user: { token: string; accountId: string };
let channelId: string;
let mcpUrl: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop; pool = db.pool;
  app = await buildServer({ pool: db.pool, secretKey: null });
  ({ token: adminToken } = await bootstrapAdmin(app));
  user = await createMember(app, adminToken, 'approver');
  ({ pat: agentPat } = await createAgent(app, adminToken, 'planner'));
  const ch = await app.inject({ method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` }, payload: { name: 'propose-ch' } });
  channelId = ch.json().id;
  await app.inject({ method: 'POST', url: `/channels/${channelId}/members`, headers: { authorization: `Bearer ${adminToken}` }, payload: { accountId: user.accountId } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});
afterAll(async () => { await app.close(); await stop(); });

async function propose(args: Record<string, unknown>): Promise<Record<string, any>> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${agentPat}` } },
  }));
  try {
    const res = await client.callTool({ name: 'automation.propose', arguments: args });
    return JSON.parse((res.content as { text: string }[])[0]!.text);
  } finally {
    await client.close();
  }
}

const auth = () => ({ authorization: `Bearer ${user.token}` });
const weekly = { kind: 'schedule', freq: 'weekly', weekdays: [1], time: '09:00', tz: 'Asia/Seoul' };

describe('automation.propose (071)', () => {
  it('제안은 승인 대기로 들어가고, 승인 전에는 켤 수도 수신을 열 수도 없다', async () => {
    const out = await propose({ name: '주간 정리', channelId, body: '@planner 지난주 정리', trigger: weekly, forHandle: 'approver' });
    const a = out.automation;
    expect(a).toMatchObject({ enabled: false, approvedAt: null, ownerId: user.accountId, nextAt: null });
    expect(a.proposedBy).toBeTruthy();

    const list = await app.inject({ method: 'GET', url: '/automations', headers: auth() });
    expect(list.json().automations.map((x: { id: string }) => x.id)).toContain(a.id);

    const on = await app.inject({ method: 'PATCH', url: `/automations/${a.id}`, headers: auth(), payload: { enabled: true } });
    expect(on.statusCode).toBe(409);
    expect(on.json().error.code).toBe('not_approved');

    await pool.query(`update automation set next_at = now() - interval '1 minute' where id = $1`, [a.id]);
    await createAutomationSweeper(pool).sweep();
    expect((await pool.query(`select count(*)::int as n from automation_run where automation_id = $1`, [a.id])).rows[0].n).toBe(0);
  });

  it('승인하면 켜지고 다음 회차가 잡힌다. 두 번 승인은 404', async () => {
    const out = await propose({ name: '매일', channelId, body: 'x', trigger: weekly, forHandle: 'approver' });
    const ok = await app.inject({ method: 'POST', url: `/automations/${out.automation.id}/approve`, headers: auth() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().automation.enabled).toBe(true);
    expect(ok.json().automation.approvedAt).toBeTruthy();
    expect(ok.json().automation.nextAt).toBeTruthy();
    const again = await app.inject({ method: 'POST', url: `/automations/${out.automation.id}/approve`, headers: auth() });
    expect(again.statusCode).toBe(404);
  });

  it('forHandle 이 없으면 에이전트 소유자가 승인자다. 없는 handle 은 거절', async () => {
    const own = await propose({ name: 'x', channelId, body: 'x', trigger: weekly });
    const owner = (await pool.query(
      `select c.owner_account_id as id from agent_config c join account a on a.id = c.account_id where a.handle = 'planner'`,
    )).rows[0]?.id ?? null;
    if (owner) expect(own.automation.ownerId).toBe(owner);
    else expect(own.error.code).toBe('no_owner');
    expect((await propose({ name: 'x', channelId, body: 'x', trigger: weekly, forHandle: 'nobody' })).error.code).toBe('no_owner');
  });

  it('에이전트는 REST 로 승인할 수 없다', async () => {
    const out = await propose({ name: 'y', channelId, body: 'y', trigger: weekly, forHandle: 'approver' });
    const res = await app.inject({ method: 'POST', url: `/automations/${out.automation.id}/approve`, headers: { authorization: `Bearer ${agentPat}` } });
    expect(res.statusCode).toBe(403);
  });
});
