import type { Pool } from 'pg';
import type { ScheduledMessageView } from '@murmur/shared';
import { postMessage } from './messages.js';

export const SCHEDULE_MAX_DAYS = 30;
export const SWEEP_INTERVAL_MS = 15_000;
export const SWEEP_BATCH_SIZE = 20;

const COLS = `id, channel_id as "channelId", author_id as "authorId",
  thread_root_id as "threadRootId", body, send_at as "sendAt",
  created_at as "createdAt", sent_message_id as "sentMessageId",
  failed_reason as "failedReason", canceled_at as "canceledAt"`;

export interface ScheduledMessageRow {
  id: string;
  channelId: string;
  authorId: string;
  threadRootId: string | null;
  body: string;
  sendAt: string;
  createdAt: string;
  sentMessageId: string | null;
  failedReason: string | null;
  canceledAt: string | null;
}

export interface SweepHost {
  addHook(hook: 'onClose', fn: () => void | Promise<void>): void;
}

interface ScheduleResult {
  scheduled: ScheduledMessageView;
}

export async function scheduleMessage(
  pool: Pool, input: {
    channelId: string;
    authorId: string;
    body: string;
    threadRootId?: string | null;
    sendAt: Date;
  },
): Promise<ScheduleResult> {
  const sendAt = input.sendAt.toISOString();
  const createdAt = new Date().toISOString();
  const res = await pool.query(
    `insert into scheduled_message (channel_id, author_id, thread_root_id, body, send_at)
     values ($1, $2, $3, $4, $5) returning ${COLS}`,
    [input.channelId, input.authorId, input.threadRootId ?? null, input.body, sendAt],
  );
  return { scheduled: res.rows[0] };
}

export async function listScheduledMessages(
  pool: Pool, channelId: string, authorId: string,
): Promise<ScheduledMessageView[]> {
  const res = await pool.query(
    `select ${COLS} from scheduled_message
     where channel_id = $1 and author_id = $2
     order by send_at`,
    [channelId, authorId],
  );
  return res.rows;
}

export async function getScheduledMessage(
  pool: Pool, id: string, authorId: string,
): Promise<ScheduledMessageView | null> {
  const res = await pool.query(
    `select ${COLS} from scheduled_message where id = $1 and author_id = $2`,
    [id, authorId],
  );
  return res.rows[0] ?? null;
}

export async function cancelScheduledMessage(
  pool: Pool, id: string, authorId: string,
): Promise<boolean> {
  const res = await pool.query(
    `update scheduled_message set canceled_at = now()
     where id = $1 and author_id = $2 and canceled_at is null
       and sent_message_id is null and failed_reason is null
     returning id`,
    [id, authorId],
  );
  return (res.rowCount ?? 0) > 0;
}

export function createScheduledMessageSweeper(pool: Pool): {
  startSweep(app: SweepHost): void;
  sweep(): Promise<void>;
} {
  let sweepInterval: ReturnType<typeof setInterval> | null = null;

  const sweep = async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const due = await client.query(
        `select id, channel_id, author_id, thread_root_id, body
         from scheduled_message
         where send_at <= now()
           and sent_message_id is null
           and failed_reason is null
           and canceled_at is null
         order by send_at
         limit $1
         for update skip locked`,
        [SWEEP_BATCH_SIZE],
      );

      for (const row of due.rows) {
        const channelCheck = await client.query(
          `select archived_at from channel where id = $1`,
          [row.channel_id],
        );
        if (channelCheck.rows[0]?.archived_at) {
          await client.query(
            `update scheduled_message set failed_reason = $1 where id = $2`,
            ['channel_archived', row.id],
          );
          continue;
        }

        const result = await postMessage(pool, {
          channelId: row.channel_id,
          authorId: row.author_id,
          body: row.body,
          threadRootId: row.thread_root_id,
        });

        if (result.message) {
          await client.query(
            `update scheduled_message set sent_message_id = $1 where id = $2`,
            [result.message.id, row.id],
          );
        } else {
          const reason = result.failure ?? 'unknown';
          await client.query(
            `update scheduled_message set failed_reason = $1 where id = $2`,
            [reason, row.id],
          );
        }
      }

      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      console.error('scheduled message sweep error:', err);
    } finally {
      client.release();
    }
  };

  return {
    startSweep(app) {
      if (sweepInterval) return;
      sweepInterval = setInterval(sweep, SWEEP_INTERVAL_MS);
      sweepInterval.unref?.();
      app.addHook('onClose', async () => {
        if (sweepInterval) {
          clearInterval(sweepInterval);
          sweepInterval = null;
        }
      });
    },
    sweep,
  };
}