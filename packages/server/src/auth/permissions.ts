/**
 * 인가 판정 — **이 파일에 하나만 둔다.**
 *
 * `checkOwnerOrAdmin`(plugin.ts)이 #253 에서 세운 원칙을 grant 에도 적용한다: 라우트는 이
 * 함수를 부르지 판정을 복사하지 않는다. 사본은 한쪽만 고쳐지고, 인가에서 그것은 조용히
 * 열리는 쪽으로 어긋난다.
 *
 * 세 층의 순서가 곧 규칙이다(스펙 2026-09-20-operator-and-permissions §6):
 *
 *   can = isOwnerOf(target) ∨ 기본 capability ∨ hasGrant(scope 또는 '') ∨ role ≥ admin
 *
 * 소유를 먼저 보는 이유: 소유는 grant 가 아니다. 내가 만든 것을 관리하는 데 admin 이
 * 나에게 무언가를 줘야 한다면 요구 4("개인 에이전트")가 grant 폭발 없이는 성립하지 않는다.
 */
import type { Pool } from 'pg';
import type { AccountView, Capability, PermissionTarget } from '@harkroom/shared';
import { CAPABILITIES, MEMBER_DEFAULT_CAPABILITIES, orgScopeOf, repoScope } from '@harkroom/shared';
import { deployRepoScopes } from '../services/mergeDenials.js';

export async function hasGrant(pool: Pool, accountId: string, cap: Capability, scope: string): Promise<boolean> {
  // scope 가 주어져도 전역('') grant 는 언제나 그 대상을 덮는다 — 전역이 대상 한정보다 넓다.
  const res = await pool.query(
    `select 1 from account_grant
      where account_id = $1 and capability = $2 and (scope = '' or scope = $3)
        and (expires_at is null or expires_at > now()) limit 1`,
    [accountId, cap, scope],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 소유 판정. 테이블마다 소유 컬럼이 다르므로 `kind` 로 가른다.
 *
 * **아직 없는 테이블·컬럼은 "소유 아님"이다.** `channel.created_by` 는 1.5 에서, `operator` 는
 * 2.2 에서 생긴다 — 그 전에 이 함수가 던지면 그 kind 를 묻는 라우트가 통째로 500 이 된다.
 * undefined_column(42703)·undefined_table(42P01) 만 삼킨다: "아직 없다"와 "소유 아님"은
 * 이 단계에서 같은 답이고, 그 밖의 오류는 진짜 오류다.
 */
export async function isOwnerOf(pool: Pool, accountId: string, target: PermissionTarget): Promise<boolean> {
  const sql: Record<PermissionTarget['kind'], string> = {
    agent: `select 1 from agent_config where account_id = $2 and owner_account_id = $1`,
    team: `select 1 from agent_team where id = $2 and created_by = $1`,
    channel: `select 1 from channel where id = $2 and created_by = $1`,
    operator: `select 1 from operator where id = $2 and owner_account_id = $1`,
  };
  try {
    const res = await pool.query(sql[target.kind], [accountId, target.id]);
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '42703' || code === '42P01') return false;
    throw err;
  }
}

/**
 * `repo.merge` 는 `can()` 을 타지 않는다(security F1·F2). 세 층 중 어느 것도 이 capability 를 열지 못한다:
 * 소유(에이전트가 저장소를 "소유"하지 않는다) · 전역 grant('' — 전 저장소가 열리는 구멍) · admin 역할.
 * 오직 (에이전트, 'repo.merge', 'repo:<owner>/<name>') 정확 일치 grant, 또는 그 owner 의 조직 grant `repo:<owner>/*`
 * (jaebin 10-09) 둘뿐이다. 조직 grant 는 **배포 저장소**(`HARKROOM_MERGE_DEPLOY_REPOS`)를 덮지 않는다 — 머지가 곧 배포인
 * 저장소는 언제나 정확한 이름으로만 연다(카드 C6 와 같은 규칙).
 *
 * 둘 다 있으면 `allow_agent_cause` 가 켜진 쪽, 그다음 정확 일치를 고른다 — 어느 grant 든 허락하면 허락이다.
 *
 * 돌려주는 것은 판정에 쓴 grant 의 사실(누가·언제·에이전트 지시 허용 여부)이다 — 호출부가 감사·시스템 줄에
 * 그대로 적는다. 없으면 null.
 */
export async function mergeGrantFor(
  pool: Pool, agentId: string, repo: string,
): Promise<{ scope: string; grantedBy: string; grantedAt: string; expiresAt: string | null; allowAgentCause: boolean } | null> {
  const scope = repoScope(repo);
  if (!scope) return null;
  const org = orgScopeOf(scope);
  const scopes = org && !deployRepoScopes().has(scope) ? [scope, org] : [scope];
  const res = await pool.query(
    `select scope, granted_by as "grantedBy", granted_at as "grantedAt", expires_at as "expiresAt",
            allow_agent_cause as "allowAgentCause"
       from account_grant
      where account_id = $1 and capability = 'repo.merge' and scope = any($2::text[])
        and (expires_at is null or expires_at > now())
      order by allow_agent_cause desc, (scope = $3) desc limit 1`,
    [agentId, scopes, scope],
  );
  return (res.rows[0] as { scope: string; grantedBy: string; grantedAt: string; expiresAt: string | null; allowAgentCause: boolean } | undefined) ?? null;
}

export async function can(
  pool: Pool, actor: AccountView, cap: Capability, target?: PermissionTarget,
): Promise<boolean> {
  // `repo.merge` 는 여기서 언제나 거짓이다 — 정확 일치 grant 만 보는 `mergeGrantFor` 가 판정한다(F1).
  if (cap === 'repo.merge') return false;
  // `api.call` 도 같다 — 사슬과 limits 를 보는 `apiGrants.ts::apiGrantFor` 가 판정한다.
  if (cap === 'api.call') return false;
  // `tool.allow` 도 같다 — 채널·규칙 정확 일치만 보는 `permissionRequests.ts::toolAllowsFor` 가 판정한다(스레드 f61af808).
  if (cap === 'tool.allow') return false;
  if (target && await isOwnerOf(pool, actor.id, target)) return true;
  // guest 는 기본 capability 가 없다 — 외부인을 채널 하나에만 들이는 자리다(스펙 §6, v2).
  if (actor.role !== 'guest' && MEMBER_DEFAULT_CAPABILITIES.includes(cap)) return true;
  const scope = target ? `${target.kind}:${target.id}` : '';
  if (await hasGrant(pool, actor.id, cap, scope)) return true;
  return actor.role === 'owner' || actor.role === 'admin';
}

/**
 * 이 계정이 **전역으로** 할 수 있는 것 전부. `/auth/me` 가 화면 게이트의 근거로 준다.
 *
 * 대상 한정 grant(scope ≠ '')는 여기 없다 — 목록으로 펼치면 "어느 채널의" 가 사라져
 * 화면이 없는 권한을 그린다. 그쪽은 대상이 있을 때 `can()` 으로 묻는다.
 */
export async function effectiveCapabilities(pool: Pool, actor: AccountView): Promise<Capability[]> {
  // `repo.merge`·`api.call` 은 전역이 될 수 없다 — admin 이라도 화면에 그 권한을 그리지 않는다(F1, #1136 L1).
  if (actor.role === 'owner' || actor.role === 'admin') return CAPABILITIES.filter((c) => c !== 'repo.merge' && c !== 'api.call');
  const res = await pool.query<{ capability: Capability }>(
    `select distinct capability from account_grant
      where account_id = $1 and scope = '' and (expires_at is null or expires_at > now())`, [actor.id]);
  const set = new Set<Capability>(actor.role === 'guest' ? [] : MEMBER_DEFAULT_CAPABILITIES);
  for (const r of res.rows) set.add(r.capability);
  return [...set];
}
