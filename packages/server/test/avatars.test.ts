import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let otherToken: string;
let otherId: string;
let storageRoot: string;

/** 진짜 PNG 시그니처(8바이트) + 뒤를 채우는 바이트. 판정은 앞 12바이트만 본다. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
/** 이미지가 아닌 파일. `<script>` 를 담은 HTML 이 아바타로 전원에게 서빙되면 안 된다. */
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  storageRoot = await mkdtemp(join(tmpdir(), 'murmur-avatar-'));
  app = await buildServer({ pool: db.pool, storage: { root: storageRoot, maxBytes: 4096 } });
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
  await app.close(); await stop();
  await rm(storageRoot, { recursive: true, force: true });
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** multipart 본문을 손으로 만든다 — 테스트가 실제 wire 형식을 지나가야 한다. */
function multipart(filename: string, content: Buffer, contentType: string) {
  const boundary = '----murmurtest';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, content, tail]), boundary };
}

async function upload(token: string, filename: string, content: Buffer, contentType: string): Promise<string> {
  const m = multipart(filename, content, contentType);
  const res = await app.inject({
    method: 'POST', url: '/uploads',
    headers: { ...auth(token), 'content-type': `multipart/form-data; boundary=${m.boundary}` },
    payload: m.body,
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

const setAvatar = (token: string, payload: unknown) =>
  app.inject({ method: 'PUT', url: '/accounts/me/avatar', headers: auth(token), payload: payload as object });

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
