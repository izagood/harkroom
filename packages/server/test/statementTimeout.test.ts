// 쿼리 시간 상한(2026-10-12). 옛 파드가 남긴 메시지 목록 쿼리가 47분을 돌며 Postgres CPU 를 다 썼다 — 상한은
// 연결 시작 파라미터라 서버가 집행한다. 마이그레이션은 그 세션에서만 상한을 푼다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { startTestDb } from './helpers/testDb.js';
import {
  createPool, STATEMENT_TIMEOUT_MS, IDLE_IN_TRANSACTION_TIMEOUT_MS, CLIENT_CHECK_INTERVAL_MS,
} from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';

let db: Awaited<ReturnType<typeof startTestDb>>;
const extra: pg.Pool[] = [];
const poolWith = (limits: Parameters<typeof createPool>[2]) => {
  const p = createPool(db.uri, () => {}, limits);
  extra.push(p);
  return p;
};

beforeAll(async () => { db = await startTestDb(); });
afterAll(async () => {
  for (const p of extra) await p.end().catch(() => {});
  await db.stop();
});

describe('쿼리 시간 상한', () => {
  it('기본 풀의 모든 세션에 상한·유휴 트랜잭션 상한·클라이언트 확인 주기가 걸려 있다', async () => {
    const show = async (name: string) => (await db.pool.query(`select current_setting($1) as v`, [name])).rows[0].v as string;
    expect(await show('statement_timeout')).toBe(`${STATEMENT_TIMEOUT_MS / 1000}s`);
    expect(await show('idle_in_transaction_session_timeout')).toBe(`${IDLE_IN_TRANSACTION_TIMEOUT_MS / 60_000}min`);
    expect(await show('client_connection_check_interval')).toBe(`${CLIENT_CHECK_INTERVAL_MS / 1000}s`);
  });

  it('상한을 넘긴 쿼리는 서버가 끊는다(57014)', async () => {
    const pool = poolWith({ statementTimeoutMs: 100 });
    await expect(pool.query('select pg_sleep(2)')).rejects.toMatchObject({ code: '57014' });
    // 끊긴 뒤에도 같은 풀로 다음 쿼리는 된다.
    expect((await pool.query('select 1 as ok')).rows[0].ok).toBe(1);
  });

  it('마이그레이션은 상한에 걸리지 않고(잠금 대기 포함), 끝나면 그 연결의 상한을 되돌린다', async () => {
    const pool = poolWith({ statementTimeoutMs: 100 });
    // 다른 인스턴스가 마이그레이션 잠금을 쥔 상황 — 기다림이 상한(100ms)보다 길다.
    const holder = await db.pool.connect();
    await holder.query('select pg_advisory_lock($1)', [0x6d726d72]);
    const run = runMigrations(pool);
    await new Promise((r) => setTimeout(r, 400));
    await holder.query('select pg_advisory_unlock($1)', [0x6d726d72]);
    holder.release();
    await expect(run).resolves.toBeUndefined();

    const settings = await Promise.all(Array.from({ length: 3 }, async () => {
      const c = await pool.connect();
      try { return (await c.query(`select current_setting('statement_timeout') as v`)).rows[0].v as string; } finally { c.release(); }
    }));
    expect(settings.every((v) => v === '100ms')).toBe(true);
  });
});
