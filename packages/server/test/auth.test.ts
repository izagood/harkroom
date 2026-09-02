import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';

let app: FastifyInstance;
let stop: () => Promise<void>;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
});
afterAll(async () => {
  await app.close();
  await stop();
});

describe('bootstrap & login', () => {
  it('bootstraps first admin with a default channel', async () => {
    const r = await app.inject({
      method: 'POST', url: '/bootstrap',
      payload: { handle: 'admin', displayName: 'Admin', password: 'pw123456' },
    });
    expect(r.statusCode).toBe(201);
    const token = (await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { handle: 'admin', password: 'pw123456' },
    })).json().token as string;

    const channels = await app.inject({
      method: 'GET', url: '/channels',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(channels.statusCode).toBe(200);
    expect(channels.json().channels).toHaveLength(1);
    expect(channels.json().channels[0]).toMatchObject({ name: 'general', kind: 'standard' });
    expect(channels.json().channels[0].name).toMatch(/^[a-z0-9_-]{1,48}$/);
  });

  it('bootstraps first admin, then rejects a second bootstrap', async () => {
    const r1 = await app.inject({
      method: 'POST', url: '/bootstrap',
      payload: { handle: 'jaebin', displayName: 'Jaebin', password: 'pw123456' },
    });
    expect(r1.statusCode).toBe(201);
    const r2 = await app.inject({
      method: 'POST', url: '/bootstrap',
      payload: { handle: 'x', displayName: 'X', password: 'pw123456' },
    });
    expect(r2.statusCode).toBe(409);
  });

  it('logs in and reads /auth/me', async () => {
    const login = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { handle: 'jaebin', password: 'pw123456' },
    });
    expect(login.statusCode).toBe(200);
    const { token } = login.json();
    const me = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ handle: 'jaebin', kind: 'human', isAdmin: true });
  });

  it('rejects wrong password and missing token', async () => {
    const bad = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { handle: 'jaebin', password: 'nope-nope' },
    });
    expect(bad.statusCode).toBe(401);
    const noauth = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(noauth.statusCode).toBe(401);
  });
});
