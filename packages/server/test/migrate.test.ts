import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdir } from 'node:fs/promises';
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
      'channel', 'channel_member', 'message',
      'inbox', 'projection_cursor', 'active_lease', 'idempotency_key',
    ]) {
      expect(names).toContain(t);
    }
    // `work_thread` 가 이 목록에 있었다. 040 이 지웠으므로 **없어야 한다** — 그냥 목록에서
    // 빼면 되살아나도 아무도 모르니, 부재를 단언한다.
    expect(names).not.toContain('work_thread');
  });

  /**
   * `enforces (repo, oid) uniqueness for system messages` 를 뒤집었다.
   *
   * 그 유니크 인덱스(`message_avcs_oid`)는 **투영 멱등성 전용**이었다 — murmur DB 를
   * 되돌려 커서가 후퇴해도 같은 avcs 객체가 메시지로 두 번 들어오지 않게 막는 자리다.
   * 메시지를 만들지 않으므로 막을 중복이 없고, 040 이 인덱스를 지웠다.
   *
   * 단언을 그냥 지우지 않고 부재를 고정하는 이유: 인덱스가 되살아나면 과거에 투영된
   * 메시지가 있는 DB 에서 마이그레이션이 실패할 수 있고(그때는 이미 운영 중이다),
   * 무엇보다 "이 유니크를 다시 요구하는 코드가 생겼다"는 신호다.
   */
  it('drops the projection-only (repo, oid) unique index', async () => {
    const idx = await pool.query(
      `select 1 from pg_indexes where schemaname = 'public' and indexname = 'message_avcs_oid'`,
    );
    expect(idx.rowCount).toBe(0);

    // 같은 (repo, oid) 를 두 번 넣어도 이제 막히지 않는다 — 위 부재의 실제 결과다.
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
    await expect(insert()).resolves.toBeTruthy();
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
      // 목록을 하드코딩하면 마이그레이션을 추가할 때마다 이 테스트가 깨진다. 여기서 지켜야 할
      // 것은 '무엇이 적용됐나'가 아니라 '디렉터리의 전부가 정확히 한 번씩 적용됐나'다.
      const onDisk = (await readdir(new URL('../src/db/migrations/', import.meta.url)))
        .filter((f) => f.endsWith('.sql')).sort();
      const applied = await a.query('select name from schema_migrations order by name');
      expect(applied.rows.map((r) => r.name)).toEqual(onDisk);
      const distinct = await a.query('select count(distinct name)::int as n from schema_migrations');
      expect(distinct.rows[0].n).toBe(onDisk.length);
    } finally {
      await a.end();
      await b.end();
    }
  });
});
