/**
 * 스위트 전체가 공유하는 Postgres 컨테이너 하나.
 *
 * 전에는 테스트 파일마다 자기 컨테이너를 띄웠다. 아무도 그렇게 결정한 적은 없다 — 첫 파일의
 * `beforeAll` 이 복사되며 27개까지 늘었을 뿐이고, 그동안 그 설계가 두 번 청구서를 보냈다.
 *
 * 1. **로컬**: vitest 는 fork 를 코어 수만큼 띄운다(14코어 → 13개). 워크트리 여러 곳에서
 *    세션이 동시에 스위트를 돌리면 그 배수가 한 Docker 데몬에 얹힌다. 2026-09-01 에 컨테이너
 *    31개가 적재돼 `docker ps` 조차 120초를 넘겼고, 24GB 머신이 멈춰 강제 재부팅했다.
 * 2. **CI**: 파일이 끝나며 자기 컨테이너를 죽이면 **다른 파일의 유휴 연결**이 FATAL 57P01 을
 *    받는다. 그게 "180개 전부 통과한 뒤 unhandled error" 로 main 을 빨갛게 만들었다.
 *
 * 컨테이너가 하나면 둘 다 성립하지 않는다. 테스트 도중 Postgres 가 죽는 일이 아예 없다.
 * (프로덕션의 pool 에러 가드는 그와 별개로 유지된다 — 실제 운영에서 재시작은 일어난다.)
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { GlobalSetupContext } from 'vitest/node';
import { runMigrations } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';

/** 마이그레이션이 끝난 원본. 파일별 DB 는 이걸 복제해서 만든다(testDb.ts). */
export const TEMPLATE_DB = 'murmur_tpl';

let container: StartedPostgreSqlContainer | null = null;

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const uri = container.getConnectionUri();

  const admin = createPool(uri, () => { /* 셋업 중 유휴 에러는 아래 실패로 드러난다 */ });
  try {
    await admin.query(`create database ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }

  // 스키마는 여기서 딱 한 번 만든다. 파일마다 runMigrations 를 다시 돌릴 이유가 없다 —
  // 27번 반복하던 일이다.
  const template = new URL(uri);
  template.pathname = `/${TEMPLATE_DB}`;
  const tpl = createPool(template.toString(), () => {});
  try {
    await runMigrations(tpl);
  } finally {
    // 반드시 끊는다. 템플릿에 살아 있는 연결이 하나라도 있으면 Postgres 가
    // `CREATE DATABASE ... TEMPLATE` 를 거절한다(source database is being accessed by other users).
    await tpl.end();
  }

  provide('pgUri', uri);
}

export async function teardown(): Promise<void> {
  await container?.stop();
  container = null;
}

declare module 'vitest' {
  interface ProvidedContext {
    /** 공유 컨테이너의 접속 URI(관리 DB). 파일별 DB 는 여기에 만든다. */
    pgUri: string;
  }
}
