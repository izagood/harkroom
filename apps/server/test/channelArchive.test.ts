import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let nonAdminToken: string;
let nonAdminId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  const { pat, accountId } = await createAgent(app, adminToken, 'nonadmin');
  nonAdminToken = pat;
  nonAdminId = accountId;
});
afterAll(async () => { await app.close(); await stop(); });

describe('channel archive', () => {
  it('admin archives a channel; listChannels returns archivedAt', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'archive-test', topic: 'test' },
    });
    const id = created.json().id as string;

    const patched = await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json().archivedAt).toBeTruthy();

    const list = await app.inject({
      method: 'GET', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    });
    const ch = list.json().channels.find((c: { id: string }) => c.id === id);
    expect(ch.archivedAt).toBeTruthy();
  });

  it('posting to archived channel returns 403 channel_archived', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'archivedchan', topic: 'test' },
    });
    const id = created.json().id as string;

    await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    const post = await app.inject({
      method: 'POST', url: `/channels/${id}/messages`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'hello' },
    });

    expect(post.statusCode).toBe(403);
    expect(post.json().error.code).toBe('channel_archived');
  });

  it('unarchiving allows posting again', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'unarchive-test', topic: 'test' },
    });
    const id = created.json().id as string;

    const archiveRes = await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });
    expect(archiveRes.json().archivedAt).toBeTruthy();

    const unarchiveRes = await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: false },
    });
    expect(unarchiveRes.json().archivedAt).toBeNull();

    const post = await app.inject({
      method: 'POST', url: `/channels/${id}/messages`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'hello again' },
    });
    expect(post.statusCode).toBe(201);
  });

  it('edit and delete still work on archived channel', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'edit-archive-test', topic: 'test' },
    });
    const channelId = created.json().id as string;

    const posted = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'to be edited' },
    });
    expect(posted.statusCode).toBe(201);
    const messageId = posted.json().id as string;

    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    const edit = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/messages/${messageId}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'edited' },
    });
    expect(edit.statusCode).toBe(200);

    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${messageId}`, headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('non-admin cannot archive (403) and channel stays unarchived', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'nonadmin-archive-test', topic: 'test' },
    });
    const id = created.json().id as string;

    const patched = await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: { authorization: `Bearer ${nonAdminToken}` },
      payload: { archived: true },
    });

    expect(patched.statusCode).toBe(403);

    const list = await app.inject({
      method: 'GET', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    });
    const ch = list.json().channels.find((c: { id: string }) => c.id === id);
    expect(ch.archivedAt).toBeFalsy();
  });

  it('allReadStates still returns archived channel (regression for visibility decision)', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'readstates-archive-test', topic: 'test' },
    });
    const id = created.json().id as string;

    await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    const reads = await app.inject({
      method: 'GET', url: '/reads', headers: { authorization: `Bearer ${adminToken}` },
    });

    const hasChannel = reads.json().reads.some((r: { channelId: string }) => r.channelId === id);
    expect(hasChannel).toBe(true);
  });
});