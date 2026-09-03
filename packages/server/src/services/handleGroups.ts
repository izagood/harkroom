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

export async function getHandleGroupByHandle(pool: Pool, handle: string): Promise<HandleGroupRow | null> {
  const res = await pool.query(`select ${COLS} from handle_group where lower(handle) = lower($1)`, [handle]);
  return res.rowCount ? res.rows[0] : null;
}

export async function createHandleGroup(
  pool: Pool, input: { handle: string; displayName: string },
): Promise<HandleGroupRow> {
  const res = await pool.query(
    `insert into handle_group (handle, display_name) values ($1, $2) returning ${COLS}`,
    [input.handle, input.displayName],
  );
  return res.rows[0];
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

export async function listHandleGroupMembers(pool: Pool, groupId: string): Promise<HandleGroupMemberRow[]> {
  const res = await pool.query(
    `select group_id as "groupId", account_id as "accountId" from handle_group_member where group_id = $1`,
    [groupId],
  );
  return res.rows;
}

export async function addHandleGroupMembers(
  pool: Pool | PoolClient, groupId: string, accountIds: string[],
): Promise<number> {
  if (!accountIds.length) return 0;
  let inserted = 0;
  for (const accountId of accountIds) {
    const res = await pool.query(
      `insert into handle_group_member (group_id, account_id) values ($1, $2) on conflict do nothing`,
      [groupId, accountId],
    );
    if (res.rowCount) inserted++;
  }
  return inserted;
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

export async function getHandleGroupMembersByHandles(
  pool: Pool, handles: string[],
): Promise<Map<string, HandleGroupRow[]>> {
  if (!handles.length) return new Map();
  const res = await pool.query(
    `select hg.handle, hg.${COLS.replace(/,/g, ', hg.')}
     from handle_group hg
     where lower(hg.handle) = any($1)`,
    [handles],
  );
  const groups = new Map<string, HandleGroupRow[]>();
  for (const row of res.rows) {
    const handle = row.handle;
    if (!groups.has(handle)) groups.set(handle, []);
    groups.get(handle)!.push(row);
  }
  return groups;
}