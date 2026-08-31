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
afterAll(async () => { await app.close(); await stop(); });

const ORIGIN = 'http://localhost:5173';

describe('cors', () => {
  it('answers a cross-origin preflight with 2xx and reflects the origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(200);
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('reflects the origin on a normal cross-origin GET', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: ORIGIN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
  });
});
