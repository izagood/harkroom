import type { Pool, PoolClient } from 'pg';
import {
  MAX_CORE_MEMORY_LENGTH, MAX_JOURNAL_MEMORIES_PER_ACCOUNT, MAX_MEMORY_ITEMS_PER_ACCOUNT, JOURNAL_EXPIRING_WINDOW,
  pickExpiringJournals, pruneRevisions, type MemoryKind,
} from './memory.js';
import { MEMORY_CORE_WARN_CHARS, MEMORY_ITEMS_WARN_COUNT } from '@harkroom/shared';

/**
 * 기억 정리의 **쓰기 쪽**(메모리 자동 요약·압축 C1, 2026-10-02, 설계
 * harkroom://message/5e177fd9-b118-4f41-acee-2bd97ae72971). 읽기·후보 뽑기는 `memory.ts::auditMemory` 다.
 *
 * 원칙 셋 — 설계에서 jaebin 이 고른 것:
 * - **지우기 대신 보관(archive).** 보관된 기억은 목록·recall·검색·200 상한에서 빠지지만 행은 남고
 *   한 호출로 돌아온다. 정리 턴이 "이건 이제 안 쓴다"를 틀리게 판단해도 잃는 것이 없다.
 * - **합치기는 한 문장.** A+B→A 를 "A 쓰기, B 보관" 두 호출로 하면 그 사이 다른 턴이 B 를 고친다.
 *   `mergeMemory` 는 한 트랜잭션에서 잠그고 기대 판(ifUpdatedAt)을 전부 대 본 뒤에 쓴다.
 * - **되돌리기는 도구다.** 이전 판은 사람 화면에만 보였다. 정리 턴이 제가 합친 것을 제가 되돌릴 수
 *   있어야 "틀리면 되돌린다"가 말이 된다. merge·restore 로 생긴 판은 보통 판과 자리를 다투지 않는다.
 *
 * LLM 은 여기 없다. 요약·증류의 **제안**은 C4 이고, 적용은 언제나 에이전트 턴 또는 사람이다 —
 * 기억은 그대로 다음 턴의 지시가 되는 자리라(080), 기계가 쓴 요약이 검토 없이 들어가면 안 된다.
 */

// 경고 문턱은 러너(`memoryPin.ts`)와 같이 쓰므로 shared 에 둔다(C2).
export { MEMORY_CORE_WARN_CHARS, MEMORY_ITEMS_WARN_COUNT };
/** 정리 임대의 기본 길이. 정리 턴 하나가 30분 예산이라 넉넉히 한 시간. */
export const MEMORY_LEASE_DEFAULT_MINUTES = 60;
export const MEMORY_LEASE_MAX_MINUTES = 180;
/**
 * 보관 항목 상한(security F2). 보관은 200 상한 밖이라 "200개 쓰고 200개 보관"을 되풀이하면 끝없이 쌓인다.
 * 넘치면 가장 오래 보관된 것부터 이전 판으로 옮기며 지운다(journal 자르기와 같은 규칙).
 */
export const MAX_ARCHIVED_MEMORIES_PER_ACCOUNT = 300;

export type MemoryWarning =
  | { code: 'core_near_limit'; length: number; limit: number }
  | { code: 'items_near_limit'; active: number; limit: number }
  | { code: 'journal_expiring'; count: number; limit: number; expiring: string[] };

/**
 * 쓰기 뒤에 붙이는 경고(C1). 턴이 끝난 뒤에는 에이전트에게 말할 길이 없으므로, **쓰는 그 자리**에서
 * 알린다 — 응답을 읽는 에이전트가 같은 턴에 정리하거나 `memory.audit` 을 부른다. 러너도 같은 사실을
 * 다음 턴 `<memory-index>` 머리에 싣는다(C2). 비어 있으면 응답에 싣지 않는다.
 */
export async function memoryWarnings(pool: Pool, accountId: string): Promise<MemoryWarning[]> {
  const res = await pool.query(
    `select
       coalesce((select char_length(value) from agent_memory where account_id = $1 and slug = 'core'), 0)::int as core_len,
       (select count(*) from agent_memory where account_id = $1 and archived_at is null)::int as active
     `,
    [accountId],
  );
  const { core_len: coreLen, active } = res.rows[0] as { core_len: number; active: number };
  const out: MemoryWarning[] = [];
  if (coreLen >= MEMORY_CORE_WARN_CHARS) out.push({ code: 'core_near_limit', length: coreLen, limit: MAX_CORE_MEMORY_LENGTH });
  if (active >= MEMORY_ITEMS_WARN_COUNT) out.push({ code: 'items_near_limit', active, limit: MAX_MEMORY_ITEMS_PER_ACCOUNT });
  const journals = await pool.query(
    `select slug, updated_at as "updatedAt" from agent_memory
     where account_id = $1 and kind = 'journal' and archived_at is null`,
    [accountId],
  );
  if (journals.rowCount && journals.rowCount > MAX_JOURNAL_MEMORIES_PER_ACCOUNT - JOURNAL_EXPIRING_WINDOW) {
    out.push({
      code: 'journal_expiring', count: journals.rowCount, limit: MAX_JOURNAL_MEMORIES_PER_ACCOUNT,
      expiring: pickExpiringJournals(journals.rows as { slug: string; updatedAt: Date }[]),
    });
  }
  return out;
}

export interface SlugConflict { conflict: { slug: string; updatedAt: Date | null } }
export type ArchiveResult = 'ok' | 'not_found' | SlugConflict;

/** DB 는 µs, JSON 은 ms — 비교는 ms 로 자른 값끼리(`memory.ts::MS_EQ` 와 같은 규칙). */
function sameMs(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.floor(a.getTime()) === Math.floor(b.getTime());
}

async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

interface LockedRow { slug: string; value: string; description: string | null; updated_at: Date; flagged_at: Date | null; archived_at: Date | null; kind: MemoryKind }

async function lockRows(c: PoolClient, accountId: string, slugs: string[]): Promise<Map<string, LockedRow>> {
  const res = await c.query(
    `select slug, value, description, updated_at, flagged_at, archived_at, kind from agent_memory
     where account_id = $1 and slug = any($2::text[]) order by slug for update`,
    [accountId, slugs],
  );
  return new Map((res.rows as LockedRow[]).map((r) => [r.slug, r]));
}

async function activeCount(c: PoolClient, accountId: string): Promise<number> {
  const r = await c.query(`select count(*)::int as n from agent_memory where account_id = $1 and archived_at is null`, [accountId]);
  return r.rows[0].n as number;
}

/**
 * 보관한다. 본문은 그대로이므로 이전 판을 남길 것이 없다 — 되돌리기는 `unarchiveMemory` 다.
 * `updated_at` 을 바꾼다: 목록에서 빠지는 일이라 판본(`memoryRev`)이 바뀌어야 러너 캐시가 따라온다.
 * 이미 보관된 것을 다시 보관하면 `ok`(멱등). `expect` 가 있으면 그 판일 때만.
 */
export async function archiveMemory(
  pool: Pool, accountId: string, slug: string, expect?: Date | null,
): Promise<ArchiveResult> {
  return withTx(pool, async (c) => {
    const row = (await lockRows(c, accountId, [slug])).get(slug);
    if (!row) return 'not_found';
    if (expect !== undefined && !sameMs(row.updated_at, expect)) return { conflict: { slug, updatedAt: row.updated_at } };
    if (row.archived_at) return 'ok';
    await c.query(
      `update agent_memory set archived_at = now(), updated_at = now() where account_id = $1 and slug = $2`,
      [accountId, slug],
    );
    await pruneArchived(c, accountId);
    return 'ok';
  });
}

/** 보관이 상한을 넘으면 가장 오래 보관된 것부터 이전 판으로 옮기며 지운다(F2). 넘치지 않으면 지울 행이 없어 값싸다. */
async function pruneArchived(c: PoolClient, accountId: string): Promise<void> {
  await c.query(
    `with d as (
       delete from agent_memory where account_id = $1 and archived_at is not null and slug in (
         select slug from agent_memory where account_id = $1 and archived_at is not null
         order by archived_at desc, slug offset $2)
       returning slug, value, description, updated_at, flagged_at, kind)
     insert into agent_memory_revision (account_id, slug, value, description, updated_at, flagged, kind)
     select $1, slug, value, description, updated_at, flagged_at is not null, kind from d`,
    [accountId, MAX_ARCHIVED_MEMORIES_PER_ACCOUNT],
  );
}

export type UnarchiveResult = 'ok' | 'not_found' | 'too_many';

/** 보관을 푼다. 살아 있는 항목이 상한이면 `too_many` — 자리를 먼저 비워야 한다. 보관 안 된 것은 `ok`. */
export async function unarchiveMemory(pool: Pool, accountId: string, slug: string): Promise<UnarchiveResult> {
  return withTx(pool, async (c) => {
    const row = (await lockRows(c, accountId, [slug])).get(slug);
    if (!row) return 'not_found';
    if (!row.archived_at) return 'ok';
    if ((await activeCount(c, accountId)) >= MAX_MEMORY_ITEMS_PER_ACCOUNT) return 'too_many';
    await c.query(
      `update agent_memory set archived_at = null, updated_at = now() where account_id = $1 and slug = $2`,
      [accountId, slug],
    );
    return 'ok';
  });
}

export interface MergeInput {
  into: string;
  from: string[];
  value: string;
  description?: string;
  kind?: MemoryKind;
  /** slug → 기대 판(`memory.get` 의 updatedAt). `into` 가 아직 없어야 하면 null. 적은 slug 만 대 본다. */
  expect?: Record<string, Date | null>;
  /** 쓰기 검사(080) 결과. 걸리면 `into` 가 걸린 판으로 저장된다 — 합치기도 쓰기다. */
  flagReason?: string | null;
}
export type MergeResult = 'ok' | 'too_many' | { notFound: string[] } | SlugConflict;

/**
 * `from` 들을 `into` 로 **한 트랜잭션에서** 합친다: into 를 새 본문으로 쓰고(이전 판은 `reason: 'merge'`,
 * `detail: { from }` 으로 남긴다), from 은 보관한다(지우지 않는다 — 틀렸으면 unarchive 로 돌아온다).
 * into 가 새 slug 여도 된다 — 그때도 merge 판을 하나 남겨 "무엇이 여기 합쳐졌나"를 적는다(측정의
 * gold 재매핑이 이것을 읽는다). from 에 into 가 들어 있으면 뺀다.
 */
export async function mergeMemory(pool: Pool, accountId: string, input: MergeInput): Promise<MergeResult> {
  const from = [...new Set(input.from.filter((s) => s !== input.into))];
  return withTx(pool, async (c) => {
    const rows = await lockRows(c, accountId, [input.into, ...from]);
    const missing = from.filter((s) => !rows.has(s));
    if (missing.length) return { notFound: missing };
    for (const [slug, want] of Object.entries(input.expect ?? {})) {
      const have = rows.get(slug)?.updated_at ?? null;
      if (!sameMs(have, want)) return { conflict: { slug, updatedAt: have } };
    }
    const prev = rows.get(input.into);
    if (!prev || prev.archived_at) {
      // into 가 새로 살아난다: from 중 살아 있는 것은 이번에 보관되므로 그만큼 자리가 난다.
      const freed = from.filter((s) => !rows.get(s)!.archived_at).length;
      if ((await activeCount(c, accountId)) - freed >= MAX_MEMORY_ITEMS_PER_ACCOUNT) return 'too_many';
    }
    const flagged = input.flagReason ? 'now()' : 'null';
    await c.query(
      `insert into agent_memory (account_id, slug, value, description, kind, flagged_at, flag_reason)
       values ($1, $2, $3, nullif($4, ''), coalesce($5, 'topic'), ${flagged}, $6)
       on conflict (account_id, slug) do update set
         value = excluded.value,
         description = case when $7 then excluded.description else agent_memory.description end,
         kind = coalesce($5, agent_memory.kind),
         flagged_at = excluded.flagged_at, flag_reason = excluded.flag_reason,
         archived_at = null, updated_at = now()`,
      [accountId, input.into, input.value, input.description ?? null, input.kind ?? null, input.flagReason ?? null,
        input.description !== undefined],
    );
    // into 가 새 slug 면 "이전 판"이 없다. 그래도 merge 판을 하나 남겨 무엇이 합쳐졌는지 적되, 본문은
    // **지금 쓰는 본문**이므로 걸림 표시도 지금 검사 결과를 따른다 — 깨끗한 판으로 적으면
    // `lastCleanRevision`·restore 가 걸린 글을 깨끗한 것처럼 돌려준다(security F1).
    await c.query(
      `insert into agent_memory_revision (account_id, slug, value, description, updated_at, flagged, reason, detail, kind)
       values ($1, $2, $3, $4, $5, $6, 'merge', $7::jsonb, $8)`,
      [accountId, input.into, prev?.value ?? input.value, prev ? prev.description : (input.description ?? null),
        prev?.updated_at ?? new Date(), prev ? prev.flagged_at !== null : input.flagReason != null,
        JSON.stringify({ from, created: !prev }), prev?.kind ?? input.kind ?? 'topic'],
    );
    if (from.length) {
      await c.query(
        `update agent_memory set archived_at = now(), updated_at = now()
         where account_id = $1 and slug = any($2::text[]) and archived_at is null`,
        [accountId, from],
      );
      await pruneArchived(c, accountId);
    }
    return 'ok';
  }).then(async (r) => {
    if (r === 'ok') await pruneRevisions(pool, accountId, input.into);
    return r;
  });
}

export type RestoreResult = 'ok' | 'not_found' | 'too_many';

/**
 * 이전 판으로 되돌린다. `revisionId` 가 없으면 가장 최근 판. 지금 판은 `reason: 'restore'` 로 남겨
 * 되돌리기 자체도 되돌릴 수 있다. 지워졌던 slug 면 되살아나고(상한 검사), 보관됐던 것이면 풀린다.
 * 걸린 판(080)으로 되돌리면 걸린 채로 살고, 되살리는 본문은 지금 규칙으로 다시 검사한다(`scan`).
 * 지워졌던 journal 은 판에 적힌 kind 로 되살아난다 — topic 이 되어 recall 에 들어가면 안 된다(security L2).
 */
export async function restoreMemory(
  pool: Pool, accountId: string, slug: string, revisionId: number | undefined,
  scan: (value: string, description: string | null) => string | null,
): Promise<RestoreResult> {
  const r = await withTx(pool, async (c) => {
    const rev = await c.query(
      `select id::int as id, value, description, flagged, kind from agent_memory_revision
       where account_id = $1 and slug = $2 ${revisionId !== undefined ? 'and id = $3' : ''}
       order by replaced_at desc, id desc limit 1`,
      revisionId !== undefined ? [accountId, slug, revisionId] : [accountId, slug],
    );
    if (!rev.rowCount) return 'not_found';
    const target = rev.rows[0] as { id: number; value: string; description: string | null; flagged: boolean; kind: MemoryKind | null };
    // 걸린 판은 걸린 채로, 깨끗했던 판도 **지금 규칙**으로 다시 검사한다(security L1) — 옛 판은 검사가
    // 없거나 약하던 때 적힌 것일 수 있다.
    const flagReason = target.flagged ? 'restored flagged revision' : scan(target.value, target.description);
    const cur = (await lockRows(c, accountId, [slug])).get(slug);
    if (!cur || cur.archived_at) {
      if ((await activeCount(c, accountId)) >= MAX_MEMORY_ITEMS_PER_ACCOUNT) return 'too_many';
    }
    if (cur) {
      await c.query(
        `insert into agent_memory_revision (account_id, slug, value, description, updated_at, flagged, reason, detail, kind)
         values ($1, $2, $3, $4, $5, $6, 'restore', $7::jsonb, $8)`,
        [accountId, slug, cur.value, cur.description, cur.updated_at, cur.flagged_at !== null, JSON.stringify({ revisionId: target.id }), cur.kind],
      );
    }
    await c.query(
      `insert into agent_memory (account_id, slug, value, description, kind, flagged_at, flag_reason)
       values ($1, $2, $3, $4, $5, case when $6::text is not null then now() end, $6::text)
       on conflict (account_id, slug) do update set
         value = excluded.value, description = excluded.description,
         kind = excluded.kind,
         flagged_at = excluded.flagged_at, flag_reason = excluded.flag_reason,
         archived_at = null, updated_at = now()`,
      [accountId, slug, target.value, target.description, target.kind ?? cur?.kind ?? 'topic', flagReason],
    );
    return 'ok';
  });
  if (r === 'ok') await pruneRevisions(pool, accountId, slug);
  return r;
}

export interface MemoryLease { holder: string; acquiredAt: Date; expiresAt: Date }
export type LeaseResult = { acquired: true; lease: MemoryLease } | { acquired: false; heldBy: MemoryLease };

/**
 * 정리 임대를 잡는다(계정당 하나). 만료됐거나 **같은 token** 이면 다시 잡힌다(연장). 다른 턴이 들고
 * 있으면 그 사실을 돌려준다 — 강제하지 않는다. 에이전트가 물러나는 것이 규칙이고, 서버는 사실만 적는다.
 */
export async function acquireMemoryLease(
  pool: Pool, accountId: string, token: string, minutes: number,
): Promise<LeaseResult> {
  const res = await pool.query(
    `insert into memory_lease (account_id, holder, acquired_at, expires_at)
     values ($1, $2, now(), now() + make_interval(mins => $3::int))
     on conflict (account_id) do update set
       holder = excluded.holder, acquired_at = now(), expires_at = excluded.expires_at
       where memory_lease.expires_at < now() or memory_lease.holder = excluded.holder
     returning holder, acquired_at as "acquiredAt", expires_at as "expiresAt"`,
    [accountId, token, minutes],
  );
  if (res.rowCount) return { acquired: true, lease: res.rows[0] as MemoryLease };
  const cur = await memoryLeaseStatus(pool, accountId);
  // 잡기와 조회 사이에 만료·해제됐으면 한 번 더 — 그래도 없으면 잡힌 셈이다.
  if (!cur) return acquireMemoryLease(pool, accountId, token, minutes);
  return { acquired: false, heldBy: cur };
}

/** 지금 유효한 임대(없거나 만료면 null). */
export async function memoryLeaseStatus(pool: Pool, accountId: string): Promise<MemoryLease | null> {
  const res = await pool.query(
    `select holder, acquired_at as "acquiredAt", expires_at as "expiresAt" from memory_lease
     where account_id = $1 and expires_at >= now()`,
    [accountId],
  );
  return res.rowCount ? (res.rows[0] as MemoryLease) : null;
}

/** token 이 맞을 때만 놓는다. 남의 임대는 못 놓는다 — 놓였으면 true. */
export async function releaseMemoryLease(pool: Pool, accountId: string, token: string): Promise<boolean> {
  const res = await pool.query(`delete from memory_lease where account_id = $1 and holder = $2`, [accountId, token]);
  return (res.rowCount ?? 0) > 0;
}
