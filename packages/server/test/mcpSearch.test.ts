import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { SEARCH_MAX_AUTHORS } from '../src/services/messages.js';

/**
 * MCP `message.search` 가 REST `/search` 와 같은 범위·거르기를 받는다(S2). 가시성은 같은 함수
 * (`searchMessages`) 하나가 정하고, 입력 형식·상한도 같은 조각(`searchInput`)이다 — security #1097:
 * 서비스의 `slice` 는 두 번째 그물이고 형식 검증이 REST 에만 있으면 MCP 가 그 구멍이 된다.
 */

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let botPat: string;
let botId: string;
let pub: string;
let secret: string;
let mcpUrl: string;
let client: Client;
let rootId: string;

const auth = { authorization: '' };

async function post(channelId: string, body: string, threadRootId?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth, payload: { body, ...(threadRootId ? { threadRootId } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

type Hit = { body: string; attachments: { filename: string }[] };
type Page = { messages?: Hit[]; hasMore?: boolean; error?: { code: string } };

async function search(args: Record<string, unknown>): Promise<Page> {
  const r = await client.callTool({ name: 'message.search', arguments: args });
  return JSON.parse((r.content as { text: string }[])[0]!.text) as Page;
}

/** 형식이 틀린 인자는 도구가 거절한다(SDK 판본에 따라 던지거나 isError 로 온다). */
async function refused(args: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await client.callTool({ name: 'message.search', arguments: args });
    return r.isError === true;
  } catch {
    return true;
  }
}

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  auth.authorization = `Bearer ${adminToken}`;
  ({ pat: botPat, accountId: botId } = await createAgent(app, adminToken, 'seekbot'));
  pub = (await app.inject({ method: 'POST', url: '/channels', headers: auth, payload: { name: 'pub' } })).json().id;
  secret = (await app.inject({ method: 'POST', url: '/channels', headers: auth, payload: { name: 'secret', visibility: 'private' } })).json().id;

  rootId = await post(pub, 'deploy root');
  const reply = await post(pub, 'deploy reply in thread', rootId);
  const old = await post(pub, 'deploy old note');
  await post(secret, 'deploy hidden secret');
  await pool.query(`update message set created_at = '2026-09-01T00:00:00Z' where id = $1`, [old]);
  await pool.query(
    `insert into attachment (message_id, uploader_id, filename, content_type, size_bytes, storage_key, attached_at)
     values ($1, $2, 'shot.png', 'image/png', 10, $3, now())`,
    [reply, adminId, randomUUID()],
  );

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${botPat}` } },
  }));
});
afterAll(async () => { await client.close(); await app.close(); await stop(); });

describe('MCP message.search (S2)', () => {
  it('범위 없이 찾으면 볼 수 있는 대화 전체 — 못 보는 private 채널은 빠진다, hasMore 를 준다', async () => {
    const page = await search({ query: 'deploy' });
    expect(page.messages!.map((m) => m.body).sort()).toEqual(['deploy old note', 'deploy reply in thread', 'deploy root']);
    expect(page.hasMore).toBe(false);
  });

  it('channelId·threadRootId 로 좁힌다 — 스레드는 루트 포함', async () => {
    const page = await search({ query: 'deploy', channelId: pub, threadRootId: rootId });
    expect(page.messages!.map((m) => m.body).sort()).toEqual(['deploy reply in thread', 'deploy root']);
  });

  it('못 보는 채널을 범위로 주면 forbidden — 빈 결과로 위장하지 않는다', async () => {
    const page = await search({ query: 'deploy', channelId: secret });
    expect(page.error?.code).toBe('forbidden');
    expect(page.messages).toBeUndefined();
  });

  it('거르기는 REST 와 같다: authorIds·기간·첨부·정렬, 결과에 첨부 요약', async () => {
    expect((await search({ query: 'deploy', authorIds: [botId] })).messages).toEqual([]);
    expect((await search({ query: 'deploy', authorIds: [adminId] })).messages).toHaveLength(3);
    expect((await search({ query: 'deploy', before: '2026-09-02T00:00:00Z' })).messages!.map((m) => m.body)).toEqual(['deploy old note']);
    expect((await search({ query: 'deploy', after: '2026-09-02T00:00:00+09:00' })).messages).toHaveLength(2);
    const files = await search({ query: 'deploy', hasAttachment: true });
    expect(files.messages!.map((m) => m.body)).toEqual(['deploy reply in thread']);
    expect(files.messages![0]!.attachments).toEqual([expect.objectContaining({ filename: 'shot.png' })]);
    const recent = await search({ query: 'deploy', sort: 'recent' });
    expect(recent.messages!.at(-1)!.body).toBe('deploy old note');
  });

  it('형식·상한은 REST 와 같은 조각 — 넘치거나 틀리면 거절한다', async () => {
    const many = Array.from({ length: SEARCH_MAX_AUTHORS + 1 }, () => randomUUID());
    expect(await refused({ query: 'deploy', authorIds: many })).toBe(true);
    expect(await refused({ query: 'deploy', authorIds: many.slice(0, SEARCH_MAX_AUTHORS) })).toBe(false);
    expect(await refused({ query: 'deploy', authorIds: ['nope'] })).toBe(true);
    expect(await refused({ query: 'deploy', after: '2026-09-02' })).toBe(true);
    expect(await refused({ query: 'deploy', after: '2026-09-02T00:00:00' })).toBe(true); // 시간대 없음
    expect(await refused({ query: 'deploy', sort: 'random' })).toBe(true);
    expect(await refused({ query: 'deploy', offset: 1001 })).toBe(true);
    expect(await refused({ query: 'x'.repeat(257) })).toBe(true);
  });
});
