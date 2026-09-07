// 투영 URL 의 저장 자리(설계 §4). 단일 행 테이블이라야 "투영 URL 이 무엇인가" 에
// 답이 하나다 — 행이 둘이면 어느 쪽을 읽느냐가 정렬 순서 같은 우연에 달린다.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { getProjectionConfig, setProjectionConfig } from '../src/services/projectionConfig.js';

let pool: Pool;
let stop: () => Promise<void>;

beforeAll(async () => { const db = await startTestDb(); pool = db.pool; stop = db.stop; });
afterAll(async () => { await stop(); });
beforeEach(async () => {
  await pool.query(`update projection_config set avcs_base_url = null where id = true`);
});

describe('projection_config', () => {
  /** 읽는 쪽이 "행이 없다" 를 따로 다루지 않도록 마이그레이션이 한 행을 넣어 둔다. */
  it('처음부터 행이 하나 있고 값은 null 이다', async () => {
    const rows = await pool.query(`select count(*)::int as n from projection_config`);
    expect(rows.rows[0]?.n).toBe(1);
    expect(await getProjectionConfig(pool)).toBeNull();
  });

  it('쓴 값을 그대로 읽는다', async () => {
    await setProjectionConfig(pool, 'http://avcs.example:4000');
    expect(await getProjectionConfig(pool)).toBe('http://avcs.example:4000');
  });

  /** 지우기는 명시적 null 이다. 빈 문자열로 지우면 오타 저장과 구분되지 않는다. */
  it('null 로 지운다', async () => {
    await setProjectionConfig(pool, 'http://avcs.example:4000');
    await setProjectionConfig(pool, null);
    expect(await getProjectionConfig(pool)).toBeNull();
  });

  it('빈 문자열은 DB 가 거절한다', async () => {
    await expect(setProjectionConfig(pool, '')).rejects.toThrow();
  });

  // 두 제약을 따로 찌른다 — PK 유일성이 true 행 중복을, check (id) 가 false 행을 막는다.
  it('행을 하나 더 넣으려 하면 DB 가 거절한다', async () => {
    await expect(pool.query(`insert into projection_config (id) values (true)`)).rejects.toThrow();
    await expect(pool.query(`insert into projection_config (id) values (false)`)).rejects.toThrow();
  });
});
