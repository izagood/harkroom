import type { Pool, PoolClient } from 'pg';
import type { InboxEntry, MessageRow } from '@murmur/shared';

export interface PostMessageInput {
  channelId: string;
  authorId: string;
  body: string;
  threadRootId?: string | null;
  kind?: 'user' | 'system';
  meta?: Record<string, unknown>;
  idempotencyKey?: string | null;
}

const COLS = `id, seq::int as seq, channel_id as "channelId", thread_root_id as "threadRootId",
  author_id as "authorId", body, kind, meta, created_at as "createdAt", edited_at as "editedAt"`;

const MENTION_RE = /@([a-z0-9_-]{2,32})/g;

async function insertInbox(
  client: PoolClient, accountId: string, messageId: string, reason: InboxEntry['reason'], notified: Set<string>,
): Promise<void> {
  await client.query(
    `insert into inbox (account_id, message_id, reason) values ($1, $2, $3)`,
    [accountId, messageId, reason],
  );
  notified.add(accountId);
}

export async function postMessage(
  pool: Pool, input: PostMessageInput,
): Promise<{ message: MessageRow; notified: string[]; replayed: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('begin');

    if (input.idempotencyKey) {
      // key는 클라이언트가 고르는 값이라 전역 유일하지 않다. 재생은 같은 author가 같은 채널로
      // 보낸 재시도일 때만이며, 그 범위를 벗어난 조회는 남의 메시지를 읽는 경로가 된다.
      const dup = await client.query(
        `select message_id from idempotency_key
         where key = $1 and author_id = $2 and channel_id = $3`,
        [input.idempotencyKey, input.authorId, input.channelId],
      );
      if (dup.rowCount) {
        const existing = await client.query(`select ${COLS} from message where id = $1`, [dup.rows[0].message_id]);
        await client.query('commit');
        return { message: existing.rows[0], notified: [], replayed: true };
      }
    }

    const inserted = await client.query(
      `insert into message (channel_id, thread_root_id, author_id, body, kind, meta)
       values ($1, $2, $3, $4, $5, $6) returning ${COLS}`,
      [input.channelId, input.threadRootId ?? null, input.authorId, input.body,
       input.kind ?? 'user', JSON.stringify(input.meta ?? {})],
    );
    const message: MessageRow = inserted.rows[0];

    if (input.idempotencyKey) {
      await client.query(
        `insert into idempotency_key (key, message_id, author_id, channel_id) values ($1, $2, $3, $4)`,
        [input.idempotencyKey, message.id, input.authorId, input.channelId],
      );
    }

    const notified = new Set<string>();

    const handles = [...new Set([...input.body.matchAll(MENTION_RE)].map((m) => m[1]))];
    if (handles.length) {
      const accounts = await client.query(
        `select id from account where handle = any($1) and id <> $2`, [handles, input.authorId],
      );
      for (const row of accounts.rows) await insertInbox(client, row.id, message.id, 'mention', notified);
    }

    if (input.threadRootId) {
      const root = await client.query(`select author_id from message where id = $1`, [input.threadRootId]);
      const rootAuthor = root.rows[0]?.author_id;
      if (rootAuthor && rootAuthor !== input.authorId && !notified.has(rootAuthor)) {
        await insertInbox(client, rootAuthor, message.id, 'thread_reply', notified);
      }
    }

    const channel = await client.query(`select kind from channel where id = $1`, [input.channelId]);
    if (channel.rows[0]?.kind === 'dm') {
      const members = await client.query(
        `select account_id from channel_member where channel_id = $1 and account_id <> $2`,
        [input.channelId, input.authorId],
      );
      for (const row of members.rows) {
        if (!notified.has(row.account_id)) await insertInbox(client, row.account_id, message.id, 'dm', notified);
      }
    }

    await client.query('commit');
    return { message, notified: [...notified], replayed: false };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** 수정/삭제 판정에 필요한 최소 정보. 없으면(또는 이미 삭제됐으면) null. */
async function loadEditable(
  pool: Pool, channelId: string, messageId: string,
): Promise<{ authorId: string; kind: 'user' | 'system' } | null> {
  const res = await pool.query(
    `select author_id as "authorId", kind from message
     where id = $1 and channel_id = $2 and deleted_at is null`,
    [messageId, channelId],
  );
  return res.rowCount ? res.rows[0] : null;
}

export type EditOutcome =
  | { ok: true; message: MessageRow }
  | { ok: false; reason: 'not_found' | 'forbidden' };

export async function editMessage(
  pool: Pool, channelId: string, messageId: string, actorId: string, body: string,
): Promise<EditOutcome> {
  const target = await loadEditable(pool, channelId, messageId);
  if (!target) return { ok: false, reason: 'not_found' };
  // 수정은 작성자만. admin 도 예외가 아니다 — 남의 발언을 고칠 수 있으면 기록이 증거가 못 된다.
  if (target.authorId !== actorId) return { ok: false, reason: 'forbidden' };
  // system 메시지는 avcs 로그의 사본이다. 사람이 고치면 원본과 어긋난 거짓이 남는다.
  if (target.kind === 'system') return { ok: false, reason: 'forbidden' };

  const res = await pool.query(
    `update message set body = $1, edited_at = now() where id = $2 returning ${COLS}`,
    [body, messageId],
  );
  return { ok: true, message: res.rows[0] };
}

export async function deleteMessage(
  pool: Pool, channelId: string, messageId: string, actor: { id: string; isAdmin: boolean },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'forbidden' }> {
  const target = await loadEditable(pool, channelId, messageId);
  if (!target) return { ok: false, reason: 'not_found' };
  // 삭제는 작성자 또는 admin. 수정과 달리 admin 을 허용하는 이유: 내용을 바꾸는 게 아니라
  // 치우는 것이고, 잘못 올라간 비밀·스팸을 치울 사람이 워크스페이스에 있어야 한다.
  if (target.authorId !== actor.id && !actor.isAdmin) return { ok: false, reason: 'forbidden' };

  await pool.query(`update message set deleted_at = now() where id = $1`, [messageId]);
  return { ok: true };
}

export async function listMessages(
  pool: Pool, channelId: string,
  opts: { since?: number; threadRootId?: string | null; limit?: number },
): Promise<MessageRow[]> {
  const limit = Math.min(opts.limit ?? 200, 500);
  if (opts.threadRootId) {
    const res = await pool.query(
      `select ${COLS} from message
       where channel_id = $1 and (id = $2 or thread_root_id = $2) and deleted_at is null
       order by seq limit $3`,
      [channelId, opts.threadRootId, limit],
    );
    return res.rows;
  }
  const since = opts.since ?? 0;
  if (since > 0) {
    const res = await pool.query(
      `select ${COLS} from message
       where channel_id = $1 and seq > $2 and deleted_at is null
       order by seq limit $3`,
      [channelId, since, limit],
    );
    return res.rows;
  }
  // since 미지정(0): 오래된 200개가 아니라 최신 N개를 반환한다 (반환 순서는 seq 오름차순 유지)
  const res = await pool.query(
    `select * from (
       select ${COLS} from message
       where channel_id = $1 and deleted_at is null
       order by seq desc limit $2
     ) latest
     order by seq`,
    [channelId, limit],
  );
  return res.rows;
}

export async function listInbox(
  pool: Pool, accountId: string, opts: { unreadOnly?: boolean },
): Promise<InboxEntry[]> {
  const res = await pool.query(
    `select i.id::int as id, i.message_id as "messageId", i.reason, i.read_at as "readAt",
            m.channel_id as "channelId"
     from inbox i join message m on m.id = i.message_id
     where i.account_id = $1 ${opts.unreadOnly ? 'and i.read_at is null' : ''}
     order by i.id`,
    [accountId],
  );
  return res.rows;
}

export async function markInboxRead(pool: Pool, accountId: string, ids: number[]): Promise<void> {
  await pool.query(
    `update inbox set read_at = now() where account_id = $1 and id = any($2) and read_at is null`,
    [accountId, ids],
  );
}

export async function searchMessages(
  pool: Pool, requesterId: string, query: string, limit = 50,
): Promise<MessageRow[]> {
  const res = await pool.query(
    `select m.id, m.seq::int as seq, m.channel_id as "channelId", m.thread_root_id as "threadRootId",
       m.author_id as "authorId", m.body, m.kind, m.meta, m.created_at as "createdAt"
     from message m
     join channel c on c.id = m.channel_id
     where m.search @@ websearch_to_tsquery('simple', $1) and m.deleted_at is null
       and (c.kind = 'standard' or exists (
         select 1 from channel_member cm where cm.channel_id = c.id and cm.account_id = $3
       ))
     order by m.seq desc limit $2`,
    [query, Math.min(limit, 100), requesterId],
  );
  return res.rows;
}
