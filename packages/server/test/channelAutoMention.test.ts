import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * 채널이 특정 에이전트를 자동으로 멘션한다(#173) — 서버 쪽 회귀선.
 *
 * 1. admin 이 걸면 행이 생기고 GET 에 나온다. 채널 하나에 둘을 걸 수 있다.
 * 2. admin 아니면 PUT/DELETE 403. 에이전트가 아닌 계정·비활성 에이전트는 400.
 * 6. 에이전트가 MCP 로 올린 메시지에는 접두가 붙지 않는다 — 서버는 본문을 고치지 않는다.
 * 7. 자동 멘션이 붙은(작성창이 접두한 모양의) 본문이 그 에이전트의 inbox 에 들어간다 —
 *    기존 판정 경로 그대로다. 서버에 자동 멘션 전용 판정은 없다.
 * 8. 감사 detail 에 본문이 없다 — handle 만.
 *
 * 3·4·5(작성창의 접두·중복 방지·한 메시지에서 끄기)는 `packages/desktop/test/autoMention.test.tsx`.
 */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let humanToken: string;
let humanId: string;
let fizz: { accountId: string; pat: string };
let honey: { accountId: string; pat: string };
let sleepy: { accountId: string; pat: string };
let channelId: string;
let mcpUrl: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function registerHuman(handle: string): Promise<{ id: string; token: string }> {
  const inviteRes = await app.inject({ method: 'POST', url: '/invites', headers: auth(adminToken), payload: {} });
  const inviteToken = inviteRes.json().token as string;
  const created = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { handle, displayName: handle, password: 'pw123456', inviteToken },
  });
  expect(created.statusCode).toBe(201);
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { handle, password: 'pw123456' } });
  expect(login.statusCode).toBe(200);
  return { id: created.json().id as string, token: login.json().token as string };
}

async function listAuto(token: string): Promise<Array<{ agentAccountId: string; handle: string }>> {
  const res = await app.inject({ method: 'GET', url: `/channels/${channelId}/auto-mentions`, headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json().autoMentions;
}

async function inboxFor(pat: string, messageId: string): Promise<Array<{ reason: string }>> {
  const res = await app.inject({ method: 'GET', url: '/inbox', headers: auth(pat) });
  expect(res.statusCode).toBe(200);
  return (res.json().entries as Array<{ reason: string; messageId: string }>)
    .filter((e) => e.messageId === messageId);
}

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}
const text = (r: Awaited<ReturnType<Client['callTool']>>): unknown =>
  JSON.parse((r.content as { type: string; text: string }[])[0]!.text);

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  fizz = await createAgent(app, adminToken, 'fizz');
  honey = await createAgent(app, adminToken, 'honey');
  sleepy = await createAgent(app, adminToken, 'sleepy');
  ({ id: humanId, token: humanToken } = await registerHuman('writer'));
  // 비활성 에이전트 — 자동 멘션에 걸 수 없어야 한다.
  const disabled = await app.inject({
    method: 'PATCH', url: `/accounts/agents/${sleepy.accountId}`, headers: auth(adminToken), payload: { disabled: true },
  });
  expect(disabled.statusCode).toBe(200);
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'automention' },
  });
  expect(ch.statusCode).toBe(201);
  channelId = ch.json().id;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});
afterAll(async () => { await app.close(); await stop(); });

describe('설정 라우트 (#173)', () => {
  // 회귀 1
  it('admin 이 걸면 행이 생기고 GET 에 나온다 — 채널 하나에 둘을 걸 수 있다', async () => {
    const first = await app.inject({
      method: 'PUT', url: `/channels/${channelId}/auto-mentions/${fizz.accountId}`, headers: auth(adminToken),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ channelId, agentAccountId: fizz.accountId, handle: 'fizz' });

    const second = await app.inject({
      method: 'PUT', url: `/channels/${channelId}/auto-mentions/${honey.accountId}`, headers: auth(adminToken),
    });
    expect(second.statusCode).toBe(200);

    // 채널을 볼 수 있는 사람이면 admin 이 아니어도 목록을 본다 — 칩을 그려야 한다.
    const rows = await listAuto(humanToken);
    expect(rows.map((r) => r.handle).sort()).toEqual(['fizz', 'honey']);

    // 같은 것을 다시 걸어도 200 이고 행은 하나다(멱등 PUT).
    const again = await app.inject({
      method: 'PUT', url: `/channels/${channelId}/auto-mentions/${fizz.accountId}`, headers: auth(adminToken),
    });
    expect(again.statusCode).toBe(200);
    expect((await listAuto(adminToken)).length).toBe(2);
  });

  // 회귀 2
  it('admin 아니면 PUT/DELETE 403', async () => {
    const put = await app.inject({
      method: 'PUT', url: `/channels/${channelId}/auto-mentions/${fizz.accountId}`, headers: auth(humanToken),
    });
    expect(put.statusCode).toBe(403);
    const del = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/auto-mentions/${fizz.accountId}`, headers: auth(humanToken),
    });
    expect(del.statusCode).toBe(403);
    // 403 이 행을 건드리지 않았다.
    expect((await listAuto(adminToken)).length).toBe(2);
  });

  it('에이전트가 아닌 계정은 400 not_an_agent', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/channels/${channelId}/auto-mentions/${humanId}`, headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_an_agent');
    expect((await listAuto(adminToken)).some((r) => r.agentAccountId === humanId)).toBe(false);
  });

  it('비활성 에이전트는 400 agent_disabled', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/channels/${channelId}/auto-mentions/${sleepy.accountId}`, headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('agent_disabled');
    expect((await listAuto(adminToken)).some((r) => r.agentAccountId === sleepy.accountId)).toBe(false);
  });

  it('DELETE 는 행을 지우고, 없던 것은 404 다', async () => {
    const del = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/auto-mentions/${honey.accountId}`, headers: auth(adminToken),
    });
    expect(del.statusCode).toBe(204);
    expect((await listAuto(adminToken)).map((r) => r.handle)).toEqual(['fizz']);
    const again = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/auto-mentions/${honey.accountId}`, headers: auth(adminToken),
    });
    expect(again.statusCode).toBe(404);
  });
});

describe('본문과 알림 (#173)', () => {
  // 회귀 6 — 서버 `postMessage` 에 접두 로직이 없음을 단언한다. 되돌려 RED 를 보려면
  // postMessage 가 저장 전에 자동 멘션 handle 을 body 앞에 붙이게 고쳐 보라.
  it('에이전트가 MCP 로 올린 메시지에는 접두가 붙지 않는다', async () => {
    // 위 describe 가 fizz 를 걸어 뒀다 — 이 채널은 지금 fizz 를 자동 멘션한다.
    expect((await listAuto(adminToken)).map((r) => r.handle)).toEqual(['fizz']);
    const client = await mcpClient(fizz.pat);
    const body = '작업을 끝냈다. 결과는 위와 같다.';
    const posted = text(await client.callTool({ name: 'message.post', arguments: { channelId, body } })) as
      { message: { id: string; body: string } };
    expect(posted.message.body).toBe(body);
    // 저장된 본문도 같다 — 응답만 원문이고 저장은 접두된 형태면 다음 조회에서 갈라진다.
    const stored = await pool.query<{ body: string }>(`select body from message where id = $1`, [posted.message.id]);
    expect(stored.rows[0]!.body).toBe(body);
    // 그리고 fizz 자신은 자기 답에 불리지 않는다 — 루프가 없다.
    expect(await inboxFor(fizz.pat, posted.message.id)).toEqual([]);
    await client.close();
  });

  // 회귀 7 — 작성창이 접두한 모양의 본문이 기존 판정 경로로 inbox 에 들어간다.
  it('자동 멘션이 붙은 본문은 그 에이전트의 inbox 에 들어간다', async () => {
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(humanToken),
      payload: { body: '@fizz 이거 확인해 줘' },
    });
    expect(res.statusCode).toBe(201);
    const messageId = res.json().id as string;
    expect((await inboxFor(fizz.pat, messageId)).map((e) => e.reason)).toEqual(['mention']);
    // 접두 없는 본문은 자동 멘션 설정이 있어도 서버가 알리지 않는다 — 판정은 본문 하나다.
    const bare = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(humanToken),
      payload: { body: '접두가 없는 글' },
    });
    expect(bare.statusCode).toBe(201);
    expect(await inboxFor(fizz.pat, bare.json().id as string)).toEqual([]);
  });

  // 회귀 8
  it('감사 detail 에는 handle 만 있고 본문이 없다', async () => {
    const secret = '이 문장은 감사 로그에 남으면 안 된다';
    const posted = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(humanToken), payload: { body: secret },
    });
    expect(posted.statusCode).toBe(201);
    // 걸고 풀어 두 종류의 감사를 모두 남긴다.
    await app.inject({
      method: 'PUT', url: `/channels/${channelId}/auto-mentions/${honey.accountId}`, headers: auth(adminToken),
    });
    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/auto-mentions/${honey.accountId}`, headers: auth(adminToken),
    });
    const rows = await pool.query<{ action: string; target: string; detail: Record<string, unknown> }>(
      `select action, target, detail from audit_log
        where action in ('channel.auto_mention.set', 'channel.auto_mention.unset') order by id`,
    );
    const actions = rows.rows.map((r) => r.action);
    expect(actions).toContain('channel.auto_mention.set');
    expect(actions).toContain('channel.auto_mention.unset');
    for (const row of rows.rows) {
      expect(row.target).toBe(channelId);
      expect(Object.keys(row.detail)).toEqual(['handle']);
      expect(JSON.stringify(row.detail)).not.toContain(secret);
    }
    expect(rows.rows[rows.rows.length - 1]!.detail.handle).toBe('honey');
  });
});
