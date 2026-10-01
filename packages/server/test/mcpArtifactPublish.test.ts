import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * MCP `artifact.publish` · `message.post.attachmentIds`(미리보기 PR ②).
 *
 * 진짜 MCP 클라이언트로 붙어 도구를 부르고, 사람 쪽 REST(메시지 목록·미리보기 발급)로 결과를
 * 확인한다 — 에이전트가 올린 것이 **사람 화면에서** 카드로 열리는지가 이 기능의 전부다.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let botPat: string;
let otherPat: string;
let channelId: string;
let otherChannelId: string;
let storageRoot: string;
let mcpUrl: string;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const PAGE = '<!doctype html><title>시안</title><h1>Inbox 보드</h1>';

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  storageRoot = await mkdtemp(join(tmpdir(), 'harkroom-mcp-art-'));
  app = await buildServer({ pool: db.pool, storage: { root: storageRoot, maxBytes: 8 * 1024 * 1024 } });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ pat: botPat } = await createAgent(app, adminToken, 'designbot'));
  ({ pat: otherPat } = await createAgent(app, adminToken, 'otherbot'));
  for (const name of ['art-a', 'art-b']) {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name },
    });
    if (name === 'art-a') channelId = ch.json().id; else otherChannelId = ch.json().id;
  }
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});
afterAll(async () => {
  await app.close(); await stop();
  await rm(storageRoot, { recursive: true, force: true });
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

type Content = { type: string; text?: string }[];
const json = (r: Awaited<ReturnType<Client['callTool']>>): any => JSON.parse((r.content as Content)[0]!.text!);

function multipart(filename: string, content: Buffer | string, contentType: string) {
  const boundary = '----harkroomart';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`,
  );
  return {
    body: Buffer.concat([head, Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** 에이전트 자격으로 올린다 — 브릿지 `attachment.upload`(PR ③)가 결국 이 REST 를 부른다. */
async function upload(token: string, filename: string, content: Buffer | string, contentType: string): Promise<string> {
  const m = multipart(filename, content, contentType);
  const res = await app.inject({ method: 'POST', url: '/uploads', headers: { ...auth(token), ...m.headers }, payload: m.body });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function messageById(id: string, channel = channelId) {
  const res = await app.inject({ method: 'GET', url: `/channels/${channel}/messages`, headers: auth(adminToken) });
  return (res.json().messages as any[]).find((m) => m.id === id);
}

const publish = (client: Client, args: Record<string, unknown>) =>
  client.callTool({ name: 'artifact.publish', arguments: { channelId, title: 'Inbox 상태 보드', body: '시안 v1', ...args } });

describe('artifact.publish', () => {
  it('posts one message whose html attachment opens as a preview for a human', async () => {
    const bot = await mcpClient(botPat);
    const out = json(await publish(bot, { html: PAGE, summary: '열 이름 정정' }));

    expect(out.error).toBeUndefined();
    expect(out.artifact).toMatchObject({ version: 1 });
    const msg = await messageById(out.message.id);
    expect(msg.attachments).toHaveLength(1);
    const [att] = msg.attachments;
    expect(att.contentType).toBe('text/html');
    expect(att.artifact).toEqual({
      artifactId: out.artifact.artifactId, version: 1, latestVersion: 1,
      title: 'Inbox 상태 보드', summary: '열 이름 정정', coverAttachmentId: null,
    });

    const issued = await app.inject({ method: 'POST', url: `/attachments/${att.id}/preview`, headers: auth(adminToken) });
    expect(issued.statusCode).toBe(201);
    const page = await app.inject({ method: 'GET', url: issued.json().path });
    expect(page.body).toBe(PAGE);
  });

  it('adds the next version as a new message and leaves the old one on its version', async () => {
    const bot = await mcpClient(botPat);
    const v1 = json(await publish(bot, { html: PAGE }));
    const v2 = json(await publish(bot, { html: PAGE.replace('보드', '보드 v2'), artifactId: v1.artifact.artifactId, title: '보드 고침', body: 'v2' }));

    expect(v2.artifact).toEqual({ artifactId: v1.artifact.artifactId, version: 2 });
    expect(v2.message.id).not.toBe(v1.message.id);
    const old = (await messageById(v1.message.id)).attachments[0].artifact;
    expect(old).toMatchObject({ version: 1, latestVersion: 2, title: '보드 고침' });
  });

  it('takes a page uploaded as a file, with a cover image', async () => {
    const bot = await mcpClient(botPat);
    const pageId = await upload(botPat, 'board.html', PAGE, 'text/html');
    const coverId = await upload(botPat, 'cover.png', PNG, 'image/png');
    const out = json(await publish(bot, { attachmentId: pageId, coverAttachmentId: coverId }));

    expect(out.error).toBeUndefined();
    const msg = await messageById(out.message.id);
    expect(msg.attachments.map((a: any) => a.id)).toEqual([pageId, coverId]);
    expect(msg.attachments[0].artifact.coverAttachmentId).toBe(coverId);
    expect(msg.attachments[1].artifact).toBeUndefined();
  });

  // security(#1045 뒤 조건): 같은 채널·같은 만든 이일 때만 버전을 붙인다.
  it('refuses to add a version to an artifact made in another channel', async () => {
    const bot = await mcpClient(botPat);
    const v1 = json(await publish(bot, { html: PAGE }));
    const out = json(await publish(bot, { html: PAGE, artifactId: v1.artifact.artifactId, channelId: otherChannelId }));

    expect(out.error.code).toBe('artifact_other_channel');
    const versions = await pool.query(`select count(*)::int as n from artifact_version where artifact_id = $1`, [v1.artifact.artifactId]);
    expect(versions.rows[0].n).toBe(1);
  });

  it('refuses to add a version to an artifact someone else made', async () => {
    const bot = await mcpClient(botPat);
    const other = await mcpClient(otherPat);
    const v1 = json(await publish(bot, { html: PAGE }));
    const out = json(await publish(other, { html: PAGE, artifactId: v1.artifact.artifactId }));

    expect(out.error.code).toBe('artifact_not_yours');
  });

  it('leaves no message and no stored file behind when it refuses', async () => {
    const bot = await mcpClient(botPat);
    const files = async () => (await readdir(storageRoot, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).length;
    const before = await files();
    const messagesBefore = (await pool.query(`select count(*)::int as n from message where channel_id = $1`, [channelId])).rows[0].n;
    const out = json(await publish(bot, { html: PAGE, artifactId: '00000000-0000-4000-8000-000000000000' }));

    expect(out.error.code).toBe('artifact_not_found');
    expect(await files()).toBe(before);
    const messagesAfter = (await pool.query(`select count(*)::int as n from message where channel_id = $1`, [channelId])).rows[0].n;
    expect(messagesAfter).toBe(messagesBefore);
  });

  it('refuses a file that is not html, and a cover that is not an image', async () => {
    const bot = await mcpClient(botPat);
    const txt = await upload(botPat, 'notes.txt', 'hi', 'text/plain');
    expect(json(await publish(bot, { attachmentId: txt })).error.code).toBe('not_html');
    const notCover = await upload(botPat, 'cover.txt', 'hi', 'text/plain');
    expect(json(await publish(bot, { html: PAGE, coverAttachmentId: notCover })).error.code).toBe('bad_cover');
  });

  it('refuses html text past the argument limit and points to a file upload', async () => {
    const bot = await mcpClient(botPat);
    const out = json(await publish(bot, { html: 'x'.repeat(2 * 1024 * 1024 + 1) }));
    expect(out.error.code).toBe('too_large');
    expect(out.error.message).toContain('attachment.upload');
  });

  it('asks for exactly one page source', async () => {
    const bot = await mcpClient(botPat);
    expect(json(await publish(bot, {})).error.code).toBe('bad_request');
    const id = await upload(botPat, 'p.html', PAGE, 'text/html');
    expect(json(await publish(bot, { html: PAGE, attachmentId: id })).error.code).toBe('bad_request');
  });
});

// security #1050 a: /mcp 만 본문 한도를 키웠다. 그 한도는 에이전트에게만 열려야 한다 — 본문을 읽기 **전에**
// 끊는지(onRequest)를 본다. 핸들러 안으로 옮기면 413 이 아니라 401/403 이 나오던 것이 413 으로 바뀐다.
describe('the larger /mcp body limit', () => {
  // 라우트 한도(≈4.5MB)보다 크다 — 읽기 전에 끊으면 401/403, 읽은 뒤에 끊으면 413 이 나온다. 그 차이를 잰다.
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', pad: 'x'.repeat(5 * 1024 * 1024) });
  const send = (headers: Record<string, string>) => app.inject({
    method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    payload: big,
  });

  it('turns away an anonymous big body before reading it', async () => {
    expect((await send({})).statusCode).toBe(401);
  });

  it('turns away a human token with a big body before reading it', async () => {
    expect((await send(auth(adminToken))).statusCode).toBe(403);
  });

  it('still refuses a body past the limit for an agent', async () => {
    const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', pad: 'x'.repeat(5 * 1024 * 1024) });
    const res = await app.inject({
      method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...auth(botPat) },
      payload: huge,
    });
    expect(res.statusCode).toBe(413);
  });
});

describe('message.post with attachments', () => {
  it('attaches the agent’s own uploads in the given order', async () => {
    const bot = await mcpClient(botPat);
    const a = await upload(botPat, 'before.png', PNG, 'image/png');
    const b = await upload(botPat, 'after.png', PNG, 'image/png');
    const out = json(await bot.callTool({ name: 'message.post', arguments: { channelId, body: '전후', attachmentIds: [a, b] } }));

    expect(out.error).toBeUndefined();
    const msg = await messageById(out.message.id);
    expect(msg.attachments.map((x: any) => x.id)).toEqual([a, b]);
    // 미리보기가 아닌 첨부에는 artifact 키가 없다.
    expect(msg.attachments[0]).toEqual({ id: a, filename: 'before.png', contentType: 'image/png', sizeBytes: PNG.length });
  });

  it('refuses someone else’s upload', async () => {
    const other = await mcpClient(otherPat);
    const mine = await upload(botPat, 'mine.png', PNG, 'image/png');
    const out = json(await other.callTool({ name: 'message.post', arguments: { channelId, body: '훔침', attachmentIds: [mine] } }));
    expect(out.error.code).toBe('bad_attachment');
  });
});
