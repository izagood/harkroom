import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

export async function startTestDb(): Promise<{ pool: pg.Pool; stop(): Promise<void> }> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  const pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  return {
    pool,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
