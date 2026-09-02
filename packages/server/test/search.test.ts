import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import { searchMessages } from '../src/services/messages.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'archive' },
  });
  channelId = ch.json().id;
  for (const body of ['deploy pipeline is green', 'lunch anyone?', 'pipeline failed again']) {
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { body },
    });
  }
});
afterAll(async () => { await app.close(); await stop(); });

describe('search', () => {
  it('finds messages by word, orders by seq desc, and respects limit', async () => {
    // Test 1: finds messages by word with correct seq desc ordering
    const res = await app.inject({
      method: 'GET', url: '/search?q=pipeline', headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const bodies = res.json().messages.map((m: { body: string }) => m.body);
    expect(bodies).toHaveLength(2);
    expect(bodies).toContain('deploy pipeline is green');
    expect(bodies).toEqual(['pipeline failed again', 'deploy pipeline is green']); // newest first, seq desc

    // Test 2: limit parameter works (before soft delete, when 2 messages match)
    const allResults = await searchMessages(pool, adminId, 'pipeline');
    const limitedResults = await searchMessages(pool, adminId, 'pipeline', 1);
    expect(allResults).toHaveLength(2);
    expect(limitedResults).toHaveLength(1);
  });

  it('excludes deleted messages', async () => {
    // Get a message to delete
    const res = await app.inject({
      method: 'GET', url: '/search?q=pipeline', headers: { authorization: `Bearer ${adminToken}` },
    });
    const pipelineMessages = res.json().messages;
    const messageToDelete = pipelineMessages[0];

    // Soft delete the message
    await pool.query('update message set deleted_at = now() where id = $1', [messageToDelete.id]);

    // Verify deleted message is excluded from search
    const afterDelete = await app.inject({
      method: 'GET', url: '/search?q=pipeline', headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(afterDelete.json().messages).toHaveLength(1);
    expect(afterDelete.json().messages[0].body).toBe('deploy pipeline is green');
  });
});
