import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let botId: string;
let botPat: string;

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ accountId: botId, pat: botPat } = await createAgent(app, adminToken, 'dirbot'));
});
afterAll(async () => { await app.close(); await stop(); });

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('directory surfaces', () => {
  it('GET /accounts lists all accounts', async () => {
    const res = await app.inject({ method: 'GET', url: '/accounts', headers: auth(adminToken) });
    expect(res.statusCode).toBe(200);
    const handles = res.json().accounts.map((a: { handle: string }) => a.handle);
    expect(handles).toContain('admin');
    expect(handles).toContain('dirbot');
  });

  it('GET /dms lists only my dm channels with memberIds', async () => {
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: auth(adminToken), payload: { accountIds: [botId] },
    });
    const dmId = dm.json().id as string;
    const mine = await app.inject({ method: 'GET', url: '/dms', headers: auth(adminToken) });
    expect(mine.json().dms).toEqual([
      { id: dmId, memberIds: expect.arrayContaining([adminId, botId]) },
    ]);
    // 제3자(새 에이전트)에게는 보이지 않는다
    const { pat: otherPat } = await createAgent(app, adminToken, 'outsider');
    const theirs = await app.inject({ method: 'GET', url: '/dms', headers: auth(otherPat) });
    expect(theirs.json().dms).toEqual([]);
  });

  it('GET /leases returns only unexpired leases', async () => {
    await pool.query(
      `insert into active_lease (repo, path, actor_key_id, expires_at)
       values ('r1','src/a.ts','k1', now() + interval '1 minute'),
              ('r1','src/b.ts','k1', now() - interval '1 minute')`,
    );
    const res = await app.inject({ method: 'GET', url: '/leases', headers: auth(botPat) });
    expect(res.json().leases).toEqual([
      { repo: 'r1', path: 'src/a.ts', actorKeyId: 'k1', expiresAt: expect.any(String) },
    ]);
  });

  it('inbox entries carry channelId', async () => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'dir-ch' },
    });
    const channelId = ch.json().id as string;
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken),
      payload: { body: '@dirbot ping' },
    });
    const inbox = await app.inject({ method: 'GET', url: '/inbox?unread=1', headers: auth(botPat) });
    expect(inbox.json().entries[0]).toMatchObject({ reason: 'mention', channelId });
  });
});
