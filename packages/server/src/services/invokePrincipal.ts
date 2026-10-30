import type { PoolClient } from 'pg';

/**
 * 에이전트 호출 권한 재설계 1단계 — principal(이번 턴을 깨운 사람). 소유자 결정 2026-10-30,
 * 규칙: 에이전트는 이번 턴을 깨운 사람이 직접 부를 수 있는 에이전트만 부른다(판정은 아직 바꾸지 않는다).
 *
 * 쓰는 곳은 **mention 호출 판정 하나**다(C5). 머지 래퍼의 사람 원인 판정·권한 승인·비밀 reveal·연쇄 깊이에는
 * 쓰지 않는다 — principal 은 「그 사람이 직접 부를 수 있었나」만 답한다.
 *
 * 값은 서버가 가진 사실로만 정한다(C1). 러너가 보내는 원인 헤더는 어느 임대를 고를지에만 쓰이고, principal 자체는
 * 발급 때 원인 글에서 해석해 임대 행에 적어 둔 값이다.
 */
type Q = Pick<PoolClient, 'query'>;

/**
 * 임대 발급(`issueTurnLease`) 때 원인 글 `m`(작성자 `a`, 인박스 `i`)에서 principal 을 정하는 SQL 식.
 * 모르면 null 이다 — null 이면 판정은 지금 규칙 그대로다(넓어지는 쪽으로 새지 않는다).
 *
 * - wake 로 깬 턴: null(C2). 같은 글로 온 wake 인박스가 하나라도 있으면 사람 부름과 섞였어도 null 로 둔다.
 * - 사람 글(`kind = 'user'`, 자동화 아님, 활성 계정): 그 작성자.
 * - 이 에이전트 자신의 선택 카드: **원본 카드를 사람이 직접 누른 답**만 그 사람(C3). 거울(mirrorOf)·
 *   일괄 답(answeredVia)·닫힘·만료(closedAt)는 null.
 * - 에이전트 글: 그 글에 적힌 principal(글을 쓴 턴의 임대에서 옮겨 적은 값).
 * - 자동화·시스템 글·그 밖: null.
 */
export const PRINCIPAL_FROM_CAUSE_SQL = `(case
  when exists (select 1 from inbox iw where iw.account_id = i.account_id and iw.message_id = m.id and iw.reason = 'wake') then null
  when m.meta ? 'ask' and m.author_id = i.account_id then (
    select ans.id from account ans
     where ans.id = nullif(m.meta->'ask'->>'answeredBy', '')::uuid
       and ans.kind = 'human' and ans.deleted_at is null and ans.disabled_at is null
       and m.meta->'ask'->>'mirrorOf' is null and m.meta->'ask'->>'answeredVia' is null
       and m.meta->'ask'->>'closedAt' is null)
  when a.kind = 'human' and m.kind = 'user' and not (m.meta ? 'automation')
       and a.deleted_at is null and a.disabled_at is null then a.id
  when a.kind = 'agent' then m.principal_account_id
  else null end)`;

/**
 * 에이전트가 지금 쓰는 글의 principal — 그 원인으로 받은 **살아 있는 임대 행**에서만 읽는다(C1, `mandateForAgentPost` 와 같은 꼴).
 * 임대가 없거나 끝났거나 만료됐으면 null. 읽는 순간에도 그 계정이 사람이고 활성인지 다시 본다.
 * (이 서버는 한 워크스페이스라 커뮤니티 멤버 = 활성 계정이다.)
 */
export async function principalForAgentPost(
  client: Q, args: { agentId: string; causeMessageId: string; now?: Date },
): Promise<string | null> {
  const now = args.now ?? new Date();
  const row = (await client.query<{ id: string }>(
    `select p.id from secret_turn_lease l
       join account p on p.id = l.principal_account_id
       join message m on m.id = l.cause_message_id and m.deleted_at is null
      where l.agent_id = $1 and l.cause_message_id = $2 and l.ended_at is null and l.expires_at > $3
        and p.kind = 'human' and p.deleted_at is null and p.disabled_at is null
      order by l.created_at desc limit 1`,
    [args.agentId, args.causeMessageId, now])).rows[0];
  return row?.id ?? null;
}
