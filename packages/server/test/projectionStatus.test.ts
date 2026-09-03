import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

describe('projection status endpoint', () => {
  let app: FastifyInstance;
  let stop: () => Promise<void>;
  let token: string;
  let dbPool: Awaited<ReturnType<typeof startTestDb>>['pool'];

  beforeAll(async () => {
    const db = await startTestDb();
    dbPool = db.pool;
    stop = db.stop;
    app = await buildServer({ pool: dbPool });
    const { token: adminToken } = await bootstrapAdmin(app);
    token = adminToken;
  });

  afterAll(async () => { await app.close(); await stop(); });

  it('returns unconfigured when configured is false', async () => {
    const testApp = await buildServer({
      pool: dbPool,
      getProjectionStatus: () => ({
        configured: false,
        repo: null,
        lastLogIndex: 0,
        lastPolledAt: null,
        lastAdvancedAt: null,
        lastError: null,
      }),
    });
    try {
      const res = await testApp.inject({
        method: 'GET',
        url: '/projection/status',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json() as { state: string };
      expect(json.state).toBe('unconfigured');
    } finally {
      await testApp.close();
    }
  });

  it('returns ok when configured and polling recently with no error', async () => {
    const now = Date.now();
    const testApp = await buildServer({
      pool: dbPool,
      getProjectionStatus: () => ({
        configured: true,
        repo: 'test/repo',
        lastLogIndex: 100,
        lastPolledAt: now,
        lastAdvancedAt: now,
        lastError: null,
      }),
    });
    try {
      const res = await testApp.inject({
        method: 'GET',
        url: '/projection/status',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json() as { state: string };
      expect(json.state).toBe('ok');
    } finally {
      await testApp.close();
    }
  });

  it('returns stalled when lastPolledAt is 6 minutes ago', async () => {
    const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
    const testApp = await buildServer({
      pool: dbPool,
      getProjectionStatus: () => ({
        configured: true,
        repo: 'test/repo',
        lastLogIndex: 100,
        lastPolledAt: sixMinutesAgo,
        lastAdvancedAt: sixMinutesAgo,
        lastError: null,
      }),
    });
    try {
      const res = await testApp.inject({
        method: 'GET',
        url: '/projection/status',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json() as { state: string };
      expect(json.state).toBe('stalled');
    } finally {
      await testApp.close();
    }
  });

  it('returns ok when lastPolledAt is 4 minutes ago (boundary test)', async () => {
    const fourMinutesAgo = Date.now() - 4 * 60 * 1000;
    const testApp = await buildServer({
      pool: dbPool,
      getProjectionStatus: () => ({
        configured: true,
        repo: 'test/repo',
        lastLogIndex: 100,
        lastPolledAt: fourMinutesAgo,
        lastAdvancedAt: fourMinutesAgo,
        lastError: null,
      }),
    });
    try {
      const res = await testApp.inject({
        method: 'GET',
        url: '/projection/status',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json() as { state: string };
      expect(json.state).toBe('ok');
    } finally {
      await testApp.close();
    }
  });

  it('returns stalled when lastError is present', async () => {
    const testApp = await buildServer({
      pool: dbPool,
      getProjectionStatus: () => ({
        configured: true,
        repo: 'test/repo',
        lastLogIndex: 100,
        lastPolledAt: Date.now(),
        lastAdvancedAt: Date.now(),
        lastError: 'connection refused',
      }),
    });
    try {
      const res = await testApp.inject({
        method: 'GET',
        url: '/projection/status',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json() as { state: string; lastError: string };
      expect(json.state).toBe('stalled');
      expect(json.lastError).toBe('connection refused');
    } finally {
      await testApp.close();
    }
  });
});