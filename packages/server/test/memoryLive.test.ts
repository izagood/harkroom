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

describe('memory MCP tools', () => {
  it('set then get returns the value', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      const setResult = await callTool(client, 'memory.set', { slug: 'core', value: 'hello world' });
      expect(setResult).toEqual({ ok: true });

      const getResult = await callTool(client, 'memory.get', { slug: 'core' });
      expect(getResult).toEqual({
        slug: 'core',
        value: 'hello world',
        updatedAt: expect.any(String),
      });
    } finally {
      await client.close();
    }
  });

  it('set(slug, null) deletes the memory', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      await callTool(client, 'memory.set', { slug: 'mem/todelete', value: 'to be deleted' });
      const getBefore = await callTool(client, 'memory.get', { slug: 'mem/todelete' });
      expect(getBefore.value).toBe('to be deleted');

      const deleteResult = await callTool(client, 'memory.set', { slug: 'mem/todelete', value: null });
      expect(deleteResult).toEqual({ ok: true });

      const getAfter = await callTool(client, 'memory.get', { slug: 'mem/todelete' });
      expect(getAfter.error?.code).toBe('not_found');
    } finally {
      await client.close();
    }
  });

  // 삭제는 멱등이다. inbox 가 at-least-once 라 같은 지시가 두 번 처리될 수 있고,
  // 그때 재삭제가 에러로 오면 성공한 작업이 실패로 기록된다.
  it('deleting an absent memory succeeds (idempotent)', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      const first = await callTool(client, 'memory.set', { slug: 'mem/never-existed', value: null });
      expect(first).toEqual({ ok: true });

      await callTool(client, 'memory.set', { slug: 'mem/twice', value: 'x' });
      await callTool(client, 'memory.set', { slug: 'mem/twice', value: null });
      const again = await callTool(client, 'memory.set', { slug: 'mem/twice', value: null });
      expect(again).toEqual({ ok: true });
    } finally {
      await client.close();
    }
  });

  it('list returns only slugs, not values', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      await callTool(client, 'memory.set', { slug: 'mem/listtest1', value: 'secret data' });
      await callTool(client, 'memory.set', { slug: 'mem/listtest2', value: 'another secret' });

      const listResult = await callTool(client, 'memory.list', {});
      expect(listResult.slugs).toContain('mem/listtest1');
      expect(listResult.slugs).toContain('mem/listtest2');
      expect(listResult.slugs.length).toBeGreaterThanOrEqual(2);
      expect(Object.keys(listResult)).toEqual(['slugs']);
    } finally {
      await client.close();
    }
  });

  it('different account cannot see other accounts memory', async () => {
    const client1 = await mcpClient(agent1Pat);
    const client2 = await mcpClient(agent2Pat);
    try {
      await client1.callTool({ name: 'memory.set', arguments: { slug: 'mem/agent1only', value: 'agent1 secret' } });
      await client2.callTool({ name: 'memory.set', arguments: { slug: 'mem/agent2only', value: 'agent2 secret' } });

      const r1 = await callTool(client1, 'memory.get', { slug: 'mem/agent1only' });
      expect(r1.value).toBe('agent1 secret');

      const r2 = await callTool(client2, 'memory.get', { slug: 'mem/agent2only' });
      expect(r2.value).toBe('agent2 secret');

      const notMyMemory = await callTool(client1, 'memory.get', { slug: 'mem/agent2only' });
      expect(notMyMemory.error?.code).toBe('not_found');

      const notMyMemory2 = await callTool(client2, 'memory.get', { slug: 'mem/agent1only' });
      expect(notMyMemory2.error?.code).toBe('not_found');

      // get 만 검사하면 list 의 스코프가 비어 있어도 통과한다 — 실제로 listMemory 에서
      // 계정 조건을 지웠을 때 이 테스트가 초록이었다(다른 테스트가 우연히 잡았을 뿐이다).
      const list1 = await callTool(client1, 'memory.list', {});
      expect(list1.slugs).toContain('mem/agent1only');
      expect(list1.slugs).not.toContain('mem/agent2only');

      const list2 = await callTool(client2, 'memory.list', {});
      expect(list2.slugs).toContain('mem/agent2only');
      expect(list2.slugs).not.toContain('mem/agent1only');
    } finally {
      await client1.close();
      await client2.close();
    }
  });

  it('rejects invalid slug formats', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      const upper = await callTool(client, 'memory.set', { slug: 'CORE', value: 'test' });
      expect(upper.error?.code).toBe('invalid_slug');

      const noPrefix = await callTool(client, 'memory.set', { slug: 'random', value: 'test' });
      expect(noPrefix.error?.code).toBe('invalid_slug');

      const longSlug = await callTool(client, 'memory.set', { slug: 'a'.repeat(256), value: 'test' });
      expect(longSlug.error?.code).toBe('invalid_slug');
    } finally {
      await client.close();
    }
  });

  it('allows core slug', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      const result = await callTool(client, 'memory.set', { slug: 'core', value: 'valid' });
      expect(result).toEqual({ ok: true });

      const getResult = await callTool(client, 'memory.get', { slug: 'core' });
      expect(getResult.value).toBe('valid');
    } finally {
      await client.close();
    }
  });

  it('rejects value > 8000 chars, allows exactly 8000', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      const tooLong = await callTool(client, 'memory.set', { slug: 'mem/toolong', value: 'a'.repeat(8001) });
      expect(tooLong.error?.code).toBe('mcp_error');

      const exact = await callTool(client, 'memory.set', { slug: 'mem/exact8000', value: 'a'.repeat(8000) });
      expect(exact).toEqual({ ok: true });
    } finally {
      await client.close();
    }
  });

  it('rejects 201st item, allows 200th', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      const listBefore = await callTool(client, 'memory.list', {});
      const existingCount = listBefore.slugs?.length ?? 0;
      const needToAdd = 200 - existingCount;

      for (let i = 0; i < needToAdd; i++) {
        const result = await callTool(client, 'memory.set', { slug: `mem/testitem${i}`, value: 'x' });
        expect(result).toEqual({ ok: true });
      }

      const add201 = await callTool(client, 'memory.set', { slug: 'mem/testitem200', value: 'x' });
      expect(add201.error?.code).toBe('too_many');

      const removeOne = await callTool(client, 'memory.set', { slug: 'mem/testitem0', value: null });
      expect(removeOne).toEqual({ ok: true });

      const addAfterDelete = await callTool(client, 'memory.set', { slug: 'mem/testitem200', value: 'x' });
      expect(addAfterDelete).toEqual({ ok: true });
    } finally {
      await client.close();
    }
  });
});