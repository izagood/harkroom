import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let otherToken: string;
let otherId: string;
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));

  const inv = await app.inject({
    method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` },
  });
  const inviteToken = inv.json().token as string;

  const register = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { handle: 'otheruser', displayName: 'Other User', password: 'pw123456', inviteToken },
  });
  otherId = register.json().id as string;
  const login = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { handle: 'otheruser', password: 'pw123456' },
  });
  otherToken = login.json().token as string;

  const created = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'test-channel' },
  });
  channelId = created.json().id as string;
});
afterAll(async () => { await app.close(); await stop(); });

describe('channel pref', () => {
  it('mutes a channel and appears in GET', async () => {
    const mute = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { muted: true },
    });
    expect(mute.statusCode).toBe(200);
    expect(mute.json().mutedAt).not.toBeNull();

    const list = await app.inject({
      method: 'GET', url: '/channels/prefs',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.statusCode).toBe(200);
    const prefs = list.json().prefs as { channelId: string; mutedAt: string | null }[];
    const found = prefs.find((p) => p.channelId === channelId);
    expect(found).not.toBeUndefined();
    expect(found?.mutedAt).not.toBeNull();
  });

  it('unmutes a channel by setting false', async () => {
    const unmute = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { muted: false },
    });
    expect(unmute.statusCode).toBe(200);
    expect(unmute.json().mutedAt).toBeNull();
  });

  it('leaves starred intact when only muting', async () => {
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { starred: true },
    });
    const muteOnly = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { muted: true },
    });
    expect(muteOnly.statusCode).toBe(200);
    expect(muteOnly.json().mutedAt).not.toBeNull();
    expect(muteOnly.json().starredAt).not.toBeNull();
  });

  it('does not see other account prefs', async () => {
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { muted: true },
    });

    const otherList = await app.inject({
      method: 'GET', url: '/channels/prefs',
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(otherList.statusCode).toBe(200);
    const prefs = otherList.json().prefs as { channelId: string }[];
    const found = prefs.find((p) => p.channelId === channelId);
    expect(found).toBeUndefined();
  });

  it('404s on non-existent channel', async () => {
    const notFound = await app.inject({
      method: 'PATCH', url: '/channels/00000000-0000-0000-0000-000000000000/pref',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { muted: true },
    });
    expect(notFound.statusCode).toBe(404);
  });
});