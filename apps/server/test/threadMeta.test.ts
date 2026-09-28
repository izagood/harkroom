import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { listMessages, postMessage } from '../src/services/messages.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminAccountId: string;
let botPat: string;
let botAccountId: string;
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  const admin = await bootstrapAdmin(app);
  adminToken = admin.token;
  adminAccountId = admin.accountId;
  ({ pat: botPat, accountId: botAccountId } = await createAgent(app, adminToken, 'helper'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'thread-meta-test-channel' },
  });
  if (ch.statusCode !== 201) {
    const list = await app.inject({
      method: 'GET', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    });
    const existing = list.json().channels?.find((c: { name: string }) => c.name === 'thread-meta-test-channel');
    if (existing) {
      channelId = existing.id;
    } else {
      throw new Error(`Failed to create channel: ${JSON.stringify(ch.json())}`);
    }
  } else {
    channelId = ch.json().id;
  }
});

afterAll(async () => { await app.close(); await stop(); });

const post = (token: string, body: string, extra: object = {}) =>
  app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`,
    headers: { authorization: `Bearer ${token}` },
    payload: { body, ...extra },
  });

/**
 * 진행·대기는 REST 로 못 올린다(그 경로에 `kind` 가 없다) — 러너가 MCP 로 올리는 것들이다.
 * 여기서 재는 것은 **집계**이므로 서비스로 바로 넣는다.
 */
const postKind = (authorId: string, body: string, kind: 'progress' | 'wake', threadRootId: string) =>
  postMessage(pool, { channelId, authorId, body, threadRootId, kind, attachmentIds: [] });

describe('thread metadata', () => {
  /**
   * **답글 수는 화면이 답글로 그리는 것만 센다**(2026-09-09).
   *
   * 여기 있던 규약은 반대였다 — 진행도 셌다. 그 시절에는 진행이 말풍선으로 흘러 수와
   * 화면이 맞았지만, `#144` 이후 스레드는 연속된 진행을 상태 한 줄(`ProgressRow`)로 접고
   * 대기를 대기 줄(`WakeRow`)로 그린다. 그래서 채널이 "답글 2개"라고 적은 스레드를 열면
   * 말풍선이 하나뿐이었다(2026-09-09 실측 화면).
   */
  it('진행·대기는 답글 수에 들지 않는다 — 대신 activityCount 가 센다', async () => {
    const root = await post(adminToken, 'root with progress');
    const rootId = root.json().id as string;

    await postKind(botAccountId, '보는 중', 'progress', rootId);
    await postKind(botAccountId, '5분 뒤 다시', 'wake', rootId);
    const answer = await post(botPat, '다 봤다', { threadRootId: rootId });
    const answerAt = answer.json().createdAt as string;

    const messages = await listMessages(pool, channelId, { limit: 10 });
    const found = messages.find((m) => m.id === rootId);
    expect(found!.replyCount).toBe(1);
    // 자리를 세우는 수는 셋을 다 센다 — 진행만 있는 스레드에서도 요약 줄과 상태 배지가
    // 서야 하기 때문이다.
    expect(found!.activityCount).toBe(3);
    // 마지막 '답글' 시각도 같은 기준이다 — 대기 줄의 시각은 답글 시각이 아니다.
    expect(new Date(found!.lastReplyAt!).getTime()).toBeCloseTo(new Date(answerAt).getTime(), -2);
  });

  it('진행만 달린 스레드는 답글 0 · 활동 1 이다', async () => {
    const root = await post(adminToken, 'root, progress only');
    const rootId = root.json().id as string;
    await postKind(botAccountId, '보는 중', 'progress', rootId);

    const messages = await listMessages(pool, channelId, { limit: 10 });
    const found = messages.find((m) => m.id === rootId);
    expect(found!.replyCount).toBe(0);
    expect(found!.activityCount).toBe(1);
    expect(found!.lastReplyAt).toBeNull();
  });

  it('root with no replies has count 0 and null lastReplyAt', async () => {
    const root = await post(adminToken, 'root message');
    const rootId = root.json().id as string;
    const messages = await listMessages(pool, channelId, { limit: 10 });
    const found = messages.find((m) => m.id === rootId);
    expect(found).toBeDefined();
    expect(found!.threadRootId).toBeNull();
    expect(found!.replyCount).toBe(0);
    expect(found!.activityCount).toBe(0);
    expect(found!.lastReplyAt).toBeNull();
    expect(found!.participantIds).toEqual([]);
  });

  it('root with 3 replies has count 3 and lastReplyAt is most recent', async () => {
    const root = await post(adminToken, 'root');
    const rootId = root.json().id as string;

    await post(botPat, 'reply 1', { threadRootId: rootId });
    await post(adminToken, 'reply 2', { threadRootId: rootId });
    const lastReply = await post(botPat, 'reply 3', { threadRootId: rootId });
    const lastReplyAt = lastReply.json().createdAt as string;

    const messages = await listMessages(pool, channelId, { limit: 10 });
    const found = messages.find((m) => m.id === rootId);
    expect(found).toBeDefined();
    expect(found!.replyCount).toBe(3);
    expect(found!.lastReplyAt).not.toBeNull();
    expect(new Date(found!.lastReplyAt!).getTime()).toBeCloseTo(new Date(lastReplyAt).getTime(), -2);
    expect(found!.participantIds).toHaveLength(2);
    expect(found!.participantIds).toContain(adminAccountId);
    expect(found!.participantIds).toContain(botAccountId);
  });

  /**
   * **참여자 순서는 '마지막으로 말한 순'이다**(identity 문서 · Task 13).
   *
   * 원래는 `ARRAY_AGG(DISTINCT author_id)` 라 uuid 순으로 정렬됐고 — 즉 순서가 사실상
   * 무작위이면서 **영원히 움직이지 않았다.** 화면이 앞에서 셋만 남기면 방금 말한 사람이
   * 잘리고 같은 얼굴이 계속 서 있는다.
   */
  it('참여자는 마지막으로 말한 순이다 — 명단이 실제로 움직인다', async () => {
    const root = await post(adminToken, 'root');
    const rootId = root.json().id as string;

    await post(adminToken, 'admin 먼저', { threadRootId: rootId });
    await post(botPat, 'bot 이 나중', { threadRootId: rootId });

    let found = (await listMessages(pool, channelId, { limit: 10 })).find((m) => m.id === rootId)!;
    // 방금 말한 bot 이 앞이다.
    expect(found.participantIds).toEqual([botAccountId, adminAccountId]);

    // admin 이 다시 말하면 **순서가 뒤집힌다** — 이것이 "명단이 움직인다"의 실물이다.
    await post(adminToken, 'admin 이 다시', { threadRootId: rootId });
    found = (await listMessages(pool, channelId, { limit: 10 })).find((m) => m.id === rootId)!;
    expect(found.participantIds).toEqual([adminAccountId, botAccountId]);
  });

  it('reply rows have null metadata', async () => {
    const root = await post(adminToken, 'root');
    const rootId = root.json().id as string;
    await post(botPat, 'reply', { threadRootId: rootId });

    const messages = await listMessages(pool, channelId, { threadRootId: rootId });
    const replies = messages.filter((m) => m.threadRootId === rootId);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.replyCount).toBeNull();
    expect(replies[0]!.lastReplyAt).toBeNull();
    expect(replies[0]!.participantIds).toBeNull();
  });

  it('deleted replies are not counted', async () => {
    const root = await post(adminToken, 'root');
    const rootId = root.json().id as string;

    await post(botPat, 'reply to delete', { threadRootId: rootId });
    const keepReply = await post(adminToken, 'reply to keep', { threadRootId: rootId });
    const keepReplyAt = keepReply.json().createdAt as string;

    const messages = await listMessages(pool, channelId, { limit: 10 });
    const found = messages.find((m) => m.id === rootId);
    expect(found!.replyCount).toBe(2);

    const deleteReply = messages.find((m) => m.body === 'reply to delete');
    expect(deleteReply).toBeDefined();

    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${deleteReply!.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const afterDelete = await listMessages(pool, channelId, { limit: 10 });
    const afterFound = afterDelete.find((m) => m.id === rootId);
    expect(afterFound!.replyCount).toBe(1);
    expect(afterFound!.lastReplyAt).not.toBeNull();
    expect(new Date(afterFound!.lastReplyAt!).getTime()).toBeCloseTo(new Date(keepReplyAt).getTime(), -2);
  });

  it('participant list has unique accounts, no duplicates', async () => {
    const root = await post(adminToken, 'root');
    const rootId = root.json().id as string;

    await post(botPat, 'reply a', { threadRootId: rootId });
    await post(botPat, 'reply b', { threadRootId: rootId });
    await post(botPat, 'reply c', { threadRootId: rootId });
    await post(adminToken, 'reply d', { threadRootId: rootId });

    const messages = await listMessages(pool, channelId, { limit: 10 });
    const found = messages.find((m) => m.id === rootId);
    expect(found!.participantIds).toHaveLength(2);
    expect(new Set(found!.participantIds).size).toBe(2);
  });

  it('counts old replies outside page size (server authority)', async () => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'large-thread' },
    });
    const chId = ch.json().id as string;

    const root = await app.inject({
      method: 'POST', url: `/channels/${chId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'root' },
    });
    const rootId = root.json().id as string;

    for (let i = 0; i < 50; i += 1) {
      await app.inject({
        method: 'POST', url: `/channels/${chId}/messages`,
        headers: { authorization: `Bearer ${botPat}` },
        payload: { body: `reply ${i}`, threadRootId: rootId },
      });
    }

    const messages = await listMessages(pool, chId, { threadRootId: rootId, limit: 100 });
    const found = messages.find((m) => m.id === rootId);
    expect(found).toBeDefined();
    expect(found!.replyCount).toBe(50);
    expect(found!.participantIds).toHaveLength(1);
    expect(found!.participantIds).toContain(botAccountId);
  });

  it('search results do not have thread metadata', async () => {
    const root = await post(adminToken, 'searchable root message');
    const rootId = root.json().id as string;
    await post(botPat, 'searchable reply', { threadRootId: rootId });

    const search = await app.inject({
      method: 'GET', url: '/search?q=searchable',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const results = search.json().messages as Array<{ id: string; replyCount: number | null }>;
    const found = results.find((m) => m.id === rootId);
    expect(found).toBeDefined();
    expect(found!.replyCount).toBeNull();
  });
});