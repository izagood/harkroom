import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * MCP `attachment.fetch`(#585) — **셸이 없는 하네스의 유일한 통로**다.
 *
 * 이 파일이 재는 것은 "함수가 무엇을 돌려주나"가 아니라 **에이전트가 실제로 그림을 손에
 * 쥐나**다. 그래서 순수 함수를 부르지 않고 진짜 MCP 클라이언트로 서버에 붙어 도구를
 * 호출하고, 돌아온 base64 를 **원본 바이트와 대조**한다. 형식만 맞고 내용이 다른 응답은
 * 여기서 걸린다 — 그것이 이 결함의 원래 모양("파일명은 알지만 내용은 모른다")이다.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let botPat: string;
let botAccountId: string;
let otherPat: string;
let channelId: string;
let storageRoot: string;
let mcpUrl: string;

/** 실제 PNG 다(1x1). 타입만 image/png 라고 적은 가짜 바이트로 재면, 진짜 그림에서 깨져도 초록이다. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  storageRoot = await mkdtemp(join(tmpdir(), 'murmur-mcp-att-'));
  app = await buildServer({ pool: db.pool, storage: { root: storageRoot, maxBytes: 8 * 1024 * 1024 } });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ pat: botPat, accountId: botAccountId } = await createAgent(app, adminToken, 'attbot'));
  ({ pat: otherPat } = await createAgent(app, adminToken, 'nosybot'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'att-mcp' },
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

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

function multipart(filename: string, content: Buffer, contentType: string) {
  const boundary = '----murmurtest';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`,
  );
  return {
    body: Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** 사람이 올리고 사람이 붙인다 — 실제 사고가 그 모양이었다(사람이 스크린샷을 붙였다). */
async function attach(filename: string, content: Buffer, contentType: string): Promise<string> {
  const m = multipart(filename, content, contentType);
  const up = await app.inject({
    method: 'POST', url: '/uploads',
    headers: { authorization: `Bearer ${adminToken}`, ...m.headers }, payload: m.body,
  });
  expect(up.statusCode).toBe(201);
  const id = up.json().id as string;
  const msg = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { body: '이거 봐줘', attachmentIds: [id] },
  });
  expect(msg.statusCode).toBe(201);
  return id;
}

type Content = { type: string; text?: string; data?: string; mimeType?: string }[];
const parts = (r: Awaited<ReturnType<Client['callTool']>>): Content => r.content as Content;
const firstJson = (r: Awaited<ReturnType<Client['callTool']>>): any => JSON.parse(parts(r)[0]!.text!);

const fetchTool = (client: Client, attachmentId: string) =>
  client.callTool({ name: 'attachment.fetch', arguments: { attachmentId } });

describe('mcp attachment.fetch', () => {
  it('hands the agent the actual image bytes', async () => {
    const id = await attach('shot.png', PNG, 'image/png');
    const client = await mcpClient(botPat);

    const res = await fetchTool(client, id);
    const p = parts(res);

    // 그림이 실제로 실렸는지 — 그리고 **그 그림이 올린 그 바이트인지**.
    const image = p.find((c) => c.type === 'image');
    expect(image).toBeDefined();
    expect(image!.mimeType).toBe('image/png');
    expect(Buffer.from(image!.data!, 'base64').equals(PNG)).toBe(true);

    // 메타데이터가 함께 온다. 이것이 없으면 에이전트는 자기가 본 것이 어느 첨부인지
    // 말할 수 없어, 나중에 "그 스크린샷"을 가리킬 근거가 없다.
    expect(firstJson(res).attachment).toMatchObject({
      id, filename: 'shot.png', contentType: 'image/png', sizeBytes: PNG.length,
    });
  });

  // 같은 바이트를 REST 로 받은 것과 대조한다. 두 통로가 다른 것을 내주면 어느 쪽을 믿을지
  // 알 수 없고, 이 PR 이 판정 함수를 한 벌로 합친 이유가 그것이다.
  it('serves the same bytes the REST download does', async () => {
    const id = await attach('same.png', PNG, 'image/png');
    const client = await mcpClient(botPat);

    const viaMcp = Buffer.from(parts(await fetchTool(client, id)).find((c) => c.type === 'image')!.data!, 'base64');
    const viaRest = await app.inject({
      method: 'GET', url: `/attachments/${id}`, headers: { authorization: `Bearer ${botPat}` },
    });

    expect(viaRest.statusCode).toBe(200);
    expect(viaMcp.equals(viaRest.rawPayload)).toBe(true);
  });

  // 이미지가 아니면 **거절이 아니라** "이렇게 받아라"다. 빈 응답으로 두면 에이전트는
  // 받기가 실패한 것과 구별하지 못하고 같은 호출을 다시 한다.
  it('falls back to metadata for a non-image, without bytes', async () => {
    const id = await attach('notes.txt', Buffer.from('할 일 목록'), 'text/plain');
    const client = await mcpClient(botPat);

    const res = await fetchTool(client, id);
    expect(parts(res).some((c) => c.type === 'image')).toBe(false);
    const json = firstJson(res);
    expect(json.attachment).toMatchObject({ filename: 'notes.txt', contentType: 'text/plain' });
    expect(json.note).toContain('not an inlineable image');
    expect(json.download).toContain(`/attachments/${id}`);
  });

  // SVG 는 이름만 이미지다 — 마크업이고 `<script>` 를 담는다. 허용 목록이 없으면 여기가
  // 모델 컨텍스트로 스크립트를 흘려보내는 자리가 된다.
  it('does not inline svg as an image', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    const id = await attach('icon.svg', svg, 'image/svg+xml');
    const client = await mcpClient(botPat);

    const res = await fetchTool(client, id);
    expect(parts(res).some((c) => c.type === 'image')).toBe(false);
    expect(firstJson(res).note).toContain('not an inlineable image');
  });

  // 큰 파일을 base64 로 만들면 서버 메모리와 모델 컨텍스트를 함께 태운다. 한계를 넘으면
  // 바이트 대신 받는 방법을 준다 — 이것도 실패가 아니다.
  it('refuses to inline an image over the size limit but says how to get it', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024 + 1 - PNG.length)]);
    const id = await attach('huge.png', big, 'image/png');
    const client = await mcpClient(botPat);

    const res = await fetchTool(client, id);
    expect(parts(res).some((c) => c.type === 'image')).toBe(false);
    const json = firstJson(res);
    expect(json.note).toContain('too large');
    expect(json.download).toContain(`/attachments/${id}`);
  });

  // 가시성은 REST 와 같은 함수가 판정한다. MCP 가 통로를 하나 더 여는 것이지,
  // 볼 수 없던 것을 볼 수 있게 만드는 것이 아니다.
  it('refuses an attachment in a channel the agent cannot see', async () => {
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountIds: [botAccountId] },
    });
    expect(dm.statusCode).toBeLessThan(300);
    const dmId = dm.json().id as string;

    const m = multipart('secret.png', PNG, 'image/png');
    const up = await app.inject({
      method: 'POST', url: '/uploads',
      headers: { authorization: `Bearer ${adminToken}`, ...m.headers }, payload: m.body,
    });
    const attId = up.json().id as string;
    await app.inject({
      method: 'POST', url: `/channels/${dmId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: '둘만 본다', attachmentIds: [attId] },
    });

    // 멤버인 에이전트는 본다.
    const member = await mcpClient(botPat);
    expect(parts(await fetchTool(member, attId)).some((c) => c.type === 'image')).toBe(true);

    // 아닌 에이전트는 못 본다 — 그리고 파일명조차 나가지 않는다.
    const nosy = await mcpClient(otherPat);
    const denied = firstJson(await fetchTool(nosy, attId));
    expect(denied.error.code).toBe('forbidden');
    // 문장까지 REST 와 같다 — 두 통로가 같은 사실을 다르게 말하면 사람이 대조할 수 없다.
    expect(denied.error.message).toBe('not a member of this dm channel');
    expect(JSON.stringify(denied)).not.toContain('secret.png');
  });

  // 메시지에 붙지 않은 업로드는 올린 사람만 본다 — 남이 id 를 맞혔을 때 열리면
  // 게시 전 초안이 새는 경로가 된다.
  it('refuses someone else\'s unattached upload', async () => {
    const m = multipart('draft.png', PNG, 'image/png');
    const up = await app.inject({
      method: 'POST', url: '/uploads',
      headers: { authorization: `Bearer ${adminToken}`, ...m.headers }, payload: m.body,
    });
    const client = await mcpClient(botPat);
    const denied = firstJson(await fetchTool(client, up.json().id));
    expect(denied.error.code).toBe('forbidden');
    expect(denied.error.message).toBe('not your upload');
  });

  // 행은 있는데 파일이 없다(#257). **던지지 않는다** — 도구가 예외로 죽으면 에이전트는
  // "서버가 고장났다"로 읽지만, 실제 사실은 "이 첨부의 파일이 없다"이고 대처가 다르다.
  it('answers attachment_missing when the row exists but the file is gone', async () => {
    const id = await attach('vanished.png', PNG, 'image/png');
    const key = (await pool.query('select storage_key from attachment where id = $1', [id])).rows[0].storage_key;
    await rm(join(storageRoot, key), { force: true });

    const client = await mcpClient(botPat);
    const res = await fetchTool(client, id);
    expect(parts(res).some((c) => c.type === 'image')).toBe(false);
    expect(firstJson(res).error.code).toBe('attachment_missing');
    // 서버 파일시스템 경로는 응답에 싣지 않는다 — 에이전트가 할 일이 달라지지 않는다.
    expect(JSON.stringify(firstJson(res))).not.toContain(storageRoot);
  });

  // 없는 것과 볼 수 없는 것을 뭉개지 않는다 — 에이전트가 할 다음 행동이 다르다
  // (전자는 id 를 다시 보고, 후자는 사람에게 묻는다).
  it('separates not_found from forbidden', async () => {
    const client = await mcpClient(botPat);
    const res = firstJson(await fetchTool(client, '11111111-1111-4111-8111-111111111111'));
    expect(res.error.code).toBe('not_found');
  });
});
