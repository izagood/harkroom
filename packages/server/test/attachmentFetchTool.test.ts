import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { unlink } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * `attachment.fetch`(#585). 셸이 없는 하네스의 에이전트는 REST 를 부를 수 없어서 첨부가
 * 파일명뿐이었다 — 그래서 파일명으로 내용을 짐작해 답하는 사고가 났다.
 *
 * 이 파일이 재는 것은 두 가지다: **바이트가 실제로 실려 오는가**, 그리고 **누가 받을 수
 * 있는지가 REST 와 같은가.** 두 번째를 재는 방법은 도구의 판정을 손으로 적는 것이 아니라
 * 같은 첨부에 대해 REST 응답과 **대조**하는 것이다 — 손으로 적은 정답표는 두 표면이 함께
 * 틀렸을 때도 초록이다.
 */

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let storageRoot: string;
let adminToken: string;
let botPat: string;
let channelId: string;
let mcpUrl: string;

/** 1x1 PNG. 실제 PNG 헤더가 있어야 base64 왕복이 뜻을 가진다. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

function multipart(filename: string, content: string | Buffer, contentType: string) {
  const boundary = '----murmurtest';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, Buffer.isBuffer(content) ? content : Buffer.from(content), tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(
  filename: string, content: string | Buffer, contentType: string, token = adminToken,
): Promise<string> {
  const m = multipart(filename, content, contentType);
  const res = await app.inject({
    method: 'POST', url: '/uploads', headers: { ...auth(token), ...m.headers }, payload: m.body,
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** 업로드 → 메시지에 붙이기. 붙지 않은 업로드는 업로더만 볼 수 있어 규칙이 다르다. */
async function attach(
  filename: string, content: string | Buffer, contentType: string,
  channel = channelId, token = adminToken,
): Promise<string> {
  const id = await upload(filename, content, contentType, token);
  const res = await app.inject({
    method: 'POST', url: `/channels/${channel}/messages`, headers: auth(token),
    payload: { body: filename, attachmentIds: [id] },
  });
  expect(res.statusCode).toBe(201);
  return id;
}

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  storageRoot = await mkdtemp(join(tmpdir(), 'murmur-afetch-'));
  app = await buildServer({ pool: db.pool, storage: { root: storageRoot, maxBytes: 2_000_000 } });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ pat: botPat } = await createAgent(app, adminToken, 'fetchbot'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'afetch' },
  });
  channelId = ch.json().id;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});
afterAll(async () => {
  await app.close(); await stop();
  await rm(storageRoot, { recursive: true, force: true });
});

type Block = { type: string; text?: string; data?: string; mimeType?: string };

async function fetchTool(id: string, token = botPat): Promise<Block[]> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: auth(token) },
  }));
  try {
    const res = await client.callTool({ name: 'attachment.fetch', arguments: { id } });
    return res.content as Block[];
  } finally {
    await client.close();
  }
}

const meta = (blocks: Block[]): Record<string, unknown> => JSON.parse(blocks[0]!.text!);

describe('attachment.fetch', () => {
  it('hands an image back as image content the model can see', async () => {
    const id = await attach('shot.png', PNG, 'image/png');

    const blocks = await fetchTool(id);

    // 그림만 오면 이게 어느 첨부였는지 알 수 없다 — 메타데이터가 함께 온다.
    expect(meta(blocks)).toMatchObject({
      inlined: true,
      attachment: { id, filename: 'shot.png', contentType: 'image/png', sizeBytes: PNG.length },
    });
    expect(blocks[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    // base64 를 되돌려 원본과 **바이트가 같은지** 본다. 길이만 재면 다른 파일도 통과한다.
    expect(Buffer.from(blocks[1]!.data!, 'base64').equals(PNG)).toBe(true);
  });

  it('hands a text file back as readable text', async () => {
    const id = await attach('log.txt', 'line one\nline two\n', 'text/plain');

    const blocks = await fetchTool(id);

    expect(meta(blocks)).toMatchObject({ inlined: true });
    expect(blocks[1]).toEqual({ type: 'text', text: 'line one\nline two\n' });
  });

  /**
   * SVG 는 `image/*` 지만 모델 이미지 디코더가 받지 않는다. 글로 내려가야 읽히고,
   * 그림으로 내려가면 모델이 깨진 이미지를 받는다.
   */
  it('sends svg as text, not as an image block', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    const id = await attach('icon.svg', svg, 'image/svg+xml');

    const blocks = await fetchTool(id);

    expect(blocks[1]).toEqual({ type: 'text', text: svg });
  });

  /**
   * 자르지 않는다. 잘린 것을 전부인 줄 알고 답하는 것이 못 보는 것보다 나쁘다 —
   * 대신 받는 길을 알려 준다.
   */
  it('refuses to inline something too large, and says how to get it instead', async () => {
    const big = 'x'.repeat(300 * 1024);
    const id = await attach('huge.log', big, 'text/plain');

    const blocks = await fetchTool(id);

    expect(blocks).toHaveLength(1);
    const body = meta(blocks) as { inlined: boolean; reason: string; download: { path: string } };
    expect(body.inlined).toBe(false);
    expect(body.reason).toContain('too large');
    expect(body.download.path).toBe(`/attachments/${id}`);
  });

  it('does not try to inline bytes the model cannot read', async () => {
    const id = await attach('archive.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'application/zip');

    const blocks = await fetchTool(id);

    expect(blocks).toHaveLength(1);
    const body = meta(blocks) as { inlined: boolean; reason: string };
    expect(body.inlined).toBe(false);
    expect(body.reason).toContain('binary');
  });

  // 바이트를 실을 수 있을 때만 받는 길을 준다 — 늘 실으면 이미 손에 든 첨부를 한 번 더 받는다.
  it('omits the download hint when the bytes are already in the result', async () => {
    const id = await attach('note.txt', 'hi', 'text/plain');

    expect(meta(await fetchTool(id))).not.toHaveProperty('download');
  });
});

/**
 * 인가는 도구가 판정하지 않는다 — REST 와 **같은 함수**를 부른다. 그러므로 재야 할 것은
 * "도구가 이 답을 낸다"가 아니라 "두 표면의 답이 같다"다.
 */
describe('attachment.fetch authorization matches the REST route', () => {
  const rest = (id: string, token: string) =>
    app.inject({ method: 'GET', url: `/attachments/${id}`, headers: auth(token) });

  it('agrees on an attachment in a channel the agent can see', async () => {
    const id = await attach('ok.txt', 'visible', 'text/plain');

    expect((await rest(id, botPat)).statusCode).toBe(200);
    expect(meta(await fetchTool(id))).toMatchObject({ inlined: true });
  });

  /**
   * 아직 메시지에 붙지 않은 업로드는 업로더만 볼 수 있다. 이 규칙이 새 표면에서 빠지면
   * 그 표면 하나가 **게시 전 초안**을 여는 통로가 된다.
   */
  it('agrees that someone else\'s unattached upload is off limits', async () => {
    const id = await upload('draft.txt', 'not posted yet', 'text/plain');

    expect((await rest(id, botPat)).statusCode).toBe(403);
    expect(meta(await fetchTool(id))).toEqual({
      error: { code: 'forbidden', message: 'not your upload' },
    });
  });

  it('agrees that an attachment in a dm the agent is not in is off limits', async () => {
    const a = await createAgent(app, adminToken, 'dm-a');
    const b = await createAgent(app, adminToken, 'dm-b');
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: auth(a.pat), payload: { accountIds: [b.accountId] },
    });
    const id = await attach('secret.txt', 'private', 'text/plain', dm.json().id, a.pat);

    expect((await rest(id, botPat)).statusCode).toBe(403);
    expect(meta(await fetchTool(id))).toMatchObject({ error: { code: 'forbidden' } });
    // 그리고 멤버는 받는다 — 위 단언만 있으면 "아무도 못 받는다"도 초록이다.
    expect(meta(await fetchTool(id, a.pat))).toMatchObject({ inlined: true });
  });

  /** 삭제된 메시지의 첨부는 없는 것이다 — 아니면 삭제가 삭제가 아니다. */
  it('agrees that a deleted message takes its attachment with it', async () => {
    const attachmentId = await upload('doomed.txt', 'bye', 'text/plain');
    const posted = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken),
      payload: { body: 'doomed', attachmentIds: [attachmentId] },
    });
    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${posted.json().id}`,
      headers: auth(adminToken),
    });

    expect((await rest(attachmentId, botPat)).statusCode).toBe(404);
    expect(meta(await fetchTool(attachmentId))).toEqual({
      error: { code: 'not_found', message: 'no such attachment' },
    });
  });

  it('agrees on an id that does not exist', async () => {
    const id = '11111111-2222-3333-4444-555555555555';

    expect((await rest(id, botPat)).statusCode).toBe(404);
    expect(meta(await fetchTool(id))).toMatchObject({ error: { code: 'not_found' } });
  });
});

/**
 * 바이트를 읽는 단계에서 어긋나는 두 경우. 행만 믿으면 둘 다 사고가 된다 —
 * 하나는 던지고(에이전트는 도구 오류를 받는다), 하나는 상한을 지나간다.
 */
describe('attachment.fetch when the row and the file disagree', () => {
  const keyOf = async (id: string): Promise<string> =>
    (await pool.query('select storage_key from attachment where id = $1', [id])).rows[0].storage_key;

  /** 행은 있는데 파일이 없다(#257). 던지지 않고 사실을 말해야 한다. */
  it('says the file is missing instead of failing the tool call', async () => {
    const id = await attach('gone.txt', 'soon gone', 'text/plain');
    await unlink(join(storageRoot, await keyOf(id)));

    expect(meta(await fetchTool(id))).toEqual({
      error: { code: 'attachment_missing', message: 'attachment file not found on the server' },
    });
  });

  /**
   * 행에 적힌 크기가 실제 파일보다 작으면, 크기 검사는 통과하고 파일은 상한을 넘는다.
   * 흐르는 중에 다시 세지 않으면 그 파일을 **통째로 메모리에 모은 뒤에야** 거절한다.
   */
  it('stops reading at the cap even when the row understates the size', async () => {
    const id = await attach('lying.log', 'y'.repeat(300 * 1024), 'text/plain');
    await pool.query('update attachment set size_bytes = 10 where id = $1', [id]);

    const blocks = await fetchTool(id);

    expect(blocks).toHaveLength(1);
    expect(meta(blocks)).toMatchObject({ inlined: false, reason: expect.stringContaining('too large') });
  });
});
