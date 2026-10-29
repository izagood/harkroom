import type { Pool, PoolClient } from 'pg';
import { channelVisibleSql } from './channels.js';

/**
 * 누가 이 에이전트의 권한·머지 카드를 정할 수 있나(소유자 결정 2026-10-29: 「사용 권한이 있는 사람 = 카드·머지 가능」).
 *
 * 규칙은 하나다 — **그 채널에서 그 에이전트를 직접 멘션해 부를 수 있는 사람**. 표는 `invokeGate.ts` 의 `passesScope` 와 같다:
 *
 * | invoke_scope | 정할 수 있는 사람 |
 * |---|---|
 * | owner | 소유자만 |
 * | list | 소유자 + `agent_invoker` 명단 |
 * | channel | 소유자 + 그 채널(DM 아님)의 멤버 |
 * | community | 소유자 + 그 채널을 볼 수 있는 사람 누구나 |
 *
 * `mayInvoke` 를 그대로 부르지 않는다(security 1) — 그 함수는 회신권(084)·같은 소유자 에이전트(073·083)·집합 경유로도 참이 되어
 * 에이전트가 카드를 정하는 길이 생긴다. 여기는 **사람 계정만**, 직접 멘션 기준의 범위만 본다.
 *
 * - 게스트(`role = 'guest'`)·지운·막힌 계정은 소유자가 아니면 정하지 못한다(security 5).
 * - 에이전트가 꺼졌거나 소유자가 비상 스위치(`agent_config.user_decide`)를 껐으면 소유자만 정한다.
 * - 범위는 **부를 때마다 지금 값**을 읽는다(security 4) — 명단에서 빠지거나 채널을 나가면 그 순간부터 정하지 못한다.
 */
/**
 * 화면이 「누가 정하나」 문구를 고르는 값(designer 시안 v1 ②·③) — 판정 없이 그리게 서버가 내려 준다.
 * 스위치가 꺼졌으면 범위와 관계없이 `switchOff`(소유자만).
 */
export type DecideScope = 'owner' | 'list' | 'channel' | 'community' | 'switchOff';
type VerdictBase = { ownerAccountId: string | null; decideScope: DecideScope | null };
export type DeciderVerdict = ({ ok: true; asOwner: boolean } & VerdictBase) | ({ ok: false } & VerdictBase);

export async function mayDecideFor(
  db: Pick<Pool | PoolClient, 'query'>,
  args: { agentId: string; actorId: string; channelId: string | null },
): Promise<DeciderVerdict> {
  const row = (await db.query<{
    ownerAccountId: string | null; scope: string; userDecide: boolean; agentOff: boolean;
    actorKind: string | null; actorRole: string | null; actorOff: boolean | null;
  }>(
    `select c.owner_account_id as "ownerAccountId", coalesce(c.invoke_scope, 'community') as scope, c.user_decide as "userDecide",
            (a.disabled_at is not null or a.deleted_at is not null) as "agentOff",
            p.kind as "actorKind", p.role as "actorRole", (p.disabled_at is not null or p.deleted_at is not null) as "actorOff"
       from agent_config c join account a on a.id = c.account_id
       left join account p on p.id = $2
      where c.account_id = $1`,
    [args.agentId, args.actorId])).rows[0];
  if (!row) return { ok: false, ownerAccountId: null, decideScope: null };
  const owner = row.ownerAccountId;
  const base: VerdictBase = { ownerAccountId: owner, decideScope: row.userDecide ? (row.scope as DecideScope) : 'switchOff' };
  if (row.actorKind !== 'human' || row.actorOff !== false) return { ok: false, ...base };
  if (owner !== null && owner === args.actorId) return { ok: true, asOwner: true, ...base };
  if (!row.userDecide || row.agentOff || row.actorRole === 'guest' || !args.channelId) return { ok: false, ...base };
  const seen = (await db.query<{ ok: boolean }>(
    `select ${channelVisibleSql('ch', '$2')} as ok from channel ch where ch.id = $1`, [args.channelId, args.actorId])).rows[0];
  if (!seen?.ok) return { ok: false, ...base };
  let passes = false;
  switch (row.scope) {
    case 'community':
      passes = true;
      break;
    case 'list':
      passes = Boolean((await db.query(`select 1 from agent_invoker where agent_id = $1 and account_id = $2`, [args.agentId, args.actorId])).rowCount);
      break;
    case 'channel':
      passes = Boolean((await db.query(
        `select 1 from channel_member m join channel ch on ch.id = m.channel_id
          where m.channel_id = $1 and m.account_id = $2 and ch.kind <> 'dm'`, [args.channelId, args.actorId])).rowCount);
      break;
    default:
      passes = false;
  }
  return passes ? { ok: true, asOwner: false, ...base } : { ok: false, ...base };
}

/**
 * SQL 안에서 같은 판정을 할 때 쓰는 조각(사슬 뿌리 `causeChainRoot` 등) — `mayDecideFor` 와 **같은 조건**이어야 한다.
 * `$agent`·`$actor`·`$channel` 은 SQL 식(열·매개변수)이다. 시험(`deciders.test.ts`)이 두 판정을 같은 표로 대조한다.
 */
export function mayDecideSql(agent: string, actor: string, channel: string): string {
  return `exists (
    select 1 from agent_config dc join account da on da.id = dc.account_id join account dp on dp.id = ${actor}
     where dc.account_id = ${agent} and dp.kind = 'human' and dp.disabled_at is null and dp.deleted_at is null
       and (dc.owner_account_id = dp.id
         or (dc.user_decide and da.disabled_at is null and da.deleted_at is null and dp.role <> 'guest'
             and exists (select 1 from channel dch where dch.id = ${channel} and ${channelVisibleSql('dch', actor)})
             and (dc.invoke_scope = 'community'
               or (dc.invoke_scope = 'list' and exists (select 1 from agent_invoker di where di.agent_id = dc.account_id and di.account_id = dp.id))
               or (dc.invoke_scope = 'channel' and exists (select 1 from channel_member dm join channel dmc on dmc.id = dm.channel_id
                     where dm.channel_id = ${channel} and dm.account_id = dp.id and dmc.kind <> 'dm'))))))`;
}
