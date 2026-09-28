/**
 * 호출 게이트 — 스펙 2026-09-20 §6. "이 사람이 이 에이전트를 지금 여기서 깨울 수 있나"의 판정은
 * **이 함수 하나**다. 멘션·@channel·집합·팀·auto-mention 이 전부 `services/messages.ts` 의
 * fan-out 을 지나므로 게이트 자리도 그곳 하나이고, 판정을 여기 모아 두는 이유는 `checkOwnerOrAdmin`
 * 과 같다: 인가 판정이 두 곳에 살면 한쪽만 고치는 날 조용히 열리는 쪽으로 어긋난다.
 *
 * | invoke_scope | 통과 조건 |
 * |---|---|
 * | community | 누구나 |
 * | channel | 호출자가 그 채널의 멤버(`channel_member`) |
 * | list | `agent_invoker` 에 호출자가 있다 |
 * | owner | 호출자 = `owner_account_id` |
 *
 * **팀·집합·auto-mention·@channel 을 거쳐 온 부름은 `community` 만 통과한다.** 그것들은 전부
 * "소유자가 아닌 무언가가 부르는 것"이고, 소유자 전용 에이전트를 팀에 넣는 것은 넣는 시점에
 * 400 으로 막힌다(`teamRoutes`·`channelAutoMentions`). 런타임의 이 거름은 그 전에 들어간 옛
 * 데이터를 위한 방어다.
 */
import type { PoolClient } from 'pg';
import type { InvokeScope } from '@harkroom/shared';

export type InvokeVia = 'mention' | 'team' | 'group' | 'channel_all' | 'auto_mention';

export interface AgentInvokeFacts {
  agentId: string;
  invokeScope: InvokeScope;
  ownerAccountId: string | null;
}

/** 여러 에이전트의 스코프를 한 번에 읽는다 — fan-out 은 후보가 여럿이다. 사람·모르는 id 는 빠진다. */
export async function invokeFactsFor(client: PoolClient, agentIds: readonly string[]): Promise<Map<string, AgentInvokeFacts>> {
  if (!agentIds.length) return new Map();
  const res = await client.query<{ id: string; invoke_scope: InvokeScope; owner_account_id: string | null }>(
    `select a.id, coalesce(c.invoke_scope, 'community') as invoke_scope, c.owner_account_id
       from account a left join agent_config c on c.account_id = a.id
      where a.kind = 'agent' and a.id = any($1::uuid[])`,
    [agentIds]);
  return new Map(res.rows.map((r) => [r.id, { agentId: r.id, invokeScope: r.invoke_scope, ownerAccountId: r.owner_account_id }]));
}

export async function mayInvoke(
  client: PoolClient,
  facts: AgentInvokeFacts,
  ctx: { callerId: string; channelId: string; via: InvokeVia },
): Promise<boolean> {
  if (facts.invokeScope === 'community') return true;
  if (ctx.via !== 'mention') return false;
  switch (facts.invokeScope) {
    case 'owner':
      return facts.ownerAccountId !== null && facts.ownerAccountId === ctx.callerId;
    case 'list': {
      const res = await client.query(
        `select 1 from agent_invoker where agent_id = $1 and account_id = $2`, [facts.agentId, ctx.callerId]);
      return Boolean(res.rowCount);
    }
    case 'channel': {
      const res = await client.query(
        `select 1 from channel_member where channel_id = $1 and account_id = $2`, [ctx.channelId, ctx.callerId]);
      return Boolean(res.rowCount);
    }
  }
}
