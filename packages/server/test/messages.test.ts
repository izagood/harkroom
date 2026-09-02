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
let botPat: string;
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  const admin = await bootstrapAdmin(app);
  adminToken = admin.token;
  ({ pat: botPat } = await createAgent(app, adminToken, 'helper'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'general' },
  });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

const post = (token: string, body: string, extra: object = {}, headers: object = {}, chId: string = channelId) =>
  app.inject({
    method: 'POST', url: `/channels/${chId}/messages`,
    headers: { authorization: `Bearer ${token}`, ...headers },
    payload: { body, ...extra },
  });

describe('messages', () => {
  it('posts, lists with since cursor', async () => {
    const r1 = await post(adminToken, 'hello');
    expect(r1.statusCode).toBe(201);
    const seq1 = r1.json().seq as number;
    await post(adminToken, 'world');
    const list = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages?since=${seq1}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.json().messages.map((m: { body: string }) => m.body)).toEqual(['world']);
  });

  it('idempotency-key returns the same message', async () => {
    const a = await post(adminToken, 'once', {}, { 'idempotency-key': 'k-1' });
    const b = await post(adminToken, 'once', {}, { 'idempotency-key': 'k-1' });
    expect(b.statusCode).toBe(200);
    expect(a.json().id).toBe(b.json().id);
  });

  // 재생은 "같은 요청의 재시도"여야 한다. key만으로 되짚으면 남의 메시지를 되돌려주는
  // 읽기 경로가 되고, 채널 격리(DM 멤버십 포함)를 우회한다.
  it('does not replay another account message that used the same key', async () => {
    const mine = await post(adminToken, '내 메시지', {}, { 'idempotency-key': 'shared-key' });

    const theirs = await post(botPat, '에이전트 메시지', {}, { 'idempotency-key': 'shared-key' });

    expect(theirs.statusCode).toBe(201);
    expect(theirs.json().id).not.toBe(mine.json().id);
    expect(theirs.json().body).toBe('에이전트 메시지');
  });

  it('does not replay a message the same author posted to a different channel', async () => {
    const other = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'elsewhere' },
    });
    const otherId = other.json().id as string;
    const there = await app.inject({
      method: 'POST', url: `/channels/${otherId}/messages`,
      headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': 'cross-channel' },
      payload: { body: '저쪽 채널 메시지' },
    });

    const here = await post(adminToken, '이쪽 채널 메시지', {}, { 'idempotency-key': 'cross-channel' });

    expect(here.statusCode).toBe(201);
    expect(here.json().id).not.toBe(there.json().id);
    expect(here.json().channelId).toBe(channelId);
  });

  it('mention creates inbox entry for the mentioned agent', async () => {
    await post(adminToken, '@helper please summarize');
    const inbox = await app.inject({
      method: 'GET', url: '/inbox?unread=1', headers: { authorization: `Bearer ${botPat}` },
    });
    expect(inbox.json().entries).toHaveLength(1);
    expect(inbox.json().entries[0].reason).toBe('mention');
  });

  it('thread reply notifies root author and lists by thread', async () => {
    const root = await post(botPat, 'root message');
    const rootId = root.json().id as string;
    await post(adminToken, 'reply here', { threadRootId: rootId });
    const thread = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages?thread=${rootId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(thread.json().messages.map((m: { body: string }) => m.body)).toEqual(['root message', 'reply here']);
    const inbox = await app.inject({
      method: 'GET', url: '/inbox?unread=1', headers: { authorization: `Bearer ${botPat}` },
    });
    const reasons = inbox.json().entries.map((e: { reason: string }) => e.reason);
    expect(reasons).toContain('thread_reply');
  });

  it('since=0 (initial load) returns the latest N messages, not the oldest', async () => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'latest-window' },
    });
    const chId = ch.json().id as string;
    for (let i = 1; i <= 5; i += 1) {
      await app.inject({
        method: 'POST', url: `/channels/${chId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { body: `m${i}` },
      });
    }
    const latest = await listMessages(pool, chId, { limit: 2 });
    expect(latest.map((m) => m.body)).toEqual(['m4', 'm5']);
    expect(latest[0]!.seq).toBeLessThan(latest[1]!.seq);
  });

  it('thread without since returns the latest N messages in ascending order', async () => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'thread-window' },
    });
    const chId = ch.json().id as string;
    const root = await post(adminToken, 'root', {}, {}, chId);
    const rootId = root.json().id as string;
    for (let i = 1; i <= 10; i += 1) {
      await post(adminToken, `reply${i}`, { threadRootId: rootId }, {}, chId);
    }
    const latest = await listMessages(pool, chId, { threadRootId: rootId, limit: 3 });
    expect(latest.map((m) => m.body)).toEqual(['reply8', 'reply9', 'reply10']);
    expect(latest[0]!.seq).toBeLessThan(latest[1]!.seq);
    expect(latest[1]!.seq).toBeLessThan(latest[2]!.seq);
  });

  it('thread with since returns messages after the cursor', async () => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'thread-since' },
    });
    const chId = ch.json().id as string;
    const root = await post(adminToken, 'root', {}, {}, chId);
    const rootId = root.json().id as string;
    for (let i = 1; i <= 10; i += 1) {
      await post(adminToken, `reply${i}`, { threadRootId: rootId }, {}, chId);
    }
    const thread = await listMessages(pool, chId, { threadRootId: rootId });
    const afterReply5 = thread.find((m) => m.body === 'reply5')!;
    const since = afterReply5.seq;
    const latest3 = await listMessages(pool, chId, { threadRootId: rootId, since, limit: 3 });
    expect(latest3.map((m) => m.body)).toEqual(['reply6', 'reply7', 'reply8']);
    expect(latest3[0]!.seq).toBeLessThan(latest3[1]!.seq);
  });

  it('inbox read marks entries', async () => {
    const inbox = await app.inject({
      method: 'GET', url: '/inbox?unread=1', headers: { authorization: `Bearer ${botPat}` },
    });
    const ids = inbox.json().entries.map((e: { id: number }) => e.id);
    const read = await app.inject({
      method: 'POST', url: '/inbox/read', headers: { authorization: `Bearer ${botPat}` },
      payload: { ids },
    });
    expect(read.statusCode).toBe(204);
    const after = await app.inject({
      method: 'GET', url: '/inbox?unread=1', headers: { authorization: `Bearer ${botPat}` },
    });
    expect(after.json().entries).toHaveLength(0);
  });
});
