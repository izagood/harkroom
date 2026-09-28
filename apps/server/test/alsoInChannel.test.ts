import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { listMessages } from '../src/services/messages.js';

// #231: 스레드 답을 채널에도 함께 올린다. 서버 쪽 회귀선은 셋이다 —
// 값이 저장돼 목록에 실려 나오는가, 에이전트(MCP)도 켤 수 있는가, 그리고
// 스레드가 아닌 메시지에 켠 것을 정규화하는가.
let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let botPat: string;
let channelId: string;
let mcpUrl: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ pat: botPat } = await createAgent(app, adminToken, 'alsobot'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'also-in-channel' },
  });
  channelId = ch.json().id as string;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});

afterAll(async () => { await app.close(); await stop(); });

const post = (token: string, body: string, extra: object = {}) =>
  app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`,
    headers: { authorization: `Bearer ${token}` },
    payload: { body, ...extra },
  });

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

const text = (r: Awaited<ReturnType<Client['callTool']>>): unknown =>
  JSON.parse((r.content as { type: string; text: string }[])[0]!.text);

describe('#231 alsoInChannel', () => {
  it('스레드 답에 켜면 저장되고 목록에도 실려 나온다', async () => {
    const root = await post(adminToken, 'root for flag');
    const rootId = root.json().id as string;
    const reply = await post(adminToken, 'answer', { threadRootId: rootId, alsoInChannel: true });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().alsoInChannel).toBe(true);

    const rows = await listMessages(pool, channelId, { limit: 50 });
    const found = rows.find((m) => m.id === reply.json().id);
    expect(found?.alsoInChannel).toBe(true);
    // 스레드 답이라는 사실은 그대로다 — 채널에도 보이는 것이지 채널 메시지가 되는 것이 아니다.
    expect(found?.threadRootId).toBe(rootId);
  });

  it('켜지 않은 스레드 답은 false 다', async () => {
    const root = await post(adminToken, 'root without flag');
    const rootId = root.json().id as string;
    const reply = await post(adminToken, 'quiet answer', { threadRootId: rootId });
    expect(reply.json().alsoInChannel).toBe(false);
  });

  // threadRootId 없이 켠 것은 뜻이 없다 — 이미 채널 메시지다. 거절 대신 정규화가 결정이고,
  // 그렇다면 **응답이 false 를 말해야** 에이전트가 "채널에 올렸다"고 오해하지 않는다.
  it('스레드가 아닌 메시지의 alsoInChannel 은 false 로 정규화된다', async () => {
    const res = await post(adminToken, 'plain channel message', { alsoInChannel: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().alsoInChannel).toBe(false);

    const rows = await listMessages(pool, channelId, { limit: 50 });
    expect(rows.find((m) => m.id === res.json().id)?.alsoInChannel).toBe(false);
  });

  it('에이전트도 MCP message.post 로 켤 수 있다', async () => {
    const root = await post(adminToken, 'root for mcp');
    const rootId = root.json().id as string;
    const client = await mcpClient(botPat);
    const posted = text(await client.callTool({
      name: 'message.post',
      arguments: { channelId, body: 'agent conclusion', threadRootId: rootId, alsoInChannel: true },
    })) as { message: { id: string; alsoInChannel: boolean } };
    await client.close();
    expect(posted.message.alsoInChannel).toBe(true);

    const rows = await listMessages(pool, channelId, { limit: 50 });
    expect(rows.find((m) => m.id === posted.message.id)?.alsoInChannel).toBe(true);
  });

  it('MCP 로도 스레드 밖의 alsoInChannel 은 false 로 정규화된다', async () => {
    const client = await mcpClient(botPat);
    const posted = text(await client.callTool({
      name: 'message.post',
      arguments: { channelId, body: 'agent plain', alsoInChannel: true },
    })) as { message: { id: string; alsoInChannel: boolean } };
    await client.close();
    // 응답이 false 를 말해야 에이전트가 "채널에도 올렸다"고 믿지 않는다.
    expect(posted.message.alsoInChannel).toBe(false);

    const rows = await listMessages(pool, channelId, { limit: 50 });
    expect(rows.find((m) => m.id === posted.message.id)?.alsoInChannel).toBe(false);
  });

  // 미읽음은 메시지 단위로 센다. 한 메시지가 두 곳에 보인다고 두 번 세어지면
  // 배지가 실제 대화량을 넘어서고, 다 읽어도 숫자가 남는다.
  it('채널에도 올린 답이 미읽음으로 두 번 세어지지 않는다', async () => {
    const before = await app.inject({
      method: 'GET', url: `/channels/${channelId}/read`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const baseline = before.json().unread as number;

    const root = await post(adminToken, 'root for unread');
    const rootId = root.json().id as string;
    // 미읽음은 남이 쓴 것만 센다 — 그래서 답은 에이전트가 쓴다.
    const client = await mcpClient(botPat);
    await client.callTool({
      name: 'message.post',
      arguments: { channelId, body: 'counted once', threadRootId: rootId, alsoInChannel: true },
    });
    await client.close();

    const after = await app.inject({
      method: 'GET', url: `/channels/${channelId}/read`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(after.json().unread).toBe(baseline + 1);
  });
});

// #231 되돌리기: 스레드 이야기를 채널로 잘못 흘렸을 때 **채널에서만** 거둔다.
// 회귀선은 "지우기가 되지 않는가" 하나에 걸려 있다 — 메시지는 스레드에 남아야 한다.
describe('#231 채널에서 거두기', () => {
  const recall = (token: string, messageId: string) =>
    app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${messageId}/also-in-channel`,
      headers: { authorization: `Bearer ${token}` },
    });

  const postAlso = async (token: string, body: string) => {
    const root = await post(token, `root for ${body}`);
    const rootId = root.json().id as string;
    const reply = await post(token, body, { threadRootId: rootId, alsoInChannel: true });
    return { rootId, id: reply.json().id as string };
  };

  it('거두면 채널에서 빠지고 스레드에는 남는다', async () => {
    const { rootId, id } = await postAlso(adminToken, 'oops');
    const res = await recall(adminToken, id);
    expect(res.statusCode).toBe(200);
    expect(res.json().alsoInChannel).toBe(false);

    const rows = await listMessages(pool, channelId, { limit: 50 });
    const found = rows.find((m) => m.id === id);
    // 지운 것이 아니다 — 행은 그대로 있고 스레드 소속도 그대로다.
    expect(found).toBeTruthy();
    expect(found?.alsoInChannel).toBe(false);
    expect(found?.threadRootId).toBe(rootId);
  });

  it('두 번 거둬도 같은 결과다', async () => {
    const { id } = await postAlso(adminToken, 'twice');
    await recall(adminToken, id);
    const again = await recall(adminToken, id);
    // 다른 창에서 먼저 거둔 뒤 이 창에서 누르는 것은 정상 경로다 — 404 가 아니다.
    expect(again.statusCode).toBe(200);
    expect(again.json().alsoInChannel).toBe(false);
  });

  it('작성자도 admin 도 아니면 거절한다', async () => {
    const { id } = await postAlso(adminToken, 'not yours');
    const res = await recall(botPat, id);
    expect(res.statusCode).toBe(403);

    const rows = await listMessages(pool, channelId, { limit: 50 });
    expect(rows.find((m) => m.id === id)?.alsoInChannel).toBe(true);
  });

  it('admin 은 남의 것도 거둘 수 있다', async () => {
    const root = await post(adminToken, 'root for agent recall');
    const rootId = root.json().id as string;
    const client = await mcpClient(botPat);
    const posted = text(await client.callTool({
      name: 'message.post',
      arguments: { channelId, body: 'agent overshare', threadRootId: rootId, alsoInChannel: true },
    })) as { message: { id: string } };
    await client.close();

    const res = await recall(adminToken, posted.message.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().alsoInChannel).toBe(false);
  });

  it('없는 메시지는 404 다', async () => {
    const res = await recall(adminToken, '00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
  });
});

// #231 의 나머지 절반: 이미 쓴 스레드 답을 **나중에** 채널로 올린다. 회귀선은 셋이다 —
// 새 메시지가 생기지 않는가(같은 id·같은 seq 여야 한다), 작성자만 할 수 있는가,
// 그리고 채널 최상위 메시지를 겨냥한 것을 조용히 성공으로 돌려보내지 않는가.
describe('나중에 채널로 올리기', () => {
  const promote = (token: string, messageId: string) =>
    app.inject({
      method: 'PUT', url: `/channels/${channelId}/messages/${messageId}/also-in-channel`,
      headers: { authorization: `Bearer ${token}` },
    });

  const postQuiet = async (token: string, body: string) => {
    const root = await post(token, `root for ${body}`);
    const rootId = root.json().id as string;
    const reply = await post(token, body, { threadRootId: rootId });
    return { rootId, id: reply.json().id as string, seq: reply.json().seq as number };
  };

  it('올리면 채널에 보이고 스레드 소속은 그대로다', async () => {
    const { rootId, id, seq } = await postQuiet(adminToken, 'later');
    const res = await promote(adminToken, id);
    expect(res.statusCode).toBe(200);
    expect(res.json().alsoInChannel).toBe(true);

    const rows = await listMessages(pool, channelId, { limit: 100 });
    const found = rows.find((m) => m.id === id);
    expect(found?.alsoInChannel).toBe(true);
    // 새 메시지가 아니다 — 같은 행이므로 seq 도 그대로다. 새 seq 를 주면 같은 말이 두 번
    // 온 것이 되어 읽음 경계가 뒤로 밀린다.
    expect(found?.seq).toBe(seq);
    expect(found?.threadRootId).toBe(rootId);
    expect(rows.filter((m) => m.body === 'later')).toHaveLength(1);
  });

  // 글을 고친 것이 아니라 보이는 곳이 늘어난 것이다. `edited_at` 이 찍히면 화면이
  // "(edited)" 를 달아, 사람이 본문을 손댔다고 말하게 된다.
  it('수정 자국을 남기지 않는다', async () => {
    const { id } = await postQuiet(adminToken, 'not an edit');
    const res = await promote(adminToken, id);
    expect(res.json().editedAt).toBeNull();
  });

  it('두 번 올려도 같은 결과다', async () => {
    const { id } = await postQuiet(adminToken, 'twice up');
    await promote(adminToken, id);
    const again = await promote(adminToken, id);
    expect(again.statusCode).toBe(200);
    expect(again.json().alsoInChannel).toBe(true);
  });

  it('거둔 답을 다시 올릴 수 있다', async () => {
    const { id } = await postQuiet(adminToken, 'round trip');
    await promote(adminToken, id);
    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${id}/also-in-channel`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const res = await promote(adminToken, id);
    expect(res.json().alsoInChannel).toBe(true);
  });

  // 거두기는 admin 에게도 열려 있지만(조정), 올리는 것은 발화다 — 남이 스레드에만
  // 쓰기로 한 말을 admin 이 채널로 퍼뜨릴 수는 없다.
  it('admin 이라도 남의 답은 올릴 수 없다', async () => {
    const root = await post(adminToken, 'root for agent promote');
    const rootId = root.json().id as string;
    const client = await mcpClient(botPat);
    const posted = text(await client.callTool({
      name: 'message.post',
      arguments: { channelId, body: 'agent quiet answer', threadRootId: rootId },
    })) as { message: { id: string } };
    await client.close();

    const res = await promote(adminToken, posted.message.id);
    expect(res.statusCode).toBe(403);

    const rows = await listMessages(pool, channelId, { limit: 100 });
    expect(rows.find((m) => m.id === posted.message.id)?.alsoInChannel).toBe(false);
  });

  // 채널 최상위 메시지는 이미 채널에 있다. 조용히 200 을 주면 화면은 "올렸다"고 말하는데
  // 아무 일도 일어나지 않는다.
  it('스레드 답이 아니면 400 이다', async () => {
    const plain = await post(adminToken, 'plain one');
    const res = await promote(adminToken, plain.json().id as string);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_thread_reply');
  });

  it('없는 메시지는 404 다', async () => {
    const res = await promote(adminToken, '00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
  });

  // 새 글을 쓸 수 없는 곳이면 옛 글을 새로 내보일 수도 없다.
  it('보관된 채널에서는 거절한다', async () => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'promote-archived' },
    });
    const archivedId = ch.json().id as string;
    const root = await app.inject({
      method: 'POST', url: `/channels/${archivedId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { body: 'root' },
    });
    const reply = await app.inject({
      method: 'POST', url: `/channels/${archivedId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'quiet', threadRootId: root.json().id },
    });
    const archived = await app.inject({
      method: 'PATCH', url: `/channels/${archivedId}`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    const res = await app.inject({
      method: 'PUT', url: `/channels/${archivedId}/messages/${reply.json().id}/also-in-channel`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('channel_archived');
  });
});
