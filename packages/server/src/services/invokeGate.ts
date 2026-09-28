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
 * **집합·auto-mention·@channel 을 거쳐 온 부름은 `community` 만 통과한다.** 그것들은 전부
 * "소유자가 아닌 무언가가 부르는 것"이다(auto-mention 은 넣는 시점에 400 으로도 막힌다).
 *
 * **팀은 다르다(068).** 팀 멘션은 사람이 이름을 붙여 둔 명단을 **그 사람이** 부르는 것이라
 * 호출자는 작성자 그대로다. 그래서 팀은 에이전트와 같은 규칙을 두 겹으로 탄다:
 * ① 팀 자체의 범위(`mayInvokeTeam`) — "이 사람이 이 팀을 부를 수 있나",
 * ② 팀원 각자의 범위(`mayInvoke(…, via: 'team')`) — 직접 멘션과 같은 판정.
 * ②가 있어서 팀이 팀원의 범위를 넓히지 못한다. 예전 규칙(팀이면 community 만)은 팀원이 나중에
 * owner 로 좁혀지는 순간 그 팀의 부름을 소유자에게서까지 조용히 빼앗았다.
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
  // 팀도 호출자가 작성자 그대로다 — 직접 멘션과 같은 판정을 탄다(위 머리 주석 ②).
  if (ctx.via !== 'mention' && ctx.via !== 'team') return false;
  return passesScope(client, facts.invokeScope, facts.ownerAccountId, ctx,
    `select 1 from agent_invoker where agent_id = $1 and account_id = $2`, facts.agentId);
}

export interface TeamInvokeFacts {
  teamId: string;
  invokeScope: InvokeScope;
  ownerAccountId: string | null;
}

/**
 * "이 사람이 이 **팀**을 부를 수 있나"(068, 머리 주석 ①). 표는 에이전트와 같다 — 같은 네 값을
 * 두 곳에서 다르게 읽으면 한쪽만 고치는 날 어긋나므로 판정 몸통(`passesScope`)을 함께 쓴다.
 */
export async function mayInvokeTeam(
  client: PoolClient,
  facts: TeamInvokeFacts,
  ctx: { callerId: string; channelId: string },
): Promise<boolean> {
  if (facts.invokeScope === 'community') return true;
  return passesScope(client, facts.invokeScope, facts.ownerAccountId, ctx,
    `select 1 from agent_team_invoker where team_id = $1 and account_id = $2`, facts.teamId);
}

async function passesScope(
  client: PoolClient,
  scope: InvokeScope,
  ownerAccountId: string | null,
  ctx: { callerId: string; channelId: string },
  listSql: string,
  subjectId: string,
): Promise<boolean> {
  switch (scope) {
    case 'community':
      return true;
    case 'owner':
      return ownerAccountId !== null && ownerAccountId === ctx.callerId;
    case 'list': {
      const res = await client.query(listSql, [subjectId, ctx.callerId]);
      return Boolean(res.rowCount);
    }
    case 'channel': {
      const res = await client.query(
        `select 1 from channel_member where channel_id = $1 and account_id = $2`, [ctx.channelId, ctx.callerId]);
      return Boolean(res.rowCount);
    }
  }
}
