import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { listMessages } from '../src/services/messages.js';

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

describe('thread metadata', () => {
  it('root with no replies has count 0 and null lastReplyAt', async () => {
    const root = await post(adminToken, 'root message');
    const rootId = root.json().id as string;
    const messages = await listMessages(pool, channelId, { limit: 10 });
    const found = messages.find((m) => m.id === rootId);
    expect(found).toBeDefined();
    expect(found!.threadRootId).toBeNull();
    expect(found!.replyCount).toBe(0);
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