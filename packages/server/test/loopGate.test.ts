// 서버 루프 문지기(S5.3 C5) — 한 sweep 이 두 프로세스에서 겹쳐 돌지 않는지, 주인이 아니면 돌지 않는지 실제 Postgres 로 본다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { LOOP_NAMES } from '../src/services/loopGate.js';
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

  it('unlock 이 실패하면 그 연결을 풀로 돌려보내지 않고 버린다(n1) — 잠금이 남지 않는다', async () => {
    const pool = createPool(db.uri, () => {});
    const released: unknown[] = [];
    const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
    (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
      const c = await connect();
      const query = c.query.bind(c) as (...a: unknown[]) => Promise<unknown>;
      (c as unknown as { query: unknown }).query = (sql: unknown, ...rest: unknown[]) =>
        typeof sql === 'string' && sql.startsWith('select pg_advisory_unlock') ? Promise.reject(new Error('unlock boom')) : query(sql, ...rest);
      const release = c.release.bind(c);
      c.release = (err?: Error | boolean) => { released.push(err); return release(err); };
      return c;
    };
    const errors: unknown[] = [];
    expect(await runGated(pool, 'retention', async () => {}, { onError: (e) => errors.push(e) })).toBe('ran');
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
    expect(errors.map((e) => (e as Error).message)).toEqual(['unlock boom']);
    // 버린 연결의 세션이 끝나면 서버가 잠금을 푼다 — 다른 프로세스가 곧 잡는다.
    let r = await runGated(other, 'retention', async () => {});
    for (let i = 0; r === 'locked' && i < 50; i++) { await new Promise((ok) => setTimeout(ok, 20)); r = await runGated(other, 'retention', async () => {}); }
    expect(r).toBe('ran');
    await pool.end();
  });

  it('루프 10개가 한꺼번에 돌아도 문지기 연결은 풀에서 하나만 쓴다(n2)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = 0;
    await db.pool.query('delete from server_loop'); // 앞 시험이 push 주인을 rust 로 바꿨다
    const ticks = LOOP_NAMES.map((n) => runGated(db.pool, n, async () => { started += 1; await gate; }));
    while (started < LOOP_NAMES.length) await new Promise((r) => setTimeout(r, 5));
    // 문지기 몫: 지금 빌려 간 연결 = 전체 - 놀고 있는 것. sweep 은 연결을 안 쓰므로 모두 문지기 몫이다.
    expect(db.pool.totalCount - db.pool.idleCount).toBe(1);
    release();
    expect(await Promise.all(ticks)).toEqual(LOOP_NAMES.map(() => 'ran'));
    expect(db.pool.totalCount - db.pool.idleCount).toBe(0);
  });

  it('같은 루프의 tick 이 이 프로세스에서 겹치면 뒤 것은 busy 로 건너뛴다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let runs = 0;
    const first = runGated(db.pool, 'stale', async () => { runs += 1; await gate; });
    while (runs === 0) await new Promise((r) => setTimeout(r, 5));
    expect(await runGated(db.pool, 'stale', async () => { runs += 1; })).toBe('busy');
    release();
    expect(await first).toBe('ran');
    expect(runs).toBe(1);
  });

  it('주인 이름은 표의 형식 검사를 지난다', async () => {
    await expect(db.pool.query(`insert into server_loop (name, owner) values ('Bad Name', 'ts')`)).rejects.toThrow();
    await expect(db.pool.query(`insert into server_loop (name, owner) values ('stale', 'go')`)).rejects.toThrow();
  });
});
