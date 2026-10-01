import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';

/**
 * 스레드 × 에이전트 모델 지정(079) — jaebin 승인 결정 1~13(2026-10-01).
 *
 * 1. 사람이 정하면 행이 생기고 GET 에 나온다. 스레드에 시스템 줄이 남는다(`@` 없이 — 부르지 않는다).
 * 2. 에이전트는 못 바꾼다(결정 3). 스레드 답글을 루트로 주면 404.
 * 3. 두 축을 다 비우면 푼다. 없던 것을 DELETE 하면 404.
 * 4. 러너용 실효값: 스레드 지정 → 에이전트 설정. 답글 id 를 줘도 그 루트를 본다.
 * 5. 에이전트의 하네스가 바뀌면 지정은 남되 stale 이고 실효값에서 빠진다(결정 9).
 * 6. 작성창 칩(POST messages `agentModels`) — 채널 최상위 글이면 그 글이 루트다. 에이전트가 실으면 403.
 */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let member: { token: string; accountId: string };
let fizz: { accountId: string; pat: string };
let channelId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function post(token: string, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: body });
}
const modelsUrl = (root: string, agent?: string) =>
  `/channels/${channelId}/threads/${root}/agent-models${agent ? `/${agent}` : ''}`;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  member = await createMember(app, adminToken, 'mina');
  fizz = await createAgent(app, adminToken, 'fizz');
  await app.inject({
    method: 'PATCH', url: `/accounts/agents/${fizz.accountId}`, headers: auth(adminToken),
    payload: { harness: 'claude-code', model: 'sonnet', effort: 'medium' },
  });
  const ch = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'models' } });
  expect(ch.statusCode).toBe(201);
  channelId = ch.json().id as string;
});

afterAll(async () => {
  await app.close();
  await stop();
});

describe('thread agent model', () => {
  it('사람이 정하면 GET 에 나오고, 스레드에 부르지 않는 시스템 줄이 남는다', async () => {
    const root = (await post(member.token, { body: 'root' })).json().id as string;
    const put = await app.inject({
      method: 'PUT', url: modelsUrl(root, fizz.accountId), headers: auth(member.token),
      payload: { model: 'opus', effort: 'xhigh' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().row).toMatchObject({ agentId: fizz.accountId, harness: 'claude-code', model: 'opus', effort: 'xhigh', setBy: member.accountId, stale: false });

    const list = await app.inject({ method: 'GET', url: modelsUrl(root), headers: auth(fizz.pat) });
    expect(list.json().agentModels).toHaveLength(1);

    const thread = await app.inject({ method: 'GET', url: `/channels/${channelId}/messages?thread=${root}`, headers: auth(member.token) });
    const sys = (thread.json().messages as Array<{ kind: string; body: string; meta: Record<string, unknown> }>).find((m) => m.kind === 'system');
    expect(sys?.meta).toMatchObject({ accountId: member.accountId, threadAgentModel: { agentId: fizz.accountId, model: 'opus', effort: 'xhigh' } });
    expect(sys?.body).not.toContain('@');
    const inbox = await app.inject({ method: 'GET', url: '/inbox', headers: auth(fizz.pat) });
    expect((inbox.json().entries as unknown[]).length).toBe(0);
  });

  it('에이전트는 바꾸지 못하고, 답글을 루트로 주면 404', async () => {
    const root = (await post(member.token, { body: 'root2' })).json().id as string;
    const byAgent = await app.inject({
      method: 'PUT', url: modelsUrl(root, fizz.accountId), headers: auth(fizz.pat), payload: { model: 'opus' },
    });
    expect(byAgent.statusCode).toBe(403);
    expect(byAgent.json().error.code).toBe('human_only');
    const reply = (await post(member.token, { body: 'reply', threadRootId: root })).json().id as string;
    const onReply = await app.inject({
      method: 'PUT', url: modelsUrl(reply, fizz.accountId), headers: auth(member.token), payload: { model: 'opus' },
    });
    expect(onReply.statusCode).toBe(404);
  });

  it('루트는 경로의 채널에 묶인다 — 다른(비공개) 채널의 rootId 로 GET·DELETE 하면 404 (security ①)', async () => {
    // 비공개 채널 B: admin 만 멤버다. mina 는 B 를 못 본다.
    const priv = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'secret-b', visibility: 'private' } });
    expect(priv.statusCode).toBe(201);
    const chB = priv.json().id as string;
    const rootB = (await app.inject({ method: 'POST', url: `/channels/${chB}/messages`, headers: auth(adminToken), payload: { body: 'b root' } })).json().id as string;
    const putB = await app.inject({ method: 'PUT', url: `/channels/${chB}/threads/${rootB}/agent-models/${fizz.accountId}`, headers: auth(adminToken), payload: { model: 'opus' } });
    expect(putB.statusCode).toBe(200);
    // mina 는 볼 수 있는 채널(models)의 경로에 B 의 rootId 를 넣는다.
    const peek = await app.inject({ method: 'GET', url: modelsUrl(rootB), headers: auth(member.token) });
    expect(peek.statusCode).toBe(404);
    const wipe = await app.inject({ method: 'DELETE', url: modelsUrl(rootB, fizz.accountId), headers: auth(member.token) });
    expect(wipe.statusCode).toBe(404);
    const still = await pool.query(`select 1 from thread_agent_model where thread_root_id = $1`, [rootB]);
    expect(still.rowCount).toBe(1);
  });

  it('작성창 POST 의 agentModels 도 루트를 경로 채널에 묶는다 — 남의 비공개 스레드 지정을 풀거나 바꾸지 못한다 (security ④)', async () => {
    const priv = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'secret-c', visibility: 'private' } });
    const chC = priv.json().id as string;
    const rootC = (await app.inject({ method: 'POST', url: `/channels/${chC}/messages`, headers: auth(adminToken), payload: { body: 'c root' } })).json().id as string;
    await app.inject({ method: 'PUT', url: `/channels/${chC}/threads/${rootC}/agent-models/${fizz.accountId}`, headers: auth(adminToken), payload: { model: 'opus' } });
    const before = await pool.query(`select count(*)::int as n from message where thread_root_id = $1`, [rootC]);
    for (const pick of [{ model: null, effort: null }, { model: 'haiku', effort: null }]) {
      const res = await post(member.token, { body: '@fizz x', threadRootId: rootC, agentModels: [{ agentId: fizz.accountId, ...pick }] });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_a_root');
    }
    const row = await pool.query(`select model from thread_agent_model where thread_root_id = $1`, [rootC]);
    expect(row.rows).toEqual([{ model: 'opus' }]);
    // 거절은 글을 올리기 **전**이다 — B 스레드에 답글도 남지 않는다.
    const after = await pool.query(`select count(*)::int as n from message where thread_root_id = $1`, [rootC]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('argv 로 갈 값의 모양을 묶는다 — `-` 로 시작·따옴표·공백·개행·`=` 는 400, 실재 이름은 받는다 (security ②)', async () => {
    const root = (await post(member.token, { body: 'root-argv' })).json().id as string;
    for (const bad of ['--dangerously-skip-permissions', 'opus"', 'a b', 'a\nb', 'x=y']) {
      const res = await app.inject({ method: 'PUT', url: modelsUrl(root, fizz.accountId), headers: auth(member.token), payload: { model: bad } });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error.code).toBe('bad_model_value');
    }
    const badEffort = await app.inject({ method: 'PUT', url: modelsUrl(root, fizz.accountId), headers: auth(member.token), payload: { effort: '"; rm' } });
    expect(badEffort.statusCode).toBe(400);
    const viaPost = await post(member.token, { body: '@fizz x', agentModels: [{ agentId: fizz.accountId, model: '-c', effort: null }] });
    expect(viaPost.statusCode).toBe(400);
    for (const ok of ['claude-opus-5[1m]', 'rro/openai/gpt-oss-120b', 'gpt-5.5']) {
      const res = await app.inject({ method: 'PUT', url: modelsUrl(root, fizz.accountId), headers: auth(member.token), payload: { model: ok } });
      expect(res.statusCode, ok).toBe(200);
    }
  });

  it('두 축을 다 비우면 풀리고, 없던 것을 DELETE 하면 404', async () => {
    const root = (await post(member.token, { body: 'root3' })).json().id as string;
    await app.inject({ method: 'PUT', url: modelsUrl(root, fizz.accountId), headers: auth(member.token), payload: { model: 'opus' } });
    const cleared = await app.inject({
      method: 'PUT', url: modelsUrl(root, fizz.accountId), headers: auth(member.token), payload: { model: ' ', effort: null },
    });
    expect(cleared.json().row).toBeNull();
    const del = await app.inject({ method: 'DELETE', url: modelsUrl(root, fizz.accountId), headers: auth(member.token) });
    expect(del.statusCode).toBe(404);
  });

  it('러너 실효값: 스레드 지정이 축마다 이기고, 답글 id 로 물어도 루트를 본다', async () => {
    const root = (await post(member.token, { body: 'root4' })).json().id as string;
    const reply = (await post(member.token, { body: 'reply', threadRootId: root })).json().id as string;
    await app.inject({ method: 'PUT', url: modelsUrl(root, fizz.accountId), headers: auth(member.token), payload: { model: 'opus' } });
    const eff = await app.inject({ method: 'GET', url: `/agent/thread-model?messageId=${reply}`, headers: auth(fizz.pat) });
    expect(eff.json()).toEqual({ model: 'opus', effort: 'medium', source: { model: 'thread', effort: 'agent' } });
    const none = await app.inject({ method: 'GET', url: '/agent/thread-model', headers: auth(fizz.pat) });
    expect(none.json()).toEqual({ model: 'sonnet', effort: 'medium', source: { model: 'agent', effort: 'agent' } });
    const human = await app.inject({ method: 'GET', url: '/agent/thread-model', headers: auth(member.token) });
    expect(human.statusCode).toBe(403);
  });

  it('하네스가 바뀌면 지정은 남되 stale 이고 실효값에서 빠진다', async () => {
    const other = await createAgent(app, adminToken, 'buzz');
    await app.inject({ method: 'PATCH', url: `/accounts/agents/${other.accountId}`, headers: auth(adminToken), payload: { harness: 'claude-code', model: 'sonnet' } });
    const root = (await post(member.token, { body: 'root5' })).json().id as string;
    await app.inject({ method: 'PUT', url: modelsUrl(root, other.accountId), headers: auth(member.token), payload: { model: 'opus' } });
    await app.inject({ method: 'PATCH', url: `/accounts/agents/${other.accountId}`, headers: auth(adminToken), payload: { harness: 'codex', model: 'gpt-5.5' } });
    const list = await app.inject({ method: 'GET', url: modelsUrl(root), headers: auth(member.token) });
    expect(list.json().agentModels[0]).toMatchObject({ model: 'opus', harness: 'claude-code', currentHarness: 'codex', stale: true });
    const eff = await app.inject({ method: 'GET', url: `/agent/thread-model?messageId=${root}`, headers: auth(other.pat) });
    expect(eff.json().model).toBe('gpt-5.5');
  });

  it('고르개 재료: 사람이면 누구나 하네스·기본값을 읽고, 오퍼레이터가 없으면 models 는 없다(모른다)', async () => {
    const res = await app.inject({ method: 'GET', url: `/agents/${fizz.accountId}/model-options`, headers: auth(member.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ harness: 'claude-code', model: 'sonnet', effort: 'medium', pickable: [] });
    const byAgent = await app.inject({ method: 'GET', url: `/agents/${fizz.accountId}/model-options`, headers: auth(fizz.pat) });
    expect(byAgent.statusCode).toBe(403);
  });

  it('작성창 칩: 채널 최상위 글이면 그 글이 루트다, 에이전트가 실으면 403', async () => {
    const res = await post(member.token, { body: '@fizz 고도화해 줘', agentModels: [{ agentId: fizz.accountId, model: 'opus', effort: 'max' }] });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const eff = await app.inject({ method: 'GET', url: `/agent/thread-model?messageId=${id}`, headers: auth(fizz.pat) });
    expect(eff.json()).toMatchObject({ model: 'opus', effort: 'max' });
    const rows = await pool.query(`select 1 from thread_agent_model where thread_root_id = $1`, [id]);
    expect(rows.rowCount).toBe(1);

    // 두 축이 빈 값은 그 스레드의 지정 **해제**다(스레드 작성창의 [스레드 지정 풀기]) — 버리면 안 풀린다.
    const reply = await post(member.token, { body: '@fizz 이어서', threadRootId: id, agentModels: [{ agentId: fizz.accountId, model: null, effort: null }] });
    expect(reply.statusCode).toBe(201);
    const after = await pool.query(`select 1 from thread_agent_model where thread_root_id = $1`, [id]);
    expect(after.rowCount).toBe(0);
    const effAfter = await app.inject({ method: 'GET', url: `/agent/thread-model?messageId=${id}`, headers: auth(fizz.pat) });
    expect(effAfter.json()).toMatchObject({ model: 'sonnet', effort: 'medium', source: { model: 'agent', effort: 'agent' } });
    const thread = await app.inject({ method: 'GET', url: `/channels/${channelId}/messages?thread=${id}`, headers: auth(member.token) });
    const cleared = (thread.json().messages as Array<{ kind: string; meta: Record<string, unknown> }>)
      .filter((m) => m.kind === 'system' && (m.meta.threadAgentModel as { model: unknown } | undefined)?.model === null);
    expect(cleared).toHaveLength(1);
    // 없던 것을 다시 풀면 시스템 줄을 남기지 않는다.
    await post(member.token, { body: '@fizz 또', threadRootId: id, agentModels: [{ agentId: fizz.accountId, model: null, effort: null }] });
    const again = await app.inject({ method: 'GET', url: `/channels/${channelId}/messages?thread=${id}`, headers: auth(member.token) });
    expect((again.json().messages as Array<{ kind: string; meta: Record<string, unknown> }>)
      .filter((m) => m.kind === 'system' && (m.meta.threadAgentModel as { model: unknown } | undefined)?.model === null)).toHaveLength(1);

    const byAgent = await post(fizz.pat, { body: 'x', agentModels: [{ agentId: fizz.accountId, model: 'opus' }] });
    expect(byAgent.statusCode).toBe(403);
  });
});
