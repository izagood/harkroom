import type { Pool } from 'pg';

export const MAX_MEMORY_VALUE_LENGTH = 8000;
export const MAX_MEMORY_ITEMS_PER_ACCOUNT = 200;

export interface MemoryEntry {
  slug: string;
  value: string;
  updatedAt: Date;
}

/**
 * `not_found` 가 없는 이유: 삭제는 **멱등**이다. inbox 는 at-least-once 라 같은 지시가
 * 두 번 처리될 수 있고, 그때 재삭제가 에러로 오면 성공한 작업이 실패로 기록된다.
 * "없는 것을 지웠다" 는 호출자가 원한 상태에 도달한 것이므로 `ok` 다.
 */
export type MemoryResult = 'ok' | 'too_many';

export async function listMemory(pool: Pool, accountId: string): Promise<string[]> {
  const res = await pool.query(
    `select slug from agent_memory where account_id = $1 order by slug`,
    [accountId],
  );
  return res.rows.map((r) => r.slug as string);
}

export async function getMemory(
  pool: Pool, accountId: string, slug: string,
): Promise<MemoryEntry | null> {
  const res = await pool.query(
    `select slug, value, updated_at as "updatedAt" from agent_memory where account_id = $1 and slug = $2`,
    [accountId, slug],
  );
  if (!res.rowCount) return null;
  return res.rows[0] as MemoryEntry;
}

export async function setMemory(
  pool: Pool, accountId: string, slug: string, value: string | null,
): Promise<MemoryResult> {
  if (value === null) {
    // 없는 것을 지워도 성공이다 — 위 MemoryResult 주석의 이유.
    await pool.query(
      `delete from agent_memory where account_id = $1 and slug = $2`,
      [accountId, slug],
    );
    return 'ok';
  }

  // 한도 검사와 삽입을 **한 문장**으로 한다. 세 왕복(존재 확인 → 개수 → 삽입)으로 하면
  // 같은 계정의 동시 호출 둘이 모두 199 를 보고 201 이 된다.
  //
  // `exists(...)` 절이 있는 이유: **기존 항목을 고치는 것은 한도에 걸리지 않아야 한다.**
  // 한도는 항목이 늘어나는 것을 막으려는 것이고, 200개에 도달한 에이전트가 자기 메모리를
  // 수정조차 못 하게 되면 저장소가 잠긴다.
  const res = await pool.query(
    `insert into agent_memory (account_id, slug, value)
     select $1, $2, $3
     where (select count(*) from agent_memory where account_id = $1) < $4
        or exists (select 1 from agent_memory where account_id = $1 and slug = $2)
     on conflict (account_id, slug) do update set value = excluded.value, updated_at = now()`,
    [accountId, slug, value, MAX_MEMORY_ITEMS_PER_ACCOUNT],
  );
  // 행이 안 들어갔다는 것은 where 절이 걸렀다는 뜻이고, 그 조건은 한도뿐이다.
  return res.rowCount ? 'ok' : 'too_many';
}
