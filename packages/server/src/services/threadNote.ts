/**
 * 스레드 메모(메모리 재설계 A안 S1, 마이그레이션 128). (에이전트, 스레드 루트) 마다 한 장, 덮어쓰기.
 *
 * 기억(`memory.ts`)과 다른 점: 수명이 스레드에 묶인다. 그래서 목록·recall·상한에 들지 않고, 러너는
 * 그 스레드의 턴에만 싣는다. 판(revision)도 남기지 않는다 — 진행 상태는 지난 값이 쓸모없다.
 */
import type { Pool } from 'pg';
import { channelVisibleSql } from './channels.js';

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
    // 보관된 메모(증류가 끝난 스레드, 135)는 없는 것으로 본다 — 읽기·러너 주입 모두.
    `select body, updated_at, flag_reason from thread_note where account_id = $1 and thread_root_id = $2 and archived_at is null`,
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
      `select updated_at, archived_at from thread_note where account_id = $1 and thread_root_id = $2 for update`,
      [accountId, threadRootId],
    );
    // 보관된 메모는 없는 것과 같다 — 새로 쓰기(ifUpdatedAt: null)로 다시 연다.
    const row = cur.rows[0] as { updated_at: Date; archived_at: Date | null } | undefined;
    const now = row && !row.archived_at ? row.updated_at : null;
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
         set body = excluded.body, flag_reason = excluded.flag_reason, archived_at = null, archived_by_run = null,
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

export interface ThreadNoteListItem {
  threadRootId: string;
  channelId: string;
  channelName: string | null;
  /** 스레드 루트 글 첫 줄(최대 80자) — 무슨 스레드인지 알아보는 제목. */
  rootFirstLine: string;
  /** 메모 첫 줄(최대 120자). 쓰기 검사에 걸린 메모는 빈 문자열 — 러너가 싣지 않는 규칙을 목록이 옆길로 무르지 않게. */
  noteFirstLine: string;
  /** 쓰기 검사(080)에 걸린 메모. `thread.note` 읽기의 `flagged` 와 같은 판정이다. */
  flagged: boolean;
  updatedAt: Date;
}

export const THREAD_NOTE_LIST_MAX = 100;

function firstLine(text: string, max: number): string {
  const line = (text.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * 내 열린(보관 안 된) 스레드 메모 목록, 최근 고친 것부터. 메모는 스레드 한 장이라 스레드를 넘는 대장
 * (열린 위임·검토 대기 목록)을 볼 길이 없었다 — 그래서 그 대장이 mem/* 로 갔다. 이 목록이 그 자리다.
 * 지워진 루트 글·이제 못 보는 채널의 메모는 뺀다(있다는 사실을 새지 않는다).
 */
export async function listThreadNotes(
  pool: Pool, accountId: string, opts: { channelId?: string; limit?: number } = {},
): Promise<ThreadNoteListItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), THREAD_NOTE_LIST_MAX);
  const res = await pool.query(
    `select n.thread_root_id, m.channel_id, c.name as channel_name, m.body as root_body, n.body, n.updated_at, n.flag_reason
       from thread_note n
       join message m on m.id = n.thread_root_id and m.deleted_at is null
       join channel c on c.id = m.channel_id
      where n.account_id = $1 and n.archived_at is null
        and ($2::uuid is null or m.channel_id = $2)
        and ${channelVisibleSql('c', '$1')}
      order by n.updated_at desc
      limit $3`,
    [accountId, opts.channelId ?? null, limit],
  );
  return (res.rows as {
    thread_root_id: string; channel_id: string; channel_name: string | null; root_body: string | null; body: string; updated_at: Date;
    flag_reason: string | null;
  }[]).map((r) => ({
    threadRootId: r.thread_root_id,
    channelId: r.channel_id,
    channelName: r.channel_name,
    rootFirstLine: firstLine(r.root_body ?? '', 80),
    noteFirstLine: r.flag_reason ? '' : firstLine(r.body, 120),
    flagged: r.flag_reason !== null,
    updatedAt: r.updated_at,
  }));
}
