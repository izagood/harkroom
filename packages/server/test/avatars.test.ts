import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import { looksLikeSvg } from '../src/services/avatars.js';

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
/** 그리기 도구가 내놓는 모양 그대로 — XML 선언이 앞에 붙는다. */
const SVG = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>',
);

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
});
