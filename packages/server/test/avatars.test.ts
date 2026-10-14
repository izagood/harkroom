import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import { AVATAR_PIXEL_LIMITS, looksLikeSvg, rasterizeSvgAvatar, startsLikeSvg, SVG_MAX_BYTES, SVG_RASTER_PX } from '../src/services/avatars.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: import('pg').Pool;
let adminToken: string;
let adminId: string;
let otherToken: string;
let otherId: string;
let storageRoot: string;
/**
 * 위 `app` 은 업로드 상한이 4 KiB 다(작은 파일로 빠르게 도는 것이 목적). SVG 상한(256 KiB)을
 * **넘기는** 파일은 그 앞에서 413 으로 막혀 아바타 판정까지 가지 못한다 — 그래서 상한을
 * 넉넉히 준 두 번째 서버를 같은 DB 위에 세운다. 토큰은 DB 에 있으니 그대로 쓴다.
 */
let bigApp: FastifyInstance;
let bigStorageRoot: string;

/** 진짜 1×1 PNG. 크기 상한(헤더로 가로·세로를 읽는다)을 지나려면 libvips 가 읽을 수 있는 그림이어야 한다. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** 이미지가 아닌 파일. `<script>` 를 담은 HTML 이 아바타로 전원에게 서빙되면 안 된다. */
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
/** 그리기 도구가 내놓는 모양 그대로 — XML 선언이 앞에 붙는다. */
const SVG = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>',
);

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  storageRoot = await mkdtemp(join(tmpdir(), 'harkroom-avatar-'));
  // 업로드 리밋을 넓힌다 — 사진 맞추기 시험은 한 번 저장에 업로드가 둘(원본·잘린 것)이라 기본 리밋에 닿는다.
  app = await buildServer({
    pool: db.pool, storage: { root: storageRoot, maxBytes: 4096 },
    rateLimits: { upload: { windowMs: 60_000, max: 1000 } },
  });
  bigStorageRoot = await mkdtemp(join(tmpdir(), 'harkroom-avatar-big-'));
  bigApp = await buildServer({ pool: db.pool, storage: { root: bigStorageRoot, maxBytes: SVG_MAX_BYTES * 4 } });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));

  const inv = await app.inject({
    method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` },
  });
  const reg = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: {
      handle: 'other', loginId: 'other', displayName: 'Other', password: 'pw123456',
      inviteToken: inv.json().token as string,
    },
  });
  otherId = reg.json().id as string;
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { loginId: 'other', password: 'pw123456' },
  });
  otherToken = login.json().token as string;
});
afterAll(async () => {
  await app.close(); await bigApp.close(); await stop();
  await rm(storageRoot, { recursive: true, force: true });
  await rm(bigStorageRoot, { recursive: true, force: true });
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** multipart 본문을 손으로 만든다 — 테스트가 실제 wire 형식을 지나가야 한다. */
function multipart(filename: string, content: Buffer, contentType: string) {
  const boundary = '----harkroomtest';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, content, tail]), boundary };
}

async function upload(
  token: string, filename: string, content: Buffer, contentType: string, on?: FastifyInstance,
): Promise<string> {
  const m = multipart(filename, content, contentType);
  const res = await (on ?? app).inject({
    method: 'POST', url: '/uploads',
    headers: { ...auth(token), 'content-type': `multipart/form-data; boundary=${m.boundary}` },
    payload: m.body,
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

const setAvatar = (token: string, payload: unknown, on?: FastifyInstance) =>
  (on ?? app).inject({
    method: 'PUT', url: '/accounts/me/avatar', headers: auth(token), payload: payload as object,
  });

const meView = async (token: string) =>
  (await app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) })).json();

const directory = async (token: string) =>
  (await app.inject({ method: 'GET', url: '/accounts', headers: auth(token) })).json().accounts as
    { id: string; avatarAttachmentId: string | null }[];

describe('#159 계정 프로필 사진', () => {
  it('아바타를 설정하면 AccountView 에 실려 온다', async () => {
    const id = await upload(adminToken, 'me.png', PNG, 'image/png');
    const set = await setAvatar(adminToken, { attachmentId: id });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ avatarAttachmentId: id });

    // 두 표면 모두 같은 사실을 말해야 한다. `/auth/me` 는 req.account 를 그대로 돌려주므로
    // 인증 쿼리에 컬럼을 빠뜨리면 내가 방금 건 사진이 내 화면에만 안 보인다.
    expect((await meView(adminToken)).avatarAttachmentId).toBe(id);
    expect((await directory(otherToken)).find((a) => a.id === adminId)?.avatarAttachmentId).toBe(id);
  });

  it('다른 계정도 그 아바타 바이트를 받을 수 있다', async () => {
    // 첨부 라우트로는 403 이다(메시지에 붙지 않은 업로드는 올린 사람만) — 그래서 전용
    // 라우트가 있다. 자기에게만 보이는 아바타는 기능이 아니다.
    const res = await app.inject({
      method: 'GET', url: `/accounts/${adminId}/avatar`, headers: auth(otherToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    // 첨부와 같은 방어를 유지한다 — 예외를 하나 두면 그 예외가 통로가 된다.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.rawPayload.subarray(0, 8)).toEqual(PNG.subarray(0, 8));
  });

  it('명시적 null 이 실제로 지운다', async () => {
    const id = await upload(otherToken, 'x.png', PNG, 'image/png');
    expect((await setAvatar(otherToken, { attachmentId: id })).statusCode).toBe(200);
    expect((await meView(otherToken)).avatarAttachmentId).toBe(id);

    const cleared = await setAvatar(otherToken, { attachmentId: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ avatarAttachmentId: null });
    expect((await meView(otherToken)).avatarAttachmentId).toBeNull();
    // 지운 뒤에는 바이트도 나오지 않는다 — 행만 끊고 파일이 계속 열리면 지운 것이 아니다.
    const bytes = await app.inject({
      method: 'GET', url: `/accounts/${otherId}/avatar`, headers: auth(adminToken),
    });
    expect(bytes.statusCode).toBe(404);
  });

  it('남의 아바타를 바꿀 수 없다', async () => {
    // 대상 id 를 받는 라우트 자체가 없다. 남은 통로는 '남의 업로드를 자기 얼굴로 걸기'인데,
    // 그것도 막는다 — 막지 않으면 id 를 맞힌 사람이 남이 올린 파일을 걸 수 있다.
    const theirs = await upload(otherToken, 'theirs.png', PNG, 'image/png');
    const before = (await meView(adminToken)).avatarAttachmentId;

    const res = await setAvatar(adminToken, { attachmentId: theirs });
    expect(res.statusCode).toBe(404);
    expect((await meView(adminToken)).avatarAttachmentId).toBe(before);
    // 올린 사람 쪽도 건드려지지 않았다.
    expect((await meView(otherToken)).avatarAttachmentId).toBeNull();
  });

  it('이미지가 아닌 파일은 400 이고 저장되지 않는다', async () => {
    // 클라이언트가 `image/png` 라고 **말한다**. 문자열만 보면 통과한다 — 실제 바이트는 HTML 이다.
    const id = await upload(adminToken, 'evil.png', HTML, 'image/png');
    const before = (await meView(adminToken)).avatarAttachmentId;

    const res = await setAvatar(adminToken, { attachmentId: id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_an_image');
    // 거절했으면 아무것도 걸리지 않았다.
    expect((await meView(adminToken)).avatarAttachmentId).toBe(before);
  });

  it('SVG 를 아바타로 걸 수 있다', async () => {
    // 매직 바이트가 없어 이진 판정으로는 안 잡힌다. 그래도 사람이 프로필 사진으로 흔히
    // 가진 파일이고, 그리는 자리가 `<img src={objectURL}>` 하나뿐이라 스크립트가 실행될
    // 문맥이 없다 — 그래서 받는다.
    const id = await upload(adminToken, 'me.svg', SVG, 'image/svg+xml');
    const set = await setAvatar(adminToken, { attachmentId: id });
    expect(set.statusCode).toBe(200);

    const bytes = await app.inject({
      method: 'GET', url: `/accounts/${adminId}/avatar`, headers: auth(otherToken),
    });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.headers['content-type']).toContain('image/svg+xml');
    // 방어는 그대로다: inline 으로 내주지 않고 sniff 도 막는다. 예외를 뚫은 것이 아니다.
    expect(bytes.headers['x-content-type-options']).toBe('nosniff');
    expect(bytes.headers['content-disposition']).toContain('attachment');
  });

  it('스크립트를 담은 SVG 는 거절한다', async () => {
    const evil = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const id = await upload(adminToken, 'evil.svg', evil, 'image/svg+xml');
    const before = (await meView(adminToken)).avatarAttachmentId;

    const res = await setAvatar(adminToken, { attachmentId: id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_an_image');
    expect((await meView(adminToken)).avatarAttachmentId).toBe(before);
  });

  it('상한을 넘긴 SVG 는 "SVG 가 아니다"가 아니라 크기로 거절한다', async () => {
    // 이유를 뭉개면 SVG 를 들고 있는 사람이 "SVG 만 쓸 수 있습니다"를 듣는다. 경로가 많은
    // 벡터 그림은 이 상한을 쉽게 넘으므로 지어낸 상황이 아니다.
    const big = Buffer.concat([
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">'),
      Buffer.from('<rect x="0" y="0" width="1" height="1"/>'.repeat(8000)),
      Buffer.from('</svg>'),
    ]);
    expect(big.length).toBeGreaterThan(SVG_MAX_BYTES);
    const id = await upload(adminToken, 'big.svg', big, 'image/svg+xml', bigApp);
    const before = (await meView(adminToken)).avatarAttachmentId;

    const res = await setAvatar(adminToken, { attachmentId: id }, bigApp);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('svg_too_large');
    expect((await meView(adminToken)).avatarAttachmentId).toBe(before);
  });

  it('상한을 넘긴 SVG 아닌 파일은 그대로 not_an_image 다', async () => {
    // 크기 갈래가 생겼다고 이미지가 아닌 큰 파일까지 SVG 이야기를 들으면 안 된다.
    const bigHtml = Buffer.concat([HTML, Buffer.alloc(SVG_MAX_BYTES + 1, 0x20)]);
    const id = await upload(adminToken, 'big.html', bigHtml, 'text/html', bigApp);
    const res = await setAvatar(adminToken, { attachmentId: id }, bigApp);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_an_image');
  });

  it('메시지에 붙은 첨부는 아바타로 걸 수 없다', async () => {
    // attachment.message_id 는 on delete cascade 다(006). 그 메시지를 지우면 첨부 행 자체가
    // 사라지고, 아바타를 걸어 둔 계정이 그 순간 깨진다.
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'files' },
    });
    const id = await upload(adminToken, 'shared.png', PNG, 'image/png');
    const posted = await app.inject({
      method: 'POST', url: `/channels/${ch.json().id}/messages`, headers: auth(adminToken),
      payload: { body: '사진', attachmentIds: [id] },
    });
    expect(posted.statusCode).toBe(201);

    expect((await setAvatar(adminToken, { attachmentId: id })).statusCode).toBe(404);
  });

  it('attachmentId 키가 아예 없으면 400 이다', async () => {
    // 지우기를 undefined 로 표현하면 JSON.stringify 가 키를 버려 조작이 조용히 무시된다.
    // 그래서 키는 필수이고, 지우기는 명시적 null 이다.
    expect((await setAvatar(adminToken, {})).statusCode).toBe(400);
  });
});

/**
 * 에이전트의 사진(identity 문서 Task 15-4). 에이전트는 **자기 사진을 올릴 손이 없다** —
 * 소유자가 대신 올려 주지 않으면 영원히 색 하나로 남는다.
 *
 * 여기서 지키는 것은 **인가 경계**다: 소유자·admin 만 걸 수 있고, 그 판정은
 * `requireOwnerOrAdmin` 하나가 낸다(판정 복제가 이 저장소에서 반복해 결함을 만들었다).
 */
describe('에이전트 아바타 (Task 15-4)', () => {
  let agentId: string;

  beforeAll(async () => {
    const created = await app.inject({
      method: 'POST', url: '/accounts/agents', headers: auth(adminToken),
      payload: { handle: 'facebot', displayName: 'facebot' },
    });
    agentId = created.json().id as string;
    // 소유자를 `other` 로 둔다 — admin 이 아닌 사람이 통과하는 것을 봐야 하기 때문이다.
    await app.inject({
      method: 'PATCH', url: `/accounts/agents/${agentId}`, headers: auth(adminToken),
      payload: { ownerAccountId: otherId },
    });
  });

  it('소유자가 자기 에이전트에 사진을 건다', async () => {
    const id = await upload(otherToken, 'bot.png', PNG, 'image/png');
    const res = await app.inject({
      method: 'PUT', url: `/accounts/agents/${agentId}/avatar`,
      headers: auth(otherToken), payload: { attachmentId: id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().avatarAttachmentId).toBe(id);

    // 걸린 사진은 **모두에게** 보인다 — 자기에게만 보이는 아바타는 기능이 아니다.
    const got = await app.inject({
      method: 'GET', url: `/accounts/${agentId}/avatar`, headers: auth(adminToken),
    });
    expect(got.statusCode).toBe(200);
  });

  it('admin 도 걸 수 있다 — 서버의 판정 하나를 그대로 쓴다', async () => {
    const id = await upload(adminToken, 'a.png', PNG, 'image/png');
    const res = await app.inject({
      method: 'PUT', url: `/accounts/agents/${agentId}/avatar`,
      headers: auth(adminToken), payload: { attachmentId: id },
    });
    expect(res.statusCode).toBe(200);
  });

  it('소유자도 admin 도 아니면 거절한다', async () => {
    const inv = await app.inject({
      method: 'POST', url: '/invites', headers: auth(adminToken),
    });
    await app.inject({
      method: 'POST', url: '/auth/register',
      payload: {
        handle: 'stranger', loginId: 'stranger', displayName: 'S', password: 'pw123456',
        inviteToken: inv.json().token as string,
      },
    });
    // 등록은 id 만 준다 — 토큰은 로그인에서 온다(위 `other` 준비와 같은 경로).
    const login = await app.inject({
      method: 'POST', url: '/auth/login', payload: { loginId: 'stranger', password: 'pw123456' },
    });
    const strangerToken = login.json().token as string;
    const id = await upload(strangerToken, 's.png', PNG, 'image/png');

    const res = await app.inject({
      method: 'PUT', url: `/accounts/agents/${agentId}/avatar`,
      headers: auth(strangerToken), payload: { attachmentId: id },
    });
    expect(res.statusCode).toBe(403);
  });

  it('이미지가 아니면 걸지 않는다 — `me` 와 같은 판정이다', async () => {
    const id = await upload(otherToken, 'evil.png', HTML, 'image/png');
    const res = await app.inject({
      method: 'PUT', url: `/accounts/agents/${agentId}/avatar`,
      headers: auth(otherToken), payload: { attachmentId: id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_an_image');
  });

  it('남의 업로드를 가져다 걸 수 없다', async () => {
    // admin 이 올린 업로드를 소유자가 자기 에이전트에 걸려고 한다.
    const theirs = await upload(adminToken, 'theirs.png', PNG, 'image/png');
    const res = await app.inject({
      method: 'PUT', url: `/accounts/agents/${agentId}/avatar`,
      headers: auth(otherToken), payload: { attachmentId: theirs },
    });
    expect(res.statusCode).toBe(404);
  });

  it('이 서버에 없는 에이전트 id 면 admin 이어도 404 다 — 0행을 고치고 200 을 내지 않는다', async () => {
    // 데스크톱이 다른 커뮤니티의 에이전트 id 로 부르는 경우다. 전에는 admin 이 술어를 통과하고
    // update 가 0행을 고쳐 200 이었다 — 화면은 성공을 말하는데 어디에도 사진이 없었다.
    const missing = '00000000-0000-4000-8000-000000000000';
    const id = await upload(adminToken, 'ghost.png', PNG, 'image/png');
    const set = await app.inject({
      method: 'PUT', url: `/accounts/agents/${missing}/avatar`,
      headers: auth(adminToken), payload: { attachmentId: id },
    });
    expect(set.statusCode).toBe(404);
    const cleared = await app.inject({
      method: 'PUT', url: `/accounts/agents/${missing}/avatar`,
      headers: auth(adminToken), payload: { attachmentId: null },
    });
    expect(cleared.statusCode).toBe(404);
  });

  it('사람 계정 id 로는 에이전트 라우트가 걸지 않는다', async () => {
    const id = await upload(adminToken, 'human.png', PNG, 'image/png');
    const res = await app.inject({
      method: 'PUT', url: `/accounts/agents/${otherId}/avatar`,
      headers: auth(adminToken), payload: { attachmentId: id },
    });
    expect(res.statusCode).toBe(404);
  });

  it('지운 에이전트에는 걸지 않는다', async () => {
    const made = await app.inject({
      method: 'POST', url: '/accounts/agents', headers: auth(adminToken),
      payload: { handle: 'gonebot', displayName: 'gonebot' },
    });
    const goneId = made.json().id as string;
    expect((await app.inject({ method: 'DELETE', url: `/accounts/agents/${goneId}`, headers: auth(adminToken) })).statusCode).toBe(204);
    const id = await upload(adminToken, 'gone.png', PNG, 'image/png');
    const res = await app.inject({
      method: 'PUT', url: `/accounts/agents/${goneId}/avatar`,
      headers: auth(adminToken), payload: { attachmentId: id },
    });
    expect(res.statusCode).toBe(404);
  });

  it('명시적 null 로 지운다 — 키가 없으면 400 이다', async () => {
    const cleared = await app.inject({
      method: 'PUT', url: `/accounts/agents/${agentId}/avatar`,
      headers: auth(otherToken), payload: { attachmentId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().avatarAttachmentId).toBeNull();

    // 키를 빼면 `JSON.stringify` 가 버려 조작이 조용히 무시된다 — 그래서 400 이다.
    const missing = await app.inject({
      method: 'PUT', url: `/accounts/agents/${agentId}/avatar`,
      headers: auth(otherToken), payload: {},
    });
    expect(missing.statusCode).toBe(400);
  });
});

/**
 * SVG 판정을 함수로 직접 본다. 라우트를 지나는 검사는 한 번 통과하면 그것으로 끝이지만,
 * 여기서 막는 것들은 **각각 다른 이유로** 막는 것이라 하나씩 세워 두어야 나중에 누가
 * 정규식을 손댈 때 무엇이 깨졌는지 보인다.
 */
describe('가로·세로 상한 (사진 후속 ① · security n6)', () => {
  /** 한 색 PNG — 압축이 잘 돼서 파일은 작은데 풀면 크다(압축 폭탄의 모양). */
  const solid = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 3, background: '#888' } }).png().toBuffer();

  it('한 변이 상한을 넘는 아바타는 파일이 작아도 거절하고, 걸지 않는다', async () => {
    const wide = await solid(AVATAR_PIXEL_LIMITS.avatar.maxSide + 1, 4);
    expect(wide.length).toBeLessThan(4096); // 업로드 상한(4KiB) 안 — 바이트로는 못 막는다.
    const before = (await meView(adminToken)).avatarAttachmentId;
    const id = await upload(adminToken, 'wide.png', wide, 'image/png');
    const res = await setAvatar(adminToken, { attachmentId: id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('image_dimensions_too_large');
    expect((await meView(adminToken)).avatarAttachmentId).toBe(before);
  });

  it('상한 안의 그림은 지난다 — 경계값', async () => {
    const edge = await solid(AVATAR_PIXEL_LIMITS.avatar.maxSide, 1);
    const id = await upload(adminToken, 'edge.png', edge, 'image/png');
    expect((await setAvatar(adminToken, { attachmentId: id })).statusCode).toBe(200);
  });

  it('원본(사진 맞추기)은 넉넉한 상한이라 큰 폰 사진 크기도 지나고, 그보다 크면 막는다', async () => {
    const cropped = await upload(adminToken, 'c.png', PNG, 'image/png');
    const phone = await upload(adminToken, 'phone.png', await solid(8064, 2), 'image/png');
    const ok = await setAvatar(adminToken, { attachmentId: cropped, source: { attachmentId: phone, crop: { x: 0, y: 0, size: 1 } } });
    expect(ok.statusCode).toBe(200);

    const cropped2 = await upload(adminToken, 'c2.png', PNG, 'image/png');
    const huge = await upload(adminToken, 'huge.png', await solid(AVATAR_PIXEL_LIMITS.original.maxSide + 1, 1), 'image/png');
    const bad = await setAvatar(adminToken, { attachmentId: cropped2, source: { attachmentId: huge, crop: { x: 0, y: 0, size: 1 } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('image_dimensions_too_large');
  });

  it('매직 바이트만 그림이고 헤더가 깨진 파일은 크기를 모르니 받지 않는다', async () => {
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
    const id = await upload(adminToken, 'fake.png', fake, 'image/png');
    const res = await setAvatar(adminToken, { attachmentId: id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_an_image');
  });
});

describe('옛 사진 정리 (사진 후속 ② · security n1·n2)', () => {
  const exists = async (id: string) =>
    (await pool.query(`select 1 from attachment where id = $1`, [id])).rowCount === 1;
  const fileOf = async (id: string) =>
    (await pool.query<{ k: string }>(`select storage_key as k from attachment where id = $1`, [id])).rows[0]!.k;
  const onDisk = async (key: string) => {
    try { await (await import('node:fs/promises')).access(join(storageRoot, key)); return true; } catch { return false; }
  };

  it('사진을 바꾸면 옛 아바타·옛 원본의 행과 파일이 지워진다', async () => {
    const o1 = await upload(otherToken, 'o1.png', PNG, 'image/png');
    const c1 = await upload(otherToken, 'c1.png', PNG, 'image/png');
    await setAvatar(otherToken, { attachmentId: c1, source: { attachmentId: o1, crop: { x: 0, y: 0, size: 1 } } });
    const [k1, k2] = [await fileOf(o1), await fileOf(c1)];

    const c2 = await upload(otherToken, 'c2.png', PNG, 'image/png');
    expect((await setAvatar(otherToken, { attachmentId: c2 })).statusCode).toBe(200);
    expect(await exists(o1)).toBe(false);
    expect(await exists(c1)).toBe(false);
    expect(await onDisk(k1)).toBe(false);
    expect(await onDisk(k2)).toBe(false);
    expect(await exists(c2)).toBe(true);
  });

  it('옛 사진을 원본으로 다시 맞추면 옛 사진은 원본으로 남는다', async () => {
    const legacy = await upload(otherToken, 'legacy.png', PNG, 'image/png');
    await setAvatar(otherToken, { attachmentId: legacy });
    const cropped = await upload(otherToken, 'cr.png', PNG, 'image/png');
    await setAvatar(otherToken, { attachmentId: cropped, source: { attachmentId: legacy, crop: { x: 0, y: 0, size: 1 } } });
    expect(await exists(legacy)).toBe(true);
    expect(await exists(cropped)).toBe(true);
  });

  it('지우기(null)도 정리한다', async () => {
    const c = await upload(otherToken, 'd.png', PNG, 'image/png');
    await setAvatar(otherToken, { attachmentId: c });
    await setAvatar(otherToken, { attachmentId: null });
    expect(await exists(c)).toBe(false);
  });

  it('같은 업로드를 다른 계정(내 에이전트)이 쓰면 남긴다', async () => {
    const created = await app.inject({
      method: 'POST', url: '/accounts/agents', headers: auth(adminToken),
      payload: { handle: 'picsharebot', displayName: 'picsharebot' },
    });
    const agentId = created.json().id as string;
    const shared = await upload(adminToken, 'shared.png', PNG, 'image/png');
    await setAvatar(adminToken, { attachmentId: shared });
    await app.inject({
      method: 'PUT', url: `/accounts/agents/${agentId}/avatar`, headers: auth(adminToken), payload: { attachmentId: shared },
    });
    const mine = await upload(adminToken, 'mine-only.png', PNG, 'image/png');
    // 내 원본 = 에이전트와 같이 쓰는 그림, 내 아바타 = 나만 쓰는 그림. 바꾸면 후보가 둘이다.
    await setAvatar(adminToken, { attachmentId: mine, source: { attachmentId: shared, crop: { x: 0, y: 0, size: 1 } } });
    const next = await upload(adminToken, 'next.png', PNG, 'image/png');
    await setAvatar(adminToken, { attachmentId: next });
    expect(await exists(shared)).toBe(true);
    // 같이 쓰는 후보가 섞여도 나만 쓰던 것은 지워진다 — 쓰이는지 검사가 없으면 FK 가 삭제문 전체를 막아 이것도 남는다.
    expect(await exists(mine)).toBe(false);
  });

  it('에이전트를 지우면 사진 칸을 비우고 파일을 치운다(security n2)', async () => {
    const created = await app.inject({
      method: 'POST', url: '/accounts/agents', headers: auth(adminToken),
      payload: { handle: 'picgonebot', displayName: 'picgonebot' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agentId = created.json().id as string;
    const o = await upload(adminToken, 'go.png', PNG, 'image/png');
    const c = await upload(adminToken, 'gc.png', PNG, 'image/png');
    await app.inject({
      method: 'PUT', url: `/accounts/agents/${agentId}/avatar`, headers: auth(adminToken),
      payload: { attachmentId: c, source: { attachmentId: o, crop: { x: 0, y: 0, size: 1 } } },
    });
    const del = await app.inject({ method: 'DELETE', url: `/accounts/agents/${agentId}`, headers: auth(adminToken) });
    expect(del.statusCode, del.body).toBe(204);
    const row = await pool.query(
      `select avatar_attachment_id, avatar_source_attachment_id, avatar_crop from account where id = $1`, [agentId]);
    expect(row.rows[0]).toEqual({ avatar_attachment_id: null, avatar_source_attachment_id: null, avatar_crop: null });
    expect(await exists(o)).toBe(false);
    expect(await exists(c)).toBe(false);
  });
});

describe('SVG 아바타를 모바일용으로 굳힌다 (사진 후속 ③)', () => {
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('raster=1 이면 걸린 SVG 를 PNG 로 내고, 없으면 SVG 그대로다', async () => {
    const id = await upload(otherToken, 'r.svg', SVG, 'image/svg+xml');
    expect((await setAvatar(otherToken, { attachmentId: id })).statusCode).toBe(200);

    const png = await app.inject({ method: 'GET', url: `/accounts/${otherId}/avatar?v=${id}&raster=1`, headers: auth(adminToken) });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toContain('image/png');
    expect(png.rawPayload.subarray(0, 8)).toEqual(PNG_SIG);
    // 방어 헤더는 같다.
    expect(png.headers['x-content-type-options']).toBe('nosniff');
    expect(png.headers['content-disposition']).toContain('attachment');

    const svg = await app.inject({ method: 'GET', url: `/accounts/${otherId}/avatar?v=${id}`, headers: auth(adminToken) });
    expect(svg.headers['content-type']).toContain('image/svg+xml');
  });

  it('래스터 아바타는 raster=1 이어도 바이트를 그대로 낸다', async () => {
    const id = await upload(otherToken, 'p.png', PNG, 'image/png');
    await setAvatar(otherToken, { attachmentId: id });
    const res = await app.inject({ method: 'GET', url: `/accounts/${otherId}/avatar?raster=1`, headers: auth(adminToken) });
    expect(res.rawPayload).toEqual(PNG);
  });

  it('굳힌 그림은 정해진 크기의 정사각형이다', async () => {
    const out = await rasterizeSvgAvatar(SVG);
    expect(out).not.toBeNull();
    const meta = await sharp(out!).metadata();
    expect([meta.width, meta.height]).toEqual([SVG_RASTER_PX, SVG_RASTER_PX]);
  });

  it('정사각이 아닌 SVG 는 꽉 채워 자른다 — 투명 띠 없이(데스크톱 object-cover 와 같게, designer s1)', async () => {
    const wide = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="8" viewBox="0 0 32 8"><rect width="32" height="8" fill="#c00"/></svg>');
    const out = await rasterizeSvgAvatar(wide);
    expect(out).not.toBeNull();
    const { data, info } = await sharp(out!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // 위·아래 모서리 픽셀이 투명하면 contain(띠)이다. cover 면 빨강으로 차 있다.
    for (const [x, y] of [[0, 0], [info.width - 1, 0], [0, info.height - 1], [info.width - 1, info.height - 1]]) {
      const i = (y! * info.width + x!) * info.channels;
      expect(data[i + 3], `alpha at ${x},${y}`).toBe(255);
      expect(data[i], `red at ${x},${y}`).toBeGreaterThan(150);
    }
  });

  it('밖을 가리키는 참조가 있으면 굳히지 않는다 — 서버가 파일·내부 주소를 읽는 통로가 되지 않게', async () => {
    const wrap = (inner: string) =>
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 8 8">${inner}</svg>`);
    for (const inner of [
      '<image href="file:///etc/passwd" width="8" height="8"/>',
      '<image xlink:href="http://169.254.169.254/latest" width="8" height="8"/>',
      '<rect width="8" height="8" style="fill:url(https://example.com/x.svg#p)"/>',
      "<image href='/etc/hosts' width='8' height='8'/>",
    ]) {
      expect(await rasterizeSvgAvatar(wrap(inner)), inner).toBeNull();
    }
    // 조각(#)과 data: 는 밖이 아니다.
    expect(await rasterizeSvgAvatar(wrap('<defs><linearGradient id="g"/></defs><rect width="8" height="8" fill="url(#g)"/>'))).not.toBeNull();
  });

  it('굳히지 못하는 SVG 는 원래 바이트로 떨어진다', async () => {
    const ext = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><image href="http://example.com/a.png" width="8" height="8"/></svg>');
    const id = await upload(otherToken, 'ext.svg', ext, 'image/svg+xml');
    expect((await setAvatar(otherToken, { attachmentId: id })).statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: `/accounts/${otherId}/avatar?raster=1`, headers: auth(adminToken) });
    expect(res.headers['content-type']).toContain('image/svg+xml');
  });
});

describe('looksLikeSvg', () => {
  const svg = (inner: string) => Buffer.from(inner);

  it('프롤로그가 붙어도 SVG 로 본다', () => {
    expect(looksLikeSvg(svg('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(true);
    expect(looksLikeSvg(svg('\ufeff  <?xml version="1.0"?><!-- 주석 --><svg viewBox="0 0 1 1"></svg>'))).toBe(true);
    // 내부 서브셋이 없는 DOCTYPE 은 옛 그리기 도구가 흔히 붙인다 — 그걸로 튕기면 안 된다.
    expect(looksLikeSvg(svg('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd"><svg/>'))).toBe(true);
  });

  it('SVG 가 아닌 것은 거절한다', () => {
    expect(looksLikeSvg(HTML)).toBe(false);
    expect(looksLikeSvg(svg('<html><body><svg/></body></html>'))).toBe(false);
    expect(looksLikeSvg(PNG)).toBe(false);
    expect(looksLikeSvg(svg('<svgx/>'))).toBe(false);
  });

  it('스크립트가 될 수 있는 조각을 거절한다', () => {
    expect(looksLikeSvg(svg('<svg><script>alert(1)</script></svg>'))).toBe(false);
    expect(looksLikeSvg(svg('<svg onload="alert(1)"/>'))).toBe(false);
    expect(looksLikeSvg(svg('<svg><a href="javascript:alert(1)"><rect/></a></svg>'))).toBe(false);
    expect(looksLikeSvg(svg('<svg><foreignObject><b>x</b></foreignObject></svg>'))).toBe(false);
    // 엔티티를 선언할 수 있는 자리는 통째로 막는다(XXE·엔티티 폭탄).
    expect(looksLikeSvg(svg('<!DOCTYPE svg [<!ENTITY a "b">]><svg/>'))).toBe(false);
  });

  it('startsLikeSvg 는 뿌리만 보고, 그것만으로 받아 주지 않는다', () => {
    // 상한을 넘긴 파일의 **거절 이유**를 가르는 데만 쓰는 판정이다. 스크립트를 담았어도
    // 뿌리가 svg 면 true 다 — 그래서 이것으로 통과시키면 안 된다는 것이 계약이다.
    const evil = svg('<svg><script>alert(1)</script></svg>');
    expect(startsLikeSvg(evil)).toBe(true);
    expect(looksLikeSvg(evil)).toBe(false);
    // 앞부분만 잘려 있어도 답한다(상한 넘는 파일은 앞 4 KiB 만 읽어 온다).
    expect(startsLikeSvg(svg('<?xml version="1.0"?><svg viewBox="0 0 1 1"><rect'))).toBe(true);
    expect(startsLikeSvg(HTML)).toBe(false);
  });
});

describe('사진 맞추기 — 원본과 고른 자리(S1)', () => {
  let agentId: string;
  const CROP = { x: 0.25, y: 0, size: 0.5 };

  const source = (id: string, token: string) =>
    app.inject({ method: 'GET', url: `/accounts/${id}/avatar/source`, headers: auth(token) });

  beforeAll(async () => {
    const created = await app.inject({
      method: 'POST', url: '/accounts/agents', headers: auth(adminToken),
      payload: { handle: 'cropbot', displayName: 'cropbot' },
    });
    agentId = created.json().id as string;
    await app.inject({
      method: 'PATCH', url: `/accounts/agents/${agentId}`, headers: auth(adminToken),
      payload: { ownerAccountId: otherId },
    });
  });

  it('잘라 올린 아바타와 함께 원본·자리를 남기고, 원본 라우트가 둘을 한 응답으로 준다', async () => {
    const original = await upload(otherToken, 'orig.png', PNG, 'image/png');
    const cropped = await upload(otherToken, 'crop.png', PNG, 'image/png');
    const set = await setAvatar(otherToken, { attachmentId: cropped, source: { attachmentId: original, crop: CROP } });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ avatarAttachmentId: cropped });

    const res = await source(otherId, otherToken);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.headers['x-harkroom-avatar-source'] as string)).toEqual({ attachmentId: original, crop: CROP });
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // 걸린 아바타는 그대로 잘린 쪽이다 — 그리는 쪽은 원본을 모른다.
    expect((await meView(otherToken)).avatarAttachmentId).toBe(cropped);
  });

  it('다시 맞출 때는 원본을 새로 올리지 않고 걸린 원본을 다시 가리킨다', async () => {
    // 첫 저장의 원본을 두 번째 저장이 그대로 다시 가리킨다(자리만 바뀐다).
    const orig = await upload(otherToken, 'orig2.png', PNG, 'image/png');
    const first = await upload(otherToken, 'c1.png', PNG, 'image/png');
    await setAvatar(otherToken, { attachmentId: first, source: { attachmentId: orig, crop: CROP } });
    const second = await upload(otherToken, 'c2.png', PNG, 'image/png');
    const moved = { x: 0.1, y: 0.2, size: 0.3 };
    const res = await setAvatar(otherToken, { attachmentId: second, source: { attachmentId: orig, crop: moved } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse((await source(otherId, otherToken)).headers['x-harkroom-avatar-source'] as string)).toEqual({ attachmentId: orig, crop: moved });
  });

  it('원본이 없는 옛 사진은 걸린 아바타를 원본으로 삼을 수 있다 — 업로더가 달라도', async () => {
    // admin 이 올려 건 에이전트 사진을 소유자(other)가 다시 맞춘다.
    const legacy = await upload(adminToken, 'legacy.png', PNG, 'image/png');
    expect((await app.inject({
      method: 'PUT', url: `/accounts/agents/${agentId}/avatar`, headers: auth(adminToken), payload: { attachmentId: legacy },
    })).statusCode).toBe(200);
    expect((await source(agentId, otherToken)).statusCode).toBe(404);

    const cropped = await upload(otherToken, 'agent-crop.png', PNG, 'image/png');
    const res = await app.inject({
      method: 'PUT', url: `/accounts/agents/${agentId}/avatar`, headers: auth(otherToken),
      payload: { attachmentId: cropped, source: { attachmentId: legacy, crop: CROP } },
    });
    expect(res.statusCode).toBe(200);
    expect((await source(agentId, otherToken)).statusCode).toBe(200);
  });

  it('남의 업로드는 원본으로도 걸 수 없고, 아바타도 걸리지 않는다', async () => {
    const theirs = await upload(adminToken, 'theirs.png', PNG, 'image/png');
    const mine = await upload(otherToken, 'mine.png', PNG, 'image/png');
    const before = (await meView(otherToken)).avatarAttachmentId;
    const res = await setAvatar(otherToken, { attachmentId: mine, source: { attachmentId: theirs, crop: CROP } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('source_not_found');
    expect((await meView(otherToken)).avatarAttachmentId).toBe(before);
  });

  it('이미지가 아닌 원본은 거절한다', async () => {
    const html = await upload(otherToken, 'x.html', HTML, 'text/html');
    const mine = await upload(otherToken, 'ok.png', PNG, 'image/png');
    const res = await setAvatar(otherToken, { attachmentId: mine, source: { attachmentId: html, crop: CROP } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_an_image');
  });

  it('자리가 0~1 밖이거나 크기가 0 이면 400 이다', async () => {
    const orig = await upload(otherToken, 'o.png', PNG, 'image/png');
    const mine = await upload(otherToken, 'm.png', PNG, 'image/png');
    for (const crop of [{ x: -0.1, y: 0, size: 0.5 }, { x: 0, y: 1.5, size: 0.5 }, { x: 0, y: 0, size: 0 }]) {
      const res = await setAvatar(otherToken, { attachmentId: mine, source: { attachmentId: orig, crop } });
      expect(res.statusCode).toBe(400);
    }
  });

  it('원본 없이 새 사진을 걸면(옛 앱) 원본 칸을 비운다', async () => {
    const orig = await upload(otherToken, 'o2.png', PNG, 'image/png');
    const c = await upload(otherToken, 'c3.png', PNG, 'image/png');
    await setAvatar(otherToken, { attachmentId: c, source: { attachmentId: orig, crop: CROP } });
    const plain = await upload(otherToken, 'plain.png', PNG, 'image/png');
    expect((await setAvatar(otherToken, { attachmentId: plain })).statusCode).toBe(200);
    expect((await source(otherId, otherToken)).statusCode).toBe(404);
  });

  it('지우면 원본도 함께 지운다', async () => {
    const orig = await upload(otherToken, 'o3.png', PNG, 'image/png');
    const c = await upload(otherToken, 'c4.png', PNG, 'image/png');
    await setAvatar(otherToken, { attachmentId: c, source: { attachmentId: orig, crop: CROP } });
    expect((await setAvatar(otherToken, { attachmentId: null })).statusCode).toBe(200);
    expect((await source(otherId, otherToken)).statusCode).toBe(404);
  });

  it('원본은 모두에게 열지 않는다 — 남의 사람 계정은 admin 이어도, 에이전트는 소유자·admin 만', async () => {
    const orig = await upload(otherToken, 'o4.png', PNG, 'image/png');
    const c = await upload(otherToken, 'c5.png', PNG, 'image/png');
    await setAvatar(otherToken, { attachmentId: c, source: { attachmentId: orig, crop: CROP } });
    // 걸린 아바타는 admin 이 받지만 원본은 못 받는다.
    expect((await source(otherId, adminToken)).statusCode).toBe(403);
    // 에이전트 원본은 admin 도 받는다(다시 맞출 수 있는 사람이다).
    expect((await source(agentId, adminToken)).statusCode).toBe(200);
    // 남의 사람 계정 원본을 일반 계정이 부르면 거절.
    expect([403, 404]).toContain((await source(adminId, otherToken)).statusCode);
  });
});
