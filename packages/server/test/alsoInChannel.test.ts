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

// #231 의 반대 방향: 스레드에 이미 올라간 답을 **나중에** 채널로도 올린다. 거두기와 같은
// 자원의 POST 다. 회귀선은 넷 — 켜지는가, 멱등인가, 남의 글은 막는가(admin 도), 스레드
// 답이 아닌 것을 막는가.
describe('#231 나중에 채널로 보내기', () => {
  const share = (token: string, messageId: string) =>
    app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${messageId}/also-in-channel`,
      headers: { authorization: `Bearer ${token}` },
    });

  const postQuiet = async (token: string, body: string) => {
    const root = await post(token, `root for ${body}`);
    const rootId = root.json().id as string;
    const reply = await post(token, body, { threadRootId: rootId });
    return { rootId, id: reply.json().id as string, seq: reply.json().seq as number };
  };

  it('나중에 켜면 채널 목록에 실려 나오고 스레드 소속은 그대로다', async () => {
    const { rootId, id, seq } = await postQuiet(adminToken, 'later');
    const res = await share(adminToken, id);
    expect(res.statusCode).toBe(200);
    expect(res.json().alsoInChannel).toBe(true);
    // 새 메시지가 아니라 같은 행이다 — id 도 seq 도 그대로다(채널의 시간을 다시 쓰지 않는다).
    expect(res.json().id).toBe(id);
    expect(res.json().seq).toBe(seq);
    // 본문을 고친 것이 아니므로 수정 자국을 남기지 않는다.
    expect(res.json().editedAt).toBeNull();

    const rows = await listMessages(pool, channelId, { limit: 50 });
    const found = rows.find((m) => m.id === id);
    expect(found?.alsoInChannel).toBe(true);
    expect(found?.threadRootId).toBe(rootId);
  });

  it('두 번 눌러도 같은 결과다', async () => {
    const { id } = await postQuiet(adminToken, 'twice later');
    await share(adminToken, id);
    const again = await share(adminToken, id);
    expect(again.statusCode).toBe(200);
    expect(again.json().alsoInChannel).toBe(true);
  });

  it('거둔 것을 다시 올릴 수 있다', async () => {
    const { id } = await postQuiet(adminToken, 'round trip');
    await share(adminToken, id);
    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${id}/also-in-channel`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const again = await share(adminToken, id);
    expect(again.json().alsoInChannel).toBe(true);
  });

  it('남의 글은 admin 이라도 채널로 내보낼 수 없다', async () => {
    const root = await post(adminToken, 'root for agent share');
    const rootId = root.json().id as string;
    const client = await mcpClient(botPat);
    const posted = text(await client.callTool({
      name: 'message.post',
      arguments: { channelId, body: 'agent quiet answer', threadRootId: rootId },
    })) as { message: { id: string } };
    await client.close();

    // 거두기(조정)와 달리 이것은 발화다 — admin 권한이 남의 말을 채널로 퍼뜨리는 힘이
    // 되면 안 된다.
    const res = await share(adminToken, posted.message.id);
    expect(res.statusCode).toBe(403);

    const rows = await listMessages(pool, channelId, { limit: 50 });
    expect(rows.find((m) => m.id === posted.message.id)?.alsoInChannel).toBe(false);
  });

  it('스레드 답이 아니면 400 이다', async () => {
    const top = await post(adminToken, 'plain channel message');
    const res = await share(adminToken, top.json().id as string);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_thread_reply');
  });

  it('없는 메시지는 404 다', async () => {
    const res = await share(adminToken, '00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
  });
});
