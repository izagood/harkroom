import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

export interface TestDb {
  pool: pg.Pool;
  /** 같은 컨테이너에 다른 데이터베이스로 붙어야 하는 테스트(동시 마이그레이션 등)를 위한 접속 URI. */
  uri: string;
  stop(): Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  const uri = container.getConnectionUri();
  const pool = new pg.Pool({ connectionString: uri });
  await runMigrations(pool);
  return {
    pool,
    uri,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
