import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let pool: Pool;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
});
afterAll(async () => { await app.close(); await stop(); });

const admin = () => ({ authorization: `Bearer ${adminToken}` });

const createAgentOnly = async (handle: string): Promise<string> => {
  const created = await app.inject({
    method: 'POST', url: '/accounts/agents', headers: admin(),
    payload: { handle, displayName: handle },
  });
  return created.json().id as string;
};

describe('PAT management', () => {
  it('GET /accounts/:id/pats returns labels without tokens', async () => {
    const accountId = await createAgentOnly('listpatbot');

    await app.inject({
      method: 'POST', url: `/accounts/${accountId}/pats`, headers: admin(), payload: { label: 'runner' },
    });
    await app.inject({
      method: 'POST', url: `/accounts/${accountId}/pats`, headers: admin(), payload: { label: 'backup' },
    });

    const res = await app.inject({
      method: 'GET', url: `/accounts/${accountId}/pats`, headers: admin(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { pats: { label: string; createdAt: string; revokedAt: string | null }[] };
    const labels = body.pats.map((p) => p.label).sort();
    expect(labels).toContain('runner');
    expect(labels).toContain('backup');
    const runner = body.pats.find((p) => p.label === 'runner');
    expect(runner!.createdAt).toBeDefined();
    expect(runner!.revokedAt).toBeNull();

    const dump = JSON.stringify(body);
    expect(dump).not.toContain('token');
    expect(dump).not.toContain('murp');
    expect(dump).not.toContain('hash');
  });

  it('GET /accounts/:id/pats includes revoked PATs', async () => {
    const accountId = await createAgentOnly('revokedpatbot');

    await app.inject({
      method: 'POST', url: `/accounts/${accountId}/pats`, headers: admin(), payload: { label: 'old' },
    });

    await app.inject({
      method: 'DELETE', url: `/accounts/${accountId}/pats/old`, headers: admin(),
    });

    const res2 = await app.inject({
      method: 'GET', url: `/accounts/${accountId}/pats`, headers: admin(),
    });
    const pats = (res2.json() as { pats: { label: string; revokedAt: string | null }[] }).pats;
    const oldPat = pats.find((p) => p.label === 'old');
    expect(oldPat).toBeDefined();
    expect(oldPat!.revokedAt).not.toBeNull();
  });

  it('rejects non-admin GET /accounts/:id/pats', async () => {
    const accountId = await createAgentOnly('nonadminpatbot');

    await app.inject({
      method: 'POST', url: '/accounts/agents', headers: admin(),
      payload: { handle: 'user', displayName: 'User' },
    });
    const userLogin = await app.inject({
      method: 'POST', url: '/auth/login', payload: { handle: 'user', password: 'pw123456' },
    });
    const token = userLogin.json().token as string;

    const res = await app.inject({
      method: 'GET', url: `/accounts/${accountId}/pats`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
  });
});