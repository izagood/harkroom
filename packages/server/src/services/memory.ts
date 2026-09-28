import type { Pool } from 'pg';

// 두 한도의 정본은 `@harkroom/shared` 다 — 설정 화면이 같은 값을 그려야 하는데
// 데스크탑은 이 패키지를 import 할 수 없다. 여기서는 다시 내보내기만 한다.
import { MAX_MEMORY_ITEMS_PER_ACCOUNT, MAX_MEMORY_VALUE_LENGTH } from '@harkroom/shared';

export { MAX_MEMORY_ITEMS_PER_ACCOUNT, MAX_MEMORY_VALUE_LENGTH };

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

/**
 * 이 계정 메모리 전체의 **판본**. 러너가 들고 있는 사본이 아직 맞는지 왕복 없이 가리는 값이다
 * (러너 메모리 캐시, 2026-09-28). 러너는 이 값이 자기 사본과 같으면 `memory.get` 을 부르지 않는다.
 *
 * 열(`rev`)을 새로 두지 않고 **있는 것에서 계산한다** — 마이그레이션 없이 들어가고, 쓰기 경로가
 * 판본을 올리는 것을 잊을 자리가 아예 없다. 재료는 `(slug, updated_at)` 이다:
 * - 추가·수정은 `updated_at = now()` 로 그 행의 값을 바꾼다.
 * - 삭제는 그 행이 목록에서 빠진다.
 * 그래서 어느 쪽이든 해시가 바뀐다. 본문을 해시하지 않는 이유: 200행×8,000자를 폴마다
 * 읽을 까닭이 없다 — 본문이 바뀌면 `updated_at` 도 반드시 바뀐다.
 *
 * 빈 저장소는 `'empty'` 다(`string_agg` 가 null 을 낸다). null 을 내면 "판본을 모르는 옛
 * 서버"와 구분되지 않는다.
 */
export async function memoryRev(pool: Pool, accountId: string): Promise<string> {
  const res = await pool.query(
    `select coalesce(
       md5(string_agg(slug || ':' || (extract(epoch from updated_at) * 1000000)::bigint, ',' order by slug)),
       'empty') as rev
     from agent_memory where account_id = $1`,
    [accountId],
  );
  return res.rows[0].rev as string;
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

/**
 * 사람이 보는 화면용 — slug 와 **값을 함께** 낸다(#139 3단계).
 *
 * `listMemory` 는 slug 만 준다. 그건 에이전트 주입 경로의 요구다(본문까지 주면 축적이
 * 곧 컨텍스트 고갈이 된다). 사람이 보는 화면은 값을 봐야 하는데, slug 마다
 * `getMemory` 를 부르면 N+1 이 된다 — 한 질의로 낸다.
 */
export async function listMemoryEntries(pool: Pool, accountId: string): Promise<MemoryEntry[]> {
  const res = await pool.query(
    `select slug, value, updated_at as "updatedAt" from agent_memory
     where account_id = $1 order by slug`,
    [accountId],
  );
  return res.rows as MemoryEntry[];
}

/** slug 하나를 지운다. 없는 것을 지워도 성공이다 — setMemory 의 멱등 규칙과 같다. */
export async function deleteMemory(pool: Pool, accountId: string, slug: string): Promise<void> {
  await pool.query(
    `delete from agent_memory where account_id = $1 and slug = $2`,
    [accountId, slug],
  );
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
