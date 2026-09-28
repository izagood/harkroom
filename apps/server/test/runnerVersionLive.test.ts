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

describe('러너 버전 기록 (#129)', () => {
  const agentsFor = async (token: string) => {
    const res = await app.inject({
      method: 'GET', url: '/accounts/agents', headers: { authorization: `Bearer ${token}` },
    });
    return res.json().agents as { id: string; runnerVersion?: string | null }[];
  };

  it('MCP 로 폴하면 그 계정의 버전이 기록된다', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      await callTool(client, 'inbox.poll', { timeoutMs: 0, version: 'sha-aaa' });

      const me = (await agentsFor(adminToken)).find((a) => a.id === agent1Id);
      expect(me?.runnerVersion).toBe('sha-aaa');
    } finally {
      await client.close();
    }
  });

  it('다른 버전으로 폴하면 값이 바뀐다', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      await callTool(client, 'inbox.poll', { timeoutMs: 0, version: 'sha-bbb' });

      const me = (await agentsFor(adminToken)).find((a) => a.id === agent1Id);
      expect(me?.runnerVersion).toBe('sha-bbb');
    } finally {
      await client.close();
    }
  });

  // 버전이 바뀔 때만 쓴다 — inbox.poll 은 최대 25초마다 오는 핫 패스라 매번 쓰면 낭비다.
  // "지금 붙어 있나"는 #124 의 인메모리 presence 가 답하므로 seen_at 을 갱신할 이유가 없다.
  it('같은 버전으로 다시 폴하면 seen_at 을 다시 쓰지 않는다', async () => {
    const client = await mcpClient(agent1Pat);
    try {
      await callTool(client, 'inbox.poll', { timeoutMs: 0, version: 'sha-same' });
      const first = await pool.query(
        'select seen_at from agent_runner_version where account_id = $1', [agent1Id],
      );

      await new Promise((r) => setTimeout(r, 50));
      await callTool(client, 'inbox.poll', { timeoutMs: 0, version: 'sha-same' });
      const second = await pool.query(
        'select seen_at from agent_runner_version where account_id = $1', [agent1Id],
      );

      expect(second.rows[0].seen_at.getTime()).toBe(first.rows[0].seen_at.getTime());
    } finally {
      await client.close();
    }
  });

  it('버전을 보내지 않은 에이전트는 runnerVersion 이 null 이다 (필드가 빠지지 않는다)', async () => {
    const other = (await agentsFor(adminToken)).find((a) => a.id === agent2Id);
    expect(other).toBeDefined();
    expect(other!.runnerVersion).toBeNull();
  });

  it('버전 없이 폴해도 정상 동작한다', async () => {
    const client = await mcpClient(agent2Pat);
    try {
      const r = await callTool(client, 'inbox.poll', { timeoutMs: 0 });
      expect(r).toBeDefined();

      const other = (await agentsFor(adminToken)).find((a) => a.id === agent2Id);
      expect(other!.runnerVersion).toBeNull();
    } finally {
      await client.close();
    }
  });
});
