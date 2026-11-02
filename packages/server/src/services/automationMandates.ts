import type { Pool, PoolClient } from 'pg';
import { recordAudit } from '../audit.js';
import { mayDecideFor } from './deciders.js';
import { endMandate, endMandateTx } from './mandateEnd.js';

/**
 * 위임장 ⑤b — 자동화당 하나(소유자 결정 2026-11-02, security 조건 1~5).
 *
 * - 위임장은 (자동화, 에이전트 소유자)마다 하나. 주인 = 에이전트 소유자, delegator = 자동화 소유자(승인한 사람). 뿌리 글은 없다(마이그 155).
 * - **회차 글에는 키를 적지 않는다**(사람 세션 글만 키를 만든다는 불변식). 턴 임대를 줄 때 서버가 `automation_run` 행에서만 읽는다.
 * - 키를 주는 회차(조건 1·2): 정기(`schedule`, 실행한 사람 없음) 또는 delegator 본인이 손으로 돌린 회차(`manual`). 바깥 사건 트리거·
 *   에이전트·다른 사람이 돌린 회차는 키 없음.
 * - 회차마다 delegator 가 **지금도** 그 채널에서 그 에이전트를 정할 수 있는지 다시 본다. 못 하면 키 없음.
 * - 위임장은 그 조건을 처음 채운 회차의 임대 발급 때 만든다(자동화가 승인·켜짐 상태여야 한다 — 승인이 그 사람의 허락이다).
 * - 수명은 자동화 상태에 묶인다(`validMandateOwner`). 고치면(본문·트리거·채널) `automation_changed`, 끄거나·자동 일시정지·지우면
 *   `automation_off` 로 끝내고 줄을 닫는다(조건 3). 다시 켜거나 고친 뒤에는 새 위임장이 생긴다 — 옛 줄은 따라오지 않는다.
 */
export type AutomationEndReason = 'automation_off' | 'automation_changed';

type Q = Pick<PoolClient, 'query'>;

export interface AutomationLeaseMandate { mandateId: string; created: boolean; automationId: string; ownerId: string; delegatorId: string }

/** 이 원인 글이 키를 줄 수 있는 자동화 회차 글이면 그 위임장(없으면 만든다). 아니면 null. 임대 발급 트랜잭션 안에서 부른다. */
export async function automationMandateForCause(client: Q, args: {
  agentId: string; causeMessageId: string; channelId: string; now: Date;
}): Promise<AutomationLeaseMandate | null> {
  const run = (await client.query<{ automationId: string; delegatorId: string; ownerId: string | null; channelId: string }>(
    `select r.automation_id as "automationId", a.owner_id as "delegatorId", c.owner_account_id as "ownerId", a.channel_id as "channelId"
       from automation_run r
       join automation a on a.id = r.automation_id
       join message m on m.id = r.message_id and m.deleted_at is null and m.meta ? 'automation'
       join agent_config c on c.account_id = $2
      where r.message_id = $1
        and a.deleted_at is null and a.enabled and a.approved_at is not null
        -- security n5: 마지막 만들기·승인·고침이 사람 세션이었던 자동화만(PAT 로 만든·고친 자동화는 키 없음).
        and a.mandate_session_at is not null
        and ((r.trigger_kind = 'schedule' and r.initiated_by is null)
          or (r.trigger_kind = 'manual' and r.initiated_by = a.owner_id))
      limit 1`,
    [args.causeMessageId, args.agentId])).rows[0];
  if (!run || !run.ownerId || run.channelId !== args.channelId) return null;
  const v = await mayDecideFor(client, { agentId: args.agentId, actorId: run.delegatorId, channelId: run.channelId });
  if (!v.ok) return null;
  const inserted = (await client.query<{ id: string }>(
    `insert into mandate (owner_account_id, delegator_account_id, automation_id, channel_id, created_at, last_activity_at)
     values ($1, $2, $3, $4, $5, $5)
     on conflict (automation_id, owner_account_id) where automation_id is not null and ended_at is null do nothing
     returning id`,
    [run.ownerId, run.delegatorId, run.automationId, run.channelId, args.now])).rows[0];
  const id = inserted?.id ?? (await client.query<{ id: string }>(
    `select id from mandate where automation_id = $1 and owner_account_id = $2 and ended_at is null`,
    [run.automationId, run.ownerId])).rows[0]?.id;
  if (!id) return null;
  await client.query(`update mandate set last_activity_at = greatest(last_activity_at, $2) where id = $1`, [id, args.now]);
  return { mandateId: id, created: !!inserted, automationId: run.automationId, ownerId: run.ownerId, delegatorId: run.delegatorId };
}

export async function auditAutomationMandateCreated(pool: Pool, m: AutomationLeaseMandate): Promise<void> {
  if (!m.created) return;
  await recordAudit(pool, {
    action: 'mandate.created', actorId: m.delegatorId, target: m.mandateId,
    detail: { mandateId: m.mandateId, via: 'automation', automationId: m.automationId, ownerId: m.ownerId, delegatorId: m.delegatorId },
  });
}

/** 트랜잭션 안에서 그 자동화의 살아 있는 위임장을 모두 끝낸다(줄도 닫는다). 끝낸 id. */
export async function endAutomationMandatesTx(client: Q, automationId: string, reason: AutomationEndReason, now = new Date()): Promise<string[]> {
  const ids = (await client.query<{ id: string }>(
    `select id from mandate where automation_id = $1 and ended_at is null for update`, [automationId])).rows.map((r) => r.id);
  for (const id of ids) await endMandateTx(client, id, reason, now);
  return ids;
}

/** 풀로 — 위임장마다 끝내고 카드를 갱신한다. */
export async function endAutomationMandates(pool: Pool, automationId: string, reason: AutomationEndReason): Promise<number> {
  const ids = (await pool.query<{ id: string }>(
    `select id from mandate where automation_id = $1 and ended_at is null`, [automationId])).rows.map((r) => r.id);
  let n = 0;
  for (const id of ids) if (await endMandate(pool, id, reason)) n += 1;
  return n;
}
