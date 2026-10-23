/**
 * 오퍼레이터의 gh 계정 보고(D1) — 저장과 읽기. 받는 값은 `parseGhReport` 를 지난 이름·줄뿐이다(토큰·이메일 칸이 없다).
 * 읽기는 **그 에이전트의 소유자**만 — 판정은 라우트(`mergeAccountRoutes.ts`)가 한다.
 */
import type { Pool } from 'pg';
import type { GhReport } from '@harkroom/shared/operatorProtocol';

/** 폐기된 오퍼레이터의 보고는 적지 않는다(토큰 폐기와 소켓 끊김 사이의 틈). 적었으면 true. */
export async function upsertGhReport(pool: Pool, operatorId: string, r: GhReport, now: Date = new Date()): Promise<boolean> {
  const res = await pool.query(
    `insert into operator_gh_report (operator_id, logins, by_scope, default_gh_user, reach, reported_at)
     select id, $2::jsonb, $3::jsonb, $4, $5::jsonb, $6 from operator where id = $1 and revoked_at is null
     on conflict (operator_id) do update set logins = excluded.logins, by_scope = excluded.by_scope,
       default_gh_user = excluded.default_gh_user, reach = excluded.reach, reported_at = excluded.reported_at`,
    [operatorId, JSON.stringify(r.logins), JSON.stringify(r.byScope), r.defaultGhUser, JSON.stringify(r.reach), now]);
  return (res.rowCount ?? 0) > 0;
}

export interface MergeAccounts {
  operatorId: string | null;
  report: (GhReport & { reportedAt: string }) | null;
}

/** 그 에이전트를 도는(배정된) 오퍼레이터의 마지막 보고. 배정이 없거나 보고가 없으면 report: null. */
export async function mergeAccountsOf(pool: Pool, agentId: string): Promise<MergeAccounts> {
  const row = (await pool.query<{ operatorId: string; logins: string[] | null; byScope: Record<string, string> | null; defaultGhUser: string | null; reach: GhReport['reach'] | null; reportedAt: Date | null }>(
    `select a.operator_id as "operatorId", r.logins, r.by_scope as "byScope", r.default_gh_user as "defaultGhUser", r.reach, r.reported_at as "reportedAt"
       from agent_assignment a
       join operator o on o.id = a.operator_id and o.revoked_at is null
       left join operator_gh_report r on r.operator_id = a.operator_id
      where a.agent_id = $1`, [agentId])).rows[0];
  if (!row) return { operatorId: null, report: null };
  if (!row.reportedAt) return { operatorId: row.operatorId, report: null };
  return {
    operatorId: row.operatorId,
    report: { logins: row.logins ?? [], byScope: row.byScope ?? {}, defaultGhUser: row.defaultGhUser, reach: row.reach ?? [], reportedAt: row.reportedAt.toISOString() },
  };
}
