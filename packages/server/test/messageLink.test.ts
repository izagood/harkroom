import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

// #178 — 링크가 가리키는 메시지 하나를 읽는 경로(`GET /messages/:id`)의 회귀 테스트.
// 이 라우트는 채널을 모른 채 id 만 받으므로, 가시성 판정을 빠뜨리면 남의 DM 본문이
// id 하나로 새어 나간다. 세 가지를 못 박는다: 좌표를 준다 / 남의 DM 은 403 이고 본문이
// 없다 / 지워진 것은 404 이고 본문이 없다.

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let aPat: string;
let bPat: string;
let cPat: string;
let channelId: string;
let rootId: string;
let replyId: string;
let dmMessageId: string;
let deletedId: string;

const DM_BODY = 'dm secret abc987';
const DELETED_BODY = 'deleted secret def654';

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  const a = await createAgent(app, adminToken, 'link-a');
  const b = await createAgent(app, adminToken, 'link-b');
  const c = await createAgent(app, adminToken, 'link-c');
  aPat = a.pat;
  bPat = b.pat;
  cPat = c.pat;

  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'links', topic: '' },
  });
  channelId = ch.json().id;

  const root = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`,
    headers: { authorization: `Bearer ${aPat}` }, payload: { body: 'root of the thread' },
  });
  rootId = root.json().id;

  const reply = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`,
    headers: { authorization: `Bearer ${aPat}` },
    payload: { body: 'a reply inside the thread', threadRootId: rootId },
  });
  replyId = reply.json().id;

  const dm = await app.inject({
    method: 'POST', url: '/dms', headers: { authorization: `Bearer ${aPat}` },
    payload: { accountIds: [b.accountId] },
  });
  const dmChannelId = dm.json().id;
  const dmMessage = await app.inject({
    method: 'POST', url: `/channels/${dmChannelId}/messages`,
    headers: { authorization: `Bearer ${aPat}` }, payload: { body: DM_BODY },
  });
  dmMessageId = dmMessage.json().id;

  const doomed = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`,
    headers: { authorization: `Bearer ${aPat}` }, payload: { body: DELETED_BODY },
  });
  deletedId = doomed.json().id;
  await app.inject({
    method: 'DELETE', url: `/channels/${channelId}/messages/${deletedId}`,
    headers: { authorization: `Bearer ${aPat}` },
  });
});
afterAll(async () => { await app.close(); await stop(); });

describe('GET /messages/:id', () => {
  // 링크를 받은 사람은 채널을 모른다 — 그것을 알려 주는 것이 이 라우트의 존재 이유다.
  it('gives the coordinates a link needs: channelId and threadRootId', async () => {
    const res = await app.inject({
      method: 'GET', url: `/messages/${replyId}`, headers: { authorization: `Bearer ${cPat}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().channelId).toBe(channelId);
    // 답글이면 루트를 준다 — 클라이언트가 스레드 패널까지 열 수 있어야 한다.
    expect(res.json().threadRootId).toBe(rootId);
  });

  it('reports a root message with threadRootId null', async () => {
    const res = await app.inject({
      method: 'GET', url: `/messages/${rootId}`, headers: { authorization: `Bearer ${cPat}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().threadRootId).toBeNull();
  });

  it('lets a dm member read their own dm message', async () => {
    const res = await app.inject({
      method: 'GET', url: `/messages/${dmMessageId}`, headers: { authorization: `Bearer ${bPat}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().body).toBe(DM_BODY);
  });

  // 본문이 응답에 없는 것까지 확인한다 — 상태 코드만 보면 "403 인데 본문도 함께 준다"를 놓친다.
  it('refuses a dm message to a non-member and leaks no body', async () => {
    const res = await app.inject({
      method: 'GET', url: `/messages/${dmMessageId}`, headers: { authorization: `Bearer ${cPat}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(DM_BODY);
  });

  // 삭제가 삭제로 남으려면 링크로도 본문에 닿을 수 없어야 한다.
  it('reports a deleted message as gone and leaks no body', async () => {
    const res = await app.inject({
      method: 'GET', url: `/messages/${deletedId}`, headers: { authorization: `Bearer ${aPat}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(DELETED_BODY);
  });

  it('needs an account', async () => {
    const res = await app.inject({ method: 'GET', url: `/messages/${rootId}` });

    expect(res.statusCode).toBe(401);
  });
});
