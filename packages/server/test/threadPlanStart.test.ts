import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { PlanDoc } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { getThreadPlan, setThreadPlan } from '../src/services/threadPlan.js';

/** 시작 글을 한 번 실패시키는 스위치. 되돌리기 시험만 켠다. */
const failNext = vi.hoisted(() => ({ on: false }));
vi.mock('../src/services/messages.js', async (orig) => {
  const real = await orig<typeof import('../src/services/messages.js')>();
  return {
    ...real,
    postMessage: async (...args: Parameters<typeof real.postMessage>) => {
      if (failNext.on && args[1].idempotencyKey?.startsWith('plan-start:')) {
        failNext.on = false;
        throw new Error('forced');
      }
      return real.postMessage(...args);
    },
  };
});

/**
 * 계획판 「시작」과 관리 에이전트(`POST /threads/:root/plan/start`·`PUT …/plan/manager`).
 *
 * 1. 사람 세션만 누른다. 상태는 잠금 안에서 ready→active, 두 번 눌러도 한 번만 불린다.
 * 2. 담당 에이전트를 직접 부르고 글을 links 에 단다. 담당 없음·다른 사람·자기 담당은 갈린다.
 * 3. 단계 제목은 에이전트가 쓴 글이다 — 사람 이름의 글에서 아무도 부르지 않는다. 걸린 판은 시작하지 않는다.
 * 4. managerId: 처음 세운 에이전트가 기본, 칸을 모르는 쓰기가 지우지 않는다, 에이전트만 된다.
 * 5. 관리 에이전트가 있으면 그 하나만 부른다. 못 부르면 사유를 싣고 담당을 직접 부른다.
 */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let admin: { token: string; accountId: string };
let member: { token: string; accountId: string };
let other: { token: string; accountId: string };
let worker: { accountId: string; pat: string };
let bystander: { accountId: string; pat: string };
let manager: { accountId: string; pat: string };
let ch: string;
let mcpUrl: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = async (token: string, body: Record<string, unknown>) =>
  (await app.inject({ method: 'POST', url: `/channels/${ch}/messages`, headers: auth(token), payload: body })).json().id as string;
const start = (token: string, root: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/threads/${root}/plan/start`, headers: auth(token), payload });
const inboxOf = async (messageId: string) =>
  (await pool.query<{ account_id: string }>(`select account_id from inbox where message_id = $1`, [messageId])).rows.map((r) => r.account_id);
const repliesOf = async (root: string) =>
  (await pool.query<{ id: string; body: string; author_id: string }>(
    `select id, body, author_id from message where thread_root_id = $1 order by seq`, [root])).rows;

const step = (id: string, over: Partial<PlanDoc['steps'][number]> = {}): PlanDoc['steps'][number] => ({
  id, title: `단계 ${id}`, state: 'pending', links: [], dependsOn: [], ...over,
});
/** 사람이 세운 판(관리 에이전트 없음). */
async function humanPlan(steps: PlanDoc['steps'], over: Partial<PlanDoc> = {}): Promise<string> {
  const root = await post(member.token, { body: 'root' });
  const res = await setThreadPlan(pool, { rootId: root, actor: { accountId: member.accountId }, doc: { goal: 'g', groups: [], steps, ...over } });
  expect(res.ok).toBe(true);
  return root;
}

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: auth(token) } }));
  return client;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (c: Client, name: string, args: Record<string, unknown>): Promise<any> => {
  const r = await c.callTool({ name, arguments: args });
  return JSON.parse((r.content as { type: string; text: string }[])[0]!.text);
};

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  admin = await bootstrapAdmin(app);
  member = await createMember(app, admin.token, 'mina');
  other = await createMember(app, admin.token, 'noah');
  worker = await createAgent(app, admin.token, 'worker');
  bystander = await createAgent(app, admin.token, 'bystander');
  manager = await createAgent(app, admin.token, 'lead');
  ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'plan-start' } })).json().id as string;
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  mcpUrl = `${address}/mcp`;
});

afterAll(async () => {
  await app.close();
  await stop();
});

describe('시작 — 담당 직접 부르기', () => {
  it('사람 세션만 누른다', async () => {
    const root = await humanPlan([step('s1', { assigneeId: worker.accountId })]);
    expect((await start(worker.pat, root, { steps: [{ id: 's1' }] })).statusCode).toBe(403);
    expect((await getThreadPlan(pool, root))?.doc.steps[0]?.state).toBe('pending');
  });

  it('active 로 바꾸고 담당을 부른 글을 links 에 단다. 두 번 눌러도 한 번만 불린다', async () => {
    const root = await humanPlan([step('s1', { assigneeId: worker.accountId })]);
    const res = await start(member.token, root, { steps: [{ id: 's1' }] });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.started).toEqual([{ id: 's1', via: 'assignee', to: worker.accountId, messageId: expect.any(String) }]);
    expect(json.plan.doc.steps[0].state).toBe('active');
    expect(json.plan.doc.steps[0].links).toEqual([{ kind: 'message', id: json.started[0].messageId }]);
    expect(await inboxOf(json.started[0].messageId)).toContain(worker.accountId);
    const replies = await repliesOf(root);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.author_id).toBe(member.accountId);

    const again = await start(member.token, root, { steps: [{ id: 's1' }] });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_started');
    expect(await repliesOf(root)).toHaveLength(1);
  });

  it('앞 단계를 기다리는 단계는 시작할 수 없다', async () => {
    const root = await humanPlan([step('s1', { assigneeId: worker.accountId }), step('s2', { assigneeId: worker.accountId, dependsOn: ['s1'] })]);
    const res = await start(member.token, root, { steps: [{ id: 's2' }] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_ready');
  });

  it('담당 없음은 골라야 하고, 고르면 담당으로 적는다. 사람은 고를 수 없다', async () => {
    const root = await humanPlan([step('s1')]);
    expect((await start(member.token, root, { steps: [{ id: 's1' }] })).json().error.code).toBe('no_assignee');
    expect((await start(member.token, root, { steps: [{ id: 's1', assigneeId: other.accountId }] })).json().error.code).toBe('invalid_assignee');
    const res = await start(member.token, root, { steps: [{ id: 's1', assigneeId: worker.accountId }] });
    expect(res.statusCode).toBe(200);
    expect(res.json().plan.doc.steps[0]).toMatchObject({ state: 'active', assigneeId: worker.accountId });
  });

  it('담당이 다른 사람이면 시작할 수 없고, 자기 담당은 글 없이 active 다', async () => {
    const root = await humanPlan([step('s1', { assigneeId: other.accountId }), step('s2', { assigneeId: member.accountId })]);
    expect((await start(member.token, root, { steps: [{ id: 's1' }] })).json().error.code).toBe('other_human_assignee');
    const mine = await start(member.token, root, { steps: [{ id: 's2' }] });
    expect(mine.json().started).toEqual([{ id: 's2', via: 'self', to: null, messageId: null }]);
    expect(await repliesOf(root)).toHaveLength(0);
  });

  it('모두 시작은 에이전트마다 글 하나이고, 안 되는 단계만 빠진다', async () => {
    const root = await humanPlan([
      step('s1', { assigneeId: worker.accountId }), step('s2', { assigneeId: worker.accountId }),
      step('s3', { assigneeId: bystander.accountId }), step('s4'),
    ]);
    const json = (await start(member.token, root, { steps: ['s1', 's2', 's3', 's4'].map((id) => ({ id })) })).json();
    expect(json.started.map((s: { id: string }) => s.id).sort()).toEqual(['s1', 's2', 's3']);
    expect(json.skipped).toEqual([{ id: 's4', code: 'no_assignee' }]);
    expect(await repliesOf(root)).toHaveLength(2);
  });

  it('그룹 담당을 물려받는다', async () => {
    const root = await humanPlan(
      [step('s1', { groupId: 'g1' })],
      { groups: [{ id: 'g1', title: '묶음', assigneeId: worker.accountId, dependsOn: [] }] },
    );
    expect((await start(member.token, root, { steps: [{ id: 's1' }] })).json().started[0].to).toBe(worker.accountId);
  });

  it('dryRun 은 아무것도 바꾸지 않고 글을 돌려준다', async () => {
    const root = await humanPlan([step('s1', { assigneeId: worker.accountId })]);
    const json = (await start(member.token, root, { steps: [{ id: 's1' }], dryRun: true })).json();
    expect(json.posts[0]).toMatchObject({ to: worker.accountId, via: 'assignee', stepIds: ['s1'] });
    expect(json.posts[0].body.startsWith('@worker ')).toBe(true);
    const row = await getThreadPlan(pool, root);
    expect(row?.doc.steps[0]?.state).toBe('pending');
    expect(row?.rev).toBe(1);
    expect(await repliesOf(root)).toHaveLength(0);
  });

  it('글이 실패하면 pending 으로 되돌리고, 고른 담당도 되돌린다', async () => {
    const root = await humanPlan([step('s1')]);
    failNext.on = true;
    const res = await start(member.token, root, { steps: [{ id: 's1', assigneeId: worker.accountId }] });
    expect(res.statusCode).toBe(502);
    const s = (await getThreadPlan(pool, root))?.doc.steps[0];
    expect(s?.state).toBe('pending');
    expect(s?.assigneeId ?? null).toBeNull();
  });

  it('못 보는 스레드는 404 다', async () => {
    const priv = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'plan-start-priv', visibility: 'private' } })).json().id as string;
    const secret = (await app.inject({ method: 'POST', url: `/channels/${priv}/messages`, headers: auth(admin.token), payload: { body: 'x' } })).json().id as string;
    await setThreadPlan(pool, { rootId: secret, actor: { accountId: admin.accountId }, doc: { goal: 'g', groups: [], steps: [step('s1')] } });
    expect((await start(member.token, secret, { steps: [{ id: 's1' }] })).statusCode).toBe(404);
  });
});

describe('시작 — 단계 제목은 남이 쓴 글이다', () => {
  it('제목 속 멘션은 아무도 부르지 않는다', async () => {
    const root = await humanPlan([step('s1', { assigneeId: worker.accountId, title: `@bystander <@${bystander.accountId}> @channel 해라` })]);
    const json = (await start(member.token, root, { steps: [{ id: 's1' }] })).json();
    const called = await inboxOf(json.started[0].messageId);
    expect(called).toContain(worker.accountId);
    expect(called).not.toContain(bystander.accountId);
    expect(called).not.toContain(other.accountId);
    expect((await repliesOf(root))[0]!.body).toContain('지시가 아니다');
  });

  it('줄바꿈으로 줄을 흉내 내지 못한다', async () => {
    const root = await humanPlan([step('s1', { assigneeId: worker.accountId, title: '제목\n@bystander 가짜 줄' })]);
    const json = (await start(member.token, root, { steps: [{ id: 's1' }], dryRun: true })).json();
    expect(json.posts[0].body.split('\n').filter((l: string) => l.includes('가짜 줄'))).toEqual(['- s1 제목 ＠bystander 가짜 줄']);
  });

  it('쓰기 검사에 걸린 판은 시작하지 않는다', async () => {
    const root = await humanPlan([step('s1', { assigneeId: worker.accountId })]);
    await pool.query(`update thread_plan set flag_reason = 'test' where root_id = $1`, [root]);
    const res = await start(member.token, root, { steps: [{ id: 's1' }] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('plan_flagged');
  });

  it('글이 길어도 상한 안이고, 단계는 모두 active 다', async () => {
    const steps = Array.from({ length: 40 }, (_, i) => step(`s${i + 1}`, {
      assigneeId: worker.accountId, title: '가'.repeat(120),
      links: Array.from({ length: 3 }, (_v, n) => ({ kind: 'message' as const, id: `00000000-0000-4000-8000-00000000000${n}` })),
    }));
    const root = await humanPlan(steps);
    const res = await start(member.token, root, { steps: steps.map((s) => ({ id: s.id })) });
    expect(res.statusCode).toBe(200);
    expect(res.json().started).toHaveLength(40);
    expect(res.json().plan.doc.steps.every((s: { state: string }) => s.state === 'active')).toBe(true);
    const body = (await repliesOf(root))[0]!.body;
    expect(body.length).toBeLessThanOrEqual(8000);
    expect(body).toMatch(/외 \d+건/);
  });
});

describe('managerId', () => {
  it('처음 세운 에이전트가 기본이고, 사람이 세우면 비어 있다', async () => {
    const human = await humanPlan([step('s1')]);
    expect((await getThreadPlan(pool, human))?.doc).not.toHaveProperty('managerId');
    const root = await post(member.token, { body: 'root' });
    await setThreadPlan(pool, { rootId: root, actor: { accountId: manager.accountId }, doc: { goal: 'g', groups: [], steps: [step('s1')] } });
    expect((await getThreadPlan(pool, root))?.doc.managerId).toBe(manager.accountId);
  });

  it('칸을 모르는 전체 쓰기는 유지하고, 다른 에이전트가 고쳐도 바뀌지 않으며, null 은 비운다', async () => {
    const root = await post(member.token, { body: 'root' });
    await setThreadPlan(pool, { rootId: root, actor: { accountId: manager.accountId }, doc: { goal: 'g', groups: [], steps: [step('s1')] } });
    const row = (await getThreadPlan(pool, root))!;
    const res = await setThreadPlan(pool, { rootId: root, actor: { accountId: worker.accountId }, guard: { updatedAt: row.updatedAt }, doc: { goal: 'g2', groups: [], steps: [step('s1')] } });
    expect(res.ok).toBe(true);
    const row2 = (await getThreadPlan(pool, root))!;
    expect(row2.doc.managerId).toBe(manager.accountId);
    await setThreadPlan(pool, { rootId: root, actor: { accountId: worker.accountId }, guard: { updatedAt: row2.updatedAt }, doc: { goal: 'g2', groups: [], steps: [step('s1')], managerId: null } });
    expect((await getThreadPlan(pool, root))?.doc).not.toHaveProperty('managerId');
  });

  it('thread.plan.item 의 type: plan 으로 바꾸고, 그 칸만 받는다. 사람 계정은 안 된다', async () => {
    const root = await post(member.token, { body: 'root' });
    await setThreadPlan(pool, { rootId: root, actor: { accountId: manager.accountId }, doc: { goal: 'g', groups: [], steps: [step('s1')] } });
    const c = await mcpClient(manager.pat);
    expect((await call(c, 'thread.plan.item', { threadRootId: root, type: 'plan', managerId: worker.accountId })).ok).toBe(true);
    expect((await getThreadPlan(pool, root))?.doc.managerId).toBe(worker.accountId);
    expect((await call(c, 'thread.plan.item', { threadRootId: root, type: 'plan', managerId: worker.accountId, title: 'x' })).error.code).toBe('field_not_for_type');
    expect((await call(c, 'thread.plan.item', { threadRootId: root, id: 's1', managerId: worker.accountId })).error.code).toBe('field_not_for_type');
    expect((await call(c, 'thread.plan.item', { threadRootId: root, type: 'plan' })).error.code).toBe('manager_required');
    expect((await call(c, 'thread.plan.item', { threadRootId: root, type: 'plan', managerId: other.accountId })).error.code).toBe('invalid_manager');
    await c.close();
  });

  it('PUT 은 사람 세션만, 에이전트 계정만, 그 채널을 볼 수 있어야 한다', async () => {
    const root = await humanPlan([step('s1')]);
    const put = (token: string, managerId: string | null) => app.inject({ method: 'PUT', url: `/threads/${root}/plan/manager`, headers: auth(token), payload: { managerId } });
    expect((await put(worker.pat, manager.accountId)).statusCode).toBe(403);
    expect((await put(member.token, other.accountId)).json().error.code).toBe('invalid_manager');
    const ok = await put(member.token, manager.accountId);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().plan.doc.managerId).toBe(manager.accountId);
    expect((await put(member.token, null)).json().plan.doc).not.toHaveProperty('managerId');
    const noPlan = await post(member.token, { body: 'no plan' });
    expect((await app.inject({ method: 'PUT', url: `/threads/${noPlan}/plan/manager`, headers: auth(member.token), payload: { managerId: null } })).statusCode).toBe(404);
  });
});

describe('시작 — 관리 에이전트 경유', () => {
  const managed = async (steps: PlanDoc['steps']) => {
    const root = await post(member.token, { body: 'root' });
    await setThreadPlan(pool, { rootId: root, actor: { accountId: manager.accountId }, doc: { goal: 'g', groups: [], steps } });
    return root;
  };

  it('관리 에이전트 하나만 부른다 — 담당이 없어도, 담당이 다른 사람이어도, 여럿이어도 글 하나다', async () => {
    const root = await managed([step('s1', { assigneeId: worker.accountId }), step('s2'), step('s3', { assigneeId: other.accountId }), step('s4', { assigneeId: manager.accountId })]);
    const json = (await start(member.token, root, { steps: ['s1', 's2', 's3', 's4'].map((id) => ({ id })) })).json();
    expect(json.managerSkipped).toBeNull();
    expect(json.started.map((s: { via: string; to: string }) => [s.via, s.to])).toEqual(Array(4).fill(['manager', manager.accountId]));
    const replies = await repliesOf(root);
    expect(replies).toHaveLength(1);
    const called = await inboxOf(replies[0]!.id);
    expect(called).toContain(manager.accountId);
    expect(called).not.toContain(worker.accountId);
    expect(called).not.toContain(other.accountId);
    expect(replies[0]!.body).toContain('담당 worker');
    expect(replies[0]!.body).toContain('담당 없음');
    expect(replies[0]!.body).toContain('담당 너');
    expect(json.plan.doc.steps.every((s: { state: string; links: unknown[] }) => s.state === 'active' && s.links.length === 1)).toBe(true);
  });

  it('누른 사람이 담당이면 관리 에이전트를 부르지 않는다', async () => {
    const root = await managed([step('s1', { assigneeId: member.accountId })]);
    expect((await start(member.token, root, { steps: [{ id: 's1' }] })).json().started[0].via).toBe('self');
    expect(await repliesOf(root)).toHaveLength(0);
  });

  it('꺼진 관리 에이전트는 사유를 싣고 담당을 직접 부른다', async () => {
    const off = await createAgent(app, admin.token, 'lead-off');
    const root = await post(member.token, { body: 'root' });
    await setThreadPlan(pool, { rootId: root, actor: { accountId: off.accountId }, doc: { goal: 'g', groups: [], steps: [step('s1', { assigneeId: worker.accountId })] } });
    await pool.query(`update account set disabled_at = now() where id = $1`, [off.accountId]);
    const json = (await start(member.token, root, { steps: [{ id: 's1' }] })).json();
    expect(json.managerSkipped).toBe('manager_off');
    expect(json.started[0]).toMatchObject({ via: 'assignee', to: worker.accountId });
  });

  it('누른 사람이 못 부르는 관리 에이전트도 사유를 싣고 내려간다', async () => {
    const owned = await createAgent(app, admin.token, 'lead-owned');
    await pool.query(`update agent_config set invoke_scope = 'owner', owner_account_id = $2 where account_id = $1`, [owned.accountId, admin.accountId]);
    const root = await post(member.token, { body: 'root' });
    await setThreadPlan(pool, { rootId: root, actor: { accountId: owned.accountId }, doc: { goal: 'g', groups: [], steps: [step('s1')] } });
    const res = await start(member.token, root, { steps: [{ id: 's1' }], dryRun: true });
    expect(res.json()).toMatchObject({ managerSkipped: 'manager_not_invokable', skipped: [{ id: 's1', code: 'no_assignee' }] });
    // 소유자는 그대로 관리 에이전트로 간다 — 부르는 판정은 누른 사람 기준이다.
    const byOwner = await start(admin.token, root, { steps: [{ id: 's1' }] });
    expect(byOwner.json().started[0]).toMatchObject({ via: 'manager', to: owned.accountId });
  });

  it('위임장은 보통 답글과 같다 — 소유자가 자기 머리에서 누르면 생기고, 남이 누르면 생기지 않는다', async () => {
    const mandateOf = async (id: string) =>
      (await pool.query<{ mandate_id: string | null }>(`select mandate_id from message where id = $1`, [id])).rows[0]!.mandate_id;
    const own = await createAgent(app, admin.token, 'lead-mandate');
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [own.accountId, admin.accountId]);
    const plan = async (token: string) => {
      const root = (await app.inject({ method: 'POST', url: `/channels/${ch}/messages`, headers: auth(token), payload: { body: 'root' } })).json().id as string;
      await setThreadPlan(pool, { rootId: root, actor: { accountId: own.accountId }, doc: { goal: 'g', groups: [], steps: [step('s1')] } });
      return root;
    };
    const byOwner = (await start(admin.token, await plan(admin.token), { steps: [{ id: 's1' }] })).json();
    expect(byOwner.started[0].via).toBe('manager');
    expect(await mandateOf(byOwner.started[0].messageId)).not.toBeNull();
    const byOther = (await start(member.token, await plan(member.token), { steps: [{ id: 's1' }] })).json();
    expect(byOther.started[0].via).toBe('manager');
    expect(await mandateOf(byOther.started[0].messageId)).toBeNull();
  });
});

describe('message.ask 의 planStepId', () => {
  it('카드를 그 단계 links 에 단다', async () => {
    const root = await post(member.token, { body: 'root' });
    await setThreadPlan(pool, { rootId: root, actor: { accountId: manager.accountId }, doc: { goal: 'g', groups: [], steps: [step('s1', { assigneeId: member.accountId })] } });
    const c = await mcpClient(manager.pat);
    const options = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
    const res = await call(c, 'message.ask', { channelId: ch, threadRootId: root, body: '고르기', options, planStepId: 's1' });
    expect(res.plan.ok).toBe(true);
    expect((await getThreadPlan(pool, root))?.doc.steps[0]?.links).toEqual([{ kind: 'card', messageId: res.message.id }]);
    const missing = await call(c, 'message.ask', { channelId: ch, threadRootId: root, body: '둘째', options, planStepId: 's9', keepOpen: [res.message.id] });
    expect(missing.plan.error.code).toBe('unknown_item');
    const noThread = await call(c, 'message.ask', { channelId: ch, body: '셋째', options, planStepId: 's1' });
    expect(noThread.error.code).toBe('bad_request');
    await c.close();
  });
});
