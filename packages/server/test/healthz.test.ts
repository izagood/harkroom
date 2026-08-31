import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/buildServer.js';

describe('healthz', () => {
  it('GET /healthz returns ok', async () => {
    const app = await buildServer({ pool: null });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, avcs: { connected: false } });
    await app.close();
  });
});
