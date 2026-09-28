import type { Pool, PoolClient } from 'pg';

/**
 * 앱에서 정한 투영 URL(마이그레이션 041). **여기서 우선순위를 판정하지 않는다** —
 * env 와 견주는 일은 `resolveProjectionUrl`(shared) 하나가 한다. 이 모듈은 저장 자리를
 * 읽고 쓸 뿐이다.
 *
 * `null` 은 '앱에서 정한 것이 없다' 이고, 그때 부름의 결과는 env 로 떨어진다.
 */
export async function getProjectionConfig(db: Pool | PoolClient): Promise<string | null> {
  const res = await db.query(`select avcs_base_url from projection_config where id = true`);
  // noUncheckedIndexedAccess: rows[0] 는 undefined 일 수 있다(마이그레이션이 행을 넣지만
  // 타입이 그것을 모른다). 없으면 '정한 것이 없다' 와 같은 뜻이므로 null 로 접는다.
  return (res.rows[0]?.avcs_base_url ?? null) as string | null;
}

/** `null` 이 지우기다. 빈 문자열은 DB 의 check 가 거절한다 — 지우기와 섞이지 않게. */
export async function setProjectionConfig(
  pool: Pool, url: string | null,
): Promise<string | null> {
  const res = await pool.query(
    `update projection_config set avcs_base_url = $1 where id = true
     returning avcs_base_url`,
    [url],
  );
  return (res.rows[0]?.avcs_base_url ?? null) as string | null;
}
