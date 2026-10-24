import type { Pool, PoolClient } from 'pg';
import { recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { audienceFor } from './channels.js';
import { MANDATE_IDLE_MS } from './mandates.js';
import { getMessageById } from './messages.js';

/**
 * 위임의 끝(3판). 위임은 세 길로 끝난다:
 * - `owner` — 소유자가 [위임 끝] 을 눌렀다(`POST /mandates/:id/end`).
 * - `idle` — 소유자 활동 없이 7일(`MANDATE_IDLE_MS`). 판정(`validMandateOwner`)은 이미 계산으로 막고, 스윕이 기록으로 남긴다.
 * - `work_done` — 그 스레드 머리에 걸린 소유자의 일감이 done 이 됐다(`workItems.ts::upsertWorkItem`).
 *
 * 끝나면 같은 트랜잭션에서 그 위임의 살아 있는 줄을 회수하고(`revoked_at`), 커밋 뒤 그 위임을 단 열린 권한 카드의
 * `permissionRequest.mandate.endedAt` 을 적는다. 끝난 위임은 되살리지 않는다 — 그 스레드의 소유자 답글은 위임을 잇지 않고
 * (`stampHumanMandate` 는 `ended_at is null` 만 민다), 새 위임은 새 스레드 머리에서만 생긴다.
 */
export type MandateEndReason = 'owner' | 'idle' | 'work_done';

type Q = Pick<PoolClient, 'query'>;

/** 트랜잭션 안에서 끝낸다. 이미 끝났으면 null(멱등). 끝냈으면 끝난 시각. 카드 갱신은 커밋 뒤 `refreshMandateCards`. */
export async function endMandateTx(client: Q, mandateId: string, reason: MandateEndReason, now = new Date()): Promise<Date | null> {
  const row = (await client.query<{ endedAt: Date }>(
    `update mandate set ended_at = $2, end_reason = $3 where id = $1 and ended_at is null returning ended_at as "endedAt"`,
    [mandateId, now, reason])).rows[0];
  if (!row) return null;
  await client.query(`update mandate_line set revoked_at = $2 where mandate_id = $1 and revoked_at is null`, [mandateId, now]);
  return row.endedAt;
}

/** 위임을 끝내고(한 트랜잭션) 카드를 갱신한다. 끝냈으면 true. */
export async function endMandate(pool: Pool, mandateId: string, reason: MandateEndReason, now = new Date()): Promise<boolean> {
  const client = await pool.connect();
  let endedAt: Date | null = null;
  try {
    await client.query('begin');
    endedAt = await endMandateTx(client, mandateId, reason, now);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (!endedAt) return false;
  await refreshMandateCards(pool, [mandateId]);
  return true;
}

/**
 * 끝난 위임을 단 **열린**(pending) 권한 카드의 meta 에 `mandate.endedAt` 을 적고 `message.updated` 를 낸다.
 * 뒤처리라 던지지 않는다 — 위임은 이미 끝났다(판정은 `ended_at` 을 본다).
 */
export async function refreshMandateCards(pool: Pool, mandateIds: string[]): Promise<void> {
  if (!mandateIds.length) return;
  try {
    const cards = (await pool.query<{ cardMessageId: string; endedAt: Date }>(
      `select r.card_message_id as "cardMessageId", d.ended_at as "endedAt"
         from permission_request r join mandate d on d.id = r.mandate_id
        where r.mandate_id = any($1::uuid[]) and d.ended_at is not null
          and r.status = 'pending' and r.card_message_id is not null`, [mandateIds])).rows;
    for (const c of cards) {
      const upd = await pool.query(
        `update message set meta = jsonb_set(meta, '{permissionRequest,mandate}',
                coalesce(meta->'permissionRequest'->'mandate', '{}'::jsonb) || jsonb_build_object('endedAt', $2::text))
          where id = $1 and meta ? 'permissionRequest'
            and (meta->'permissionRequest'->'mandate'->>'endedAt') is null`,
        [c.cardMessageId, c.endedAt.toISOString()]);
      if (!upd.rowCount) continue;
      const card = await getMessageById(pool, c.cardMessageId);
      if (card) emitEvent({ type: 'message.updated', message: card, audience: await audienceFor(pool, card.channelId) });
    }
  } catch (err) {
    console.error('mandate end card refresh error:', err);
  }
}

/** 7일 활동이 없던 위임을 `idle` 로 끝낸다(한 묶음). 끝낸 개수. */
export async function endIdleMandates(pool: Pool, opts: { now?: Date; limit?: number } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const client = await pool.connect();
  let ids: string[] = [];
  try {
    await client.query('begin');
    ids = (await client.query<{ id: string }>(
      `update mandate set ended_at = $1, end_reason = 'idle'
        where id in (select id from mandate where ended_at is null and last_activity_at <= $2
                      order by last_activity_at limit $3 for update skip locked)
        returning id`,
      [now, new Date(now.getTime() - MANDATE_IDLE_MS), opts.limit ?? MANDATE_IDLE_BATCH])).rows.map((r) => r.id);
    if (ids.length) {
      await client.query(`update mandate_line set revoked_at = $2 where mandate_id = any($1::uuid[]) and revoked_at is null`, [ids, now]);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (ids.length) {
    await refreshMandateCards(pool, ids);
    for (const id of ids) await recordAudit(pool, { action: 'mandate.ended', target: id, detail: { reason: 'idle' } });
  }
  return ids.length;
}

export const MANDATE_IDLE_BATCH = 200;
export const MANDATE_IDLE_SWEEP_INTERVAL_MS = 10 * 60_000;

export function createMandateIdleSweeper(pool: Pool, opts: { now?: () => Date } = {}): {
  startSweep(app: { addHook(hook: 'onClose', fn: () => void | Promise<void>): void }): void;
  sweep(): Promise<void>;
} {
  let sweepInterval: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      while ((await endIdleMandates(pool, { now: opts.now?.() ?? new Date() })) >= MANDATE_IDLE_BATCH) { /* 다음 묶음 */ }
    } catch (err) {
      // 던지면 처리 안 된 거절로 프로세스가 죽는다(agentWakes 의 10-12 사고). 다음 주기에 다시 한다.
      console.error('mandate idle sweep error:', err);
    } finally {
      running = false;
    }
  };
  return {
    startSweep(app) {
      if (sweepInterval) return;
      sweepInterval = setInterval(() => { void sweep(); }, MANDATE_IDLE_SWEEP_INTERVAL_MS);
      app.addHook('onClose', () => {
        if (sweepInterval) clearInterval(sweepInterval);
        sweepInterval = null;
      });
    },
    sweep,
  };
}

/** 일감이 done 이 된 스레드 머리의 위임(그 일감 주인 소유) — 트랜잭션 안에서 끝낸다. 끝낸 위임 id 들. */
export async function endMandatesForDoneThreadTx(client: Q, args: { ownerId: string; threadRootId: string; now?: Date }): Promise<string[]> {
  const now = args.now ?? new Date();
  const ids = (await client.query<{ id: string }>(
    `select id from mandate where root_message_id = $1 and owner_account_id = $2 and ended_at is null for update`,
    [args.threadRootId, args.ownerId])).rows.map((r) => r.id);
  const ended: string[] = [];
  for (const id of ids) if (await endMandateTx(client, id, 'work_done', now)) ended.push(id);
  return ended;
}
