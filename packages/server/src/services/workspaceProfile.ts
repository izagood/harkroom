import type { Pool } from 'pg';
import type { AvatarTarget } from './avatars.js';

/**
 * 워크스페이스 아이콘(마이그레이션 077). 파일 판정은 아바타와 같은 `detectAvatarType` 이 하고,
 * 이 모듈은 한 행짜리 자리를 읽고 쓸 뿐이다.
 */
export async function getWorkspaceIconId(pool: Pool): Promise<string | null> {
  const res = await pool.query(`select icon_attachment_id from workspace_profile where id = true`);
  return (res.rows[0]?.icon_attachment_id ?? null) as string | null;
}

/**
 * 아이콘을 건다(또는 null 로 지운다). `setAccountAvatar` 와 같은 이유로 판정한 타입을 첨부 행에
 * 덮어쓰고, 한 트랜잭션으로 묶는다 — 타입만 고쳐지고 아이콘이 안 걸리면 아무도 안 쓰는 수정이 남는다.
 */
export async function setWorkspaceIcon(
  pool: Pool, icon: { attachmentId: string; contentType: string } | null,
): Promise<void> {
  if (!icon) {
    await pool.query(`update workspace_profile set icon_attachment_id = null where id = true`);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`update attachment set content_type = $2 where id = $1`, [icon.attachmentId, icon.contentType]);
    await client.query(`update workspace_profile set icon_attachment_id = $1 where id = true`, [icon.attachmentId]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** 지금 걸린 아이콘의 바이트 위치와 id. 없으면 null. */
export async function findWorkspaceIcon(
  pool: Pool,
): Promise<(AvatarTarget & { attachmentId: string }) | null> {
  const res = await pool.query(
    `select a.id as "attachmentId", a.storage_key as "storageKey", a.content_type as "contentType",
            a.size_bytes::int as "sizeBytes"
       from workspace_profile w join attachment a on a.id = w.icon_attachment_id
      where w.id = true`,
  );
  return res.rowCount ? res.rows[0] : null;
}
