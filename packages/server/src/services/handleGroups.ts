import type { Pool, PoolClient } from 'pg';
import type { HandleGroupRow, HandleGroupMemberRow } from '@murmur/shared';

const COLS = `id, handle, display_name as "displayName", created_at as "createdAt"`;

export async function listHandleGroups(pool: Pool): Promise<HandleGroupRow[]> {
  const res = await pool.query(`select ${COLS} from handle_group order by handle`);
  return res.rows;
}

export async function getHandleGroup(pool: Pool, id: string): Promise<HandleGroupRow | null> {
  const res = await pool.query(`select ${COLS} from handle_group where id = $1`, [id]);
  return res.rowCount ? res.rows[0] : null;
}

export async function getHandleGroupByHandle(
  pool: Pool | PoolClient, handle: string,
): Promise<HandleGroupRow | null> {
  const res = await pool.query(`select ${COLS} from handle_group where lower(handle) = lower($1)`, [handle]);
  return res.rowCount ? res.rows[0] : null;
}

/**
 * 집합을 만든다(#230). 같은 이름의 **계정이 있으면 만들지 않는다** — `null` 을 돌려준다.
 *
 * 계정 확인과 삽입을 **한 문장**에 둔 이유: 따로 읽고 나서 넣으면 그 사이에 같은 이름의
 * 계정이 생겨 양쪽이 다 성공한다. `@foo` 가 사람인지 집합인지 갈리는 순간이 바로 그
 * 경합이고, 두 표에 걸치는 제약은 스키마로 표현할 수 없으므로 문장 하나가 그 자리다.
 *
 * 같은 이름의 **집합**이 이미 있는 경우는 `handle_group.handle` 의 unique 제약이 막는다 —
 * 호출부가 미리 확인하지만, 경합에서는 이 제약이 마지막 방어선이다.
 */
export async function createHandleGroup(
  pool: Pool, input: { handle: string; displayName: string },
): Promise<HandleGroupRow | null> {
  const res = await pool.query(
    `insert into handle_group (handle, display_name)
     select $1, $2
     where not exists (select 1 from account where lower(handle) = lower($1))
     returning ${COLS}`,
    [input.handle, input.displayName],
  );
  return res.rowCount ? res.rows[0] : null;
}

export async function updateHandleGroup(
  pool: Pool, id: string, patch: { displayName?: string },
): Promise<HandleGroupRow | null> {
  if (patch.displayName === undefined) return getHandleGroup(pool, id);
  const res = await pool.query(
    `update handle_group set display_name = $2 where id = $1 returning ${COLS}`,
    [id, patch.displayName],
  );
  return res.rowCount ? res.rows[0] : null;
}

export async function deleteHandleGroup(pool: Pool, id: string): Promise<boolean> {
  const res = await pool.query(`delete from handle_group where id = $1`, [id]);
  return (res.rowCount ?? 0) > 0;
}

export async function listHandleGroupMembers(
  pool: Pool | PoolClient, groupId: string,
): Promise<HandleGroupMemberRow[]> {
  const res = await pool.query(
    `select group_id as "groupId", account_id as "accountId" from handle_group_member where group_id = $1`,
    [groupId],
  );
  return res.rows;
}

/**
 * 구성원을 넣는다. **사람 계정만** 들어간다(#230 결정 1) — 에이전트 셋이 든 집합을
 * 멘션하면 턴 셋이 동시에 시작되고, 그것은 `#172` 가 반대편에서 묻고 있는 질문이다.
 *
 * 라우트가 미리 400 으로 거절하지만 여기서도 `kind = 'human'` 으로 좁힌다 — 서버의 다른
 * 호출부가 이 함수를 부를 때 그 결정이 따라오게 하려는 것이다. 화면에서만 막으면 안 되는
 * 것과 같은 이유로, 라우트에서만 막아도 안 된다.
 *
 * 존재하지 않는 계정 id 는 조용히 빠진다 — FK 위반으로 500 이 되는 것보다 낫고, 라우트가
 * 넣은 수와 돌아온 수를 비교해 사람에게 말할 수 있다.
 */
export async function addHandleGroupMembers(
  pool: Pool | PoolClient, groupId: string, accountIds: string[],
): Promise<number> {
  if (!accountIds.length) return 0;
  const res = await pool.query(
    `insert into handle_group_member (group_id, account_id)
     select $1, a.id from account a where a.id = any($2) and a.kind = 'human'
     on conflict do nothing`,
    [groupId, accountIds],
  );
  return res.rowCount ?? 0;
}

export async function removeHandleGroupMembers(
  pool: Pool | PoolClient, groupId: string, accountIds: string[],
): Promise<number> {
  const res = await pool.query(
    `delete from handle_group_member where group_id = $1 and account_id = any($2)`,
    [groupId, accountIds],
  );
  return res.rowCount ?? 0;
}
