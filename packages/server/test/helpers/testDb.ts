import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';

export interface TestDb {
  pool: pg.Pool;
  /** 같은 컨테이너에 다른 데이터베이스로 붙어야 하는 테스트(동시 마이그레이션 등)를 위한 접속 URI. */
  uri: string;
  stop(): Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  const uri = container.getConnectionUri();
  // 프로덕션과 같은 가드를 쓴다. 테스트 파일마다 자기 컨테이너를 죽이는데, 그때 다른 파일의
  // 유휴 연결이 FATAL 57P01 을 받는다 — 리스너가 없으면 그것이 **테스트 전부 통과한 뒤에도**
  // unhandled error 로 러너를 실패시킨다(CI 에서 실제로 났다: 180 통과 + unhandled 1).
  const pool = createPool(uri, () => { /* 종료 경합의 FATAL 은 정상이다 */ });
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
