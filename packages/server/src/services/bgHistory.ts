/**
 * 백그라운드 회차 히스토리와 되돌리기(G1 · BG4 서버, 설계 harkroom://message/4a44f18a 4절). 사람(소유자·admin) 화면용이다.
 *
 * - 회차 목록은 `bg_job` 행 그대로(언제·종류·상태·요약·쓰기 수·토큰·시간). 요약은 에이전트가 쓴 글이다 — 화면은 평문으로만 그린다.
 * - 회차 하나를 펼치면 바뀐 기억마다 전/후를 준다. 전 = 그 회차가 밀어낸 가장 이른 이전 판, 후 = 회차 직후 판(지금 행이거나,
 *   그 뒤 다른 쓰기에 밀려났으면 그 이전 판).
 * - 되돌리기는 `run_id`·`bg_job_change` 로만 대상을 고른다(`turn_id` 는 헤더 모양만 본 관측용 표지라 판정에 안 쓴다 — security n2).
 *   지금 판이 회차 직후 판과 같은 것만 되돌리고, 그 사이 다른 턴·사람이 고친 것은 건너뛰어 목록으로 돌려준다.
 */
import type { Pool } from 'pg';

import { scanWrite } from './contentScan.js';
import { archiveMemory, restoreMemory, unarchiveMemory } from './memoryCurate.js';
import { bgPaused, BG_KINDS, type BgKind } from './bgJobs.js';

export interface BgRunSummary {
  id: string;
  kind: string;
  day: string;
  status: string;
  summary: string | null;
  error: string | null;
  writes: number;
  tokens: number | null;
  durationMs: number | null;
  createdAt: Date;
  finishedAt: Date | null;
  revertedAt: Date | null;
  changes: number;
}

export async function listBgRuns(pool: Pool, accountId: string, limit = 30): Promise<BgRunSummary[]> {
  const r = await pool.query<BgRunSummary>(
    `select j.id, j.kind, to_char(j.day, 'YYYY-MM-DD') as day, j.status, j.summary, j.error, j.writes, j.tokens,
            j.duration_ms as "durationMs", j.created_at as "createdAt", j.finished_at as "finishedAt", j.reverted_at as "revertedAt",
            (select count(distinct c.slug) from bg_job_change c where c.run_id = j.id)::int as changes
       from bg_job j where j.account_id = $1
      order by j.created_at desc limit $2`,
    [accountId, limit],
  );
  return r.rows;
}

export interface BgState {
  enabled: boolean;
  paused: BgKind[];
}

export async function bgState(pool: Pool, accountId: string): Promise<BgState> {
  const on = await pool.query<{ bg_enabled: boolean }>(`select bg_enabled from agent_config where account_id = $1`, [accountId]);
  const paused: BgKind[] = [];
  for (const k of BG_KINDS) if (await bgPaused(pool, accountId, k)) paused.push(k);
  return { enabled: on.rows[0]?.bg_enabled ?? true, paused };
}

export async function setBgEnabled(pool: Pool, accountId: string, enabled: boolean): Promise<void> {
  await pool.query(`update agent_config set bg_enabled = $2 where account_id = $1`, [accountId, enabled]);
}

interface MemSnap { value: string; description: string | null; kind: string | null }
export interface BgRunChange {
  slug: string;
  ops: string[];
  before: MemSnap | null;
  after: (MemSnap & { archived: boolean }) | null;
  /** 지금 판이 회차 직후 판과 같은가 — 아니면 되돌리기가 건너뛴다. */
  unchangedSince: boolean;
}

const sameMs = (a: Date | null, b: Date | null) => (a === null || b === null ? a === b : Math.floor(a.getTime()) === Math.floor(b.getTime()));

/** 회차 하나에서 바뀐 기억마다 전/후. 없는 회차·남의 회차면 null. */
export async function bgRunChanges(pool: Pool, accountId: string, runId: string): Promise<BgRunChange[] | null> {
  const own = await pool.query(`select 1 from bg_job where id = $1 and account_id = $2`, [runId, accountId]);
  if (!own.rowCount) return null;
  const ch = await pool.query<{ slug: string; op: string; after_updated_at: Date | null }>(
    `select slug, op, after_updated_at from bg_job_change where run_id = $1 order by id`, [runId],
  );
  const bySlug = new Map<string, { ops: string[]; after: Date | null }>();
  for (const c of ch.rows) {
    const e = bySlug.get(c.slug) ?? { ops: [], after: null };
    e.ops.push(c.op);
    e.after = c.after_updated_at;
    bySlug.set(c.slug, e);
  }
  const out: BgRunChange[] = [];
  for (const [slug, e] of bySlug) {
    const firstRev = await pool.query<MemSnap & { reason: string | null; created: boolean }>(
      `select value, description, kind, reason, coalesce((detail->>'created')::boolean, false) as created
         from agent_memory_revision where account_id = $1 and slug = $2 and run_id = $3
        order by replaced_at, id limit 1`,
      [accountId, slug, runId],
    );
    const fr = firstRev.rows[0];
    // 회차가 만든 기억(create, 또는 새 이름으로 merge)에는 「전」이 없다.
    const before = !fr || (fr.reason === 'merge' && fr.created) ? null : { value: fr.value, description: fr.description, kind: fr.kind };
    const cur = await pool.query<MemSnap & { updated_at: Date; archived_at: Date | null }>(
      `select value, description, kind, updated_at, archived_at from agent_memory where account_id = $1 and slug = $2`, [accountId, slug],
    );
    const row = cur.rows[0];
    let after: BgRunChange['after'] = null;
    const unchangedSince = !!row && sameMs(row.updated_at, e.after);
    if (row && unchangedSince) after = { value: row.value, description: row.description, kind: row.kind, archived: row.archived_at !== null };
    else if (e.after) {
      const later = await pool.query<MemSnap>(
        `select value, description, kind from agent_memory_revision where account_id = $1 and slug = $2
           and date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $3::timestamptz) order by replaced_at limit 1`,
        [accountId, slug, e.after],
      );
      if (later.rows[0]) after = { ...later.rows[0], archived: false };
    }
    out.push({ slug, ops: e.ops, before: before ?? (e.ops.every((o) => o === 'archive') && row ? { value: row.value, description: row.description, kind: row.kind } : null), after, unchangedSince });
  }
  return out;
}

export type RevertResult =
  | { reverted: string[]; skipped: { slug: string; reason: 'changed_since' | 'gone' | 'too_many' }[] }
  | 'not_found' | 'already_reverted' | 'not_finished';

/**
 * [이 회차 되돌리기]. 기억마다: 지금 판이 회차 직후 판과 같을 때만 —
 * 회차가 만든 것은 보관, 회차가 고친 것은 그 회차가 밀어낸 가장 이른 판으로 restore(보관됐어도 함께 되살아난다),
 * 보관만 한 것은 되살린다. 그 사이 바뀐 것은 건너뛴다. 회차는 한 번만 되돌린다.
 */
export async function revertBgRun(pool: Pool, accountId: string, runId: string, actorId: string): Promise<RevertResult> {
  const claim = await pool.query<{ status: string }>(
    `update bg_job set reverted_at = now(), reverted_by = $3
      where id = $1 and account_id = $2 and reverted_at is null and status in ('done', 'failed', 'skipped')
      returning status`,
    [runId, accountId, actorId],
  );
  if (!claim.rowCount) {
    const r = await pool.query<{ reverted_at: Date | null }>(`select reverted_at from bg_job where id = $1 and account_id = $2`, [runId, accountId]);
    if (!r.rows[0]) return 'not_found';
    return r.rows[0].reverted_at ? 'already_reverted' : 'not_finished';
  }
  const ch = await pool.query<{ slug: string; op: string; after_updated_at: Date | null }>(
    `select slug, op, after_updated_at from bg_job_change where run_id = $1 order by id`, [runId],
  );
  const last = new Map<string, Date | null>();
  const ops = new Map<string, string[]>();
  for (const c of ch.rows) { last.set(c.slug, c.after_updated_at); ops.set(c.slug, [...(ops.get(c.slug) ?? []), c.op]); }
  const reverted: string[] = [];
  const skipped: { slug: string; reason: 'changed_since' | 'gone' | 'too_many' }[] = [];
  for (const [slug, after] of last) {
    const cur = await pool.query<{ updated_at: Date }>(`select updated_at from agent_memory where account_id = $1 and slug = $2`, [accountId, slug]);
    if (!cur.rows[0]) { skipped.push({ slug, reason: 'gone' }); continue; }
    if (!sameMs(cur.rows[0].updated_at, after)) { skipped.push({ slug, reason: 'changed_since' }); continue; }
    const first = await pool.query<{ id: number; reason: string | null; created: boolean }>(
      `select id::int as id, reason, coalesce((detail->>'created')::boolean, false) as created
         from agent_memory_revision where account_id = $1 and slug = $2 and run_id = $3 order by replaced_at, id limit 1`,
      [accountId, slug, runId],
    );
    const f = first.rows[0];
    const created = (ops.get(slug)?.[0] === 'create') || (f?.reason === 'merge' && f.created);
    let r: unknown;
    if (created) r = await archiveMemory(pool, accountId, slug, cur.rows[0].updated_at);
    else if (f) r = await restoreMemory(pool, accountId, slug, f.id, (v, d) => scanWrite(v, d)?.reason ?? null);
    else r = await unarchiveMemory(pool, accountId, slug);
    if (r === 'ok') reverted.push(slug);
    else skipped.push({ slug, reason: r === 'too_many' ? 'too_many' : 'changed_since' });
  }
  return { reverted, skipped };
}
