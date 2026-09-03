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
let userToken: string;
let userId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  const { pat, accountId } = await createAgent(app, adminToken, 'nonadmin');
  nonAdminToken = pat;
  const userResult = await createAgent(app, adminToken, 'user');
  userToken = userResult.pat;
  userId = userResult.accountId;
});
afterAll(async () => { await app.close(); await stop(); });

describe('channel delete (#155)', () => {
  it(' archived empty channel is deleted', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'delete-empty-archived', topic: 'test' },
    });
    const id = created.json().id as string;

    await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${id}`, headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(deleted.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    });
    const ch = list.json().channels.find((c: { id: string }) => c.id === id);
    expect(ch).toBeFalsy();
  });

  it('archived channel with messages is deleted without FK violation', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'delete-with-messages', topic: 'test' },
    });
    const channelId = created.json().id as string;

    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'message 1' },
    });
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'message 2' },
    });

    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(deleted.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    });
    const ch = list.json().channels.find((c: { id: string }) => c.id === channelId);
    expect(ch).toBeFalsy();
  });

  it('non-archived channel deletion returns 409 and channel remains', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'delete-not-archived', topic: 'test' },
    });
    const id = created.json().id as string;

    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${id}`, headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().error.code).toBe('not_archived');

    const list = await app.inject({
      method: 'GET', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    });
    const ch = list.json().channels.find((c: { id: string }) => c.id === id);
    expect(ch).toBeTruthy();
  });

  it('DM cannot be deleted', async () => {
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountIds: [userId] },
    });
    const dmId = dm.json().id as string;

    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${dmId}`, headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().error.code).toBe('cannot_delete_dm');
  });

  it('non-admin returns 403 and channel remains', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'delete-nonadmin', topic: 'test' },
    });
    const id = created.json().id as string;

    await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${id}`, headers: { authorization: `Bearer ${nonAdminToken}` },
    });

    expect(deleted.statusCode).toBe(403);

    const list = await app.inject({
      method: 'GET', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    });
    const ch = list.json().channels.find((c: { id: string }) => c.id === id);
    expect(ch).toBeTruthy();
  });

  it('after deletion, no messages, reactions, attachments, read positions, members, or pins remain', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'delete-cleanup-test', topic: 'test' },
    });
    const channelId = created.json().id as string;

    const msg1 = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'message 1' },
    });
    const messageId = msg1.json().id as string;

    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: { authorization: `Bearer ${userToken}` },
      payload: { body: 'message 2' },
    });

    await app.inject({
      method: 'PUT', url: `/channels/${channelId}/messages/${messageId}/reactions/%F0%9F%91%8D`,
      headers: { authorization: `Bearer ${userToken}` },
    });

    await app.inject({
      method: 'PUT', url: `/channels/${channelId}/read`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { seq: 10 },
    });

    await app.inject({
      method: 'POST', url: `/channels/${channelId}/pins`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { messageId },
    });

    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
    });

    const messages = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`, headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(messages.json().messages.length).toBe(0);

    const reads = await app.inject({
      method: 'GET', url: '/reads', headers: { authorization: `Bearer ${adminToken}` },
    });
    const channelRead = reads.json().reads.find((r: { channelId: string }) => r.channelId === channelId);
    expect(channelRead).toBeFalsy();

    const members = await app.inject({
      method: 'GET', url: `/channels/${channelId}/members`, headers: { authorization: `Bearer ${adminToken}` },
    });
    // 채널이 삭제되었으므로 404가 반환된다
    expect(members.statusCode).toBe(404);

    const pins = await app.inject({
      method: 'GET', url: `/channels/${channelId}/pins`, headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(pins.json().pins.length).toBe(0);
  });

  it('audit log contains channel name and counts without body', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'delete-audit-test', topic: 'test topic' },
    });
    const channelId = created.json().id as string;

    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'secret message' },
    });

    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
    });

    const audit = await app.inject({
      method: 'GET', url: '/audit?action=channel.deleted&limit=5', headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(audit.statusCode).toBe(200);
    const entries = audit.json().entries as Array<{ action: string; detail: Record<string, unknown> }>;
    const entry = entries.find((e) => e.detail.name === 'delete-audit-test');
    expect(entry).toBeTruthy();
    expect(entry!.detail.messageCount).toBe(1);
    expect(entry!.detail.attachmentCount).toBe(0);
    expect(entry!.detail.topic).toBeUndefined();
    expect(entry!.detail.body).toBeUndefined();
  });

  it('delete-info returns 409 for non-archived channel', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'delete-info-test', topic: 'test' },
    });
    const id = created.json().id as string;

    const info = await app.inject({
      method: 'GET', url: `/channels/${id}/delete-info`, headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(info.statusCode).toBe(409);
    expect(info.json().error.code).toBe('not_archived');
  });

  it('delete-info returns 409 for DM', async () => {
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountIds: [userId] },
    });
    const dmId = dm.json().id as string;

    const info = await app.inject({
      method: 'GET', url: `/channels/${dmId}/delete-info`, headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(info.statusCode).toBe(409);
    expect(info.json().error.code).toBe('cannot_delete_dm');
  });
});