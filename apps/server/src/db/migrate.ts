import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

// 마이그레이션 직렬화용 advisory lock 키. 테이블에 의존하지 않는 잠금이어야 한다 —
// 'create table if not exists schema_migrations' 자체도 동시 실행 시 pg 카탈로그 유니크
// 인덱스에서 깨지므로(실측: pg_type_typname_nsp_index), 첫 DDL보다 앞서 잠글 곳이 필요하다.
const MIGRATION_LOCK_KEY = 0x6d726d72; // 'mrmr'

export async function runMigrations(pool: Pool): Promise<void> {
  // 롤링 업데이트에서 구·신 인스턴스가 같은 DB에 동시 부팅해도 한쪽만 실제로 적용하고,
  // 다른 쪽은 잠금을 기다렸다가 "이미 적용됨"을 보고 그냥 통과한다. 잠금은 세션 수준이라
  // 마이그레이션마다 커밋해도 유지된다.
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`create table if not exists schema_migrations (name text primary key)`);
    const dir = new URL('./migrations/', import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const name of files) {
      const applied = await client.query('select 1 from schema_migrations where name = $1', [name]);
      if ((applied.rowCount ?? 0) > 0) continue;
      const sql = await readFile(new URL(name, dir), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
  } finally {
    // 잠금 해제 실패로 원래 에러를 덮지 않는다. 커넥션을 반납하면 세션 잠금은 어차피 풀린다.
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
