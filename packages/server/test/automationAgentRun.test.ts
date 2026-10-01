/**
 * 082 — 에이전트가 돌리는 "지금 한 번"(MCP `automation.list`·`automation.run`).
 *
 * 권한은 하나다: 이 턴의 원인 메시지(`CAUSE_HEADER`)를 그 자동화의 소유자가 썼고, 그 메시지가
 * 실제로 이 에이전트를 깨웠어야 한다. 에이전트가 원인이거나(위임) 자동화 글이 원인이면 거절한다.
 * 글은 소유자 이름으로 나가지만 사슬의 깊이를 이어받아 연쇄 상한을 세탁하지 못한다.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CAUSE_HEADER } from '@harkroom/shared/runnerLink';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { createAutomationSweeper, enqueueRun } from '../src/services/automations.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let boss: { token: string; accountId: string };
let other: { token: string; accountId: string };
let runner: { accountId: string; pat: string };
let helper: { accountId: string; pat: string };
let channelId: string;
let mcpUrl: string;

const weekly = { kind: 'schedule', freq: 'weekly', weekdays: [1], time: '09:00', tz: 'Asia/Seoul' };

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop; pool = db.pool;
  app = await buildServer({ pool: db.pool, secretKey: null });
  ({ token: adminToken } = await bootstrapAdmin(app));
  boss = await createMember(app, adminToken, 'boss');
  other = await createMember(app, adminToken, 'other');
  runner = await createAgent(app, adminToken, 'runner');
  helper = await createAgent(app, adminToken, 'helper');
  const ch = await app.inject({ method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` }, payload: { name: 'arun' } });
  channelId = ch.json().id;
  for (const id of [boss.accountId, other.accountId, runner.accountId, helper.accountId]) {
    await app.inject({ method: 'POST', url: `/channels/${channelId}/members`, headers: { authorization: `Bearer ${adminToken}` }, payload: { accountId: id } });
  }
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});
afterAll(async () => { await app.close(); await stop(); });

async function tool(pat: string, cause: string | null, name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${pat}`, ...(cause ? { [CAUSE_HEADER]: cause } : {}) } },
  }));
  try {
    const res = await client.callTool({ name, arguments: args });
    return JSON.parse((res.content as { text: string }[])[0]!.text);
  } finally {
    await client.close();
  }
}

async function say(token: string, body: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: { authorization: `Bearer ${token}` }, payload: { body },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function create(token: string, body: string, name = '주간 보고'): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/automations', headers: { authorization: `Bearer ${token}` },
    payload: { name, channelId, body, trigger: weekly },
  });
  expect(res.statusCode).toBe(201);
  return res.json().automation.id as string;
}

async function message(id: string) {
  return (await pool.query(`select author_id, body, meta, mention_depth from message where id = $1`, [id])).rows[0];
}

describe('automation.run (082)', () => {
  it('소유자가 부른 턴에서 돌리면 소유자 이름으로 나가고, 실행자·원인·깊이가 남는다', async () => {
    const id = await create(boss.token, `${'가'.repeat(250)} 정리`);
    const cause = await say(boss.token, '@runner 주간 보고 자동화 지금 돌려');

    const list = await tool(runner.pat, cause, 'automation.list');
    expect(list.ownerId).toBe(boss.accountId);
    const item = list.automations.find((a: { id: string }) => a.id === id);
    expect(item.bodyPreview).toHaveLength(201);
    expect(item.bodyPreview.endsWith('…')).toBe(true);

    const out = await tool(runner.pat, cause, 'automation.run', { automationId: id });
    expect(out.run).toMatchObject({ status: 'pending', triggerKind: 'manual', initiatedBy: runner.accountId, causeMessageId: cause });
    expect(out.automation).toMatchObject({ id, ownerId: boss.accountId, channelId });

    await createAutomationSweeper(pool).sweep();
    const run = (await pool.query(`select status, message_id, chain_depth from automation_run where id = $1`, [out.run.id])).rows[0];
    expect(run.status).toBe('sent');
    expect(run.chain_depth).toBe(1);
    const m = await message(run.message_id);
    expect(m.author_id).toBe(boss.accountId);
    expect(m.meta.automation).toMatchObject({ id, runId: out.run.id, trigger: 'manual', initiatedBy: runner.accountId });
    expect(m.mention_depth).toBe(1);

    // 같은 자동화를 10분 안에 또 — 거절만 하고 자동화는 켜진 채로 둔다.
    const again = await tool(runner.pat, await say(boss.token, '@runner 한 번 더'), 'automation.run', { automationId: id });
    expect(again.error.code).toBe('agent_quota');
    const a = (await pool.query(`select enabled, paused_reason from automation where id = $1`, [id])).rows[0];
    expect(a).toEqual({ enabled: true, paused_reason: null });
  });

  it('시간당 3회를 넘기면 agent_quota (10분 간격을 지켜도)', async () => {
    const id = await create(boss.token, '시간 상한');
    for (let i = 0; i < 3; i++) {
      await enqueueRun(pool, { automationId: id, eventKey: `manual:q${i}`, triggerKind: 'manual', vars: {}, initiatedBy: runner.accountId });
    }
    await pool.query(`update automation_run set created_at = now() - interval '20 minutes' where automation_id = $1`, [id]);
    const out = await tool(runner.pat, await say(boss.token, '@runner 돌려'), 'automation.run', { automationId: id });
    expect(out.error.code).toBe('agent_quota');
    // 다른 에이전트의 회차도 같은 자동화의 몫으로 센다 — 에이전트를 바꿔 가며 우회하지 못한다.
    const viaHelper = await tool(helper.pat, await say(boss.token, '@helper 돌려'), 'automation.run', { automationId: id });
    expect(viaHelper.error.code).toBe('agent_quota');
  });

  it('남이 부른 턴에서는 소유자의 자동화를 보지도 돌리지도 못한다', async () => {
    const id = await create(boss.token, '남의 것');
    const cause = await say(other.token, '@runner boss 의 자동화 돌려');
    const list = await tool(runner.pat, cause, 'automation.list');
    expect(list.automations.map((a: { id: string }) => a.id)).not.toContain(id);
    expect((await tool(runner.pat, cause, 'automation.run', { automationId: id })).error.code).toBe('not_found');
  });

  it('원인이 없거나, 나를 깨우지 않은 메시지면 no_cause', async () => {
    const id = await create(boss.token, '원인');
    expect((await tool(runner.pat, null, 'automation.run', { automationId: id })).error.code).toBe('no_cause');
    const notCalling = await say(boss.token, '그냥 혼잣말');
    expect((await tool(runner.pat, notCalling, 'automation.run', { automationId: id })).error.code).toBe('no_cause');
    // helper 를 부른 소유자 메시지를 runner 가 원인으로 대도 안 된다.
    const forHelper = await say(boss.token, '@helper 이건 너한테');
    expect((await tool(runner.pat, forHelper, 'automation.list')).error.code).toBe('no_cause');
  });

  it('에이전트가 원인이면(위임) cause_not_human', async () => {
    const id = await create(boss.token, '위임');
    const delegated = (await tool(helper.pat, await say(boss.token, '@helper 맡긴다'), 'message.post', {
      channelId, body: '@runner boss 의 자동화를 돌려 줘',
    })).message.id as string;
    expect((await tool(runner.pat, delegated, 'automation.run', { automationId: id })).error.code).toBe('cause_not_human');
  });

  it('자동화가 낸 글이 원인이면 automation_reentry — 그 턴의 발화는 깊이를 잇는다', async () => {
    const id = await create(boss.token, '@runner 주간 보고 써 줘');
    const out = await tool(runner.pat, await say(boss.token, '@runner 지금 돌려'), 'automation.run', { automationId: id });
    await createAutomationSweeper(pool).sweep();
    const posted = (await pool.query(`select message_id from automation_run where id = $1`, [out.run.id])).rows[0].message_id as string;
    const woke = await pool.query(`select 1 from inbox where message_id = $1 and account_id = $2`, [posted, runner.accountId]);
    expect(woke.rowCount).toBe(1);

    expect((await tool(runner.pat, posted, 'automation.run', { automationId: id })).error.code).toBe('automation_reentry');
    // 자동화 글(깊이 1)에 깨어난 runner 의 발화는 2 다 — 사람 글처럼 1 로 되돌아가지 않는다.
    const reply = (await tool(runner.pat, posted, 'message.post', { channelId, body: '보고 끝' })).message.id as string;
    expect((await message(reply)).mention_depth).toBe(2);
  });

  it('승인 전 제안은 not_approved', async () => {
    const cause = await say(boss.token, '@runner 제안해 둔 것 돌려');
    const proposed = await tool(runner.pat, cause, 'automation.propose', {
      name: '제안', channelId, body: 'x', trigger: weekly, forHandle: 'boss',
    });
    const out = await tool(runner.pat, cause, 'automation.run', { automationId: proposed.automation.id });
    expect(out.error.code).toBe('not_approved');
    const list = await tool(runner.pat, cause, 'automation.list');
    expect(list.automations.map((a: { id: string }) => a.id)).not.toContain(proposed.automation.id);
  });

  it('꺼진 자동화도 돌린다(사람 버튼과 같다)', async () => {
    const id = await create(boss.token, '꺼짐');
    await app.inject({ method: 'PATCH', url: `/automations/${id}`, headers: { authorization: `Bearer ${boss.token}` }, payload: { enabled: false } });
    const out = await tool(runner.pat, await say(boss.token, '@runner 꺼진 것 돌려'), 'automation.run', { automationId: id });
    expect(out.run.status).toBe('pending');
  });

  it('연쇄 상한이 1 이면 chain_capped', async () => {
    const id = await create(boss.token, '상한');
    await pool.query(`update mention_policy set chain_limit = 1 where id = true`);
    try {
      const out = await tool(runner.pat, await say(boss.token, '@runner 돌려'), 'automation.run', { automationId: id });
      expect(out.error.code).toBe('chain_capped');
    } finally {
      await pool.query(`update mention_policy set chain_limit = 8 where id = true`);
    }
  });

  it('물려받은 깊이가 상한이면 자동화 글의 에이전트 부름은 막힌다', async () => {
    const id = await create(boss.token, '@helper 받아');
    const queued = await enqueueRun(pool, {
      automationId: id, eventKey: 'manual:deep', triggerKind: 'manual', vars: {},
      initiatedBy: runner.accountId, chainDepth: 8,
    });
    expect(queued.status).toBe('queued');
    await createAutomationSweeper(pool).sweep();
    const run = (await pool.query(`select message_id from automation_run where event_key = 'manual:deep'`)).rows[0];
    const m = await message(run.message_id);
    expect(m.mention_depth).toBe(8);
    expect(m.meta.mentionChainCapped).toEqual(['helper']);
    const woke = await pool.query(`select 1 from inbox where message_id = $1 and account_id = $2`, [run.message_id, helper.accountId]);
    expect(woke.rowCount).toBe(0);
  });

  it('사람 버튼 회차는 그대로 — 실행자 없음, 깊이 0, 부름은 막히지 않는다', async () => {
    const id = await create(boss.token, '@helper 버튼');
    const res = await app.inject({ method: 'POST', url: `/automations/${id}/run`, headers: { authorization: `Bearer ${boss.token}` } });
    expect(res.statusCode).toBe(202);
    expect(res.json().run.initiatedBy).toBeNull();
    await createAutomationSweeper(pool).sweep();
    const run = (await pool.query(`select message_id from automation_run where id = $1`, [res.json().run.id])).rows[0];
    const m = await message(run.message_id);
    expect(m.mention_depth).toBe(0);
    expect(m.meta.automation.initiatedBy).toBeUndefined();
    const woke = await pool.query(`select 1 from inbox where message_id = $1 and account_id = $2`, [run.message_id, helper.accountId]);
    expect(woke.rowCount).toBe(1);
  });
});
