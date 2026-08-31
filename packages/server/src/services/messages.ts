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
  author_id as "authorId", body, kind, meta, created_at as "createdAt"`;

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
      const dup = await client.query(
        `select m.id from idempotency_key k join message m on m.id = k.message_id where k.key = $1`,
        [input.idempotencyKey],
      );
      if (dup.rowCount) {
        const existing = await client.query(`select ${COLS} from message where id = $1`, [dup.rows[0].id]);
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
      await client.query(`insert into idempotency_key (key, message_id) values ($1, $2)`, [input.idempotencyKey, message.id]);
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
  const res = await pool.query(
    `select ${COLS} from message
     where channel_id = $1 and seq > $2 and deleted_at is null
     order by seq limit $3`,
    [channelId, opts.since ?? 0, limit],
  );
  return res.rows;
}

export async function listInbox(
  pool: Pool, accountId: string, opts: { unreadOnly?: boolean },
): Promise<InboxEntry[]> {
  const res = await pool.query(
    `select id::int as id, message_id as "messageId", reason, read_at as "readAt"
     from inbox where account_id = $1 ${opts.unreadOnly ? 'and read_at is null' : ''}
     order by id`,
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

export async function searchMessages(pool: Pool, query: string, limit = 50): Promise<MessageRow[]> {
  const res = await pool.query(
    `select ${COLS} from message
     where search @@ websearch_to_tsquery('simple', $1) and deleted_at is null
     order by seq desc limit $2`,
    [query, Math.min(limit, 100)],
  );
  return res.rows;
}
