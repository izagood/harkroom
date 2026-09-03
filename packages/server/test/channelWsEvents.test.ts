import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminPat2: string;
let adminId: string;
let adminId2: string;
let baseUrl: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ accountId: adminId2, pat: adminPat2 } = await createAgent(app, adminToken, 'test2'));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await app.close(); await stop(); });

async function ticketFor(token: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/ws-ticket', headers: { authorization: `Bearer ${token}` },
  });
  return res.json().ticket as string;
}

function collectWithTicket(ticket: string): { events: unknown[]; ready: Promise<void>; close(): void } {
  const events: unknown[] = [];
  const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${ticket}`);
  ws.on('message', (data) => events.push(JSON.parse(String(data))));
  const ready = new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (data) => {
      if ((JSON.parse(String(data)) as { type?: string }).type === 'presence.snapshot') resolve();
    });
  });
  return { events, ready, close: () => ws.close() };
}

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('channel WS events (#284)', () => {
  const collect = async (token: string) => collectWithTicket(await ticketFor(token));

  it('1. A creates channel → B receives channel.created', async () => {
    const admin = await collect(adminToken);
    const user = await collect(adminPat2);
    await admin.ready; await user.ready;

    const res = await app.inject({
      method: 'POST', url: '/channels',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'test-public', visibility: 'public' },
    });
    expect(res.statusCode).toBe(201);
    const channelId = res.json().id;

    await waitFor(() =>
      admin.events.some((e: any) => e.type === 'channel.created' && e.channel.id === channelId) &&
      user.events.some((e: any) => e.type === 'channel.created' && e.channel.id === channelId)
    );

    const adminEvent = admin.events.find((e: any) => e.type === 'channel.created') as any;
    const userEvent = user.events.find((e: any) => e.type === 'channel.created') as any;
    expect(adminEvent?.channel.id).toBe(channelId);
    expect(userEvent?.channel.id).toBe(channelId);
    expect(adminEvent?.audience).toBe('all');
    expect(userEvent?.audience).toBe('all');

    admin.close(); user.close();
  });

  it('2. private channel created → non-member does not receive', async () => {
    const admin = await collect(adminToken);
    const user = await collect(adminPat2);
    await admin.ready; await user.ready;

    const res = await app.inject({
      method: 'POST', url: '/channels',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'test-private', visibility: 'private' },
    });
    expect(res.statusCode).toBe(201);
    const channelId = res.json().id;

    // admin gets the event
    await waitFor(() =>
      admin.events.some((e: any) => e.type === 'channel.created' && e.channel.id === channelId)
    );

    // user (non-member) should NOT receive the event
    await new Promise((r) => setTimeout(r, 500));
    const userChannelEvents = user.events.filter((e: any) => e.type === 'channel.created');
    expect(userChannelEvents.some((e: any) => e.channel.id === channelId)).toBe(false);

    admin.close(); user.close();
  });

  it('3. delete channel → all who could see it receive channel.deleted', async () => {
    // create a public channel first
    const createRes = await app.inject({
      method: 'POST', url: '/channels',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'to-delete', visibility: 'public' },
    });
    const channelId = createRes.json().id;

    const admin = await collect(adminToken);
    const user = await collect(adminPat2);
    await admin.ready; await user.ready;

    // archive the channel first (required for deletion)
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    // delete the channel
    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    await waitFor(() =>
      admin.events.some((e: any) => e.type === 'channel.deleted' && e.channelId === channelId) &&
      user.events.some((e: any) => e.type === 'channel.deleted' && e.channelId === channelId)
    );

    const adminEvent = admin.events.find((e: any) => e.type === 'channel.deleted') as any;
    const userEvent = user.events.find((e: any) => e.type === 'channel.deleted') as any;
    expect(adminEvent?.channelId).toBe(channelId);
    expect(userEvent?.channelId).toBe(channelId);

    admin.close(); user.close();
  });

  it('4. public→private: non-member gets deleted, member gets updated', async () => {
    // create a public channel
    const createRes = await app.inject({
      method: 'POST', url: '/channels',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'to-private', visibility: 'public' },
    });
    const channelId = createRes.json().id;

    const admin = await collect(adminToken);
    const user = await collect(adminPat2);
    await admin.ready; await user.ready;

    // user is NOT a member (public channel but not added)

    // change to private
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { visibility: 'private' },
    });

    // non-member (user) should get channel.deleted
    await waitFor(() =>
      user.events.some((e: any) => e.type === 'channel.deleted' && e.channelId === channelId)
    );

    // member (admin) should get channel.updated
    await waitFor(() =>
      admin.events.some((e: any) => e.type === 'channel.updated' && e.channel.id === channelId)
    );

    const userDeletedEvent = user.events.find((e: any) => e.type === 'channel.deleted') as any;
    const adminUpdatedEvent = admin.events.find((e: any) => e.type === 'channel.updated') as any;
    expect(userDeletedEvent?.channelId).toBe(channelId);
    expect(adminUpdatedEvent?.channel.id).toBe(channelId);
    expect(adminUpdatedEvent?.channel.visibility).toBe('private');

    admin.close(); user.close();
  });

  it('5. saved.changed goes only to the owner', async () => {
    // create a channel and a message
    const channelRes = await app.inject({
      method: 'POST', url: '/channels',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'saved-test', visibility: 'public' },
    });
    const channelId = channelRes.json().id;

    const msgRes = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'test message for save' },
    });
    const messageId = msgRes.json().id;

    const admin = await collect(adminToken);
    const user = await collect(adminPat2);
    await admin.ready; await user.ready;

    // admin saves the message
    await app.inject({
      method: 'PUT', url: `/saved/${messageId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // admin should receive saved.changed
    await waitFor(() =>
      admin.events.some((e: any) => e.type === 'saved.changed' && e.messageId === messageId && e.state === 'open')
    );

    // user should NOT receive saved.changed (not their saved message)
    await new Promise((r) => setTimeout(r, 500));
    const userSavedEvents = user.events.filter((e: any) => e.type === 'saved.changed');
    expect(userSavedEvents.some((e: any) => e.messageId === messageId)).toBe(false);

    // test state change
    await app.inject({
      method: 'PATCH', url: `/saved/${messageId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { state: 'done' },
    });

    await waitFor(() =>
      admin.events.some((e: any) => e.type === 'saved.changed' && e.messageId === messageId && e.state === 'done')
    );

    // test unsave
    await app.inject({
      method: 'DELETE', url: `/saved/${messageId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    await waitFor(() =>
      admin.events.some((e: any) => e.type === 'saved.changed' && e.messageId === messageId && e.state === null)
    );

    admin.close(); user.close();
  });
});