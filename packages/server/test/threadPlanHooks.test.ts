import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { PlanDoc } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { getThreadPlan, setThreadPlan } from '../src/services/threadPlan.js';

/**
 * 계획판 P6 서버-2 — `message.report` 의 `planStepId`, `message.delegate` 의 `planRootId`·`planGroupId`.
 *
 * 1. report planStepId → 그 스레드 계획의 그 단계만 done. 이미 done 이면 unchanged(rev 그대로). 없는 단계면 plan.error, 보고는 선다.
 * 2. 보안: 부른 계정이 계획의 스레드를 못 보면 계획은 그대로다(보고 스레드든 위임의 부모 계획이든).
 * 3. delegate → 부모 계획의 그룹 linkedRootId = 위임 스레드. 자기 스레드·이미 다른 곳에 이어진 그룹·단계 가진 그룹은 막는다.
 */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let leadPat: string;
let leadId: string;
let onePat: string;
let publicCh: string;
let privateCh: string;
let mcpUrl: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = async (channelId: string, body: Record<string, unknown>) =>
  (await app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken), payload: body })).json().id as string;

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: auth(token) } }));
  return client;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (c: Client, name: string, args: Record<string, unknown>): Promise<any> => {
  const r = await c.callTool({ name, arguments: args });
  const t = (r.content as { type: string; text: string }[])[0]!.text;
  if (r.isError) return { isError: true, text: t };
  return JSON.parse(t);
};

const stepsDoc = (): PlanDoc => ({
  goal: '배포',
  groups: [],
  steps: [
    { id: 's1', title: '리뷰', state: 'active', links: [], dependsOn: [] },
    { id: 's2', title: '배포', state: 'pending', links: [], dependsOn: ['s1'] },
  ],
});
const groupDoc = (): PlanDoc => ({
  goal: '나눠서',
  groups: [{ id: 'g1', title: '서버', dependsOn: [] }, { id: 'g2', title: '화면', dependsOn: [] }],
  steps: [{ id: 's1', groupId: 'g2', title: '시안', state: 'pending', links: [], dependsOn: [] }],
});
const report = (channelId: string, threadRootId: string | undefined, planStepId: string) =>
  ({ channelId, ...(threadRootId ? { threadRootId } : {}), body: '끝', checks: ['시험 통과'], planStepId });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ pat: leadPat, accountId: leadId } = await createAgent(app, adminToken, 'hlead'));
  const one = await createAgent(app, adminToken, 'hone');
  onePat = one.pat;
  const team = (await app.inject({ method: 'POST', url: '/teams', headers: auth(adminToken), payload: { name: 'hookteam' } })).json().id as string;
  for (const accountId of [leadId, one.accountId]) {
    await app.inject({ method: 'PUT', url: `/teams/${team}/members/${accountId}`, headers: auth(adminToken) });
  }
  await app.inject({ method: 'PUT', url: `/teams/${team}/lead`, headers: auth(adminToken), payload: { accountId: leadId } });
  publicCh = (await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'plan-hooks' } })).json().id;
  privateCh = (await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'plan-hooks-priv', visibility: 'private' },
  })).json().id;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});
afterAll(async () => { await app.close(); await stop(); });

describe('message.report planStepId', () => {
  it('그 단계만 done · 다시 주면 unchanged · 없는 단계면 plan.error 이고 보고는 선다', async () => {
    const c = await mcpClient(leadPat);
    const root = await post(publicCh, { body: 'report root' });
    await setThreadPlan(pool, { rootId: root, doc: stepsDoc(), actor: { accountId: adminId } });

    const r1 = await call(c, 'message.report', report(publicCh, root, 's1'));
    expect(r1.message?.id).toBeTruthy();
    expect(r1.plan).toEqual({ ok: true, rev: 2 });
    const row = await getThreadPlan(pool, root);
    expect(row?.doc.steps.map((s) => s.state)).toEqual(['done', 'pending']);
    expect(row?.updatedBy).toBe(leadId);

    const r2 = await call(c, 'message.report', report(publicCh, root, 's1'));
    expect(r2.plan).toEqual({ ok: true, unchanged: true });
    expect((await getThreadPlan(pool, root))?.rev).toBe(2);

    const r3 = await call(c, 'message.report', report(publicCh, root, 's9'));
    expect(r3.message?.id).toBeTruthy();
    expect(r3.plan).toMatchObject({ ok: false, error: { code: 'unknown_item', id: 's9' } });

    const noPlanRoot = await post(publicCh, { body: 'no plan' });
    expect((await call(c, 'message.report', report(publicCh, noPlanRoot, 's1'))).plan.error.code).toBe('no_plan');
    await c.close();
  });

  it('threadRootId 없이 planStepId 만 주면 보고 전에 거절한다', async () => {
    const c = await mcpClient(leadPat);
    const r = await call(c, 'message.report', report(publicCh, undefined, 's1'));
    expect(r.error?.code).toBe('bad_request');
    await c.close();
  });

  it('보안: 못 보는 채널의 스레드를 보고 채널만 바꿔 가리켜도 보고·계획 모두 막힌다', async () => {
    const c = await mcpClient(leadPat);
    const secret = await post(privateCh, { body: 'secret' });
    await setThreadPlan(pool, { rootId: secret, doc: stepsDoc(), actor: { accountId: adminId } });
    const r = await call(c, 'message.report', report(publicCh, secret, 's1'));
    // 첫 겹: 게시 경로가 그 채널의 스레드가 아니라고 막는다. 둘째 겹(writeThreadPlan 의 부른 계정 확인)은 위임 시험이 본다.
    expect(r.error?.code).toBe('bad_thread');
    const row = await getThreadPlan(pool, secret);
    expect(row?.rev).toBe(1);
    expect(row?.doc.steps[0]!.state).toBe('active');
    await c.close();
  });
});

describe('message.delegate planGroupId', () => {
  it('부모 계획의 그룹을 위임 스레드에 잇는다 · 같은 스레드면 unchanged', async () => {
    const lead = await mcpClient(leadPat);
    const one = await mcpClient(onePat); // 팀원 presence
    const parent = await post(publicCh, { body: 'parent' });
    await setThreadPlan(pool, { rootId: parent, doc: groupDoc(), actor: { accountId: adminId } });
    const child = await post(publicCh, { body: 'child' });

    const d = await call(lead, 'message.delegate', {
      channelId: publicCh, threadRootId: child, body: '서버 맡아라', to: ['hone'], planRootId: parent, planGroupId: 'g1',
    });
    expect(d.delegated).toEqual(['hone']);
    expect(d.plan).toEqual({ ok: true, rev: 2 });
    const row = await getThreadPlan(pool, parent);
    expect(row?.doc.groups.find((g) => g.id === 'g1')?.linkedRootId).toBe(child);
    expect((await pool.query(`select child_root from thread_plan_link where parent_root = $1`, [parent])).rows.map((x) => x.child_root)).toEqual([child]);

    const again = await call(lead, 'message.delegate', {
      channelId: publicCh, threadRootId: child, body: '다시', to: ['hone'], planRootId: parent, planGroupId: 'g1',
    });
    expect(again.plan).toEqual({ ok: true, unchanged: true });

    const other = await post(publicCh, { body: 'other child' });
    const moved = await call(lead, 'message.delegate', {
      channelId: publicCh, threadRootId: other, body: '딴 데', to: ['hone'], planRootId: parent, planGroupId: 'g1',
    });
    expect(moved.plan).toMatchObject({ ok: false, error: { code: 'group_already_linked', id: 'g1' } });
    expect((await getThreadPlan(pool, parent))?.doc.groups[0]!.linkedRootId).toBe(child);

    const withSteps = await call(lead, 'message.delegate', {
      channelId: publicCh, threadRootId: other, body: '화면', to: ['hone'], planRootId: parent, planGroupId: 'g2',
    });
    expect(withSteps.plan).toMatchObject({ ok: false, error: { code: 'linked_group_has_steps' } });
    await one.close();
    await lead.close();
  });

  it('보안: 부른 계정이 부모 계획의 스레드를 못 보면 forbidden 이고 계획은 그대로다', async () => {
    const lead = await mcpClient(leadPat);
    const one = await mcpClient(onePat);
    const parent = await post(privateCh, { body: 'secret parent' });
    await setThreadPlan(pool, { rootId: parent, doc: groupDoc(), actor: { accountId: adminId } });
    const child = await post(publicCh, { body: 'child' });
    const d = await call(lead, 'message.delegate', {
      channelId: publicCh, threadRootId: child, body: '맡아라', to: ['hone'], planRootId: parent, planGroupId: 'g1',
    });
    expect(d.plan).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    const row = await getThreadPlan(pool, parent);
    expect(row?.rev).toBe(1);
    expect(row?.doc.groups[0]!.linkedRootId).toBeUndefined();
    await one.close();
    await lead.close();
  });

  it('인자 짝이 안 맞거나 자기 스레드를 가리키면 위임 전에 거절한다', async () => {
    const lead = await mcpClient(leadPat);
    const child = await post(publicCh, { body: 'self' });
    const half = await call(lead, 'message.delegate', { channelId: publicCh, threadRootId: child, body: 'x', to: ['hone'], planGroupId: 'g1' });
    expect(half.error?.code).toBe('bad_request');
    const self = await call(lead, 'message.delegate', {
      channelId: publicCh, threadRootId: child, body: 'x', to: ['hone'], planRootId: child, planGroupId: 'g1',
    });
    expect(self.error?.code).toBe('self_link');
    expect((await pool.query(`select 1 from message where thread_root_id = $1`, [child])).rowCount).toBe(0);
    await lead.close();
  });
});
