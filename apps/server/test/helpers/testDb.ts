import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import type pg from 'pg';
import { createPool } from '../../src/db/pool.js';
import { TEMPLATE_DB } from './globalSetup.js';

export interface TestDb {
  pool: pg.Pool;
  /** 같은 컨테이너에 다른 데이터베이스로 붙어야 하는 테스트(동시 마이그레이션 등)를 위한 접속 URI. */
  uri: string;
  stop(): Promise<void>;
}

/**
 * `CREATE DATABASE ... TEMPLATE` 직렬화용 키. 같은 템플릿에서 동시에 복제하면 Postgres 가
 * `55006 source database is being accessed by other users` 로 거절할 수 있다. fork 가 13개씩
 * 붙는 곳이므로 운에 맡기지 않는다. 복제는 수십 ms 라 직렬화해도 병목이 아니다.
 * migrate.ts 의 잠금(0x6d726d72)과 다른 키여야 한다 — 둘은 서로를 기다릴 이유가 없다.
 */
const CLONE_LOCK_KEY = 0x6d726d73; // 'mrms'

const withDatabase = (uri: string, name: string): string => {
  const url = new URL(uri);
  url.pathname = `/${name}`;
  return url.toString();
};

/**
 * 이 테스트 파일만 쓰는 빈 database 를 준다. 컨테이너는 스위트 전체가 공유하고
 * (helpers/globalSetup.ts), 여기서는 마이그레이션이 끝난 템플릿을 복제할 뿐이다 —
 * 격리에 필요한 것은 빈 스키마이지 Postgres 프로세스 하나가 아니다.
 */
export async function startTestDb(): Promise<TestDb> {
  const base = inject('pgUri');
  // 식별자로 그대로 들어가므로 영숫자만 남긴다(인용부호 없이 안전한 형태).
  const name = `t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const admin = createPool(base, () => { /* 관리 연결의 유휴 에러는 무시한다 */ });
  const client = await admin.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [CLONE_LOCK_KEY]);
    await client.query(`create database ${name} template ${TEMPLATE_DB}`);
  } finally {
    await client.query('select pg_advisory_unlock($1)', [CLONE_LOCK_KEY]).catch(() => {});
    client.release();
    await admin.end();
  }

  const uri = withDatabase(base, name);
  // 프로덕션과 같은 가드를 쓴다. 컨테이너를 공유하게 된 뒤로 테스트 도중 Postgres 가 죽는 일은
  // 없어졌지만, 가드를 벗기면 프로덕션과 다른 Pool 을 테스트하는 셈이 된다.
  const pool = createPool(uri, () => { /* 종료 경합의 FATAL 은 정상이다 */ });

  return {
    pool,
    uri,
    stop: async () => {
      await pool.end();
      // 스위트가 길면 복제본이 쌓인다. 컨테이너가 곧 사라지므로 실패해도 치명적이지 않다 —
      // 정리 실패가 테스트 실패를 덮지 않도록 삼킨다.
      const dropper = createPool(base, () => {});
      try {
        await dropper.query(`drop database if exists ${name} with (force)`);
      } catch { /* 위 주석 */ } finally {
        await dropper.end();
      }
    },
  };
}
