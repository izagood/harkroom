import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

// 감사 ① — DM 가시성 누출 회귀 테스트: search/GET/POST(REST)와 MCP message.read/message.post가
// dm 채널 비멤버에게 새어나가지 않는지, 멤버에게는 정상 동작하는지 검증한다.

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let aPat: string;
let bPat: string;
let cPat: string;
let dmChannelId: string;
let mcpUrl: string;

const DM_BODY = 'secret dm payload xyz123';

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  const a = await createAgent(app, adminToken, 'agent-a');
  const b = await createAgent(app, adminToken, 'agent-b');
  const c = await createAgent(app, adminToken, 'agent-c');
  aPat = a.pat;
  bPat = b.pat;
  cPat = c.pat;

  const dm = await app.inject({
    method: 'POST', url: '/dms', headers: { authorization: `Bearer ${aPat}` },
    payload: { accountIds: [b.accountId] },
  });
  dmChannelId = dm.json().id;

  await app.inject({
    method: 'POST', url: `/channels/${dmChannelId}/messages`,
    headers: { authorization: `Bearer ${aPat}` },
    payload: { body: DM_BODY },
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});
afterAll(async () => { await app.close(); await stop(); });

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}
const text = (r: Awaited<ReturnType<Client['callTool']>>): unknown =>
  JSON.parse((r.content as { type: string; text: string }[])[0]!.text);

describe('dm visibility', () => {
  it('search never returns a dm body to a non-member, but does to a member', async () => {
    const denied = await app.inject({
      method: 'GET', url: '/search?q=xyz123', headers: { authorization: `Bearer ${cPat}` },
    });
    expect(denied.json().messages).toHaveLength(0);

    const allowed = await app.inject({
      method: 'GET', url: '/search?q=xyz123', headers: { authorization: `Bearer ${aPat}` },
    });
    expect(allowed.json().messages.map((m: { body: string }) => m.body)).toContain(DM_BODY);
  });

  it('REST GET messages 403s a non-member and 200s a member', async () => {
    const denied = await app.inject({
      method: 'GET', url: `/channels/${dmChannelId}/messages`,
      headers: { authorization: `Bearer ${cPat}` },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: { code: 'forbidden', message: expect.any(String) } });

    const allowed = await app.inject({
      method: 'GET', url: `/channels/${dmChannelId}/messages`,
      headers: { authorization: `Bearer ${bPat}` },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().messages.map((m: { body: string }) => m.body)).toContain(DM_BODY);
  });

  it('REST POST messages 403s a non-member and 201s a member', async () => {
    const denied = await app.inject({
      method: 'POST', url: `/channels/${dmChannelId}/messages`,
      headers: { authorization: `Bearer ${cPat}` },
      payload: { body: 'intruder' },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'POST', url: `/channels/${dmChannelId}/messages`,
      headers: { authorization: `Bearer ${bPat}` },
      payload: { body: 'hi from b' },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('MCP message.read 403s a non-member and succeeds for a member', async () => {
    const nonMember = await mcpClient(cPat);
    const denied = text(await nonMember.callTool({
      name: 'message.read', arguments: { channelId: dmChannelId },
    })) as { error?: { code: string } };
    expect(denied.error?.code).toBe('forbidden');
    await nonMember.close();

    const member = await mcpClient(bPat);
    const allowed = text(await member.callTool({
      name: 'message.read', arguments: { channelId: dmChannelId },
    })) as { messages?: { body: string }[] };
    expect(allowed.messages?.some((m) => m.body === DM_BODY)).toBe(true);
    await member.close();
  });

  it('MCP message.post 403s a non-member and succeeds for a member', async () => {
    const nonMember = await mcpClient(cPat);
    const denied = text(await nonMember.callTool({
      name: 'message.post', arguments: { channelId: dmChannelId, body: 'intruder via mcp' },
    })) as { error?: { code: string } };
    expect(denied.error?.code).toBe('forbidden');
    await nonMember.close();

    const member = await mcpClient(bPat);
    const allowed = text(await member.callTool({
      name: 'message.post', arguments: { channelId: dmChannelId, body: 'hi via mcp' },
    })) as { message?: { id: string } };
    expect(allowed.message?.id).toBeTruthy();
    await member.close();
  });
});
