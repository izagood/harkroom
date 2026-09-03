import type { Pool } from 'pg';
import type { MessageRow, SavedMessageRow } from '@murmur/shared';
import { COLS as MESSAGE_COLS } from './messages.js';
import { channelVisibleSql } from './channels.js';

type SavedMessageWithMetaRow = MessageRow & {
  smState: 'open' | 'done';
  smCreatedAt: string;
  smDoneAt: string | null;
};

function toSavedMessageRow({
  smState,
  smCreatedAt,
  smDoneAt,
  ...message
}: SavedMessageWithMetaRow): SavedMessageRow {
  return {
    messageId: message.id,
    channelId: message.channelId,
    state: smState,
    createdAt: smCreatedAt,
    doneAt: smDoneAt,
    message,
  };
}

async function selectSavedMessages(
  pool: Pool,
  accountId: string,
  state: 'open' | 'done',
  messageId: string | null,
): Promise<SavedMessageRow[]> {
  const res = await pool.query(
    `select m.*, sm.state as "smState", sm.created_at as "smCreatedAt", sm.done_at as "smDoneAt"
     from saved_message sm
     join lateral (
       select ${MESSAGE_COLS} from message where message.id = sm.message_id
     ) m on true
     where sm.account_id = $1 and sm.state = $2 and ($3::uuid is null or sm.message_id = $3)
     order by sm.created_at desc`,
    [accountId, state, messageId],
  );
  return (res.rows as SavedMessageWithMetaRow[]).map(toSavedMessageRow);
}

export async function listSavedMessages(
  pool: Pool,
  accountId: string,
  state: 'open' | 'done',
): Promise<SavedMessageRow[]> {
  return selectSavedMessages(pool, accountId, state, null);
}

export async function getSavedMessage(
  pool: Pool,
  accountId: string,
  messageId: string,
): Promise<SavedMessageRow | null> {
  const rows = await selectSavedMessages(pool, accountId, 'open', messageId);
  if (rows.length > 0) return rows[0] ?? null;
  const doneRows = await selectSavedMessages(pool, accountId, 'done', messageId);
  return doneRows.length > 0 ? (doneRows[0] ?? null) : null;
}

export async function getSavedMessageOpenCount(pool: Pool, accountId: string): Promise<number> {
  const res = await pool.query(
    `select count(*) as cnt from saved_message where account_id = $1 and state = 'open'`,
    [accountId],
  );
  return Number(res.rows[0]!.cnt);
}

export async function saveMessage(
  pool: Pool,
  args: { accountId: string; messageId: string },
): Promise<SavedMessageRow | 'not_found'> {
  const channelRes = await pool.query(
    `select c.id as channel_id from message m
     join channel c on c.id = m.channel_id
     where m.id = $1`,
    [args.messageId],
  );
  if (!channelRes.rowCount) return 'not_found';
  const channelId = channelRes.rows[0]!.channel_id;

  if (!(await pool.query(
    `select 1 from channel_member where channel_id = $1 and account_id = $2`,
    [channelId, args.accountId],
  )).rowCount) {
    return 'not_found';
  }

  const visibilityRes = await pool.query(
    `select ${channelVisibleSql('c', '$2')} as visible from channel c where c.id = $1`,
    [channelId, args.accountId],
  );
  if (!visibilityRes.rowCount || !visibilityRes.rows[0]!.visible) {
    return 'not_found';
  }

  await pool.query(
    `insert into saved_message (account_id, message_id, state)
     values ($1, $2, 'open')
     on conflict (account_id, message_id) do update set state = 'open', done_at = null`,
    [args.accountId, args.messageId],
  );

  const rows = await selectSavedMessages(pool, args.accountId, 'open', args.messageId);
  return rows[0] ?? 'not_found';
}

export async function unsaveMessage(
  pool: Pool,
  args: { accountId: string; messageId: string },
): Promise<'unsaved' | 'not_found'> {
  const res = await pool.query(
    `delete from saved_message where account_id = $1 and message_id = $2 returning 1`,
    [args.accountId, args.messageId],
  );
  return res.rowCount ? 'unsaved' : 'not_found';
}

export async function updateSavedMessageState(
  pool: Pool,
  args: { accountId: string; messageId: string; state: 'open' | 'done' },
): Promise<SavedMessageRow | 'not_found'> {
  const doneAt = args.state === 'done' ? new Date().toISOString() : null;
  const res = await pool.query(
    `update saved_message set state = $3, done_at = $4
     where account_id = $1 and message_id = $2
     returning account_id`,
    [args.accountId, args.messageId, args.state, doneAt],
  );
  if (!res.rowCount) return 'not_found';

  const rows = await selectSavedMessages(pool, args.accountId, args.state, args.messageId);
  return rows[0] ?? 'not_found';
}