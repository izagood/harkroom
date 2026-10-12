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
   * 그 유니크 인덱스(`message_avcs_oid`)는 **투영 멱등성 전용**이었다 — harkroom DB 를
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

  // 트랜잭션 밖 파일(2026-10-12, 120·121): `concurrently` 로 만든 인덱스가 **유효하게** 서 있어야 한다.
  // 실패해 INVALID 로 남은 인덱스는 이름만 있고 플래너가 안 쓴다 — 이름만 보면 놓친다.
  it('builds the no-transaction (concurrently) indexes as valid indexes', async () => {
    const res = await pool.query(
      `select c.relname as name, i.indisvalid as valid
         from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname in ('inbox_message_idx', 'inbox_unread_idx') order by c.relname`);
    expect(res.rows).toEqual([
      { name: 'inbox_message_idx', valid: true },
      { name: 'inbox_unread_idx', valid: true },
    ]);
  });

  it('reruns a no-transaction file over a leftover INVALID index', async () => {
    const { runMigrations } = await import('../src/db/migrate.js');
    // 만들다 죽은 꼴을 흉내 낸다: 기록을 지우고 인덱스를 INVALID 로 돌린다.
    await pool.query(`delete from schema_migrations where name = '121_inbox_unread_index.sql'`);
    await pool.query(`update pg_index set indisvalid = false where indexrelid = 'inbox_unread_idx'::regclass`);
    await runMigrations(pool);
    const res = await pool.query(
      `select i.indisvalid as valid from pg_index i where i.indexrelid = 'inbox_unread_idx'::regclass`);
    expect(res.rows[0].valid).toBe(true);
  });

  it('splits a no-transaction file into statements, skipping comment lines', async () => {
    const { splitStatements, NO_TRANSACTION_MARK } = await import('../src/db/migrate.js');
    const sql = '-- migrate: no-transaction\n-- a; b;\ndrop index concurrently if exists x;\ncreate index concurrently\n  if not exists x on t (a);\n';
    expect(NO_TRANSACTION_MARK.test(sql)).toBe(true);
    expect(NO_TRANSACTION_MARK.test('-- 트랜잭션 파일\ncreate index x on t (a);')).toBe(false);
    expect(splitStatements(sql)).toEqual([
      'drop index concurrently if exists x;',
      'create index concurrently\n  if not exists x on t (a);',
    ]);
  });

  // 잠금 대기 로그(#1331 security n1): 다른 인스턴스가 잠금을 쥐고 있으면 기다리는 동안 간격마다 한 줄 남긴다.
  it('logs while waiting for a migration lock held by another instance', async () => {
    const { runMigrations } = await import('../src/db/migrate.js');
    const holder = await pool.connect();
    const lines: string[] = [];
    try {
      await holder.query('select pg_advisory_lock($1)', [0x6d726d72]);
      const run = runMigrations(pool, { log: (m) => lines.push(m), lockWaitLogMs: 100 });
      // 두드리는 간격(250ms)이 로그 간격보다 길어 시각으로 재지 않고 줄이 둘 쌓일 때까지 기다린다.
      const until = Date.now() + 5_000;
      while (lines.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines[0]).toMatch(/waiting for the migration lock/);
      await holder.query('select pg_advisory_unlock($1)', [0x6d726d72]);
      await run;
    } finally {
      // 시험이 중간에 실패해도 잠금을 쥔 연결이 풀로 돌아가지 않게 한다(#1331 security 낮은 지적) — 돌아가면 뒤
      // 시험의 마이그레이션이 그 잠금을 기다리다 시한에 걸린다.
      await holder.query('select pg_advisory_unlock_all()').catch(() => {});
      holder.release(true);
    }
  });

  // 잠금 상한(2026-10-12): 트랜잭션 파일은 남이 쥔 테이블 잠금을 5초 넘게 기다리지 않는다 — 기다리는 동안
  // 그 뒤에 줄 선 쓰기가 전부 서기 때문이다. 상한을 넘기면 마이그레이션이 실패해야 한다.
  it('gives up on a transactional file when a table lock is held past lock_timeout', async () => {
    const { MIGRATION_LOCK_TIMEOUT } = await import('../src/db/migrate.js');
    expect(MIGRATION_LOCK_TIMEOUT).toBe('5s');
    await pool.query('create database lock_timeout_boot');
    const target = new URL(uri);
    target.pathname = '/lock_timeout_boot';
    const a = new pg.Pool({ connectionString: target.toString() });
    try {
      const { runMigrations } = await import('../src/db/migrate.js');
      await runMigrations(a);
      // 마지막 트랜잭션 파일을 다시 돌게 하고, 그 표를 다른 연결이 쥐고 놓지 않는다.
      // 인덱스도 걷는다 — 있으면 `if not exists` 가 잠금 없이 지나갈 수 있다(잠금 대기를 재려는 시험이다).
      await a.query(`delete from schema_migrations where name = '119_message_channel_feed_index.sql'`);
      await a.query('drop index message_channel_feed_seq_idx');
      const holder = await a.connect();
      await holder.query('begin');
      await holder.query('lock table message in access exclusive mode');
      const started = Date.now();
      await expect(runMigrations(a)).rejects.toThrow(/lock timeout/);
      expect(Date.now() - started).toBeLessThan(20_000);
      await holder.query('rollback');
      holder.release();
      // 잠금이 풀리면 다시 돌아 끝난다.
      await runMigrations(a);
    } finally {
      await a.end();
    }
  }, 30_000);

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
