/**
 * 스레드 계획판(Thread Plan) P1 — 저장·조회·연결 진행률·이벤트(마이그레이션 158).
 *
 * 판정(검증·파생 상태·진행률)은 shared `planGraph.ts` 하나가 한다. 여기는 그것을 DB 와 권한에 잇는다.
 *
 * 연결 맵은 **받는 쪽 기준**으로만 만든다(설계 R2) — 판정 결과는 결국 누군가에게 전달되므로, 거르지 않은 맵으로 센
 * 「이제 시작 가능」은 못 보는 자식 스레드가 끝났다는 사실을 거꾸로 알려 준다.
 * - **개인 맵**(`{ viewer }`): GET·도구 응답·프롬프트. 자식 글이 없거나 그 채널을 못 보면 `'hidden'` — 없는 스레드와
 *   못 보는 스레드가 똑같이 보인다.
 * - **청중 맵**(`{ audience: 부모 채널 }`): 이벤트·2차 시스템 줄·목록 칩처럼 부모 채널 청중 전원에게 한 값으로 가는 자리.
 *   자식이 public standard 채널이거나 부모와 같은 채널일 때만 보이고, 그 밖은 `'hidden'`.
 * 거르지 않은 사실은 쓸 때의 존재 확인에만 쓰고 밖으로 내지 않는다.
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
  /** 자식 채널이 public standard 다(누구나 본다). */
  publicChannel: boolean;
  /** viewerId 를 줬을 때 그 사람이 자식 채널을 보는가. 주지 않았으면 false. */
  viewerVisible: boolean;
  /** 자식 계획의 진행률(1단 합침 — 자식의 연결 그룹은 다시 풀지 않는다). 계획이 없으면 null. */
  progress: PlanProgress | null;
}

async function childFacts(db: Queryable, roots: string[], viewerId: string | null): Promise<Map<string, ChildFacts>> {
  const out = new Map<string, ChildFacts>();
  if (!roots.length) return out;
  const res = await db.query(
    `select m.id, m.channel_id, p.doc,
            (c.kind = 'standard' and c.visibility = 'public') as public_channel,
            ${viewerId ? channelVisibleSql('c', '$2') : 'false'} as viewer_visible
       from message m
       join channel c on c.id = m.channel_id
       left join thread_plan p on p.root_id = m.id
      where m.id = any($1::uuid[]) and m.deleted_at is null and m.thread_root_id is null`,
    viewerId ? [roots, viewerId] : [roots],
  );
  for (const r of res.rows as { id: string; channel_id: string; doc: PlanDoc | null; public_channel: boolean; viewer_visible: boolean }[]) {
    out.set(r.id, {
      rootId: r.id, exists: true, channelId: r.channel_id,
      publicChannel: Boolean(r.public_channel), viewerVisible: Boolean(r.viewer_visible),
      // 재귀하지 않는다(K5): 자식의 연결 그룹은 맵 없이 센다 — 「아직 계획 없음」으로 읽힌다.
      progress: r.doc ? planProgress(r.doc) : null,
    });
  }
  for (const id of roots) {
    if (!out.has(id)) out.set(id, { rootId: id, exists: false, channelId: null, publicChannel: false, viewerVisible: false, progress: null });
  }
  return out;
}

const ZERO: PlanProgress = { done: 0, total: 0, active: 0, blocked: 0, waiting: 0 };

/** 누구에게 갈 결과인가. 개인(그 사람 권한) 또는 부모 채널 청중(전원에게 한 값). */
export type LinkedAudience = { viewer: string } | { audience: string };

/** 연결 맵 — 받는 쪽 기준(파일 머리 주석). 못 보거나 없는 자식은 `'hidden'`. */
export async function linkedFor(db: Queryable, doc: PlanDoc, to: LinkedAudience): Promise<{
  map: LinkedProgress; views: ThreadPlanLinkedView[];
}> {
  const facts = await childFacts(db, linkedRoots(doc), 'viewer' in to ? to.viewer : null);
  const map = new Map<string, PlanProgress | 'hidden'>();
  for (const f of facts.values()) {
    const visible = f.exists && ('viewer' in to ? f.viewerVisible : (f.publicChannel || f.channelId === to.audience));
    map.set(f.rootId, visible ? (f.progress ?? ZERO) : 'hidden');
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
  const { map, views } = await linkedFor(pool, row.doc, { viewer: viewerId });
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
  /**
   * **새로 더한** 연결 스레드가 없거나 쓰는 이가 볼 수 없다 — 둘을 가르지 않는다(있다는 사실을 새지 않는다). 답글 id 도
   * 이것이다. 이미 있던 연결은 다시 묻지 않는다(R1) — 남이 건 연결 때문에 다른 단계를 못 고치면 안 된다.
   */
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
  }
  const flag = doc ? scanWrite(...planTexts(doc)) : null;

  const client = await pool.connect();
  let result: ThreadPlanWriteResult | { ok: true; deleted: true };
  try {
    await client.query('begin');
    const cur = await client.query(`select updated_at, rev, doc from thread_plan where root_id = $1 for update`, [rootId]);
    const now = cur.rows[0] as { updated_at: Date; rev: number; doc: PlanDoc } | undefined;
    if (now && !guard) {
      await client.query('rollback');
      return { ok: false, error: { code: 'guard_required', updatedAt: now.updated_at.toISOString(), rev: now.rev } };
    }
    if (guard && (guard.updatedAt?.getTime() ?? null) !== (now?.updated_at.getTime() ?? null)) {
      await client.query('rollback');
      return { ok: false, error: { code: 'conflict', updatedAt: now?.updated_at.toISOString() ?? null, rev: now?.rev ?? null } };
    }
    if (doc) {
      // 잠근 판과 견줘 새로 더한 연결만 묻는다(R1). 2차 자동 갱신(actorId null)은 존재만 본다.
      const before = new Set(now ? linkedRoots(now.doc).map((id) => id.toLowerCase()) : []);
      const added = linkedRoots(doc).filter((id) => !before.has(id.toLowerCase()));
      const facts = await childFacts(client, added, actorId);
      for (const f of facts.values()) {
        if (!f.exists || (actorId !== null && !f.viewerVisible)) {
          await client.query('rollback');
          return { ok: false, error: { code: 'linked_thread_unavailable', id: f.rootId } };
        }
      }
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
 * `thread.plan.changed` 를 낸다. progress 는 **청중 맵**으로 센다(R2) — 부모 채널 청중 전원에게 한 값으로 가므로, 그 청중이
 * 다 볼 수 있는 자식(public standard 이거나 같은 채널)만 열고 나머지는 hidden 으로 센다. 계획이 지워졌으면 rev·progress 가 null.
 */
export async function emitPlanChanged(pool: Pool, channelId: string, rootId: string, row: ThreadPlanRow | null): Promise<void> {
  let progress: PlanProgress | null = null;
  if (row) {
    const { map } = await linkedFor(pool, row.doc, { audience: channelId });
    progress = planProgress(row.doc, map);
  }
  emitEvent({
    type: 'thread.plan.changed', channelId, rootId, rev: row?.rev ?? null, progress,
    audience: await audienceFor(pool, channelId),
  });
}
