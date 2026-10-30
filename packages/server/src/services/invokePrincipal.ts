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

/**
 * 그 원인 글로 이 에이전트에게 온 inbox 사유들(mention·thread_reply·wake 등) — `message.principal_cause_reasons` 에만 적는다(153, 서버 집계 전용).
 * 집계에서 「자기 글로 깬 턴이 옛 principal 을 이어받는 길」이 wake 말고 있는지 사유별로 본다(보안 검토 넘김 ①).
 */
export async function causeReasonsFor(
  client: Q, args: { agentId: string; causeMessageId: string },
): Promise<string[]> {
  return (await client.query<{ reason: string }>(
    `select distinct reason from inbox where account_id = $1 and message_id = $2 order by reason`,
    [args.agentId, args.causeMessageId])).rows.map((r) => r.reason);
}

/**
 * 그림자 집계(2단계 → 3단계 스위치 결정의 근거). 최근 `$1` 시간(기본 3일 = 72) 동안의 **에이전트 글** 을 하루(KST)별로 센다.
 *
 * - `denied_posts`: 계정 멘션이 막힌 에이전트 글(`mentionDenied`)
 * - `opened_posts`·`opened_calls`: 그 가운데 안 A 였다면 열렸을 글·부름 수(`mentionPrincipalShadow`)
 * - `no_principal_posts`: 막혔고 principal 도 없던 글(wake·자동화·임대 없음 — 3단계 뒤에도 그대로 막힌다)
 * - `by_cause`: 열렸을 부름의 원인 inbox 사유별 수(`{"mention": 3, "thread_reply": 1}`, `principal_cause_reasons`)
 * 3단계 스위치가 켜져 있으면 그림자는 생기지 않는다(대신 `invokedAsPrincipal`). 끈 서버에서만 뜻이 있다.
 * - `principals`: 열렸을 부름을 빌려 준 사람 수
 *
 * 운영 DB 에서 그대로 돌린다: `psql -v hours=72 -c "<이 문장에서 $1 을 :hours 로>"`. 쓰지 않고 읽기만 한다.
 */
/**
 * 3단계 스위치 — 기본 켜짐(소유자 결정 2026-10-30: 그림자 집계를 기다리지 않고 바로 전환). `HARKROOM_PRINCIPAL_INVOKE=off`
 * (`0`·`false` 도 같다)면 판정은 2단계로 돌아간다 — 열지 않고 그림자(`mentionPrincipalShadow`)만 남긴다. 부를 때마다 읽는다.
 */
export function principalInvokeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.HARKROOM_PRINCIPAL_INVOKE ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}

/**
 * principal 하나가 24시간 동안 빌려 줄 수 있는 에이전트 글 수(보안 검토 C6). 넘으면 그 글의 부름은 지금 규칙대로 막히고
 * `mentionDeniedPrincipal: 'capped'` 가 남는다. 연쇄 상한(chainLimit·24시간)은 이것과 따로 그대로 걸린다.
 */
export const PRINCIPAL_INVOKE_DAILY_CAP = 200;

/** 최근 24시간 동안 이 principal 의 권한으로 부름을 연 에이전트 글 수. */
export async function principalInvokesToday(client: Q, principalId: string, now = new Date()): Promise<number> {
  const r = await client.query<{ n: number }>(
    `select count(*)::int as n from message
      where principal_account_id = $1 and created_at > $2 and deleted_at is null and meta ? 'invokedAsPrincipal'`,
    [principalId, new Date(now.getTime() - 24 * 60 * 60_000)]);
  return r.rows[0]?.n ?? 0;
}

/**
 * 서버만 쓰는 부름 meta 키(보안 검토 n2). 글을 쓰는 쪽(MCP·REST 어느 입구든 `postMessage` 를 지난다)이 넣은 같은 키는
 * 걷어 낸다 — 남기면 그 판정이 없던 글에 「누구 권한으로」·「막힘」 표시를 위조할 수 있다.
 */
export const SERVER_CALL_META_KEYS = [
  'mentionDenied', 'mentionDeniedPrincipal', 'mentionChainCapped', 'mentionChainLimit', 'mentionChainReason',
  'mentionPrincipalShadow', 'invokedAsPrincipal',
] as const;

export function stripServerCallMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return meta;
  if (!SERVER_CALL_META_KEYS.some((k) => Object.hasOwn(meta, k))) return meta;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) if (!(SERVER_CALL_META_KEYS as readonly string[]).includes(k)) out[k] = v;
  return out;
}

export const PRINCIPAL_SHADOW_REPORT_SQL = `
with posts as (
  select m.id, (m.created_at at time zone 'Asia/Seoul')::date as day, m.meta, m.principal_account_id, m.principal_cause_reasons
    from message m join account a on a.id = m.author_id
   where a.kind = 'agent' and m.deleted_at is null
     and m.created_at > now() - make_interval(hours => $1::int)
     and m.meta ? 'mentionDenied'
), causes as (
  select p.day, r.reason, count(*) as n
    from posts p, unnest(p.principal_cause_reasons) r(reason)
   where p.meta ? 'mentionPrincipalShadow'
   group by p.day, r.reason
)
select p.day::text as day,
       count(*)::int as denied_posts,
       count(*) filter (where p.meta ? 'mentionPrincipalShadow')::int as opened_posts,
       coalesce(sum(jsonb_array_length(p.meta->'mentionPrincipalShadow'->'ids')) filter (where p.meta ? 'mentionPrincipalShadow'), 0)::int as opened_calls,
       count(*) filter (where p.principal_account_id is null)::int as no_principal_posts,
       count(distinct p.meta->'mentionPrincipalShadow'->>'principalId')::int as principals,
       coalesce((select jsonb_object_agg(c.reason, c.n) from causes c where c.day = p.day), '{}'::jsonb) as by_cause
  from posts p
 group by p.day
 order by p.day`;
