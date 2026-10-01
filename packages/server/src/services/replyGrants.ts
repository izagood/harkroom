import type { PoolClient } from 'pg';

/**
 * 회신권(마이그레이션 084) — **범위가 좁은 에이전트가 부른 상대는 그 스레드에서 답할 수 있다.**
 *
 * 판정(`hasReplyGrant`)은 `invokeGate.mayInvoke` 가 부른다 — 인가 판정을 한 자리에 두는 규칙
 * (`invokeGate.ts` 머리 주석)을 지키려고, 여기에는 행을 여닫는 사실만 둔다. 여는 자리와 닫는
 * 자리는 `postMessage` 한 곳이다.
 */

/** 결과를 끝내 안 낸 경우의 안전장치. 깨움·위임 상한(6h)과 같다. */
export const REPLY_GRANT_TTL_SEC = 6 * 60 * 60;

/**
 * X(작성자)가 스레드 T 에서 Y 들을 불렀다 — Y→X 회신권을 연다(이미 있으면 다시 연다).
 *
 * 작성자가 **게이트에 걸리는 에이전트**(invoke_scope 가 community 가 아니다)일 때만 연다. 사람과
 * 공개 에이전트는 회신을 받는 데 허가가 필요 없다 — 필요 없는 행을 만들면 무엇이 무엇을 여는지
 * 읽기 어려워진다. 받는 쪽도 에이전트만이다: 사람의 글은 이 게이트와 무관하게 사람의 것이다.
 */
export async function openReplyGrants(
  client: PoolClient,
  input: { granterId: string; threadRootId: string; granteeIds: readonly string[] },
): Promise<void> {
  const grantees = input.granteeIds.filter((id) => id !== input.granterId);
  if (!grantees.length) return;
  await client.query(
    `insert into invoke_reply_grant (grantee_id, granter_id, thread_root_id, expires_at)
     select g.id, $1, $2, now() + make_interval(secs => $4)
       from account g
      where g.id = any($3::uuid[]) and g.kind = 'agent'
        and exists (
          select 1 from account a join agent_config c on c.account_id = a.id
           where a.id = $1 and a.kind = 'agent' and c.invoke_scope <> 'community')
     on conflict (grantee_id, granter_id, thread_root_id) do update
       set opened_at = now(), expires_at = excluded.expires_at, closed_at = null`,
    [input.granterId, input.threadRootId, grantees, REPLY_GRANT_TTL_SEC]);
}

/** Y 가 T 에서 X 를 깨울 회신권이 지금 열려 있나. */
export async function hasReplyGrant(
  client: Pick<PoolClient, 'query'>,
  input: { granteeId: string; granterId: string; threadRootId: string },
): Promise<boolean> {
  const res = await client.query(
    `select 1 from invoke_reply_grant
      where grantee_id = $1 and granter_id = $2 and thread_root_id = $3
        and closed_at is null and expires_at > now()`,
    [input.granteeId, input.granterId, input.threadRootId]);
  return Boolean(res.rowCount);
}

/**
 * Y 가 T 에 결과를 냈다 — 그 스레드의 Y 회신권을 전부 닫는다. 이 발화 자체는 닫기 **전에**
 * 게이트를 지났으므로 닿는다("결과 한 번"). 진행 줄·대기 줄은 부르는 쪽이 정한다(`countsAsReply`).
 */
export async function closeReplyGrants(
  client: PoolClient,
  input: { granteeId: string; threadRootId: string },
): Promise<void> {
  await client.query(
    `update invoke_reply_grant set closed_at = now()
      where grantee_id = $1 and thread_root_id = $2 and closed_at is null`,
    [input.granteeId, input.threadRootId]);
}
