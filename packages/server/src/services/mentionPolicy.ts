import type { Pool, PoolClient } from 'pg';
import { MENTION_CHAIN_LIMIT, type MentionPolicy } from '@harkroom/shared';

/**
 * 멘션 연쇄 상한(078). 단일 행 테이블(`mention_policy`)을 읽고 쓴다.
 *
 * 게시마다 읽는다 — 캐시하지 않는다. 행 하나짜리 PK 조회라 싸고, 캐시를 두면 설정을 바꾼
 * 뒤에도 그 프로세스가 옛 값으로 막거나 풀어 준다(서버가 여러 대면 대마다 다르다).
 * 행이 없으면(마이그레이션 전 스냅숏 같은 드문 경우) 기본값으로 떨어진다.
 */
export async function getMentionPolicy(db: Pool | PoolClient): Promise<MentionPolicy> {
  const res = await db.query(`select chain_limit from mention_policy where id = true`);
  return { chainLimit: (res.rows[0]?.chain_limit as number | undefined) ?? MENTION_CHAIN_LIMIT };
}

export async function setMentionPolicy(pool: Pool, patch: MentionPolicy): Promise<MentionPolicy> {
  const res = await pool.query(
    `insert into mention_policy (id, chain_limit) values (true, $1)
       on conflict (id) do update set chain_limit = excluded.chain_limit
     returning chain_limit`,
    [patch.chainLimit],
  );
  return { chainLimit: res.rows[0].chain_limit as number };
}
