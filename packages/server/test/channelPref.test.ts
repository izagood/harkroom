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
  it('sets notify level and appears in GET', async () => {
    const set = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { notifyLevel: 'none' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().notifyLevel).toBe('none');

    const list = await app.inject({
      method: 'GET', url: '/channels/prefs',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.statusCode).toBe(200);
    const prefs = list.json().prefs as { channelId: string; notifyLevel: string }[];
    const found = prefs.find((p) => p.channelId === channelId);
    expect(found).not.toBeUndefined();
    expect(found?.notifyLevel).toBe('none');
  });

  it('accepts the middle level', async () => {
    const set = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { notifyLevel: 'mentions' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().notifyLevel).toBe('mentions');
  });

  it('rejects an unknown level', async () => {
    const bad = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { notifyLevel: 'sometimes' },
    });
    expect(bad.statusCode).toBe(400);
  });

  // `muted` 는 더 이상 받지 않는다(#224). 남겨 두면 아무것도 읽지 않는 스위치가 되어
  // "껐는데 왜 아직 울리나"가 그대로 돌아온다.
  it('no longer accepts a muted patch', async () => {
    const legacy = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { muted: true },
    });
    expect(legacy.statusCode).not.toBe(200);
  });

  it('leaves starred intact when only setting the level', async () => {
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { starred: true },
    });
    const levelOnly = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { notifyLevel: 'none' },
    });
    expect(levelOnly.statusCode).toBe(200);
    expect(levelOnly.json().notifyLevel).toBe('none');
    expect(levelOnly.json().starredAt).not.toBeNull();
  });

  it('does not see other account prefs', async () => {
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { notifyLevel: 'none' },
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
      payload: { notifyLevel: 'none' },
    });
    expect(notFound.statusCode).toBe(404);
  });
});