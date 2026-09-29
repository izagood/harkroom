import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import { onEvent, type WorkspaceEvent } from '../src/events.js';

// 워크스페이스 아이콘 — 데스크탑 커뮤니티 레일의 사진. 프로필 사진(#159)의 길을 그대로 타므로
// 판정 자체(매직 바이트·SVG 검사)는 avatars.test.ts 가 본다. 여기는 **워크스페이스에 잇는 것**만 본다.

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let memberToken: string;
let storageRoot: string;
let pool: import('pg').Pool;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  storageRoot = await mkdtemp(join(tmpdir(), 'harkroom-wsicon-'));
  app = await buildServer({ pool: db.pool, storage: { root: storageRoot, maxBytes: 4096 } });
  ({ token: adminToken } = await bootstrapAdmin(app));
  const inv = await app.inject({
    method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` },
  });
  await app.inject({
    method: 'POST', url: '/auth/register',
    payload: {
      handle: 'member', loginId: 'member', displayName: 'Member', password: 'pw123456',
      inviteToken: inv.json().token as string,
    },
  });
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { loginId: 'member', password: 'pw123456' },
  });
  memberToken = login.json().token as string;
});
afterAll(async () => {
  await app.close(); await stop();
  await rm(storageRoot, { recursive: true, force: true });
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function upload(token: string, filename: string, content: Buffer, contentType: string): Promise<string> {
  const boundary = '----harkroomtest';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
      + `Content-Type: ${contentType}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: 'POST', url: '/uploads',
    headers: { ...auth(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

const setIcon = (token: string, payload: unknown) => app.inject({
  method: 'PUT', url: '/settings/workspace-icon', headers: auth(token), payload: payload as object,
});
const getIcon = (token: string) => app.inject({ method: 'GET', url: '/workspace/icon', headers: auth(token) });

describe('워크스페이스 아이콘', () => {
  it('걸린 것이 없으면 404 — 데스크탑은 글자로 폴백한다', async () => {
    expect((await getIcon(memberToken)).statusCode).toBe(404);
  });

  it('admin 이 걸면 멤버 전원이 그 바이트를 받는다(아바타와 같은 방어 헤더)', async () => {
    const events: WorkspaceEvent[] = [];
    const off = onEvent((e) => { if (e.type === 'workspace.icon.changed') events.push(e); });
    const id = await upload(adminToken, 'icon.png', PNG, 'image/png');
    const set = await setIcon(adminToken, { attachmentId: id });
    off();
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ iconAttachmentId: id });
    expect(events).toEqual([{ type: 'workspace.icon.changed', iconAttachmentId: id }]);

    // 첨부 라우트로는 멤버가 403 이다(붙지 않은 업로드는 올린 사람만) — 그래서 전용 라우트다.
    const res = await getIcon(memberToken);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers.etag).toBe(`"${id}"`);
    expect(res.rawPayload.subarray(0, 8)).toEqual(PNG.subarray(0, 8));

    const audit = await pool.query(
      `select detail from audit_log where action = 'workspace.icon.updated' order by id desc limit 1`,
    );
    expect(audit.rows[0]?.detail).toMatchObject({ before: null, after: id });
  });

  it('멤버는 바꿀 수 없다 — 모든 멤버의 화면에 걸리는 얼굴이다', async () => {
    const id = await upload(memberToken, 'mine.png', PNG, 'image/png');
    expect((await setIcon(memberToken, { attachmentId: id })).statusCode).toBe(403);
  });

  it('남의 업로드는 걸 수 없다', async () => {
    const id = await upload(memberToken, 'theirs.png', PNG, 'image/png');
    expect((await setIcon(adminToken, { attachmentId: id })).statusCode).toBe(404);
  });

  it('이미지가 아니면 400 이고 걸려 있던 것은 그대로다', async () => {
    const before = (await getIcon(memberToken)).headers.etag;
    const id = await upload(adminToken, 'x.html', HTML, 'image/png');
    const res = await setIcon(adminToken, { attachmentId: id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_an_image');
    expect((await getIcon(memberToken)).headers.etag).toBe(before);
  });

  it('키가 없으면 400, 명시적 null 이 지운다', async () => {
    expect((await setIcon(adminToken, {})).statusCode).toBe(400);
    const cleared = await setIcon(adminToken, { attachmentId: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ iconAttachmentId: null });
    expect((await getIcon(memberToken)).statusCode).toBe(404);
  });

  it('로그인하지 않으면 읽을 수 없다', async () => {
    expect((await app.inject({ method: 'GET', url: '/workspace/icon' })).statusCode).toBe(401);
  });
});
