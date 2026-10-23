import type { PoolClient } from 'pg';

/**
 * 위임(mandate) W1 — 키를 **서버가** 적는다(133). 에이전트는 이 값을 보지도 보내지도 않는다.
 *
 * - 소유자(사람)가 자기 에이전트를 실제로 깨운 **새 스레드 머리** → 위임을 만들고 그 글에 적는다.
 * - 위임이 붙은 머리의 스레드에 소유자가 답하면 → 같은 위임, `last_activity_at` 을 민다.
 * - 에이전트 글 → 그 글의 (검증된) 원인에 대해 쥔 살아 있는 턴 임대의 위임. 에이전트의 **지금** 소유자가 위임 소유자와 같을 때만.
 *
 * W1 은 판정을 바꾸지 않는다 — 머지 판정 옆에서 그림자로만 계산한다(`mergeGrants.ts::shadowMandate`).
 */

/** 위임의 유효 기간 — 마지막 활동에서 7일(카드로 주는 grant 기한과 같다). */
export const MANDATE_IDLE_MS = 7 * 86_400_000;

type Q = Pick<PoolClient, 'query'>;

/** 사람 글의 위임. 새 머리면 `notifiedIds` 중 이 사람 소유 에이전트가 있을 때 만든다. 답글이면 머리의 위임(소유자 본인일 때)을 잇는다. */
export async function stampHumanMandate(client: Q, args: {
  messageId: string; authorId: string; channelId: string; threadRootId: string | null; notifiedIds: string[]; now?: Date;
}): Promise<string | null> {
  const now = args.now ?? new Date();
  let mandateId: string | null = null;
  if (!args.threadRootId) {
    if (!args.notifiedIds.length) return null;
    const own = await client.query(
      `select 1 from agent_config c join account a on a.id = c.account_id
        where c.account_id = any($1::uuid[]) and c.owner_account_id = $2 and a.kind = 'agent' limit 1`,
      [args.notifiedIds, args.authorId]);
    if (!own.rowCount) return null;
    mandateId = (await client.query<{ id: string }>(
      `insert into mandate (owner_account_id, root_message_id, channel_id, thread_root_id, created_at, last_activity_at)
       values ($1, $2, $3, $2, $4, $4)
       on conflict (root_message_id) do update set last_activity_at = excluded.last_activity_at
       returning id`,
      [args.authorId, args.messageId, args.channelId, now])).rows[0]!.id;
  } else {
    mandateId = (await client.query<{ id: string }>(
      `update mandate d set last_activity_at = greatest(d.last_activity_at, $3)
         from message r
        where r.id = $1 and d.id = r.mandate_id and d.owner_account_id = $2 and d.ended_at is null
        returning d.id`,
      [args.threadRootId, args.authorId, now])).rows[0]?.id ?? null;
    if (!mandateId) return null;
  }
  await client.query(`update message set mandate_id = $2 where id = $1`, [args.messageId, mandateId]);
  return mandateId;
}

/**
 * 에이전트 글이 물려받을 위임 — 그 원인(`causeMessageId`, 오퍼레이터를 거친 요청의 원인 헤더)으로 이 에이전트가 쥔 **살아 있는 턴 임대**의
 * 위임이고, 글쓴 에이전트의 지금 소유자가 위임 소유자와 같을 때만. 채널이 달라도 된다.
 *
 * 사슬 고리(`verifiedCauseLink`, inbox 60분)와 **따로** 본다(n4): 임대는 만들 때 원인을 이미 확인했고, 그 임대가 살아 있는 동안(임대 수명)
 * 턴은 같은 위임 안이다. 60분이 지나 사슬 고리(`cause_message_id`)가 끊겨도 위임은 임대가 끝날 때까지 잇는다. 원인 글이 지워졌으면 잇지 않는다.
 */
export async function mandateForAgentPost(client: Q, args: { agentId: string; causeMessageId: string; now?: Date }): Promise<string | null> {
  const now = args.now ?? new Date();
  const row = (await client.query<{ id: string }>(
    `select d.id from secret_turn_lease l
       join mandate d on d.id = l.mandate_id
       join agent_config c on c.account_id = l.agent_id
       join message m on m.id = l.cause_message_id and m.deleted_at is null
      where l.agent_id = $1 and l.cause_message_id = $2 and l.ended_at is null and l.expires_at > $3
        and c.owner_account_id = d.owner_account_id
      order by l.created_at desc limit 1`,
    [args.agentId, args.causeMessageId, now])).rows[0];
  return row?.id ?? null;
}

/** 위임이 지금 유효한가 — 끝나지 않았고 마지막 활동이 7일 안. 유효하면 소유자 id. */
export async function validMandateOwner(client: Q, mandateId: string | null, now = new Date()): Promise<string | null> {
  if (!mandateId) return null;
  const row = (await client.query<{ owner: string }>(
    `select owner_account_id as owner from mandate where id = $1 and ended_at is null and last_activity_at > $2`,
    [mandateId, new Date(now.getTime() - MANDATE_IDLE_MS)])).rows[0];
  return row?.owner ?? null;
}
