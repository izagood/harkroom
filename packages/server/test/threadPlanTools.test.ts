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
 * 계획판 도구(P2) — `thread.plan`·`thread.plan.item`.
 *
 * 1. 읽기·새로 세우기·guard 필수·항목 더하기/고치기, 응답의 nowReady·nowWaiting.
 * 2. S1: 답글 id 는 not_root, 못 보는 채널은 읽기·쓰기 모두 forbidden(서비스가 rootId 에서 채널을 뽑는다).
 * 3. N4: 모르는 키는 버리고 저장한다. 틀린 state 는 스키마가 막는다.
 * 4. S3 회귀: 못 보는 자식에 연결된 계획을 고쳐도 응답(nowReady·derived)은 부른 계정 기준이라 자식 완료가 새지 않는다.
 * 5. 병렬 턴: 서로 다른 단계를 고치는 item 둘이 다 들어간다.
 */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let admin: { token: string; accountId: string };
let bot: { accountId: string; pat: string };
let publicCh: string;
let privateCh: string;
let mcpUrl: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = async (token: string, channelId: string, body: Record<string, unknown>) =>
  (await app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: body })).json().id as string;

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

const base = (): PlanDoc => ({
  goal: '배포',
  groups: [],
  steps: [
    { id: 's1', title: '리뷰', state: 'active', links: [], dependsOn: [] },
    { id: 's2', title: '배포', state: 'pending', links: [], dependsOn: ['s1'] },
  ],
});

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  admin = await bootstrapAdmin(app);
  bot = await createAgent(app, admin.token, 'planbot');
  publicCh = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'plan-tools' } })).json().id;
  privateCh = (await app.inject({
    method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'plan-tools-priv', visibility: 'private' },
  })).json().id;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});
afterAll(async () => { await app.close(); await stop(); });

describe('thread.plan tools', () => {
  it('읽기 → 세우기 → guard 필수 → item 으로 더하고 고치면 nowReady·nowWaiting 이 온다', async () => {
    const c = await mcpClient(bot.pat);
    const root = await post(admin.token, publicCh, { body: 'plan root' });
    expect(await call(c, 'thread.plan', { threadRootId: root })).toEqual({ plan: null });

    const first = await call(c, 'thread.plan', { threadRootId: root, plan: base(), ifUpdatedAt: null });
    expect(first).toMatchObject({ ok: true, rev: 1, nowReady: [], nowWaiting: ['s2'], progress: { done: 0, total: 2, active: 1 } });

    const noGuard = await call(c, 'thread.plan', { threadRootId: root, plan: base() });
    expect(noGuard.error).toMatchObject({ code: 'guard_required', rev: 1 });

    const added = await call(c, 'thread.plan.item', { threadRootId: root, title: '공지', dependsOn: ['s2'] });
    expect(added).toMatchObject({ ok: true, rev: 2, id: 's3', nowWaiting: ['s3'] });

    const done = await call(c, 'thread.plan.item', { threadRootId: root, id: 's1', state: 'done', ifRev: 2 });
    expect(done).toMatchObject({ ok: true, rev: 3, nowReady: ['s2'], nowWaiting: [] });

    const stale = await call(c, 'thread.plan.item', { threadRootId: root, id: 's2', state: 'active', ifRev: 2 });
    expect(stale.error).toMatchObject({ code: 'rev_conflict', rev: 3 });

    const cycle = await call(c, 'thread.plan.item', { threadRootId: root, id: 's1', addDependsOn: ['s3'] });
    expect(cycle.error).toMatchObject({ code: 'dependency_cycle' });

    const group = await call(c, 'thread.plan.item', { threadRootId: root, type: 'group', title: '묶음', state: 'done' });
    expect(group.error).toMatchObject({ code: 'field_not_for_type', field: 'state' });

    const read = await call(c, 'thread.plan', { threadRootId: root });
    expect(read.plan).toMatchObject({ rev: 3, updatedBy: bot.accountId, derived: { s1: { derived: 'done' }, s2: { derived: 'ready' }, s3: { derived: 'waiting', waitingOn: ['s2'] } } });
    await c.close();
  });

  it('S1: 답글 id 는 not_root, 못 보는 채널은 읽기·쓰기·item 모두 forbidden', async () => {
    const c = await mcpClient(bot.pat);
    const root = await post(admin.token, publicCh, { body: 'r' });
    const reply = await post(admin.token, publicCh, { body: 'reply', threadRootId: root });
    expect((await call(c, 'thread.plan', { threadRootId: reply })).error.code).toBe('not_root');
    expect((await call(c, 'thread.plan', { threadRootId: reply, plan: base(), ifUpdatedAt: null })).error.code).toBe('not_root');

    const secret = await post(admin.token, privateCh, { body: 'secret' });
    await setThreadPlan(pool, { rootId: secret, doc: base(), actor: { accountId: admin.accountId } });
    expect((await call(c, 'thread.plan', { threadRootId: secret })).error.code).toBe('forbidden');
    expect((await call(c, 'thread.plan', { threadRootId: secret, plan: null, ifUpdatedAt: null })).error.code).toBe('forbidden');
    expect((await call(c, 'thread.plan.item', { threadRootId: secret, id: 's1', state: 'done' })).error.code).toBe('forbidden');
    expect((await getThreadPlan(pool, secret))?.rev).toBe(1);
    await c.close();
  });

  it('N4: 모르는 키는 버리고 저장한다 · 틀린 state 는 스키마가 막는다', async () => {
    const c = await mcpClient(bot.pat);
    const root = await post(admin.token, publicCh, { body: 'strip' });
    const doc = { ...base(), evil: 'x', steps: base().steps.map((s) => ({ ...s, injected: { a: 1 } })) };
    expect(await call(c, 'thread.plan', { threadRootId: root, plan: doc, ifUpdatedAt: null })).toMatchObject({ ok: true });
    const row = await getThreadPlan(pool, root);
    expect(row?.doc).not.toHaveProperty('evil');
    expect(row?.doc.steps[0]).not.toHaveProperty('injected');

    const bad = await call(c, 'thread.plan.item', { threadRootId: root, id: 's1', state: 'finished' });
    expect(bad.isError).toBe(true);
    await c.close();
  });

  it('S3 회귀: 못 보는 자식에 연결된 계획을 고쳐도 응답은 부른 계정 기준이다', async () => {
    const parent = await post(admin.token, publicCh, { body: 'parent' });
    const child = await post(admin.token, privateCh, { body: 'child' });
    const doneDoc: PlanDoc = { goal: 'c', groups: [], steps: [{ id: 's1', title: 'x', state: 'done', links: [], dependsOn: [] }] };
    await setThreadPlan(pool, { rootId: child, doc: doneDoc, actor: { accountId: admin.accountId } });
    await setThreadPlan(pool, {
      rootId: parent, actor: { accountId: admin.accountId },
      doc: {
        goal: 'A', groups: [{ id: 'g1', title: 'B', linkedRootId: child, dependsOn: [] }],
        steps: [
          { id: 's1', title: 'A 준비', state: 'pending', links: [], dependsOn: [] },
          { id: 's2', title: 'A 마무리', state: 'pending', links: [], dependsOn: ['g1'] },
        ],
      },
    });
    const c = await mcpClient(bot.pat);
    // 남이 건 비공개 연결이 있어도 다른 단계는 고칠 수 있다(R1) — 그리고 자식이 끝났어도 s2 는 ready 로 오지 않는다.
    const res = await call(c, 'thread.plan.item', { threadRootId: parent, id: 's1', state: 'active' });
    expect(res).toMatchObject({ ok: true, rev: 2 });
    expect(res.nowReady).not.toContain('s2');
    const read = await call(c, 'thread.plan', { threadRootId: parent });
    expect(read.plan.derived.g1.derived).toBe('hidden');
    expect(read.plan.derived.s2).toMatchObject({ derived: 'waiting', waitingOn: ['g1'] });
    expect(read.plan.linked).toEqual([{ groupId: 'g1', rootId: child, hidden: true, channelId: null, progress: null }]);
    // 못 보는 스레드를 새로 연결하는 것은 막힌다.
    const link = await call(c, 'thread.plan.item', { threadRootId: parent, type: 'group', title: 'C', linkedRootId: child });
    expect(link).toMatchObject({ ok: true });
    const other = await post(admin.token, privateCh, { body: 'child-2' });
    const linkNew = await call(c, 'thread.plan.item', { threadRootId: parent, type: 'group', title: 'D', linkedRootId: other });
    expect(linkNew.error).toMatchObject({ code: 'linked_thread_unavailable', id: other });
    await c.close();
  });

  it('병렬 턴: 서로 다른 단계를 고치는 item 둘이 다 들어간다', async () => {
    const root = await post(admin.token, publicCh, { body: 'parallel' });
    const c1 = await mcpClient(bot.pat);
    const c2 = await mcpClient(bot.pat);
    await call(c1, 'thread.plan', { threadRootId: root, plan: base(), ifUpdatedAt: null });
    const [a, b] = await Promise.all([
      call(c1, 'thread.plan.item', { threadRootId: root, id: 's1', state: 'done' }),
      call(c2, 'thread.plan.item', { threadRootId: root, id: 's2', title: '배포(운영)' }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const row = await getThreadPlan(pool, root);
    expect(row?.rev).toBe(3);
    expect(row?.doc.steps.map((s) => [s.state, s.title])).toEqual([['done', '리뷰'], ['pending', '배포(운영)']]);
    await c1.close();
    await c2.close();
  });
});
