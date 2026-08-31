import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
});
afterAll(async () => { await app.close(); await stop(); });

describe('channels', () => {
  it('admin creates channel with repo binding; anyone lists it', async () => {
    const res = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'dev', topic: 'work', repo: 'main-repo' },
    });
    expect(res.statusCode).toBe(201);
    const list = await app.inject({
      method: 'GET', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.json().channels).toEqual([
      expect.objectContaining({ name: 'dev', kind: 'standard', repo: 'main-repo' }),
    ]);
  });

  it('dm is deduplicated for the same member set', async () => {
    const { accountId: botId } = await createAgent(app, adminToken, 'dmbot');
    const mk = () => app.inject({
      method: 'POST', url: '/dms', headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountIds: [botId] },
    });
    const a = await mk();
    const b = await mk();
    expect(a.json().id).toBe(b.json().id);
    expect(a.json().kind).toBe('dm');
  });
});
