/**
 * 스레드 계획판(Thread Plan) P1 — 저장·조회·연결 진행률·이벤트(마이그레이션 158).
 *
 * 판정(검증·파생 상태·진행률)은 shared `planGraph.ts` 하나가 한다. 여기는 그것을 DB 와 권한에 잇는다.
 *
 * 연결 맵을 두 가지로 만든다(설계 N1):
 * - **보는 사람 기준**(`linkedFor(..., viewerId)`): 화면 응답(GET)만 쓴다. 자식 채널을 못 보거나 자식 글이 없으면
 *   둘 다 `'hidden'` — 없는 스레드와 볼 수 없는 스레드가 똑같이 보여야 있다는 사실이 새지 않는다.
 * - **서버 기준**(`linkedFor(..., null)`): 서버가 판정할 때(2차의 nowReady·알림) 쓴다. 권한으로 거르지 않는다.
 *   쓰는 이가 자식 스레드를 볼 수 있는지는 쓸 때 막는다(`linked_thread_unavailable`) — 그래서 도구 응답에
 *   서버 기준 판정이 실려도 쓴 이가 못 보는 스레드의 진척은 섞이지 않는다.
 */
import type { Pool, PoolClient } from 'pg';
import {
  derivePlan, planProgress, validatePlan,
  type LinkedProgress, type PlanDoc, type PlanProgress, type PlanValidationError, type ThreadPlanLinkedView, type ThreadPlanView,
} from '@harkroom/shared';
import { emitEvent } from '../events.js';
import { audienceFor, channelVisibleSql } from './channels.js';
import { scanWrite } from './contentScan.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ThreadPlanRow {
  rootId: string;
  channelId: string;
  doc: PlanDoc;
  rev: number;
  flagReason: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

type Queryable = Pick<Pool, 'query'> | PoolClient;

function toRow(r: {
  root_id: string; channel_id: string; doc: PlanDoc; rev: number; flag_reason: string | null; updated_by: string | null; updated_at: Date;
}): ThreadPlanRow {
  return {
    rootId: r.root_id, channelId: r.channel_id, doc: r.doc, rev: r.rev,
    flagReason: r.flag_reason, updatedBy: r.updated_by, updatedAt: r.updated_at,
  };
}

export async function getThreadPlan(pool: Queryable, rootId: string): Promise<ThreadPlanRow | null> {
  const res = await pool.query(
    `select root_id, channel_id, doc, rev, flag_reason, updated_by, updated_at from thread_plan where root_id = $1`,
    [rootId],
  );
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

/** 계획에 연결된 자식 스레드 id 들(그룹 순서, 중복 없음). */
export function linkedRoots(doc: PlanDoc): string[] {
  const out: string[] = [];
  for (const g of doc.groups) if (g.linkedRootId && !out.includes(g.linkedRootId)) out.push(g.linkedRootId);
  return out;
}

interface ChildFacts {
  rootId: string;
  /** 자식 루트 글이 (지워지지 않고) 있다. */
  exists: boolean;
  channelId: string | null;
  /** viewerId 가 있을 때만 뜻이 있다. */
  visible: boolean;
  /** 자식 계획의 진행률(1단 합침 — 자식의 연결 그룹은 다시 풀지 않는다). 계획이 없으면 null. */
  progress: PlanProgress | null;
}

async function childFacts(pool: Queryable, roots: string[], viewerId: string | null): Promise<Map<string, ChildFacts>> {
  const out = new Map<string, ChildFacts>();
  if (!roots.length) return out;
  const res = await pool.query(
    `select m.id, m.channel_id, p.doc,
            ${viewerId ? channelVisibleSql('c', '$2') : 'true'} as visible
       from message m
       join channel c on c.id = m.channel_id
       left join thread_plan p on p.root_id = m.id
      where m.id = any($1::uuid[]) and m.deleted_at is null and m.thread_root_id is null`,
    viewerId ? [roots, viewerId] : [roots],
  );
  for (const r of res.rows as { id: string; channel_id: string; doc: PlanDoc | null; visible: boolean }[]) {
    out.set(r.id, {
      rootId: r.id, exists: true, channelId: r.channel_id, visible: Boolean(r.visible),
      // 재귀하지 않는다(K5): 자식의 연결 그룹은 자식이 받은 맵 없이 센다 — 「아직 계획 없음」으로 읽힌다.
      progress: r.doc ? planProgress(r.doc) : null,
    });
  }
  for (const id of roots) {
    if (!out.has(id)) out.set(id, { rootId: id, exists: false, channelId: null, visible: false, progress: null });
  }
  return out;
}

const ZERO: PlanProgress = { done: 0, total: 0, active: 0, blocked: 0, waiting: 0 };

/**
 * 연결 맵. `viewerId` 가 있으면 보는 사람 기준(없거나 못 보면 'hidden'), null 이면 서버 기준(거르지 않음 —
 * 없는 자식은 「아직 계획 없음」).
 */
export async function linkedFor(pool: Queryable, doc: PlanDoc, viewerId: string | null): Promise<{
  map: LinkedProgress; views: ThreadPlanLinkedView[];
}> {
  const facts = await childFacts(pool, linkedRoots(doc), viewerId);
  const map = new Map<string, PlanProgress | 'hidden'>();
  for (const f of facts.values()) {
    const hidden = viewerId !== null && (!f.exists || !f.visible);
    map.set(f.rootId, hidden ? 'hidden' : (f.progress ?? ZERO));
  }
  const views: ThreadPlanLinkedView[] = [];
  for (const g of doc.groups) {
    if (!g.linkedRootId) continue;
    const v = map.get(g.linkedRootId);
    const f = facts.get(g.linkedRootId);
    views.push(v === 'hidden' || !v
      ? { groupId: g.id, rootId: g.linkedRootId, hidden: true, channelId: null, progress: null }
      : { groupId: g.id, rootId: g.linkedRootId, hidden: false, channelId: f?.channelId ?? null, progress: v });
  }
  return { map, views };
}

/** 화면 응답. 파생 상태·진행률은 보는 사람 기준 맵으로 센다. */
export async function threadPlanView(pool: Pool, row: ThreadPlanRow, viewerId: string): Promise<ThreadPlanView> {
  const { map, views } = await linkedFor(pool, row.doc, viewerId);
  return {
    rootId: row.rootId,
    channelId: row.channelId,
    doc: row.doc,
    rev: row.rev,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    flagged: row.flagReason ? { reason: row.flagReason } : null,
    derived: derivePlan(row.doc, map),
    progress: planProgress(row.doc, map),
    linked: views,
  };
}

/** 쓰기 거절. shared 의 검증 거절에 서버만 아는 둘을 더한다. */
export type ThreadPlanWriteError =
  | PlanValidationError
  /** 계획이 이미 있는데 `ifUpdatedAt` 없이 덮으려 했다 — 다른 에이전트가 세운 단계가 날아간다. */
  | { code: 'guard_required'; updatedAt: string; rev: number }
  | { code: 'conflict'; updatedAt: string | null; rev: number | null }
  /** linkedRootId 가 uuid 꼴이 아니다. */
  | { code: 'invalid_linked_root'; id: string }
  /** 자기 스레드를 가리켰다(A→A). */
  | { code: 'self_link'; id: string }
  /** 연결할 스레드가 없거나 쓰는 이가 볼 수 없다 — 둘을 가르지 않는다(있다는 사실을 새지 않는다). 답글 id 도 이것이다. */
  | { code: 'linked_thread_unavailable'; id: string };

export type ThreadPlanWriteResult =
  | { ok: true; row: ThreadPlanRow; flagged: { reason: string; rules: string[] } | null }
  | { ok: false; error: ThreadPlanWriteError };

/** 쓰기 검사(080)에 넣을 글 — 사람이 읽고 러너가 싣는 칸 전부. */
function planTexts(doc: PlanDoc): string[] {
  return [
    doc.goal, doc.next ?? '', doc.blocked ?? '',
    ...doc.groups.map((g) => g.title),
    ...doc.steps.flatMap((s) => [s.title, s.blockedReason ?? '']),
  ];
}

/**
 * 계획 전체를 쓴다(`doc` 이 null 이면 지운다).
 *
 * - 저장 전에 `validatePlan` 을 **반드시** 지난다. 꼴 검사(필드 타입·state 값)는 부르는 쪽(P2 도구 스키마)이 먼저 한다.
 * - 계획이 이미 있으면 `guard`(읽은 updatedAt)가 필수다. 없던 계획은 `guard.updatedAt: null` 이거나 guard 없이 쓴다.
 * - `actorId` 는 쓰는 계정. 연결할 스레드를 그 계정이 볼 수 있어야 한다. 2차 자동 갱신은 null 로 부른다(권한 검사 없음).
 */
export async function setThreadPlan(
  pool: Pool,
  input: { rootId: string; channelId: string; doc: PlanDoc | null; guard?: { updatedAt: Date | null }; actorId: string | null },
): Promise<ThreadPlanWriteResult | { ok: true; deleted: true }> {
  const { rootId, channelId, doc, guard, actorId } = input;
  if (doc) {
    const v = validatePlan(doc);
    if (!v.ok) return { ok: false, error: v.error };
    for (const id of linkedRoots(doc)) {
      if (!UUID_RE.test(id)) return { ok: false, error: { code: 'invalid_linked_root', id } };
      if (id.toLowerCase() === rootId.toLowerCase()) return { ok: false, error: { code: 'self_link', id } };
    }
    const facts = await childFacts(pool, linkedRoots(doc), actorId);
    for (const f of facts.values()) {
      if (!f.exists || (actorId !== null && !f.visible)) return { ok: false, error: { code: 'linked_thread_unavailable', id: f.rootId } };
    }
  }
  const flag = doc ? scanWrite(...planTexts(doc)) : null;

  const client = await pool.connect();
  let result: ThreadPlanWriteResult | { ok: true; deleted: true };
  try {
    await client.query('begin');
    const cur = await client.query(`select updated_at, rev from thread_plan where root_id = $1 for update`, [rootId]);
    const now = cur.rows[0] as { updated_at: Date; rev: number } | undefined;
    if (now && !guard) {
      await client.query('rollback');
      return { ok: false, error: { code: 'guard_required', updatedAt: now.updated_at.toISOString(), rev: now.rev } };
    }
    if (guard && (guard.updatedAt?.getTime() ?? null) !== (now?.updated_at.getTime() ?? null)) {
      await client.query('rollback');
      return { ok: false, error: { code: 'conflict', updatedAt: now?.updated_at.toISOString() ?? null, rev: now?.rev ?? null } };
    }
    if (!doc) {
      await client.query(`delete from thread_plan where root_id = $1`, [rootId]);
      await client.query('commit');
      result = { ok: true, deleted: true };
    } else {
      const res = await client.query(
        `insert into thread_plan (root_id, channel_id, doc, flag_reason, updated_by) values ($1, $2, $3::jsonb, $4, $5)
         on conflict (root_id) do update
           set doc = excluded.doc, flag_reason = excluded.flag_reason, updated_by = excluded.updated_by,
               rev = thread_plan.rev + 1,
               updated_at = greatest(now(), thread_plan.updated_at + interval '1 millisecond')
         returning root_id, channel_id, doc, rev, flag_reason, updated_by, updated_at`,
        [rootId, channelId, JSON.stringify(doc), flag?.reason ?? null, actorId],
      );
      // 역참조는 doc 에서 다시 만든다 — 정본은 doc 하나다.
      await client.query(`delete from thread_plan_link where parent_root = $1`, [rootId]);
      const roots = linkedRoots(doc);
      if (roots.length) {
        await client.query(
          `insert into thread_plan_link (parent_root, child_root) select $1, unnest($2::uuid[]) on conflict do nothing`,
          [rootId, roots],
        );
      }
      await client.query('commit');
      result = { ok: true, row: toRow(res.rows[0]), flagged: flag ? { reason: flag.reason, rules: flag.rules } : null };
    }
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await emitPlanChanged(pool, channelId, rootId, 'row' in result ? result.row : null);
  return result;
}

/**
 * `thread.plan.changed` 를 낸다. progress 는 연결 그룹이 없는 계획에만 싣는다 — 연결 진행률은 보는 사람마다 다르므로
 * 채널 청중 전원에게 한 값을 보내면 비공개 자식의 진척이 샌다(security P1 조건 3). 그때는 null 이고 화면이 GET 으로 다시 읽는다.
 */
export async function emitPlanChanged(pool: Pool, channelId: string, rootId: string, row: ThreadPlanRow | null): Promise<void> {
  const progress = row && linkedRoots(row.doc).length === 0 ? planProgress(row.doc) : null;
  emitEvent({
    type: 'thread.plan.changed', channelId, rootId, rev: row?.rev ?? null, progress,
    audience: await audienceFor(pool, channelId),
  });
}
