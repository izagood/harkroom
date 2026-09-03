import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * #232 회귀선(서버). 첨부는 메시지 단위로만 존재했고 채널 기준으로 물어볼 표면이 없었다.
 * 여기 묶어 둔 것은 그 표면이 지켜야 하는 약속들이다 — 특히 **다른 채널의 첨부**와
 * **지운 메시지의 첨부**가 새지 않는다는 것, 그리고 볼 수 없는 채널이면 파일명도 나가지
 * 않는다는 것.
 */

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let storageRoot: string;
let channelId: string;
let otherChannelId: string;
let dmChannelId: string;
let outsiderPat: string;
let dmMemberPat: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** multipart 본문을 손으로 만든다 — 테스트가 실제 wire 형식을 지나가야 한다. */
function multipart(filename: string, content: string) {
  const boundary = '----murmurfiles';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/plain\r\n\r\n`,
  );
  const body = Buffer.concat([head, Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(filename: string, token = adminToken): Promise<string> {
  const m = multipart(filename, 'payload');
  const res = await app.inject({
    method: 'POST', url: '/uploads', headers: { ...auth(token), ...m.headers }, payload: m.body,
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** 파일 하나를 붙인 메시지를 게시하고 그 메시지 id 를 준다. */
async function post(channel: string, filename: string, token = adminToken): Promise<string> {
  const attachmentId = await upload(filename, token);
  const res = await app.inject({
    method: 'POST', url: `/channels/${channel}/messages`, headers: auth(token),
    payload: { body: filename, attachmentIds: [attachmentId] },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

const listFiles = (channel: string, token = adminToken, qs = '') =>
  app.inject({ method: 'GET', url: `/channels/${channel}/files${qs}`, headers: auth(token) });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  storageRoot = await mkdtemp(join(tmpdir(), 'murmur-chfiles-'));
  app = await buildServer({ pool: db.pool, storage: { root: storageRoot, maxBytes: 4096 } });
  ({ token: adminToken } = await bootstrapAdmin(app));

  const mk = async (name: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name },
    });
    return res.json().id as string;
  };
  channelId = await mk('files-here');
  otherChannelId = await mk('files-elsewhere');

  // 게시 순서가 곧 최신순의 기준이다(seq 오름차순).
  await post(channelId, 'first.txt');
  await post(channelId, 'second.txt');
  const doomed = await post(channelId, 'deleted.txt');
  await post(otherChannelId, 'elsewhere.txt');

  // 소프트 삭제 — 하드 삭제가 아니므로 `attachment` 행은 그대로 남는다. 그게 이 테스트의 요지다.
  const del = await app.inject({
    method: 'DELETE', url: `/channels/${channelId}/messages/${doomed}`, headers: auth(adminToken),
  });
  expect(del.statusCode).toBe(204);

  // DM: 비멤버가 봤을 때 파일명이 새는지 보기 위한 채널이다.
  const a = await createAgent(app, adminToken, 'files-a');
  const b = await createAgent(app, adminToken, 'files-b');
  const outsider = await createAgent(app, adminToken, 'files-outsider');
  outsiderPat = outsider.pat;
  dmMemberPat = a.pat;
  const dm = await app.inject({
    method: 'POST', url: '/dms', headers: auth(a.pat), payload: { accountIds: [b.accountId] },
  });
  dmChannelId = dm.json().id;
  await post(dmChannelId, 'private-secret.txt', a.pat);
});

afterAll(async () => {
  await app.close(); await stop();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('채널 파일 색인', () => {
  it('그 채널의 첨부를 최신순으로 준다', async () => {
    const res = await listFiles(channelId);
    expect(res.statusCode).toBe(200);
    const names = res.json().files.map((f: { filename: string }) => f.filename);
    // 최신순이다 — 오래된 것부터 주면 파일을 다시 찾는 사람이 또 스크롤해야 한다.
    expect(names).toEqual(['second.txt', 'first.txt']);

    // 누르면 그 메시지로 갈 수 있어야 하므로 messageId·messageSeq 가 함께 온다.
    const [newest] = res.json().files;
    expect(newest.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(newest.messageSeq).toBeGreaterThan(0);
  });

  it('다른 채널의 첨부는 섞이지 않는다', async () => {
    const here = await listFiles(channelId);
    const there = await listFiles(otherChannelId);
    // 채널 조건이 조인 뒤로 밀리거나 빠지면 이 단언이 깨진다 — 그때 첨부는 전 채널이 섞인다.
    expect(here.json().files.map((f: { filename: string }) => f.filename)).not.toContain('elsewhere.txt');
    expect(there.json().files.map((f: { filename: string }) => f.filename)).toEqual(['elsewhere.txt']);
  });

  it('지운 메시지의 첨부는 목록에 없다', async () => {
    const res = await listFiles(channelId);
    const body = res.payload;
    // `deleted_at is null` 이 빠지면 파일명이 그대로 남는다 — 그건 삭제가 삭제가 아닌 것이다.
    expect(body).not.toContain('deleted.txt');
    expect(res.json().files).toHaveLength(2);
  });

  it('볼 수 없는 채널이면 403 이고 파일명도 새지 않는다', async () => {
    const res = await listFiles(dmChannelId, outsiderPat);
    expect(res.statusCode).toBe(403);
    // 개수도 이름도 나가면 안 된다. 파일명은 그 자체로 내용이다 — 목록을 먼저 만들고
    // 나중에 판정하면 이 단언이 깨진다.
    expect(res.payload).not.toContain('private-secret.txt');
    expect(res.json().files).toBeUndefined();

    // 멤버는 정상적으로 본다 — 403 이 "아무도 못 본다"로 넓어지지 않았음을 함께 고정한다.
    const member = await listFiles(dmChannelId, dmMemberPat);
    expect(member.statusCode).toBe(200);
    expect(member.json().files.map((f: { filename: string }) => f.filename)).toEqual(['private-secret.txt']);
  });

  it('before 커서로 더 오래된 페이지를 준다', async () => {
    const first = await listFiles(channelId, adminToken, '?limit=1');
    expect(first.json().files.map((f: { filename: string }) => f.filename)).toEqual(['second.txt']);
    expect(first.json().hasMore).toBe(true);

    const cursor = first.json().files[0].messageSeq;
    const next = await listFiles(channelId, adminToken, `?limit=1&before=${cursor}`);
    expect(next.json().files.map((f: { filename: string }) => f.filename)).toEqual(['first.txt']);
    // 더 오래된 것이 없으면 hasMore 는 false 다 — 클라이언트가 빈 페이지를 계속 요청하지 않는다.
    expect(next.json().hasMore).toBe(false);
  });
});
