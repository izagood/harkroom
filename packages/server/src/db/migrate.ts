import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(`create table if not exists schema_migrations (name text primary key)`);
  const dir = new URL('./migrations/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const name of files) {
    const applied = await pool.query('select 1 from schema_migrations where name = $1', [name]);
    if ((applied.rowCount ?? 0) > 0) continue;
    const sql = await readFile(new URL(name, dir), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [name]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }
}
