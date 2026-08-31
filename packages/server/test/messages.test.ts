import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let botPat: string;
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
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

const post = (token: string, body: string, extra: object = {}, headers: object = {}) =>
  app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`,
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
