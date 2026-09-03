import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { createScheduledMessageSweeper } from '../src/services/scheduledMessages.js';

async function createUser(app: FastifyInstance, adminToken: string, handle: string): Promise<{ token: string; accountId: string }> {
  const inv = await app.inject({
    method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` },
  });
  const inviteToken = inv.json().token as string;
  const reg = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { inviteToken, handle, displayName: handle, password: 'pw123456' },
  });
  const accountId = reg.json().id as string;
  const login = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { handle, password: 'pw123456' },
  });
  return { token: login.json().token as string, accountId };
}

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let userToken: string;
let userId: string;
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  const user = await createUser(app, adminToken, 'testuser');
  userToken = user.token;
  userId = user.accountId;

  // Create a channel for testing
  const channel = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'scheduled-test' },
  });
  channelId = channel.json().id as string;

  // Add user to channel
  await app.inject({
    method: 'POST', url: `/channels/${channelId}/members`, headers: { authorization: `Bearer ${adminToken}` },
    payload: { accountId: userId },
  });
});
afterAll(async () => { await app.close(); await stop(); });

describe('scheduled messages', () => {
  it('creates a scheduled message and stores it in scheduled_message table, not in message table', async () => {
    const futureTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: '예약 테스트', sendAt: futureTime },
    });

    expect(res.statusCode).toBe(201);
    const scheduled = res.json().scheduled as { id: string };
    expect(scheduled.id).toBeDefined();

    // Verify it's not in message table
    const messages = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(messages.json().messages).toHaveLength(0);

    // Verify it's in scheduled_message table
    const list = await app.inject({
      method: 'GET', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(list.json().scheduled).toHaveLength(1);
    expect(list.json().scheduled[0]).toMatchObject({ body: '예약 테스트' });
  });

  it('other user cannot see my scheduled messages', async () => {
    const futureTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: '비밀 예약', sendAt: futureTime },
    });

    const { token: otherToken } = await createUser(app, adminToken, 'otheruser');
    const list = await app.inject({
      method: 'GET', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(list.json().scheduled).toHaveLength(0);
  });

  it('rejects past send_at', async () => {
    const pastTime = new Date(Date.now() - 60 * 1000).toISOString();
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: '과거 예약', sendAt: pastTime },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('send_at_in_past');
  });

  it('rejects send_at more than 30 days in the future', async () => {
    const farFutureTime = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: '너무 먼 미래', sendAt: farFutureTime },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('send_at_too_far');
  });

  it('agent cannot schedule messages', async () => {
    const { pat } = await createAgent(app, adminToken, 'scheduling-agent');
    const futureTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${pat}` },
      payload: { body: '에이전트 예약', sendAt: futureTime },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('agents_cannot_schedule');
  });

  it('sweep sends messages that are due', async () => {
    const pastTime = new Date(Date.now() - 1000).toISOString();
    const createRes = await app.inject({
      method: 'POST', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: '지금 발송', sendAt: pastTime },
    });
    expect(createRes.statusCode).toBe(201);
    const scheduledId = createRes.json().scheduled.id as string;

    const sweeper = createScheduledMessageSweeper(app.pool as never);
    await sweeper.sweep();

    const list = await app.inject({
      method: 'GET', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    const scheduled = list.json().scheduled as Array<{ sentMessageId: string | null }>;
    expect(scheduled[0].sentMessageId).toBeDefined();

    const messages = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(messages.json().messages).toHaveLength(1);
    expect(messages.json().messages[0].body).toBe('지금 발송');
  });

  it('canceled messages are skipped by sweep', async () => {
    const pastTime = new Date(Date.now() - 1000).toISOString();
    const createRes = await app.inject({
      method: 'POST', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: '취소할 예약', sendAt: pastTime },
    });
    expect(createRes.statusCode).toBe(201);
    const scheduledId = createRes.json().scheduled.id as string;

    await app.inject({
      method: 'DELETE', url: `/scheduled/${scheduledId}`,
      headers: { authorization: `Bearer ${userToken}` },
    });

    const sweeper = createScheduledMessageSweeper(app.pool as never);
    await sweeper.sweep();

    const list = await app.inject({
      method: 'GET', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    const scheduled = list.json().scheduled as Array<{ canceledAt: string | null; sentMessageId: string | null }>;
    expect(scheduled[0].canceledAt).toBeDefined();
    expect(scheduled[0].sentMessageId).toBeNull();
  });

  it('channel archive blocks scheduled message sending', async () => {
    // Create a new channel for this test
    const newChannel = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'archive-test' },
    });
    const newChannelId = newChannel.json().id as string;
    await app.inject({
      method: 'POST', url: `/channels/${newChannelId}/members`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountId: userId },
    });

    // Schedule first (not archived yet)
    const pastTime = new Date(Date.now() - 1000).toISOString();
    const createRes = await app.inject({
      method: 'POST', url: `/channels/${newChannelId}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: '보관된 채널 예약', sendAt: pastTime },
    });
    expect(createRes.statusCode).toBe(201);

    // Then archive the channel
    await app.inject({
      method: 'PATCH', url: `/channels/${newChannelId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    const sweeper = createScheduledMessageSweeper(app.pool as never);
    await sweeper.sweep();

    const list = await app.inject({
      method: 'GET', url: `/channels/${newChannelId}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    const scheduled = list.json().scheduled as Array<{ failedReason: string | null }>;
    expect(scheduled[0].failedReason).toBe('channel_archived');
  });

  it('can cancel a scheduled message', async () => {
    const futureTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const createRes = await app.inject({
      method: 'POST', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: '취소할 예약', sendAt: futureTime },
    });
    expect(createRes.statusCode).toBe(201);
    const scheduledId = createRes.json().scheduled.id as string;

    const cancelRes = await app.inject({
      method: 'DELETE', url: `/scheduled/${scheduledId}`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(cancelRes.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET', url: `/channels/${channelId}/scheduled`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    const scheduled = list.json().scheduled as Array<{ canceledAt: string | null }>;
    expect(scheduled[0].canceledAt).toBeDefined();
  });
});