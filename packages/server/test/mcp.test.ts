import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

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
  ({ pat: botPat } = await createAgent(app, adminToken, 'mcpbot'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'mcp-ch', repo: 'mcp-repo' },
  });
  channelId = ch.json().id;
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

describe('mcp surface', () => {
  it('rejects human session token', async () => {
    await expect(mcpClient(adminToken)).rejects.toThrow();
  });

  it('lists tools, posts and reads messages', async () => {
    const client = await mcpClient(botPat);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'account.me', 'channel.list', 'inbox.poll', 'message.post',
      'message.read', 'message.search', 'work.link', 'workspace.guide',
    ]);

    const posted = text(await client.callTool({
      name: 'message.post', arguments: { channelId, body: 'hello from mcp' },
    })) as { message: { id: string } };
    const read = text(await client.callTool({
      name: 'message.read', arguments: { channelId },
    })) as { messages: { body: string }[] };
    expect(read.messages.some((m) => m.body === 'hello from mcp')).toBe(true);

    const linked = text(await client.callTool({
      name: 'work.link',
      arguments: { repo: 'mcp-repo', intentOid: 'i-77', threadRootMessageId: posted.message.id },
    }));
    expect(linked).toEqual({ ok: true });
    await client.close();
  });

  it('work.link rejects a thread root that belongs to a different channel (감사 ②)', async () => {
    const otherCh = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'other-ch' },
    });
    const otherChannelId = otherCh.json().id;
    const otherMsg = await app.inject({
      method: 'POST', url: `/channels/${otherChannelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'root in a channel not bound to mcp-repo' },
    });

    const client = await mcpClient(botPat);
    const mismatched = text(await client.callTool({
      name: 'work.link',
      arguments: { repo: 'mcp-repo', intentOid: 'i-wrong-channel', threadRootMessageId: otherMsg.json().id },
    })) as { error?: { code: string } };
    expect(mismatched.error?.code).toBe('invalid_thread');

    const missing = text(await client.callTool({
      name: 'work.link',
      arguments: { repo: 'mcp-repo', intentOid: 'i-missing-root', threadRootMessageId: '00000000-0000-0000-0000-000000000000' },
    })) as { error?: { code: string } };
    expect(missing.error?.code).toBe('invalid_thread');

    const wt = await pool.query(
      `select 1 from work_thread where repo = 'mcp-repo' and intent_oid in ('i-wrong-channel', 'i-missing-root')`,
    );
    expect(wt.rowCount).toBe(0);
    await client.close();
  });

  // 에이전트 런타임은 murmur 밖에 있어서 서버가 재시도를 강제할 수 없다. 그래서 "재시작은
  // 정상 이벤트이니 백오프로 다시 걸어라"는 계약을 guide가 문서로 들고 있어야 한다.
  it('states the inbox.poll retry contract in workspace.guide', async () => {
    const client = await mcpClient(botPat);
    const { guide } = text(await client.callTool({ name: 'workspace.guide', arguments: {} })) as { guide: string };
    expect(guide).toMatch(/빈 결과/);
    expect(guide).toMatch(/재시도/);
    expect(guide).toMatch(/재시작|업데이트/);
    await client.close();
  });

  it('inbox.poll returns mention created after the call (long-poll)', async () => {
    const client = await mcpClient(botPat);
    const pending = client.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 10_000 } });
    await new Promise((r) => setTimeout(r, 300));
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: '@mcpbot wake up' },
    });
    const result = text(await pending) as { entries: { reason: string }[] };
    expect(result.entries.some((e) => e.reason === 'mention')).toBe(true);
    await client.close();
  });
});
