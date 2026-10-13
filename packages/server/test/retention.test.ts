// 보존 기간 정리(2026-10-13 쿼리 개선 Q5-c). 지우는 것은 idempotency_key 7일·만료 30일 지난 session 둘뿐이고,
// 첫 sweep 은 지우기 전에 대상 수를 세어 로그에 남긴다. 한 번에 RETENTION_BATCH 줄까지만 지운다.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';
import { createRetentionSweeper, RETENTION_BATCH } from '../src/services/retention.js';

let app: FastifyInstance; let pool: Pool; let stop: () => Promise<void>;
let adminId: string; let channelId: string; let messageId: string;

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool;
  app = await buildServer({ pool });
  const admin = await bootstrapAdmin(app);
  adminId = admin.accountId;
  channelId = (await app.inject({ method: 'POST', url: '/channels', headers: { authorization: `Bearer ${admin.token}` }, payload: { name: 'retention' } })).json().id;
  messageId = ((await postMessage(pool, { channelId, authorId: adminId, threadRootId: null, body: 'x', meta: {} })) as { message: { id: string } }).message.id;
});
afterAll(async () => { await app.close(); await stop(); });
beforeEach(async () => {
  await pool.query(`delete from idempotency_key where key like 'rt-%'`);
  await pool.query(`delete from session where token_hash like 'rt-%'`);
});

const key = (name: string, age: string) => pool.query(
  `insert into idempotency_key (key, message_id, author_id, channel_id, created_at) values ($1, $2, $3, $4, now() - $5::interval)`,
  [name, messageId, adminId, channelId, age]);
const sess = (hash: string, expiresIn: string) => pool.query(
  `insert into session (token_hash, account_id, expires_at) values ($1, $2, now() + $3::interval)`, [hash, adminId, expiresIn]);
const has = async (table: 'idempotency_key' | 'session', col: string, v: string) =>
  ((await pool.query(`select 1 from ${table} where ${col} = $1`, [v])).rowCount ?? 0) > 0;

describe('보존 기간 정리 (Q5-c)', () => {
  it('idempotency_key 는 7일 넘은 것만, session 은 만료 30일 넘은 것만 지운다 — 쓰는 중인 세션·갓 만료된 세션은 남는다', async () => {
    await key('rt-old', '7 days 1 minute');
    await key('rt-edge', '6 days 23 hours');
    await sess('rt-dead', '-30 days -1 minute');
    await sess('rt-recent-expired', '-29 days');
    await sess('rt-live', '+14 days');
    const res = await createRetentionSweeper(pool, { log: () => {} }).sweep();
    expect(await has('idempotency_key', 'key', 'rt-old')).toBe(false);
    expect(await has('idempotency_key', 'key', 'rt-edge')).toBe(true);
    expect(await has('session', 'token_hash', 'rt-dead')).toBe(false);
    expect(await has('session', 'token_hash', 'rt-recent-expired')).toBe(true);
    expect(await has('session', 'token_hash', 'rt-live')).toBe(true);
    expect(res.map((r) => r.table)).toEqual(['idempotency_key', 'session']);
  });

  it('첫 sweep 은 지우기 전에 표마다 대상 수를 로그에 남기고, 그 뒤 sweep 은 다시 세지 않는다 — 로그에 행 내용은 없다', async () => {
    await key('rt-a', '8 days'); await key('rt-b', '9 days');
    await sess('rt-gone', '-40 days');
    const lines: string[] = [];
    const s = createRetentionSweeper(pool, { log: (m) => lines.push(m) });
    await s.sweep();
    const counts = lines.filter((l) => l.includes('eligible='));
    expect(counts).toEqual([
      expect.stringMatching(/^retention: idempotency_key eligible=2 /),
      expect.stringMatching(/^retention: session eligible=1 /),
    ]);
    // 세는 줄이 지우는 줄보다 먼저다.
    expect(lines.findIndex((l) => l.includes('eligible='))).toBeLessThan(lines.findIndex((l) => l.includes('deleted=')));
    expect(lines.join('\n')).not.toMatch(/rt-a|rt-b|rt-gone/);
    lines.length = 0;
    await s.sweep();
    expect(lines.filter((l) => l.includes('eligible='))).toEqual([]);
  });

  it(`한 번에 ${RETENTION_BATCH} 줄까지만 지우고 나머지는 다음 sweep 에 지운다`, async () => {
    await pool.query(
      `insert into idempotency_key (key, message_id, author_id, channel_id, created_at)
       select 'rt-bulk-' || g, $1, $2, $3, now() - interval '10 days' from generate_series(1, $4::int) g`,
      [messageId, adminId, channelId, RETENTION_BATCH + 50]);
    const s = createRetentionSweeper(pool, { log: () => {} });
    expect((await s.sweep()).find((r) => r.table === 'idempotency_key')!.deleted).toBe(RETENTION_BATCH);
    expect((await s.sweep()).find((r) => r.table === 'idempotency_key')!.deleted).toBe(50);
    expect((await pool.query(`select count(*)::int as n from idempotency_key where key like 'rt-bulk-%'`)).rows[0].n).toBe(0);
  });

  it('지우지 않기로 한 표(secret_turn_lease·inbox·audit_log)는 규칙에 없다', async () => {
    const { RETENTION_RULES } = await import('../src/services/retention.js');
    const tables: string[] = RETENTION_RULES.map((r) => r.table);
    for (const t of ['secret_turn_lease', 'inbox', 'audit_log', 'secret_access_log']) expect(tables).not.toContain(t);
  });
});
