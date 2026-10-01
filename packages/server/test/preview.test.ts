import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { PREVIEW_TOKEN_TTL_MS, signPreviewToken, verifyPreviewToken } from '../src/services/artifactPreview.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let channelId: string;
let storageRoot: string;
// 시계는 시험이 쥔다 — 만료를 기다리지 않고 잰다.
let clock = Date.parse('2026-10-02T00:00:00Z');

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  storageRoot = await mkdtemp(join(tmpdir(), 'harkroom-preview-'));
  app = await buildServer({
    pool: db.pool, storage: { root: storageRoot, maxBytes: 8 * 1024 * 1024 }, previewNow: () => clock,
  });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'previews' },
  });
  channelId = ch.json().id;
});
afterAll(async () => {
  await app.close(); await stop();
  await rm(storageRoot, { recursive: true, force: true });
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

function multipart(filename: string, content: string | Buffer, contentType: string) {
  const boundary = '----harkroompreview';
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

/** 메시지에 붙은 첨부 하나를 만든다. */
async function postFile(
  content: string | Buffer, opts: { token?: string; channel?: string; contentType?: string; name?: string } = {},
): Promise<{ attachmentId: string; messageId: string }> {
  const token = opts.token ?? adminToken;
  const m = multipart(opts.name ?? 'page.html', content, opts.contentType ?? 'text/html');
  const up = await app.inject({
    method: 'POST', url: '/uploads', headers: { ...auth(token), ...m.headers }, payload: m.body,
  });
  expect(up.statusCode).toBe(201);
  const msg = await app.inject({
    method: 'POST', url: `/channels/${opts.channel ?? channelId}/messages`, headers: auth(token),
    payload: { body: '시안', attachmentIds: [up.json().id] },
  });
  expect(msg.statusCode).toBe(201);
  return { attachmentId: up.json().id, messageId: msg.json().id };
}

/** 첨부를 미리보기 버전으로 건다. 만드는 도구(artifact.publish)는 다음 PR 이라 여기선 SQL 로 건다. */
async function asVersion(attachmentId: string, opts: { artifactId?: string; channel?: string; by?: string } = {}) {
  let artifactId = opts.artifactId;
  if (!artifactId) {
    const a = await pool.query(
      `insert into artifact (channel_id, title, created_by) values ($1, 'Inbox 상태 보드', $2) returning id`,
      [opts.channel ?? channelId, opts.by ?? adminId],
    );
    artifactId = a.rows[0].id as string;
  }
  await pool.query(
    `insert into artifact_version (artifact_id, version, attachment_id)
     values ($1, coalesce((select max(version) from artifact_version where artifact_id = $1), 0) + 1, $2)`,
    [artifactId, attachmentId],
  );
  return artifactId;
}

const issue = (attachmentId: string, token = adminToken) =>
  app.inject({ method: 'POST', url: `/attachments/${attachmentId}/preview`, headers: auth(token) });

const PAGE = '<!doctype html><title>시안</title><script>document.title="ok"</script>';

describe('opening a preview', () => {
  it('serves the uploaded html behind a short-lived path, without a bearer header', async () => {
    const { attachmentId } = await postFile(PAGE);
    await asVersion(attachmentId);

    const res = await issue(attachmentId);
    expect(res.statusCode).toBe(201);
    const { path, expiresAt } = res.json();
    expect(path).toMatch(/^\/preview\/[^/]+$/);
    expect(Date.parse(expiresAt) - clock).toBe(PREVIEW_TOKEN_TTL_MS);

    const page = await app.inject({ method: 'GET', url: path });
    expect(page.statusCode).toBe(200);
    expect(page.body).toBe(PAGE);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  // 격리의 전부가 이 헤더다. allow-same-origin 이 끼면 에이전트 스크립트가 서버 origin 에서 돈다.
  it('always sandboxes the page into an opaque origin', async () => {
    const { attachmentId } = await postFile(PAGE);
    await asVersion(attachmentId);
    const page = await app.inject({ method: 'GET', url: (await issue(attachmentId)).json().path });

    const csp = String(page.headers['content-security-policy']);
    const directives = csp.split(';').map((d) => d.trim());
    const sandbox = directives.find((d) => d.startsWith('sandbox'));
    expect(sandbox).toBeDefined();
    expect(sandbox).not.toContain('allow-same-origin');
    expect(sandbox).not.toContain('allow-top-navigation');
    expect(sandbox).not.toContain('allow-forms');
    expect(directives).toContain("connect-src 'none'");
    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain("form-action 'none'");
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['cache-control']).toBe('no-store');
    // 첨부 다운로드처럼 attachment 로 내려가면 프레임이 비어 보인다 — 여기선 문서다.
    expect(page.headers['content-disposition']).toBeUndefined();
  });

  it('reports which artifact and version the attachment is', async () => {
    const v1 = await postFile(PAGE);
    const artifactId = await asVersion(v1.attachmentId);
    const v2 = await postFile(PAGE.replace('ok', 'v2'));
    await asVersion(v2.attachmentId, { artifactId });

    expect((await issue(v1.attachmentId)).json()).toMatchObject({ artifactId, version: 1, latestVersion: 2, title: 'Inbox 상태 보드' });
    expect((await issue(v2.attachmentId)).json()).toMatchObject({ artifactId, version: 2, latestVersion: 2 });
  });

  it('can be reloaded within its lifetime and not after', async () => {
    const { attachmentId } = await postFile(PAGE);
    await asVersion(attachmentId);
    const { path } = (await issue(attachmentId)).json();

    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(200);
    const saved = clock;
    try {
      clock += PREVIEW_TOKEN_TTL_MS;
      expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    } finally {
      clock = saved;
    }
  });
});

describe('what is not a preview', () => {
  // v1 범위: 사람이 올린 아무 .html 첨부는 지금처럼 다운로드뿐이다.
  it('refuses an html attachment that no artifact version points to', async () => {
    const { attachmentId } = await postFile(PAGE);
    const res = await issue(attachmentId);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_a_preview');
  });

  it('refuses a version whose file is not html', async () => {
    const { attachmentId } = await postFile('PNG', { contentType: 'image/png', name: 'x.png' });
    await asVersion(attachmentId);
    expect((await issue(attachmentId)).statusCode).toBe(404);
  });

  it('refuses a page past the preview size limit so the card can offer a download', async () => {
    const { attachmentId } = await postFile(Buffer.alloc(5 * 1024 * 1024 + 1, 0x20));
    await asVersion(attachmentId);
    const res = await issue(attachmentId);
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('too_large');
  });

  it('keeps the plain download route from rendering the same html inline', async () => {
    const { attachmentId } = await postFile(PAGE);
    await asVersion(attachmentId);
    const dl = await app.inject({ method: 'GET', url: `/attachments/${attachmentId}`, headers: auth(adminToken) });
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(String(dl.headers['content-disposition'])).toMatch(/^attachment;/);
  });
});

describe('who may open a preview', () => {
  it('refuses to issue a path without a login', async () => {
    const { attachmentId } = await postFile(PAGE);
    await asVersion(attachmentId);
    expect((await app.inject({ method: 'POST', url: `/attachments/${attachmentId}/preview` })).statusCode).toBe(401);
  });

  it('refuses someone outside the dm the preview lives in', async () => {
    const { accountId: peerId, pat: peerPat } = await createAgent(app, adminToken, 'previewpeer');
    const { pat: outsiderPat } = await createAgent(app, adminToken, 'previewoutsider');
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: auth(adminToken), payload: { accountIds: [peerId] },
    });
    const dmId = dm.json().id as string;
    const { attachmentId } = await postFile(PAGE, { token: peerPat, channel: dmId });
    await asVersion(attachmentId, { channel: dmId, by: peerId });

    expect((await issue(attachmentId, peerPat)).statusCode).toBe(201);
    expect((await issue(attachmentId, outsiderPat)).statusCode).toBe(403);
  });

  // 토큰을 받은 뒤 메시지가 지워지면, 남은 수명 안이라도 열리면 안 된다.
  it('stops serving a path once its message is deleted', async () => {
    const { attachmentId, messageId } = await postFile(PAGE);
    await asVersion(attachmentId);
    const { path } = (await issue(attachmentId)).json();
    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${messageId}`, headers: auth(adminToken),
    });
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
  });

  it('refuses a forged or altered path', async () => {
    const { attachmentId } = await postFile(PAGE);
    await asVersion(attachmentId);
    const { path } = (await issue(attachmentId)).json() as { path: string };
    const token = path.slice('/preview/'.length);

    const forged = signPreviewToken(Buffer.alloc(32, 7), attachmentId, adminId, clock);
    expect((await app.inject({ method: 'GET', url: `/preview/${forged}` })).statusCode).toBe(404);
    // 서명 자리 글자 하나를 바꾼다(끝 글자는 남는 비트가 있어 끝에서 둘째).
    const at = token.length - 2;
    const flipped = token.slice(0, at) + (token[at] === 'A' ? 'B' : 'A') + token.slice(at + 1);
    expect((await app.inject({ method: 'GET', url: `/preview/${flipped}` })).statusCode).toBe(404);
    // 서명은 그대로 두고 첨부 id 자리(앞 글자)를 바꾼다.
    const swapped = (token.startsWith('A') ? 'B' : 'A') + token.slice(1);
    expect((await app.inject({ method: 'GET', url: `/preview/${swapped}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/preview/nonsense' })).statusCode).toBe(404);
  });
});

describe('preview tokens', () => {
  const key = Buffer.alloc(32, 1);
  const ATT = '0b6f1c1e-1111-4a2b-8c3d-000000000001';
  const ACC = '0b6f1c1e-2222-4a2b-8c3d-000000000002';
  it('round-trips the attachment and account it was signed for', () => {
    const t = signPreviewToken(key, ATT, ACC, 1000);
    expect(verifyPreviewToken(key, t, 1000)).toEqual({ attachmentId: ATT, accountId: ACC });
    expect(verifyPreviewToken(key, t, 1000 + PREVIEW_TOKEN_TTL_MS)).toBeNull();
  });

  // fastify 경로 파라미터 기본 한도(100자)를 넘으면 414 다.
  it('fits in a route parameter', () => {
    expect(signPreviewToken(key, ATT, ACC, 1000).length).toBeLessThanOrEqual(100);
  });

  it('rejects a body swapped under a valid signature', () => {
    const a = Buffer.from(signPreviewToken(key, ATT, ACC, 1000), 'base64url');
    const b = Buffer.from(signPreviewToken(key, ACC, ACC, 1000), 'base64url');
    const swapped = Buffer.concat([b.subarray(0, 36), a.subarray(36)]).toString('base64url');
    expect(verifyPreviewToken(key, swapped, 1000)).toBeNull();
  });

  it('is shared by every server process through the database', async () => {
    const rows = await pool.query(`select count(*)::int as n from preview_signing_key`);
    expect(rows.rows[0].n).toBe(1);
  });
});
