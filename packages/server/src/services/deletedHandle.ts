import type { PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { DELETED_HANDLE_PREFIX } from './reservedHandles.js';

/**
 * 지운 계정의 handle(묘비 이름). 기본은 `deleted-<id 앞 8자>` 이고, 그 이름이 계정·팀·집합 어디에 있으면(접두를
 * 막기 전에 만들어진 것) 더 긴 꼬리로 물러선다 — 삭제가 이름 하나 때문에 영영 막히면 안 된다.
 *
 * 사람 삭제(`deleteHumanAccount`)와 에이전트 삭제(`deleteAgentAccount`)가 함께 쓴다 — 두 삭제가 이름을
 * 다르게 다루면 한쪽만 옛 이름을 쥐고 남아, 같은 이름으로 다시 만들 때 막힌다.
 */
export async function freeDeletedHandle(client: PoolClient, accountId: string): Promise<string> {
  const hex = accountId.replace(/-/g, '');
  for (const candidate of [`${DELETED_HANDLE_PREFIX}${hex.slice(0, 8)}`, `${DELETED_HANDLE_PREFIX}${hex.slice(0, 24)}`]) {
    const taken = await client.query(
      `select 1 from account where lower(handle) = lower($1) and id <> $2
       union all select 1 from agent_team where lower(name) = lower($1)
       union all select 1 from handle_group where lower(handle) = lower($1)`, [candidate, accountId]);
    if (!taken.rowCount) return candidate;
  }
  return `${DELETED_HANDLE_PREFIX}${randomBytes(12).toString('hex')}`;
}
