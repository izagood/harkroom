/**
 * 스레드 메모(메모리 재설계 A안 S1, 마이그레이션 128). (에이전트, 스레드 루트) 마다 한 장, 덮어쓰기.
 *
 * 기억(`memory.ts`)과 다른 점: 수명이 스레드에 묶인다. 그래서 목록·recall·상한에 들지 않고, 러너는
 * 그 스레드의 턴에만 싣는다. 판(revision)도 남기지 않는다 — 진행 상태는 지난 값이 쓸모없다.
 */
import type { Pool } from 'pg';

export const MAX_THREAD_NOTE_LENGTH = 4000;

export interface ThreadNote {
  body: string;
  updatedAt: Date;
  flagReason: string | null;
}

/**
 * 메모를 달 수 있는 스레드인가: 루트 글이어야 하고(답글 id 를 주면 그 스레드의 루트를 쓰라고 거절한다),
 * 채널을 볼 수 있어야 한다. 판정은 호출자가 `assertChannelVisible` 로 하도록 채널 id 를 돌려준다.
 */
export async function threadRootChannel(
  pool: Pool, threadRootId: string,
): Promise<{ channelId: string } | 'not_found' | 'not_root'> {
  const res = await pool.query(
    `select channel_id, thread_root_id from message where id = $1 and deleted_at is null`,
    [threadRootId],
  );
  const row = res.rows[0] as { channel_id: string; thread_root_id: string | null } | undefined;
  if (!row) return 'not_found';
  if (row.thread_root_id !== null) return 'not_root';
  return { channelId: row.channel_id };
}

export async function getThreadNote(pool: Pool, accountId: string, threadRootId: string): Promise<ThreadNote | null> {
  const res = await pool.query(
    `select body, updated_at, flag_reason from thread_note where account_id = $1 and thread_root_id = $2`,
    [accountId, threadRootId],
  );
  const row = res.rows[0] as { body: string; updated_at: Date; flag_reason: string | null } | undefined;
  return row ? { body: row.body, updatedAt: row.updated_at, flagReason: row.flag_reason } : null;
}

/**
 * 덮어쓴다. `body` 가 null 이면 지운다(멱등). `ifUpdatedAt` 은 `memory.set` 과 같은 낙관적 동시성 —
 * 같은 스레드에 깨움 턴과 이어받은 턴이 겹칠 수 있다. null 은 "아직 없어야 한다".
 */
export async function setThreadNote(
  pool: Pool, accountId: string, threadRootId: string, body: string | null,
  guard: { updatedAt: Date | null } | undefined, flagReason: string | null,
): Promise<{ updatedAt: Date | null } | { conflict: { updatedAt: Date | null } }> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const cur = await client.query(
      `select updated_at from thread_note where account_id = $1 and thread_root_id = $2 for update`,
      [accountId, threadRootId],
    );
    const now = (cur.rows[0] as { updated_at: Date } | undefined)?.updated_at ?? null;
    if (guard && (guard.updatedAt?.getTime() ?? null) !== (now?.getTime() ?? null)) {
      await client.query('rollback');
      return { conflict: { updatedAt: now } };
    }
    if (body === null) {
      await client.query(`delete from thread_note where account_id = $1 and thread_root_id = $2`, [accountId, threadRootId]);
      await client.query('commit');
      return { updatedAt: null };
    }
    const res = await client.query(
      `insert into thread_note (account_id, thread_root_id, body, flag_reason) values ($1, $2, $3, $4)
       on conflict (account_id, thread_root_id) do update
         set body = excluded.body, flag_reason = excluded.flag_reason,
             updated_at = greatest(now(), thread_note.updated_at + interval '1 millisecond')
       returning updated_at`,
      [accountId, threadRootId, body, flagReason],
    );
    await client.query('commit');
    return { updatedAt: (res.rows[0] as { updated_at: Date }).updated_at };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
