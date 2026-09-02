import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let channelId: string;
let storageRoot: string;

const MAX = 2048;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  storageRoot = await mkdtemp(join(tmpdir(), 'murmur-att-'));
  app = await buildServer({ pool: db.pool, storage: { root: storageRoot, maxBytes: MAX } });
  ({ token: adminToken } = await bootstrapAdmin(app));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'files' },
  });
  channelId = ch.json().id;
});
afterAll(async () => {
  await app.close(); await stop();
  await rm(storageRoot, { recursive: true, force: true });
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** multipart 본문을 손으로 만든다 — 테스트가 실제 wire 형식을 지나가야 한다. */
function multipart(filename: string, content: string | Buffer, contentType = 'text/plain') {
  const boundary = '----murmurtest';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, Buffer.isBuffer(content) ? content : Buffer.from(content), tail]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const upload = (filename: string, content: string | Buffer, token = adminToken, ct?: string) => {
  const m = multipart(filename, content, ct);
  return app.inject({
    method: 'POST', url: '/uploads', headers: { ...auth(token), ...m.headers }, payload: m.body,
  });
};

const say = (body: string, attachmentIds: string[], token = adminToken) =>
  app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token),
    payload: { body, attachmentIds },
  });

const messages = async (token = adminToken) => {
  const res = await app.inject({
    method: 'GET', url: `/channels/${channelId}/messages`, headers: auth(token),
  });
  return res.json().messages as Array<{
    id: string;
    attachments: Array<{ id: string; filename: string; sizeBytes: number; contentType: string }>;
  }>;
};

describe('uploading a file', () => {
  it('accepts a file and reports what it stored', async () => {
    const res = await upload('note.txt', 'hello');

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ filename: 'note.txt', sizeBytes: 5, contentType: 'text/plain' });
    expect(res.json().id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // 제한을 넘는 파일을 끝까지 받아 놓고 거절하면 제한이 제한이 아니다.
  it('refuses a file past the size limit', async () => {
    const res = await upload('big.bin', 'x'.repeat(MAX + 1));

    expect(res.statusCode).toBe(413);
  });

  // multipart 파서가 제한에서 스트림을 조용히 잘라내면, 그 잘린 바이트를 성공으로 저장할 수
  // 있다 — 사용자는 온전한 파일이 올라갔다고 믿는다. 제한이 없는 것보다 나쁘다.
  it('does not keep a truncated file when it refuses', async () => {
    const before = await readdir(storageRoot, { recursive: true, withFileTypes: true });

    await upload('big2.bin', 'y'.repeat(MAX * 2));

    const after = await readdir(storageRoot, { recursive: true, withFileTypes: true });
    expect(after.filter((f) => f.isFile()).length).toBe(before.filter((f) => f.isFile()).length);
  });

  it('refuses an upload with no file part', async () => {
    const res = await app.inject({
      method: 'POST', url: '/uploads', headers: { ...auth(adminToken), 'content-type': 'multipart/form-data; boundary=----x' },
      payload: Buffer.from('------x--\r\n'),
    });

    expect(res.statusCode).toBe(400);
  });

  it('refuses an anonymous upload', async () => {
    const m = multipart('x.txt', 'x');
    const res = await app.inject({ method: 'POST', url: '/uploads', headers: m.headers, payload: m.body });

    expect(res.statusCode).toBe(401);
  });

  // 파일명이 경로가 되면 스토리지 밖에 쓰는 통로가 된다. 이름은 메타데이터로만 남는다.
  it('keeps a path-like filename as a plain name', async () => {
    const res = await upload('../../etc/passwd', 'x');

    expect(res.statusCode).toBe(201);
    expect(res.json().filename).not.toContain('/');
  });
});

describe('attaching an upload to a message', () => {
  it('shows the attachment on the message', async () => {
    const up = (await upload('a.txt', 'aaa')).json();

    const res = await say('파일 보냅니다', [up.id]);

    expect(res.statusCode).toBe(201);
    expect(res.json().attachments).toEqual([
      expect.objectContaining({ id: up.id, filename: 'a.txt', sizeBytes: 3 }),
    ]);
  });

  it('lists the attachment when the channel is read back', async () => {
    const up = (await upload('listed.txt', 'zz')).json();
    const posted = (await say('목록 확인', [up.id])).json();

    const found = (await messages()).find((m) => m.id === posted.id)!;

    expect(found.attachments.map((a) => a.filename)).toEqual(['listed.txt']);
  });

  it('reports no attachments as an empty list, not a missing field', async () => {
    const posted = (await say('첨부 없음', [])).json();

    expect(posted.attachments).toEqual([]);
  });

  it('keeps several attachments in the order they were given', async () => {
    const a = (await upload('1.txt', 'a')).json();
    const b = (await upload('2.txt', 'b')).json();

    const res = await say('두 개', [a.id, b.id]);

    expect(res.json().attachments.map((x: { filename: string }) => x.filename)).toEqual(['1.txt', '2.txt']);
  });

  // 남의 업로드를 자기 메시지에 붙이면, 올린 적 없는 파일을 자기 것으로 게시할 수 있다.
  it('refuses to attach someone else’s upload', async () => {
    const { pat } = await createAgent(app, adminToken, 'thief');
    const mine = (await upload('mine.txt', 'secret')).json();

    const res = await say('남의 업로드', [mine.id], pat);

    expect(res.statusCode).toBe(400);
  });

  // 한 업로드가 여러 메시지에 붙으면 하나를 지울 때 다른 쪽이 깨진다.
  it('refuses to attach the same upload twice', async () => {
    const up = (await upload('once.txt', 'x')).json();
    await say('첫 번째', [up.id]);

    const res = await say('두 번째', [up.id]);

    expect(res.statusCode).toBe(400);
  });

  it('refuses an attachment id that does not exist', async () => {
    const res = await say('없는 첨부', ['00000000-0000-0000-0000-000000000000']);

    expect(res.statusCode).toBe(400);
  });

  // 본문이 비어도 파일만 보내는 것은 자연스럽다.
  it('allows a message that is only an attachment', async () => {
    const up = (await upload('only.txt', 'x')).json();

    const res = await say('', [up.id]);

    expect(res.statusCode).toBe(201);
  });
});

describe('downloading an attachment', () => {
  it('serves exactly the bytes that were uploaded', async () => {
    const up = (await upload('down.txt', 'the bytes')).json();
    await say('내려받기', [up.id]);

    const res = await app.inject({ method: 'GET', url: `/attachments/${up.id}`, headers: auth(adminToken) });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('the bytes');
  });

  // 브라우저가 내용을 스크립트로 해석하면 첨부가 XSS 통로가 된다.
  it('tells the browser not to sniff and not to render inline', async () => {
    const up = (await upload('x.html', '<script>alert(1)</script>', adminToken, 'text/html')).json();
    await say('html', [up.id]);

    const res = await app.inject({ method: 'GET', url: `/attachments/${up.id}`, headers: auth(adminToken) });

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
  });

  it('refuses an anonymous download', async () => {
    const up = (await upload('private.txt', 'x')).json();
    await say('비공개', [up.id]);

    const res = await app.inject({ method: 'GET', url: `/attachments/${up.id}` });

    expect(res.statusCode).toBe(401);
  });

  it('404s for an attachment that does not exist', async () => {
    const res = await app.inject({
      method: 'GET', url: '/attachments/00000000-0000-0000-0000-000000000000', headers: auth(adminToken),
    });

    expect(res.statusCode).toBe(404);
  });

  // 아직 메시지에 붙지 않은 업로드는 올린 사람만 볼 수 있다 — 남이 id 를 맞히면 열리면 안 된다.
  it('hides an unattached upload from everyone but its uploader', async () => {
    const { pat } = await createAgent(app, adminToken, 'peeker');
    const up = (await upload('draft.txt', 'draft')).json();

    const mine = await app.inject({ method: 'GET', url: `/attachments/${up.id}`, headers: auth(adminToken) });
    const theirs = await app.inject({ method: 'GET', url: `/attachments/${up.id}`, headers: auth(pat) });

    expect(mine.statusCode).toBe(200);
    expect(theirs.statusCode).toBe(403);
  });
});

describe('who may download', () => {
  it('refuses a download from outside the dm the message lives in', async () => {
    const { accountId: peerId, pat: peerPat } = await createAgent(app, adminToken, 'dmpeer');
    const { pat: outsiderPat } = await createAgent(app, adminToken, 'dmoutsider');
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: auth(adminToken), payload: { accountIds: [peerId] },
    });
    const dmId = dm.json().id as string;
    const m = multipart('secret.txt', 'top secret');
    const up = (await app.inject({
      method: 'POST', url: '/uploads', headers: { ...auth(peerPat), ...m.headers }, payload: m.body,
    })).json();
    await app.inject({
      method: 'POST', url: `/channels/${dmId}/messages`, headers: auth(peerPat),
      payload: { body: '비밀 파일', attachmentIds: [up.id] },
    });

    const res = await app.inject({
      method: 'GET', url: `/attachments/${up.id}`, headers: auth(outsiderPat),
    });

    expect(res.statusCode).toBe(403);
  });

  // 메시지가 지워지면 첨부도 도달 불가여야 한다 — 아니면 삭제가 삭제가 아니다.
  it('refuses a download once the message is deleted', async () => {
    const up = (await upload('gone.txt', 'x')).json();
    const posted = (await say('지울 메시지', [up.id])).json();
    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${posted.id}`, headers: auth(adminToken),
    });

    const res = await app.inject({ method: 'GET', url: `/attachments/${up.id}`, headers: auth(adminToken) });

    expect(res.statusCode).toBe(404);
  });
});
