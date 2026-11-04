import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { PlanDoc } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { getThreadPlan, setThreadPlan, threadPlanView, writeThreadPlan } from '../src/services/threadPlan.js';
import { clearPlanAuto, setPlanAuto } from '../src/services/threadPlanAuto.js';
import { issueTurnLease } from '../src/services/secretAccess.js';

/**
 * 계획판 자동 진행 — 켜기·끄기(G-2a).
 * 켜는 근거는 이 스레드의 사람 글이고, 그 글이 지금 이 에이전트 턴의 원인이어야 한다. 에이전트 혼자 켜지 못한다.
 */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let admin: { token: string; accountId: string };
let member: { token: string; accountId: string };
let manager: { accountId: string; pat: string };
let other: { accountId: string; pat: string };
let op: { operatorId: string };
let ch: string;
let mcpUrl: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = async (token: string, body: Record<string, unknown>, channel = ch) =>
  (await app.inject({ method: 'POST', url: `/channels/${channel}/messages`, headers: auth(token), payload: body })).json().id as string;
const step = (id: string): PlanDoc['steps'][number] => ({ id, title: `단계 ${id}`, state: 'pending', links: [], dependsOn: [] });

async function plan(managerId = manager.accountId): Promise<string> {
  const root = await post(member.token, { body: 'root' });
  const res = await setThreadPlan(pool, { rootId: root, actor: { accountId: member.accountId }, doc: { goal: 'g', groups: [], steps: [step('s1'), step('s2')], managerId } });
  expect(res.ok).toBe(true);
  return root;
}
/** 사람이 @manager 를 불러 임대를 받은 글. */
async function called(root: string, by = member.token, agentHandle = 'mgr', agentId = manager.accountId): Promise<string> {
  const id = await post(by, { body: `@${agentHandle} s2까지 진행해`, threadRootId: root });
  const issued = await issueTurnLease(pool, { agentId, operatorId: op.operatorId, causeMessageId: id });
  expect(issued.ok).toBe(true);
  return id;
}
const auto = (root: string, sourceMessageId: string, agentId = manager.accountId, until = 's2') =>
  setPlanAuto(pool, { rootId: root, agentId, until, sourceMessageId });
const codeOf = (r: Awaited<ReturnType<typeof auto>>) => (r.ok ? 'ok' : r.error.code);
const systemLines = async (root: string) => (await pool.query<{ meta: Record<string, unknown>; body: string }>(
  `select meta, body from message where thread_root_id = $1 and kind = 'system' and meta ? 'planAutoState' order by seq`, [root])).rows;

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  app = await buildServer({ pool });
  const addr = await app.listen({ host: '127.0.0.1', port: 0 });
  mcpUrl = `${addr}/mcp`;
  admin = await bootstrapAdmin(app);
  member = await createMember(app, admin.token, 'alice');
  manager = await createAgent(app, admin.token, 'mgr');
  other = await createAgent(app, admin.token, 'other');
  op = await registerOperator(app, admin.token, 'mac');
  for (const a of [manager.accountId, other.accountId]) {
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [a, op.operatorId, admin.accountId]);
  }
  ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'room' } })).json().channel?.id
    ?? (await pool.query<{ id: string }>(`select id from channel where name = 'room'`)).rows[0]!.id;
});
afterAll(async () => { await app.close(); await stop(); });

describe('켜기', () => {
  it('자기를 부른 사람 글을 근거로 관리 에이전트가 켠다. 판·이벤트·시스템 줄에 남고 그 줄은 아무도 부르지 않는다', async () => {
    const root = await plan();
    const source = await called(root);
    const r = await auto(root, source);
    expect(r.ok).toBe(true);
    const row = await getThreadPlan(pool, root);
    expect(row!.auto).toMatchObject({ until: 's2', sourceMessageId: source, by: member.accountId });
    expect((await threadPlanView(pool, row!, member.accountId)).auto?.until).toBe('s2');
    const [line] = await systemLines(root);
    expect(line!.meta.planAutoState).toMatchObject({ on: true, until: 's2', sourceMessageId: source, by: member.accountId });
    expect(line!.body).toContain(`harkroom://message/${source}`);
    const inbox = await pool.query<{ account_id: string; reason: string }>(`select i.account_id, i.reason from inbox i join message m on m.id = i.message_id where m.thread_root_id = $1 and m.kind = 'system'`, [root]);
    // 머리 주인에게 가는 thread_reply 는 부름이 아니다. 관리 에이전트를 부르지 않는다.
    expect(inbox.rows.filter((r) => r.reason !== 'thread_reply')).toEqual([]);
    expect(inbox.rows.some((r) => r.account_id === manager.accountId)).toBe(false);
  });

  it('근거가 이 턴의 원인 글이 아니면 거절한다 — 다른 사람 글을 고를 수 없다', async () => {
    const root = await plan();
    const notCalled = await post(member.token, { body: '그냥 한 말', threadRootId: root });
    expect(codeOf(await auto(root, notCalled))).toBe('source_not_cause');
    expect((await getThreadPlan(pool, root))!.auto).toBeNull();
  });

  it('끝난 턴의 임대로는 켜지 못한다', async () => {
    const root = await plan();
    const source = await called(root);
    await pool.query(`update secret_turn_lease set ended_at = now() where cause_message_id = $1`, [source]);
    expect(codeOf(await auto(root, source))).toBe('source_not_cause');
  });

  it('다른 에이전트가 부름 받은 임대로는 켜지 못한다', async () => {
    const root = await plan();
    const source = await called(root, member.token, 'other', other.accountId);
    expect(codeOf(await auto(root, source))).toBe('source_not_cause');
  });

  it('관리 에이전트가 아니면 거절한다', async () => {
    const root = await plan();
    const source = await called(root, member.token, 'other', other.accountId);
    expect(codeOf(await auto(root, source, other.accountId))).toBe('not_manager');
  });

  it('다른 스레드 글·에이전트 글·자동화 글은 근거가 되지 못한다', async () => {
    const root = await plan();
    const elsewhere = await called(await plan());
    expect(codeOf(await auto(root, elsewhere))).toBe('invalid_source');
    const own = await called(root);
    await pool.query(`update message set meta = meta || '{"automation":{"id":"x"}}'::jsonb where id = $1`, [own]);
    expect(codeOf(await auto(root, own))).toBe('invalid_source');
    const byAgent = await called(root);
    await pool.query(`update message set author_id = $2 where id = $1`, [byAgent, other.accountId]);
    expect(codeOf(await auto(root, byAgent))).toBe('invalid_source');
    const deleted = await called(root);
    await pool.query(`update message set deleted_at = now() where id = $1`, [deleted]);
    expect(codeOf(await auto(root, deleted))).toBe('invalid_source');
  });

  it('같은 근거로 두 번 켜지 못한다 — 끈 뒤에도', async () => {
    const root = await plan();
    const source = await called(root);
    expect(codeOf(await auto(root, source))).toBe('ok');
    expect(codeOf(await auto(root, source))).toBe('source_used');
    await clearPlanAuto(pool, { rootId: root, actor: { kind: 'human', accountId: member.accountId } });
    expect(codeOf(await auto(root, source))).toBe('source_used');
  });

  it('없는 끝점·걸린 판·계획 없음은 거절한다', async () => {
    const root = await plan();
    const source = await called(root);
    expect(codeOf(await auto(root, source, manager.accountId, 's99'))).toBe('unknown_until');
    await pool.query(`update thread_plan set flag_reason = 'x' where root_id = $1`, [root]);
    expect(codeOf(await auto(root, source))).toBe('flagged');
    const none = await post(member.token, { body: 'no plan' });
    expect(codeOf(await auto(none, source))).toBe('no_plan');
  });

  it('근거 사람이 그 채널을 못 보면 거절한다', async () => {
    const root = await plan();
    const source = await called(root);
    await pool.query(`update channel set visibility = 'private' where id = $1`, [ch]).catch(() => undefined);
    await pool.query(`delete from channel_member where channel_id = $1 and account_id = $2`, [ch, member.accountId]).catch(() => undefined);
    const r = codeOf(await auto(root, source));
    await pool.query(`update channel set visibility = 'public' where id = $1`, [ch]).catch(() => undefined);
    await pool.query(`insert into channel_member (channel_id, account_id) values ($1, $2) on conflict do nothing`, [ch, member.accountId]).catch(() => undefined);
    expect(r).toBe('source_hidden');
  });

  it('doc 쓰기로는 자동 진행을 바꿀 수 없다', async () => {
    const root = await plan();
    const before = await getThreadPlan(pool, root);
    const res = await writeThreadPlan(pool, root, { accountId: manager.accountId }, (prev) => ({
      doc: { ...prev!.doc, goal: 'g2', auto: { until: 's2' } } as unknown as PlanDoc,
    }));
    expect(res.ok).toBe(true);
    const after = await getThreadPlan(pool, root);
    expect(after!.auto).toBeNull();
    expect(after!.rev).toBe(before!.rev + 1);
  });

  it('판을 고쳐도 켜진 자동 진행은 그대로다', async () => {
    const root = await plan();
    await auto(root, await called(root));
    await writeThreadPlan(pool, root, { accountId: manager.accountId }, (prev) => ({ doc: { ...prev!.doc, goal: 'g3' } }));
    expect((await getThreadPlan(pool, root))!.auto?.until).toBe('s2');
  });
});

describe('도구(thread.plan.item)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (args: Record<string, unknown>): Promise<any> => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: auth(manager.pat) } }));
    const r = await client.callTool({ name: 'thread.plan.item', arguments: args });
    await client.close();
    return JSON.parse((r.content as { text: string }[])[0]!.text);
  };

  it('auto 를 적어 켜고 null 로 끈다. 다른 칸과 함께 쓰면 거절한다. doc 에는 남지 않는다', async () => {
    const root = await plan();
    const source = await called(root);
    expect((await call({ threadRootId: root, type: 'plan', title: 'x', auto: { until: 's2', sourceMessageId: source } })).error.code).toBe('auto_alone');
    expect((await call({ threadRootId: root, auto: { until: 's2', sourceMessageId: source } })).error.code).toBe('auto_alone');
    const on = await call({ threadRootId: root, type: 'plan', auto: { until: 's2', sourceMessageId: source } });
    expect(on.auto.until).toBe('s2');
    const row = await getThreadPlan(pool, root);
    expect(JSON.stringify(row!.doc)).not.toContain('auto');
    const off = await call({ threadRootId: root, type: 'plan', auto: null });
    expect(off).toMatchObject({ ok: true, auto: null, changed: true });
  });

  it('임대 없는 글로는 도구로도 켜지 못한다', async () => {
    const root = await plan();
    const free = await post(member.token, { body: '그냥 한 말', threadRootId: root });
    expect((await call({ threadRootId: root, type: 'plan', auto: { until: 's2', sourceMessageId: free } })).error.code).toBe('source_not_cause');
  });
});

describe('끄기', () => {
  it('사람은 DELETE 로 끈다. 꺼진 줄을 남긴다. 꺼져 있으면 줄을 더 쓰지 않는다', async () => {
    const root = await plan();
    await auto(root, await called(root));
    const res = await app.inject({ method: 'DELETE', url: `/threads/${root}/plan/auto`, headers: auth(member.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().plan.auto).toBeNull();
    const lines = await systemLines(root);
    expect(lines.at(-1)!.meta.planAutoState).toMatchObject({ on: false, reason: 'human' });
    const again = await app.inject({ method: 'DELETE', url: `/threads/${root}/plan/auto`, headers: auth(member.token) });
    expect(again.statusCode).toBe(200);
    expect(await systemLines(root)).toHaveLength(lines.length);
  });

  it('에이전트 PAT 은 DELETE 를 못 쓴다', async () => {
    const root = await plan();
    const res = await app.inject({ method: 'DELETE', url: `/threads/${root}/plan/auto`, headers: auth(manager.pat) });
    expect(res.statusCode).toBe(403);
  });

  it('관리 에이전트는 끌 수 있고 다른 에이전트는 못 끈다', async () => {
    const root = await plan();
    await auto(root, await called(root));
    const denied = await clearPlanAuto(pool, { rootId: root, actor: { kind: 'manager', accountId: other.accountId } });
    expect(denied.ok).toBe(false);
    expect((await getThreadPlan(pool, root))!.auto).not.toBeNull();
    const ok = await clearPlanAuto(pool, { rootId: root, actor: { kind: 'manager', accountId: manager.accountId } });
    expect(ok.ok && ok.changed).toBe(true);
    expect((await systemLines(root)).at(-1)!.meta.planAutoState).toMatchObject({ on: false, reason: 'manager' });
  });
});
