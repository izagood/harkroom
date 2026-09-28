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
let base: string;

let agent1Pat: string;
let agent1Id: string;
let agent2Pat: string;
let agent2Id: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '127.0.0.1';
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ accountId: agent1Id, pat: agent1Pat } = await createAgent(app, adminToken, 'agent-1'));
  ({ accountId: agent2Id, pat: agent2Pat } = await createAgent(app, adminToken, 'agent-2'));
});
afterAll(async () => { await app.close(); await stop(); });

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args }) as { content: { type: 'text'; text: string }[] };
  const text = result.content[0]?.text;
  if (!text) throw new Error('no content');
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: 'mcp_error', message: text } };
  }
}

describe('진행 설명 메시지 (#144)', () => {
  let channelId: string;

  beforeAll(async () => {
    const res = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'progress-test' },
    });
    channelId = res.json().id as string;
  });

  // 이 테스트가 마이그레이션 누락을 잡는다. message.kind 에 체크 제약이 걸려 있어서
  // 014 없이는 삽입이 제약 위반으로 실패한다 — 타입만 넓히면 컴파일은 통과하고
  // 런타임에 깨진다.
  it('진행 설명이 실제로 저장되고 채널에서 읽힌다', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      await callTool(client, 'message.progress', { channelId, body: '오래 걸리는 작업을 시작한다' });

      const read = await callTool(client, 'message.read', { channelId });
      const found = (read.messages as { body: string; kind: string }[])
        .find((m) => m.body === '오래 걸리는 작업을 시작한다');
      expect(found).toBeDefined();
      expect(found!.kind).toBe('progress');
    } finally {
      await client.close();
    }
  });

  // 결과 발화와 **구분 가능해야** 한다 — 러너가 그것으로 침묵을 판정한다.
  it('진행 설명과 결과 발화가 kind 로 갈린다', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      await callTool(client, 'message.progress', { channelId, body: '진행 설명입니다' });
      await callTool(client, 'message.post', { channelId, body: '결과입니다' });

      const read = await callTool(client, 'message.read', { channelId });
      const rows = read.messages as { body: string; kind: string }[];
      expect(rows.find((m) => m.body === '진행 설명입니다')!.kind).toBe('progress');
      expect(rows.find((m) => m.body === '결과입니다')!.kind).toBe('user');
    } finally {
      await client.close();
    }
  });
});
