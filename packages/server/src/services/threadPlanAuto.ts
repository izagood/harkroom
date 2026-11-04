/**
 * 계획판 자동 진행 — 켜기·끄기(G-2a). 깨우기는 다음 PR 이다.
 *
 * 켜는 것은 **사람의 글**이다. 관리 에이전트가 사람의 「~까지 진행해」를 읽고 그 글을 근거로 적는다. 에이전트 혼자서는 켤 수 없다:
 * 쓰는 이가 관리 에이전트이고, 근거 글이 이 스레드의 사람 글이며, **그 글이 지금 이 에이전트 턴 임대의 원인**이어야 한다.
 * 임대는 서버가 실제로 그 글에 불린 에이전트에게만 주므로, 에이전트가 아무 사람 글이나 근거로 고를 수 없다.
 * 사람이 다른 뜻으로 쓴 글을 관리자가 잘못 읽는 것은 여기서 막지 못한다 — 켜질 때 시스템 줄과 끄기 길로 보완한다.
 */
import type { Pool } from 'pg';
import { emitPlanChanged, THREAD_PLAN_COLUMNS, toRow, type ThreadPlanRow } from './threadPlan.js';
import { audienceFor, channelVisibleSql } from './channels.js';
import { threadRootChannel } from './threadNote.js';
import { emitPosted } from '../events.js';
import { postMessage } from './messages.js';
import { systemI18n } from './systemI18n.js';
import type { PlanDoc } from '@harkroom/shared';

export type PlanAutoError =
  | { code: 'not_found' | 'not_root' | 'no_plan' | 'flagged' | 'not_manager' | 'unknown_until' }
  | { code: 'source_not_cause' | 'invalid_source' | 'source_hidden' | 'source_used' };

export type PlanAutoResult = { ok: true; row: ThreadPlanRow; changed: boolean } | { ok: false; error: PlanAutoError };

async function notice(pool: Pool, row: ThreadPlanRow, authorId: string, body: string, meta: Record<string, unknown>): Promise<void> {
  const posted = await postMessage(pool, {
    channelId: row.channelId, threadRootId: row.rootId, authorId, kind: 'system', serverNotice: true, noMentions: true, body, meta,
  } as Parameters<typeof postMessage>[1]);
  if (!posted.failure) emitPosted(posted, await audienceFor(pool, row.channelId));
}

/** 켠다. 이미 켜져 있으면 새 근거·끝점으로 바꾼다. 범위를 넓히려면 새 사람 글이 있어야 한다. */
export async function setPlanAuto(pool: Pool, args: {
  rootId: string; agentId: string; until: string; sourceMessageId: string; now?: Date;
}): Promise<PlanAutoResult> {
  const root = await threadRootChannel(pool, args.rootId);
  if (root === 'not_found' || root === 'not_root') return { ok: false, error: { code: root } };
  const now = args.now ?? new Date();
  const client = await pool.connect();
  let row: ThreadPlanRow;
  let by: string;
  try {
    await client.query('begin');
    const cur = (await client.query<{ doc: PlanDoc; flag_reason: string | null; auto_used_sources: string[] }>(
      `select doc, flag_reason, auto_used_sources from thread_plan where root_id = $1 for update`, [args.rootId])).rows[0];
    const refuse = async (code: PlanAutoError['code']): Promise<PlanAutoResult> => {
      await client.query('rollback');
      return { ok: false, error: { code } as PlanAutoError };
    };
    if (!cur) return await refuse('no_plan');
    if (cur.flag_reason) return await refuse('flagged');
    if (cur.doc.managerId !== args.agentId) return await refuse('not_manager');
    if (![...cur.doc.steps, ...cur.doc.groups].some((n) => n.id === args.until)) return await refuse('unknown_until');
    // 지금 이 에이전트 턴의 원인 글인가. 끝났거나 만료된 임대는 세지 않는다.
    const lease = await client.query(
      `select 1 from secret_turn_lease
        where agent_id = $1 and cause_message_id = $2 and ended_at is null and expires_at > $3 limit 1`,
      [args.agentId, args.sourceMessageId, now]);
    if (!lease.rowCount) return await refuse('source_not_cause');
    const source = (await client.query<{ authorId: string; mandateId: string | null; visible: boolean }>(
      `select m.author_id as "authorId", m.mandate_id as "mandateId", ${channelVisibleSql('c', 'm.author_id')} as visible
         from message m
         join account a on a.id = m.author_id
         join channel c on c.id = m.channel_id
        where m.id = $1 and coalesce(m.thread_root_id, m.id) = $2 and m.deleted_at is null
          and m.kind = 'user' and not (m.meta ? 'automation')
          and a.kind = 'human' and a.deleted_at is null and a.disabled_at is null`,
      [args.sourceMessageId, args.rootId])).rows[0];
    if (!source) return await refuse('invalid_source');
    if (!source.visible) return await refuse('source_hidden');
    if (cur.auto_used_sources.includes(args.sourceMessageId)) return await refuse('source_used');
    const res = await client.query(
      `update thread_plan
          set auto_until = $2, auto_source = $3, auto_by = $4, auto_mandate = $5, auto_at = $6, auto_woken = '{}'::jsonb,
              auto_used_sources = array_append(auto_used_sources, $3::uuid),
              rev = rev + 1, updated_at = greatest(now(), updated_at + interval '1 millisecond')
        where root_id = $1
        returning ${THREAD_PLAN_COLUMNS}`,
      [args.rootId, args.until, args.sourceMessageId, source.authorId, source.mandateId, now]);
    await client.query('commit');
    row = toRow(res.rows[0]);
    by = source.authorId;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await emitPlanChanged(pool, row.channelId, row.rootId, row);
  // 사람이 잘못 읽힌 것을 바로 보게 근거 글 링크를 함께 쓴다. 멘션은 만들지 않는다(noMentions).
  await notice(pool, row, args.agentId, `▶ 자동 진행 켜짐 · ${args.until}까지 · 근거 harkroom://message/${args.sourceMessageId}`, {
    planAutoState: { on: true, until: args.until, sourceMessageId: args.sourceMessageId, by },
    i18n: systemI18n('system.plan.autoOn', { accountId: by, until: args.until }),
  });
  return { ok: true, row, changed: true };
}

/** 끈다. 꺼져 있으면 아무 일도 하지 않는다. 쓴 근거 글은 남아 같은 글로 다시 켜지 못한다. */
export async function clearPlanAuto(pool: Pool, args: {
  rootId: string; actor: { kind: 'human' | 'manager'; accountId: string };
}): Promise<PlanAutoResult> {
  const client = await pool.connect();
  let row: ThreadPlanRow;
  let changed = false;
  try {
    await client.query('begin');
    const cur = (await client.query<{ doc: PlanDoc; auto_until: string | null }>(
      `select doc, auto_until from thread_plan where root_id = $1 for update`, [args.rootId])).rows[0];
    if (!cur) {
      await client.query('rollback');
      return { ok: false, error: { code: 'no_plan' } };
    }
    if (args.actor.kind === 'manager' && cur.doc.managerId !== args.actor.accountId) {
      await client.query('rollback');
      return { ok: false, error: { code: 'not_manager' } };
    }
    changed = cur.auto_until !== null;
    const res = changed
      ? await client.query(
        `update thread_plan
            set auto_until = null, auto_source = null, auto_by = null, auto_mandate = null, auto_at = null, auto_woken = '{}'::jsonb,
                rev = rev + 1, updated_at = greatest(now(), updated_at + interval '1 millisecond')
          where root_id = $1
          returning ${THREAD_PLAN_COLUMNS}`, [args.rootId])
      : await client.query(`select ${THREAD_PLAN_COLUMNS} from thread_plan where root_id = $1`, [args.rootId]);
    await client.query('commit');
    row = toRow(res.rows[0]);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (!changed) return { ok: true, row, changed: false };
  await emitPlanChanged(pool, row.channelId, row.rootId, row);
  await notice(pool, row, args.actor.accountId, '▶ 자동 진행 꺼짐', args.actor.kind === 'human'
    ? { planAutoState: { on: false, reason: 'human' }, i18n: systemI18n('system.plan.autoOffHuman', { accountId: args.actor.accountId }) }
    : { planAutoState: { on: false, reason: 'manager' }, i18n: systemI18n('system.plan.autoOffManager', {}) });
  return { ok: true, row, changed: true };
}
