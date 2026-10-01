import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { applyAgentPicks } from '../src/services/agentModelPicks.js';

/**
 * 에이전트가 다른 에이전트를 부르며 그 스레드의 모델을 고른다(087, jaebin 승인 결정 1~9).
 *
 * - 대상 소유자가 켠 목록(opt-in) 안에서만, 이 글이 실제로 깨우는 **다른** 에이전트에게만.
 * - 사람이 정한 행은 덮지도 풀지도 못한다(409). 한 스레드에 에이전트 변경 3번까지(429).
 * - 거절이면 **글 자체가 없다**(결정 6).
 */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let member: { token: string; accountId: string };
let lead: { accountId: string; pat: string };
let fable: { accountId: string; pat: string };
let other: { accountId: string; pat: string };
let channelId: string;
let mcpUrl: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function mcp(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}
const text = (r: Awaited<ReturnType<Client['callTool']>>): Record<string, any> =>
  JSON.parse((r.content as { type: string; text: string }[])[0]!.text);

async function say(args: Record<string, unknown>): Promise<Record<string, any>> {
  const c = await mcp(lead.pat);
  try {
    return text(await c.callTool({ name: 'message.post', arguments: { channelId, ...args } }));
  } finally {
    await c.close();
  }
}
const countBody = async (body: string) =>
  (await pool.query(`select 1 from message where body like $1`, [`%${body}%`])).rowCount ?? 0;
const rowOf = async (root: string, agentId: string) =>
  (await pool.query(`select model, effort, set_by_kind from thread_agent_model where thread_root_id = $1 and agent_id = $2`, [root, agentId])).rows[0];

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  member = await createMember(app, adminToken, 'mina');
  lead = await createAgent(app, adminToken, 'lead');
  fable = await createAgent(app, adminToken, 'reviewer');
  other = await createAgent(app, adminToken, 'other');
  const ch = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'picks' } });
  channelId = ch.json().id as string;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});
afterAll(async () => { await app.close(); await stop(); });

describe('agent picks a model for the agent it calls (087)', () => {
  it('소유자가 목록을 켜지 않았으면(기본) 고르지 못하고, 글도 남지 않는다', async () => {
    const out = await say({ body: '@reviewer 검토 부탁-1', agentModels: [{ agentId: fable.accountId, model: 'fable' }] });
    expect(out.error?.code).toBe('not_pickable');
    expect(await countBody('검토 부탁-1')).toBe(0);
  });

  it('허용 목록은 그 에이전트의 소유자만 정한다', async () => {
    const byMember = await app.inject({
      method: 'PUT', url: `/accounts/agents/${fable.accountId}/pickable-models`, headers: auth(member.token), payload: { models: [{ model: 'fable', efforts: ['medium'] }] },
    });
    expect(byMember.statusCode).toBe(403);
    const bad = await app.inject({
      method: 'PUT', url: `/accounts/agents/${fable.accountId}/pickable-models`, headers: auth(adminToken), payload: { models: [{ model: '-x' }] },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'PUT', url: `/accounts/agents/${fable.accountId}/pickable-models`, headers: auth(adminToken), payload: { models: [{ model: 'fable', efforts: ['medium', 'high'] }, { model: 'opus' }] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().models).toEqual([{ model: 'fable', efforts: ['medium', 'high'] }, { model: 'opus', efforts: [] }]);
    const badEffort = await app.inject({
      method: 'PUT', url: `/accounts/agents/${fable.accountId}/pickable-models`, headers: auth(adminToken),
      payload: { models: [{ model: 'fable', efforts: ['"max'] }] },
    });
    expect(badEffort.statusCode).toBe(400);
  });

  it('agent.modelOptions 가 고를 수 있는 것을 알려 준다 — 자기 자신은 빈 목록', async () => {
    const c = await mcp(lead.pat);
    try {
      const opts = text(await c.callTool({ name: 'agent.modelOptions', arguments: { handle: 'reviewer' } }));
      expect(opts.pickable).toEqual([{ id: 'fable', efforts: ['medium', 'high'] }, { id: 'opus', efforts: [] }]);
      const self = text(await c.callTool({ name: 'agent.modelOptions', arguments: { handle: 'lead' } }));
      expect(self.pickable).toEqual([]);
    } finally {
      await c.close();
    }
  });

  it('부르며 고르면 그 스레드에 에이전트 지정이 생기고, 대상의 실효값이 된다', async () => {
    const out = await say({ body: '@reviewer 검토 부탁-2', agentModels: [{ agentId: fable.accountId, model: 'fable', effort: 'medium' }] });
    expect(out.error).toBeUndefined();
    const root = out.message.id as string;
    expect(await rowOf(root, fable.accountId)).toEqual({ model: 'fable', effort: 'medium', set_by_kind: 'agent' });
    const eff = await app.inject({ method: 'GET', url: `/agent/thread-model?messageId=${root}`, headers: auth(fable.pat) });
    expect(eff.json()).toMatchObject({ model: 'fable', effort: 'medium', source: { model: 'thread', effort: 'thread' } });
    const sys = await pool.query(`select meta from message where thread_root_id = $1 and kind = 'system'`, [root]);
    expect(sys.rows[0].meta.threadAgentModel).toMatchObject({ agentId: fable.accountId, model: 'fable', byKind: 'agent' });
  });

  it('effort 도 허용 목록으로 묶는다 — 목록 밖 effort·effort 만 올리기·effort 못 고르는 모델은 403(결정 11)', async () => {
    // 이 시험 환경에는 오퍼레이터가 없다 — 하네스 목록을 모를 때도 허용 목록 밖 effort 는 거절해야 한다.
    const outside = await say({ body: '@reviewer effort-1', agentModels: [{ agentId: fable.accountId, model: 'fable', effort: 'max' }] });
    expect(outside.error?.code).toBe('not_pickable');
    const effortOnly = await say({ body: '@reviewer effort-2', agentModels: [{ agentId: fable.accountId, model: null, effort: 'high' }] });
    expect(effortOnly.error?.code).toBe('not_pickable');
    const noEffort = await say({ body: '@reviewer effort-3', agentModels: [{ agentId: fable.accountId, model: 'opus', effort: 'high' }] });
    expect(noEffort.error?.code).toBe('not_pickable');
    for (const n of [1, 2, 3]) expect(await countBody(`effort-${n}`)).toBe(0);
    const ok = await say({ body: '@reviewer effort-4', agentModels: [{ agentId: fable.accountId, model: 'fable', effort: 'high' }] });
    expect(ok.error).toBeUndefined();
    expect(await rowOf(ok.message.id, fable.accountId)).toMatchObject({ model: 'fable', effort: 'high', set_by_kind: 'agent' });
  });

  it('목록 밖 모델·자기 자신·부르지 않는 에이전트는 거절하고 글을 남기지 않는다', async () => {
    const outside = await say({ body: '@reviewer 검토 부탁-3', agentModels: [{ agentId: fable.accountId, model: 'haiku' }] });
    expect(outside.error?.code).toBe('not_pickable');
    const self = await say({ body: '@reviewer 검토 부탁-4', agentModels: [{ agentId: lead.accountId, model: 'opus' }] });
    expect(self.error?.code).toBe('self_pick');
    const notCalled = await say({ body: '혼잣말 검토 부탁-5', agentModels: [{ agentId: fable.accountId, model: 'fable' }] });
    expect(notCalled.error?.code).toBe('not_called');
    for (const n of [3, 4, 5]) expect(await countBody(`검토 부탁-${n}`)).toBe(0);
  });

  it('사람이 정한 지정은 에이전트가 덮지도 풀지도 못한다(409)', async () => {
    const root = (await say({ body: '@reviewer 스레드 시작-6' })).message.id as string;
    await app.inject({
      method: 'PUT', url: `/channels/${channelId}/threads/${root}/agent-models/${fable.accountId}`, headers: auth(member.token),
      payload: { model: 'opus' },
    });
    const over = await say({ body: '@reviewer 덮기-6', threadRootId: root, agentModels: [{ agentId: fable.accountId, model: 'fable' }] });
    expect(over.error?.code).toBe('human_pinned');
    const clear = await say({ body: '@reviewer 풀기-6', threadRootId: root, agentModels: [{ agentId: fable.accountId, model: null, effort: null }] });
    expect(clear.error?.code).toBe('human_pinned');
    expect(await rowOf(root, fable.accountId)).toMatchObject({ model: 'opus', set_by_kind: 'human' });
    // 사람은 에이전트 지정을 덮을 수 있다 — 위에서 이미 사람이 덮은 것과 같은 경로다.
  });

  it('위임(message.delegate)으로 넘길 때도 넘겨받는 팀원의 모델을 고른다 — 팀원 아닌 대상은 거절', async () => {
    const team = (await app.inject({ method: 'POST', url: '/teams', headers: auth(adminToken), payload: { name: 'pickteam' } })).json().id as string;
    for (const id of [lead.accountId, fable.accountId]) {
      await app.inject({ method: 'PUT', url: `/teams/${team}/members/${id}`, headers: auth(adminToken) });
    }
    await app.inject({ method: 'PUT', url: `/teams/${team}/lead`, headers: auth(adminToken), payload: { accountId: lead.accountId } });
    // 넘겨받는 팀원이 붙어 있어야 의무가 생긴다 — MCP 요청 하나가 생존 신호다.
    const ping = await mcp(fable.pat);
    await ping.callTool({ name: 'account.me', arguments: {} });
    const root = (await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken), payload: { body: '위임 스레드-8' },
    })).json().id as string;
    const c = await mcp(lead.pat);
    try {
      const ok = text(await c.callTool({
        name: 'message.delegate',
        arguments: { channelId, threadRootId: root, body: '검토 넘김-8', to: ['reviewer'], agentModels: [{ agentId: fable.accountId, model: 'fable' }] },
      }));
      expect(ok.error).toBeUndefined();
      expect(await rowOf(root, fable.accountId)).toMatchObject({ model: 'fable', set_by_kind: 'agent' });
      const wrong = text(await c.callTool({
        name: 'message.delegate',
        arguments: { channelId, threadRootId: root, body: '엉뚱-8', to: ['reviewer'], agentModels: [{ agentId: other.accountId, model: 'fable' }] },
      }));
      expect(wrong.error?.code).toBe('not_called');
      expect(await countBody('엉뚱-8')).toBe(0);
    } finally {
      await c.close();
      await ping.close();
    }
  });

  /**
   * 경쟁 조건(security #1010 ①): 판정(사람 행 없음)과 쓰기 사이에 사람이 칩으로 정하고 커밋하면,
   * 에이전트 쓰기는 그 행을 덮거나 지우지 못하고 409 로 끝나야 한다. 다른 커넥션으로 커밋된 사람 행을
   * **쓰기 질의 직전에** 끼워 넣어 그 순간을 재현한다(READ COMMITTED 의 on conflict 는 최신 판을 다시 본다).
   */
  for (const mode of ['set', 'clear'] as const) {
    it(`판정 뒤·쓰기 전에 사람이 정하면 에이전트 ${mode === 'set' ? '지정' : '풀기'}는 409 이고 사람 행이 그대로다`, async () => {
      const root = (await say({ body: `@reviewer 경쟁-${mode}`, ...(mode === 'clear' ? { agentModels: [{ agentId: fable.accountId, model: 'fable' }] } : {}) })).message.id as string;
      const client = await pool.connect();
      try {
        await client.query('begin');
        const raw = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
        let injected = false;
        const wrapped = new Proxy(client, {
          get(target, prop, recv) {
            if (prop !== 'query') return Reflect.get(target, prop, recv);
            return async (sql: unknown, params?: unknown) => {
              const text = typeof sql === 'string' ? sql : '';
              if (!injected && /^\s*(insert into thread_agent_model|delete from thread_agent_model)/.test(text)) {
                injected = true;
                await pool.query(
                  `insert into thread_agent_model (thread_root_id, agent_id, harness, model, effort, set_by, set_by_kind)
                   values ($1, $2, 'claude-code', 'opus', null, $3, 'human')
                   on conflict (thread_root_id, agent_id) do update set model = 'opus', set_by_kind = 'human', set_by = $3`,
                  [root, fable.accountId, member.accountId],
                );
              }
              return raw(sql, params);
            };
          },
        });
        const out = await applyAgentPicks(wrapped as typeof client, {
          channelId, threadRootId: root, actorId: lead.accountId,
          picks: [{ agentId: fable.accountId, model: mode === 'set' ? 'fable' : null, effort: null }],
          notified: new Set([fable.accountId]),
        });
        expect(injected).toBe(true);
        expect(out).toMatchObject({ ok: false, rejection: { status: 409, code: 'human_pinned' } });
        await client.query('rollback');
      } finally {
        client.release();
      }
      expect(await rowOf(root, fable.accountId)).toEqual({ model: 'opus', effort: null, set_by_kind: 'human' });
    });
  }

  it('허용 목록은 에이전트 PAT 으로 못 연다 — 그 에이전트가 소유자여도(결정 9, 권장 a)', async () => {
    await pool.query(`update agent_config set owner_account_id = $1 where account_id = $2`, [lead.accountId, other.accountId]);
    const res = await app.inject({
      method: 'PUT', url: `/accounts/agents/${other.accountId}/pickable-models`, headers: auth(lead.pat), payload: { models: [{ model: 'opus' }] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('human_only');
  });

  it('에이전트가 정한 행은 에이전트가 풀 수 있고, 한 스레드에 3번까지만 바꾼다(429)', async () => {
    const root = (await say({ body: '@reviewer 시작-7', agentModels: [{ agentId: fable.accountId, model: 'fable' }] })).message.id as string;
    const b = await say({ body: '@reviewer 바꿈-7', threadRootId: root, agentModels: [{ agentId: fable.accountId, model: 'opus' }] });
    expect(b.error).toBeUndefined();
    const c = await say({ body: '@reviewer 풀기-7', threadRootId: root, agentModels: [{ agentId: fable.accountId, model: null, effort: null }] });
    expect(c.error).toBeUndefined();
    expect(await rowOf(root, fable.accountId)).toBeUndefined();
    const d = await say({ body: '@reviewer 넷째-7', threadRootId: root, agentModels: [{ agentId: fable.accountId, model: 'fable' }] });
    expect(d.error?.code).toBe('model_change_limit');
    expect(await countBody('넷째-7')).toBe(0);
    // 바꾸지 않는 지정(같은 값)·없던 지정 풀기는 세지 않는다.
    void other;
  });
});
