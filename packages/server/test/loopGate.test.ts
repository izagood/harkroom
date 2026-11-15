// 서버 루프 문지기(S5.3 C5) — 한 sweep 이 두 프로세스에서 겹쳐 돌지 않는지, 주인이 아니면 돌지 않는지 실제 Postgres 로 본다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '../src/db/pool.js';
import { LOOP_LOCK_CLASS, runGated } from '../src/services/loopGate.js';
import { startTestDb, type TestDb } from './helpers/testDb.js';

let db: TestDb;
let other: pg.Pool;

beforeAll(async () => {
  db = await startTestDb();
  // 다른 프로세스(Rust 앞단·두 번째 TS)를 흉내 내는 따로 된 풀 — 세션이 달라야 advisory lock 이 서로를 막는다.
  other = createPool(db.uri, () => {});
});
afterAll(async () => {
  await other.end();
  await db.stop();
});

describe('runGated', () => {
  it('두 풀이 같은 루프를 동시에 돌리면 sweep 은 한 번만 돈다', async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const sweep = async () => { runs += 1; await gate; };
    const first = runGated(db.pool, 'wake', sweep);
    // 첫 tick 이 잠금을 쥔 채 sweep 안에서 멈출 때까지 기다린다.
    while (runs === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await runGated(other, 'wake', sweep);
    expect(second).toBe('locked');
    release();
    expect(await first).toBe('ran');
    expect(runs).toBe(1);
    // 풀린 뒤에는 다시 잡힌다.
    expect(await runGated(other, 'wake', async () => {})).toBe('ran');
  });

  it('다른 루프 이름은 서로 막지 않는다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = false;
    const first = runGated(db.pool, 'automation', async () => { started = true; await gate; });
    while (!started) await new Promise((r) => setTimeout(r, 5));
    expect(await runGated(other, 'scheduled', async () => {})).toBe('ran');
    release();
    expect(await first).toBe('ran');
  });

  it('주인 줄이 없으면 ts 가 주인이고, rust 로 바꾸면 TS 는 건너뛴다', async () => {
    let runs = 0;
    const sweep = async () => { runs += 1; };
    expect(await runGated(db.pool, 'push', sweep)).toBe('ran');
    expect(await runGated(db.pool, 'push', sweep, { side: 'rust' })).toBe('not_owner');
    await db.pool.query(`insert into server_loop (name, owner) values ('push', 'rust')`);
    expect(await runGated(db.pool, 'push', sweep)).toBe('not_owner');
    expect(await runGated(db.pool, 'push', sweep, { side: 'rust' })).toBe('ran');
    expect(runs).toBe(2);
  });

  it('sweep 이 던져도 던지지 않고 잠금을 푼다', async () => {
    const errors: unknown[] = [];
    const r = await runGated(db.pool, 'bg', async () => { throw new Error('boom'); }, { onError: (e) => errors.push(e) });
    expect(r).toBe('error');
    expect(errors).toHaveLength(1);
    const held = await db.pool.query(
      `select count(*)::int as n from pg_locks where locktype = 'advisory' and classid = $1::bigint::oid`, [LOOP_LOCK_CLASS]);
    expect(held.rows[0].n).toBe(0);
    expect(await runGated(other, 'bg', async () => {})).toBe('ran');
  });

  it('주인 이름은 표의 형식 검사를 지난다', async () => {
    await expect(db.pool.query(`insert into server_loop (name, owner) values ('Bad Name', 'ts')`)).rejects.toThrow();
    await expect(db.pool.query(`insert into server_loop (name, owner) values ('stale', 'go')`)).rejects.toThrow();
  });
});
