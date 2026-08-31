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
