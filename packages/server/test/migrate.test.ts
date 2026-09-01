import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg, { type Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';

let pool: Pool;
let uri: string;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ pool, uri, stop } = await startTestDb());
});
afterAll(async () => stop());

describe('migrations', () => {
  it('creates all core tables and is idempotent on rerun', async () => {
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations(pool); // 재실행해도 에러 없어야 함
    const res = await pool.query(
      `select table_name from information_schema.tables where table_schema='public' order by table_name`,
    );
    const names = res.rows.map((r) => r.table_name);
    for (const t of [
      'account', 'session', 'pat', 'invite', 'account_key',
      'channel', 'channel_member', 'message', 'work_thread',
      'inbox', 'projection_cursor', 'active_lease', 'idempotency_key',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('enforces (repo, oid) uniqueness for system messages', async () => {
    const acc = await pool.query(
      `insert into account (handle, display_name, kind) values ('sys','sys','agent') returning id`,
    );
    const ch = await pool.query(
      `insert into channel (name, kind, repo) values ('c1','standard','r1') returning id`,
    );
    const insert = () =>
      pool.query(
        `insert into message (channel_id, author_id, body, kind, meta)
         values ($1,$2,'x','system','{"repo":"r1","oid":"o1"}')`,
        [ch.rows[0].id, acc.rows[0].id],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });

  // 롤링 업데이트(구·신 인스턴스 동시 기동)에서 두 프로세스가 같은 빈 DB에 마이그레이션을
  // 걸면, 잠금이 없으면 뒤늦은 쪽이 'relation already exists'로 부팅 중 죽는다.
  it('lets two instances migrate the same fresh database concurrently', async () => {
    const { runMigrations } = await import('../src/db/migrate.js');
    await pool.query('create database concurrent_boot');
    const target = new URL(uri);
    target.pathname = '/concurrent_boot';
    const a = new pg.Pool({ connectionString: target.toString() });
    const b = new pg.Pool({ connectionString: target.toString() });
    try {
      await Promise.all([runMigrations(a), runMigrations(b)]);
      const applied = await a.query('select name from schema_migrations order by name');
      expect(applied.rows.map((r) => r.name)).toEqual(['001_init.sql', '002_idempotency_scope.sql']);
    } finally {
      await a.end();
      await b.end();
    }
  });
});
