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
  type LinkedProgress, type PlanDoc, type PlanProgress, type PlanValidationError, type ThreadPlanAuto, type ThreadPlanLinkedView, type ThreadPlanView,
} from '@harkroom/shared';
import { emitEvent } from '../events.js';
import { assertChannelVisible, audienceFor, channelVisibleSql } from './channels.js';
import { threadRootChannel } from './threadNote.js';
import { scanWrite } from './contentScan.js';
import { planSeq } from './threadPlanItem.js';
import { noticePlanAutoOff } from './threadPlanAuto.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ThreadPlanRow {
  rootId: string;
  channelId: string;
  doc: PlanDoc;
  rev: number;
  flagReason: string | null;
  updatedBy: string | null;
  updatedAt: Date;
  /** 자동 진행(`threadPlanAuto.ts`). 꺼져 있으면 `null`. */
  auto: ThreadPlanAuto | null;
}

type Queryable = Pick<Pool, 'query'> | PoolClient;

export const THREAD_PLAN_COLUMNS = 'root_id, channel_id, doc, rev, flag_reason, updated_by, updated_at, auto_until, auto_source, auto_by, auto_at';

export function toRow(r: {
  auto_until: string | null; auto_source: string | null; auto_by: string | null; auto_at: Date | null;
  root_id: string; channel_id: string; doc: PlanDoc; rev: number; flag_reason: string | null; updated_by: string | null; updated_at: Date;
}): ThreadPlanRow {
  return {
    rootId: r.root_id, channelId: r.channel_id, doc: r.doc, rev: r.rev,
    flagReason: r.flag_reason, updatedBy: r.updated_by, updatedAt: r.updated_at,
    auto: r.auto_until && r.auto_at
      ? { until: r.auto_until, sourceMessageId: r.auto_source, by: r.auto_by, at: r.auto_at.toISOString() }
      : null,
  };
}

export async function getThreadPlan(pool: Queryable, rootId: string): Promise<ThreadPlanRow | null> {
  const res = await pool.query(
    `select ${THREAD_PLAN_COLUMNS} from thread_plan where root_id = $1`,
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
    auto: row.auto,
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
  | { code: 'linked_thread_unavailable'; id: string }
  /** 관리 에이전트로 적은 계정이 에이전트가 아니거나 그 채널을 볼 수 없다. */
  | { code: 'invalid_manager'; id: string };

/** 스레드·권한 거절(S1). 셋 다 서비스가 rootId 에서 직접 판정한다 — 부르는 쪽이 준 채널을 믿지 않는다. */
export type ThreadPlanAccessError =
  | { code: 'not_found' }
  /** 답글 id 를 줬다 — 스레드 루트 글의 id 여야 한다. */
  | { code: 'not_root' }
  /** 쓰는 이가 그 스레드의 채널을 못 본다. */
  | { code: 'forbidden' };

export type ThreadPlanWriteResult =
  | {
    ok: true; row: ThreadPlanRow; flagged: { reason: string; rules: string[] } | null;
    /** 바꾸기 전 판(없던 계획이면 null). 도구가 nowReady·nowWaiting 을 세는 데 쓴다. */
    before: PlanDoc | null;
  }
  | { ok: false; error: ThreadPlanWriteError | ThreadPlanAccessError };

/**
 * 누가 쓰는가(S2). 계정이 쓰면 그 계정 권한으로 스레드·새 연결을 확인한다. `system` 은 2차 자동 갱신만 쓴다 —
 * null 하나로 두면 도구 경로에서 id 가 빠졌을 때 권한 검사가 조용히 꺼진다.
 */
export type PlanActor = { accountId: string } | { system: true };

/** 쓰기 검사(080)에 넣을 글 — 사람이 읽고 러너가 싣는 칸 전부. */
function planTexts(doc: PlanDoc): string[] {
  return [
    doc.goal, doc.next ?? '', doc.blocked ?? '',
    ...doc.groups.map((g) => g.title),
    ...doc.steps.flatMap((s) => [s.title, s.blockedReason ?? '']),
  ];
}

/** 잠근 판을 받아 새 판을 만든다. null 이면 지운다. 거절이면 그 코드. */
export type PlanBuild<E> = (prev: { doc: PlanDoc; rev: number; updatedAt: Date } | null) =>
  { doc: PlanDoc | null } | { error: E };

/**
 * 계획 쓰기의 **한 경로**(N5). 전체 쓰기(`setThreadPlan`)와 항목 쓰기(`thread.plan.item`)가 모두 이것을 지난다 —
 * 새 연결만 확인하는 diff(R1)·검증·쓰기 검사·link 재작성이 두 벌이 되지 않게.
 *
 * 순서: 스레드·권한(S1) → 잠금(for update) → `build(잠근 판)` → `validatePlan` → 연결 꼴 → 새 연결 확인 → 저장 → commit 뒤 이벤트.
 */
export async function writeThreadPlan<E extends { code: string }>(
  pool: Pool, rootId: string, actor: PlanActor, build: PlanBuild<E>,
): Promise<ThreadPlanWriteResult | { ok: true; deleted: true; before: PlanDoc | null } | { ok: false; error: E }> {
  const root = await threadRootChannel(pool, rootId);
  if (root === 'not_found' || root === 'not_root') return { ok: false, error: { code: root } };
  const channelId = root.channelId;
  const accountId = 'accountId' in actor ? actor.accountId : null;
  if (accountId !== null && !(await assertChannelVisible(pool, channelId, accountId))) {
    return { ok: false, error: { code: 'forbidden' } };
  }

  const client = await pool.connect();
  let result: ThreadPlanWriteResult | { ok: true; deleted: true; before: PlanDoc | null };
  let fail: { ok: false; error: ThreadPlanWriteError | E } | null = null;
  let managerChanged = false;
  let autoOff: { row: ThreadPlanRow; previousManager: string | null } | null = null;
  try {
    await client.query('begin');
    const cur = await client.query(`select updated_at, rev, doc from thread_plan where root_id = $1 for update`, [rootId]);
    const now = cur.rows[0] as { updated_at: Date; rev: number; doc: PlanDoc } | undefined;
    const built = build(now ? { doc: now.doc, rev: now.rev, updatedAt: now.updated_at } : null);
    // 번호표(seq)는 서버가 정한다 — 입력(zod)으로는 받지 않고, 앞 판과 새 판에서 다시 센다(R1).
    let doc: PlanDoc | null = 'error' in built || !built.doc ? null : { ...built.doc, seq: planSeq(now?.doc ?? null, built.doc) };
    if (doc) {
      const before = now?.doc.managerId ?? null;
      // 칸을 모르는 쓰기(undefined)가 관리 에이전트를 지우지 않는다. 비우는 것은 null 을 적었을 때뿐이다.
      let manager = doc.managerId === undefined ? before : doc.managerId;
      // 처음 세운 에이전트가 기본 관리자다. 사람이 세우면 비운다.
      if (!now && !manager && accountId !== null) {
        const kind = await client.query<{ kind: string }>(`select kind from account where id = $1`, [accountId]);
        if (kind.rows[0]?.kind === 'agent') manager = accountId;
      }
      const { managerId: _drop, ...rest } = doc;
      doc = manager ? { ...rest, managerId: manager } : rest;
      // 관리 에이전트가 바뀌면 자동 진행을 끈다 — 남이 켠 자동 진행과 그 사람의 위임을 이어받지 못하게.
      if (now && manager !== before) managerChanged = true;
      if (manager && manager !== before) {
        const eligible = await client.query(
          `select 1 from account a join channel c on c.id = $2
            where a.id = $1 and a.kind = 'agent' and a.deleted_at is null and ${channelVisibleSql('c', '$1')}`,
          [manager, channelId],
        );
        if (!eligible.rowCount) fail = { ok: false, error: { code: 'invalid_manager', id: manager } };
      }
    }
    if ('error' in built) {
      fail = { ok: false, error: built.error };
    } else if (doc && !fail) {
      const v = validatePlan(doc);
      if (!v.ok) fail = { ok: false, error: v.error };
      for (const id of fail ? [] : linkedRoots(doc)) {
        if (!UUID_RE.test(id)) { fail = { ok: false, error: { code: 'invalid_linked_root', id } }; break; }
        if (id.toLowerCase() === rootId.toLowerCase()) { fail = { ok: false, error: { code: 'self_link', id } }; break; }
      }
      if (!fail) {
        // 잠근 판과 견줘 새로 더한 연결만 묻는다(R1). system 은 존재만 본다.
        const beforeSet = new Set(now ? linkedRoots(now.doc).map((id) => id.toLowerCase()) : []);
        const added = linkedRoots(doc).filter((id) => !beforeSet.has(id.toLowerCase()));
        const facts = await childFacts(client, added, accountId);
        for (const f of facts.values()) {
          if (!f.exists || (accountId !== null && !f.viewerVisible)) {
            fail = { ok: false, error: { code: 'linked_thread_unavailable', id: f.rootId } };
            break;
          }
        }
      }
    }
    if (fail) {
      await client.query('rollback');
      return fail as { ok: false; error: E };
    }
    if (!doc) {
      await client.query(`delete from thread_plan where root_id = $1`, [rootId]);
      await client.query('commit');
      result = { ok: true, deleted: true, before: now?.doc ?? null };
    } else {
      const flag = scanWrite(...planTexts(doc));
      const res = await client.query(
        `insert into thread_plan (root_id, channel_id, doc, flag_reason, updated_by) values ($1, $2, $3::jsonb, $4, $5)
         on conflict (root_id) do update
           set doc = excluded.doc, flag_reason = excluded.flag_reason, updated_by = excluded.updated_by,
               rev = thread_plan.rev + 1,
               updated_at = greatest(now(), thread_plan.updated_at + interval '1 millisecond')
         returning ${THREAD_PLAN_COLUMNS}`,
        [rootId, channelId, JSON.stringify(doc), flag?.reason ?? null, accountId],
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
      let written = toRow(res.rows[0]);
      if (managerChanged && written.auto) {
        const cleared = await client.query(
          `update thread_plan
              set auto_until = null, auto_source = null, auto_by = null, auto_mandate = null, auto_at = null, auto_woken = '{}'::jsonb, auto_range = '{}'::jsonb
            where root_id = $1 returning ${THREAD_PLAN_COLUMNS}`, [rootId]);
        written = toRow(cleared.rows[0]);
        autoOff = { row: written, previousManager: now?.doc.managerId ?? null };
      }
      await client.query('commit');
      result = {
        ok: true, row: written, flagged: flag ? { reason: flag.reason, rules: flag.rules } : null, before: now?.doc ?? null,
      };
    }
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await emitPlanChanged(pool, channelId, rootId, 'row' in result ? result.row : null);
  if (autoOff) {
    const off = autoOff as { row: ThreadPlanRow; previousManager: string | null };
    await noticePlanAutoOff(pool, off.row, [accountId, off.row.doc.managerId, off.previousManager], 'manager_changed');
  }
  return result;
}

/**
 * 계획 전체를 쓴다(`doc` 이 null 이면 지운다).
 *
 * - 저장 전에 `validatePlan` 을 **반드시** 지난다. 꼴 검사(필드 타입·state 값)는 부르는 쪽(도구 스키마)이 먼저 한다.
 * - 계획이 이미 있으면 `guard`(읽은 updatedAt)가 필수다. 없던 계획은 `guard.updatedAt: null` 이거나 guard 없이 쓴다.
 */
export async function setThreadPlan(
  pool: Pool,
  input: { rootId: string; doc: PlanDoc | null; guard?: { updatedAt: Date | null }; actor: PlanActor },
) {
  const { guard, doc } = input;
  return writeThreadPlan<ThreadPlanWriteError>(pool, input.rootId, input.actor, (now) => {
    if (now && !guard) return { error: { code: 'guard_required', updatedAt: now.updatedAt.toISOString(), rev: now.rev } };
    if (guard && (guard.updatedAt?.getTime() ?? null) !== (now?.updatedAt.getTime() ?? null)) {
      return { error: { code: 'conflict', updatedAt: now?.updatedAt.toISOString() ?? null, rev: now?.rev ?? null } };
    }
    return { doc };
  });
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

/**
 * 채널 목록 행(루트)에 `planProgress` 를 붙인다(P5). 청중 맵으로 센다 — 같은 행이 채널 청중 전원에게 같은 값으로 간다.
 * 읽을 때 세므로 자식 스레드가 바뀌어도 다음 목록 읽기에는 맞는 값이다(실시간 반영은 2차 구독기).
 * 답글·지워진 행은 손대지 않는다(키 없음 = 모른다). 계획 없는 루트는 null.
 *
 * 쿼리는 늘 최대 둘이다(R1): 페이지의 계획 한 번, 그 계획들이 연결한 자식 전부를 한 번. `listMessages` 는 서버에서 가장
 * 자주 도는 경로라 연결 계획마다 왕복을 더하지 않는다. 청중 판정(public 이거나 같은 채널)은 계획별로 메모리에서 한다 —
 * `linkedFor(doc, {audience})` 와 같은 술어다.
 */
export async function attachPlanProgress<T extends { id: string; channelId: string; threadRootId: string | null; deletedAt?: unknown }>(
  db: Queryable, rows: T[],
): Promise<T[]> {
  const roots = rows.filter((r) => r.threadRootId === null && !r.deletedAt);
  if (!roots.length) return rows;
  const res = await db.query(
    `select root_id, channel_id, doc, rev, updated_at from thread_plan where root_id = any($1::uuid[])`,
    [roots.map((r) => r.id)],
  );
  const plans = new Map((res.rows as { root_id: string; channel_id: string; doc: PlanDoc; rev: number; updated_at: Date }[]).map((r) => [r.root_id, r]));
  const allChildren = [...new Set([...plans.values()].flatMap((p) => linkedRoots(p.doc)))];
  const facts = await childFacts(db, allChildren, null);
  for (const r of roots) {
    const p = plans.get(r.id);
    if (!p) {
      (r as T & { planProgress?: unknown }).planProgress = null;
      continue;
    }
    const map = new Map<string, PlanProgress | 'hidden'>();
    for (const id of linkedRoots(p.doc)) {
      const f = facts.get(id);
      const visible = !!f && f.exists && (f.publicChannel || f.channelId === p.channel_id);
      map.set(id, visible ? (f!.progress ?? ZERO) : 'hidden');
    }
    (r as T & { planProgress?: unknown }).planProgress = { ...planProgress(p.doc, map), rev: p.rev, updatedAt: p.updated_at.toISOString() };
  }
  return rows;
}
