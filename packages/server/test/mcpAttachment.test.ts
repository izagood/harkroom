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
  storageRoot = await mkdtemp(join(tmpdir(), 'harkroom-mcp-att-'));
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
  const boundary = '----harkroomtest';
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

  // 이미지도 텍스트도 아니면 **거절이 아니라** "이렇게 받아라"다. 빈 응답으로 두면
  // 에이전트는 받기가 실패한 것과 구별하지 못하고 같은 호출을 다시 한다.
  //
  // **이 자리에 예전에는 `text/plain` 이 서 있었다**(#585). #609 가 그것을 실어 주기로
  // 했으므로 여기는 진짜로 둘 다 아닌 타입이어야 한다 — 안 그러면 이 축이 새 동작을
  // 막는 회귀선이 된다.
  it('falls back to metadata for something that is neither image nor text', async () => {
    const id = await attach('bundle.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'application/zip');
    const client = await mcpClient(botPat);

    const res = await fetchTool(client, id);
    expect(parts(res).some((c) => c.type === 'image')).toBe(false);
    const json = firstJson(res);
    expect(json.attachment).toMatchObject({ filename: 'bundle.zip', contentType: 'application/zip' });
    expect(json.text).toBeUndefined();
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

    // #609 의 함정: SVG 는 **텍스트이기도 하다.** "이미지가 아니면 텍스트" 로 규칙을
    // 쓰면 여기서 마크업이 통째로 모델 컨텍스트에 실린다. 허용 목록이라 빠지는 것을
    // 여기서 고정한다 — 되돌려 RED 로 확인했다(`isTextType` 을 `!IMAGE_TYPES…` 로 바꾸면 빨개진다).
    expect(firstJson(res).text).toBeUndefined();
    expect(JSON.stringify(firstJson(res))).not.toContain('<script>');
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

  /**
   * #609 — **텍스트도 손에 쥔다.**
   *
   * 이미지 축과 같은 방식으로 잰다: 진짜 MCP 클라이언트로 도구를 부르고 돌아온 문자열을
   * **올린 원본과 대조**한다. "형식은 맞는데 내용이 다르다"가 이 결함군의 실패 모양이고,
   * 길이나 존재만 재는 축은 그것을 통과시킨다.
   */
  describe('텍스트 첨부 (#609)', () => {
    // 한글을 섞는다. ASCII 만으로 재면 UTF-8 왕복이 깨져도 초록이다.
    const LOG = '에러가 났다\nTraceback (most recent call last):\n  File "a.py", line 1\nValueError: 값이 틀렸다\n';

    it('로그를 올린 그대로 글로 싣는다', async () => {
      const id = await attach('run.log', Buffer.from(LOG, 'utf8'), 'text/plain');
      const client = await mcpClient(botPat);

      const json = firstJson(await fetchTool(client, id));
      // 바이트 단위로 같다 — 한 글자라도 다르면 여기서 걸린다.
      expect(json.text).toBe(LOG);
      expect(json.attachment).toMatchObject({ filename: 'run.log', contentType: 'text/plain' });
      // 안 잘렸으면 자른 표시를 붙이지 않는다. 늘 붙으면 그 값이 아무것도 안 말한다.
      expect(json.truncated).toBeUndefined();
    });

    // 허용 목록의 나머지 갈래. `+json` 접미는 `application/vnd.…+json` 로 실제로 올라온다.
    it.each([
      ['data.json', 'application/json'],
      ['feed.xml', 'application/xml'],
      ['doc.json', 'application/vnd.api+json'],
      ['page.html', 'text/html'],
    ])('%s (%s) 도 글로 실린다', async (filename, contentType) => {
      const body = '{"ok":true,"말":"한글"}';
      const id = await attach(filename, Buffer.from(body, 'utf8'), contentType);
      const client = await mcpClient(botPat);

      expect(firstJson(await fetchTool(client, id)).text).toBe(body);
    });

    /**
     * **자르되 잘랐다고 말한다.** 이슈가 요구한 세 가지를 한자리에서 본다: 앞뒤가 남고,
     * 자른 사실이 응답에 있고, 받는 방법이 함께 온다.
     *
     * 앞만 남기지 않는 이유가 여기서 눈에 보인다 — 로그는 **끝**에 실패가 있다.
     */
    it('상한을 넘으면 앞뒤를 남기고 자른 사실을 응답에 적는다', async () => {
      const big = `머리표식\n${'가'.repeat(200_000)}\n꼬리표식`;
      const id = await attach('huge.log', Buffer.from(big, 'utf8'), 'text/plain');
      const client = await mcpClient(botPat);

      const json = firstJson(await fetchTool(client, id));
      expect(json.text).toContain('머리표식');
      expect(json.text).toContain('꼬리표식');
      expect(json.text).toContain('characters omitted');
      expect(json.truncated.droppedCharacters).toBeGreaterThan(0);
      expect(json.truncated.limitBytes).toBe(256 * 1024);
      expect(json.download).toContain(`/attachments/${id}`);

      // **깨진 글자를 만들지 않는다.** 바이트로 잘랐으면 경계에서 한글이 쪼개져 U+FFFD 가
      // 섞인다 — 디코딩한 뒤 자르기로 한 이유가 이것이다.
      expect(json.text).not.toContain('\uFFFD');
    });

    /**
     * UTF-8 이 아니면 **텍스트로 취급하지 않는다.** 기본 디코더는 깨진 바이트를 조용히
     * `U+FFFD` 로 바꿔 성공하는데, 그러면 에이전트는 깨진 글자가 원본인지 사고인지
     * 구별할 수 없다 — "내용은 알지만 틀렸다"가 되어 원래 결함보다 나쁘다.
     */
    it('UTF-8 이 아니면 글로 싣지 않고 이유를 말한다', async () => {
      // EUC-KR 의 "한글" — UTF-8 로는 못 읽는 바이트다.
      const euckr = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);
      const id = await attach('legacy.txt', euckr, 'text/plain');
      const client = await mcpClient(botPat);

      const json = firstJson(await fetchTool(client, id));
      expect(json.text).toBeUndefined();
      expect(json.note).toContain('not valid UTF-8');
      expect(json.download).toContain(`/attachments/${id}`);
    });

    /**
     * 읽기 상한을 넘으면 이미지와 같이 메타데이터로 떨어진다. **문구가 텍스트의 것이어야
     * 한다** — 여기서 `not an inlineable image type` 이라고 답하면 거짓말이고, 에이전트는
     * 타입을 바꿔 다시 올려 달라고 사람에게 말하게 된다.
     */
    it('읽기 상한을 넘으면 텍스트의 문구로 떨어진다', async () => {
      const id = await attach('massive.log', Buffer.alloc(4 * 1024 * 1024 + 1, 0x61), 'text/plain');
      const client = await mcpClient(botPat);

      const json = firstJson(await fetchTool(client, id));
      expect(json.text).toBeUndefined();
      expect(json.note).toContain('too large to inline as text');
      expect(json.note).not.toContain('not an inlineable image');
    });

    // 이미지 축이 REST 와 대조하는 것과 같은 이유다: 두 통로가 다른 것을 내주면 어느 쪽을
    // 믿을지 알 수 없다.
    it('REST 다운로드와 같은 내용을 준다', async () => {
      const id = await attach('same.log', Buffer.from(LOG, 'utf8'), 'text/plain');
      const client = await mcpClient(botPat);

      const viaMcp = firstJson(await fetchTool(client, id)).text;
      const viaRest = await app.inject({
        method: 'GET', url: `/attachments/${id}`, headers: { authorization: `Bearer ${botPat}` },
      });

      expect(viaRest.statusCode).toBe(200);
      expect(viaMcp).toBe(viaRest.rawPayload.toString('utf8'));
    });
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
