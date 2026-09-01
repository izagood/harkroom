import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { Lifecycle } from '../src/lifecycle.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let pollPat: string;
let resumePat: string;
let channelId: string;

interface Instance {
  app: FastifyInstance;
  lifecycle: Lifecycle;
  mcpUrl: string;
}

/** 업데이트 = 같은 Postgres에 붙는 서버 프로세스 교체. 인스턴스를 새로 띄우는 것으로 흉내낸다. */
async function spawn(): Promise<Instance> {
  const lifecycle = new Lifecycle();
  const app = await buildServer({ pool, lifecycle });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return { app, lifecycle, mcpUrl: `http://127.0.0.1:${port}/mcp` };
}

async function mcpClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

const text = (r: Awaited<ReturnType<Client['callTool']>>): unknown =>
  JSON.parse((r.content as { type: string; text: string }[])[0]!.text);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  const setup = await spawn();
  ({ token: adminToken } = await bootstrapAdmin(setup.app));
  ({ pat: pollPat } = await createAgent(setup.app, adminToken, 'pollbot'));
  ({ pat: resumePat } = await createAgent(setup.app, adminToken, 'resumebot'));
  const ch = await setup.app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'restart-ch' },
  });
  channelId = ch.json().id;
  await setup.app.close();
});
afterAll(async () => stop());

describe('업데이트로 에이전트 세션이 끊기지 않는다', () => {
  it('ends an in-flight inbox.poll as a normal empty result when the server drains', async () => {
    const a = await spawn();
    const client = await mcpClient(a.mcpUrl, pollPat);
    const pending = client.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 20_000 } });
    await sleep(300);

    const started = Date.now();
    await a.lifecycle.beginDrain();
    const result = text(await pending);

    expect(result).toEqual({ entries: [], messages: [] });
    expect(Date.now() - started).toBeLessThan(5_000);
    await client.close();
    await a.app.close();
  });

  // main.ts의 실제 종료 순서(drain → close)를 그대로 밟는다. drain이 응답을 "논리적으로"
  // 마감해도 바이트가 소켓에 나가기 전에 close()가 소켓을 부수면 에이전트가 보는 것은
  // 여전히 절단이다.
  it('flushes the draining poll response even when close() follows immediately', async () => {
    const a = await spawn();
    const client = await mcpClient(a.mcpUrl, pollPat);
    const pending = client.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 20_000 } });
    await sleep(300);

    await a.lifecycle.beginDrain();
    await a.app.close();

    expect(text(await pending)).toEqual({ entries: [], messages: [] });
    await client.close();
  });

  it('does not park a new inbox.poll while the server is draining', async () => {
    const a = await spawn();
    await a.lifecycle.beginDrain();
    const client = await mcpClient(a.mcpUrl, pollPat);

    const started = Date.now();
    const result = text(await client.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 20_000 } }));

    expect(result).toEqual({ entries: [], messages: [] });
    expect(Date.now() - started).toBeLessThan(2_000);
    await client.close();
    await a.app.close();
  });

  it('lets an agent resume its poll loop against a replacement instance', async () => {
    const a = await spawn();
    const clientA = await mcpClient(a.mcpUrl, resumePat);
    const pending = clientA.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 20_000 } });
    await sleep(300);
    await a.lifecycle.beginDrain();
    expect(text(await pending)).toEqual({ entries: [], messages: [] });
    await clientA.close();
    await a.app.close();

    const b = await spawn();
    await b.app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: '@resumebot 교체된 인스턴스에서 부른다' },
    });
    const clientB = await mcpClient(b.mcpUrl, resumePat);
    const resumed = text(await clientB.callTool({
      name: 'inbox.poll', arguments: { timeoutMs: 5_000 },
    })) as { entries: { reason: string }[] };

    expect(resumed.entries.some((e) => e.reason === 'mention')).toBe(true);
    await clientB.close();
    await b.app.close();
  });

  it('replays a message retried across the replacement instead of duplicating it', async () => {
    const headers = { authorization: `Bearer ${adminToken}`, 'idempotency-key': 'retry-across-restart' };
    const payload = { body: '업데이트 중 재시도된 발화' };

    const a = await spawn();
    const first = await a.app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers, payload });
    await a.lifecycle.beginDrain();
    await a.app.close();

    const b = await spawn();
    const retried = await b.app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers, payload });
    await b.app.close();

    expect(retried.json().id).toBe(first.json().id);
    const rows = await pool.query(`select count(*)::int as n from message where body = $1`, [payload.body]);
    expect(rows.rows[0].n).toBe(1);
  });
});
