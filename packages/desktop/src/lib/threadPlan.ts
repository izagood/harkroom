/**
 * 스레드 계획판(P4·P5) 화면 판정 — 순수 함수만. 파생 상태는 서버가 준 `derived` 를 그대로 쓴다
 * (architect D-c: 앱에서 `derivePlan` 을 다시 돌리지 않는다 — 권한으로 거른 연결 맵은 서버만 안다).
 */
import type { PlanDerivedState, PlanDoc, PlanGroup, PlanProgress, ThreadPlanView } from '@harkroom/shared';

/** 칩·띠의 색. 막힘만 빨강(D2) — 나머지는 진행 중/끝남 무채색 결이다. */
export type PlanTone = 'blocked' | 'done' | 'active' | 'empty';

export function planTone(p: PlanProgress | null | undefined): PlanTone {
  if (!p || p.total === 0) return 'empty';
  if (p.blocked > 0) return 'blocked';
  if (p.done >= p.total) return 'done';
  return 'active';
}

/** 24시간 넘게 안 고친 판은 「낡았을 수 있음」(D3). 시각을 못 읽으면 낡지 않은 것으로 본다. */
export const PLAN_STALE_MS = 24 * 60 * 60 * 1000;
export function isPlanStale(updatedAt: string, now: number): boolean {
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) && now - t > PLAN_STALE_MS;
}

const PILL_RANK: Record<PlanDerivedState, number> = { blocked: 0, active: 1, ready: 2, waiting: 3, hidden: 4, done: 5 };

/** 그룹 하나의 진행 수. 연결 그룹은 서버가 준 자식 진행률(개인 맵), 볼 수 없으면 null. */
export function groupCount(plan: ThreadPlanView, g: PlanGroup): { done: number; total: number } | null {
  if (g.linkedRootId) {
    const l = plan.linked.find((x) => x.groupId === g.id);
    return l && !l.hidden && l.progress ? { done: l.progress.done, total: l.progress.total } : null;
  }
  const steps = plan.doc.steps.filter((s) => s.groupId === g.id);
  return { done: steps.filter((s) => plan.derived[s.id]?.derived === 'done').length, total: steps.length };
}

export interface PlanPill { id: string; title: string; state: PlanDerivedState; count: { done: number; total: number } | null }

/**
 * 띠의 그룹 알약(D7) — 막힘 먼저, 그다음 진행·시작 가능·대기·끝남. 같은 순위는 문서 순서.
 * 그룹이 넷 이상이면 알약 대신 개수 요약(`summary`)을 쓴다.
 */
export function planPills(plan: ThreadPlanView): {
  pills: PlanPill[];
  summary: { groups: number; active: number; blocked: number; firstBlocked: string | null } | null;
} {
  const all = plan.doc.groups.map((g, i) => ({
    id: g.id, title: g.title, state: plan.derived[g.id]?.derived ?? 'waiting', count: groupCount(plan, g), i,
  }));
  all.sort((a, b) => PILL_RANK[a.state] - PILL_RANK[b.state] || a.i - b.i);
  const pills = all.map(({ id, title, state, count }) => ({ id, title, state, count }));
  if (pills.length < 4) return { pills, summary: null };
  return {
    pills,
    summary: {
      groups: pills.length,
      active: pills.filter((p) => p.state === 'active').length,
      blocked: pills.filter((p) => p.state === 'blocked').length,
      firstBlocked: pills.find((p) => p.state === 'blocked')?.title ?? null,
    },
  };
}

/** 노드 id → 그 노드가 속한 그룹 id(그룹이면 자기 자신). 그룹 밖 단계는 null. */
function groupOf(doc: PlanDoc, id: string): string | null {
  if (doc.groups.some((g) => g.id === id)) return id;
  return doc.steps.find((s) => s.id === id)?.groupId ?? null;
}

/**
 * 맨 위 흐름 한 줄(D5) — 그룹을 의존 층으로 묶는다. 같은 층(서로 기다리지 않는 그룹)은 「동시에 진행」, 층 사이는 ⟶.
 * 그룹의 앞 노드는 그 그룹의 dependsOn 과 그 안 단계가 다른 그룹을 기다리는 것 모두다. 그룹이 없으면 null.
 */
export function planFlow(doc: PlanDoc): string[][] | null {
  if (!doc.groups.length) return null;
  const before = new Map<string, Set<string>>();
  for (const g of doc.groups) before.set(g.id, new Set());
  const add = (from: string | null, dep: string) => {
    const to = groupOf(doc, dep);
    if (from && to && to !== from) before.get(from)?.add(to);
  };
  for (const g of doc.groups) for (const d of g.dependsOn) add(g.id, d);
  for (const s of doc.steps) for (const d of s.dependsOn) add(s.groupId ?? null, d);
  // 가장 긴 앞 사슬의 길이가 층이다. 순환은 서버가 막지만, 돌지 않게 깊이를 그룹 수로 묶는다.
  const depth = new Map<string, number>();
  const level = (id: string, guard: number): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (guard > doc.groups.length) return 0;
    let d = 0;
    for (const b of before.get(id) ?? []) d = Math.max(d, level(b, guard + 1) + 1);
    depth.set(id, d);
    return d;
  };
  const layers: string[][] = [];
  for (const g of doc.groups) (layers[level(g.id, 0)] ??= []).push(g.id);
  return layers.filter((l) => l && l.length);
}

/** 이 노드의 그룹 이름(「앞: 그룹 · 단계」에 쓴다). 같은 그룹이거나 그룹이 없으면 null(D6). */
export function crossGroupTitle(doc: PlanDoc, depId: string, fromGroupId: string | null): string | null {
  const g = groupOf(doc, depId);
  if (!g || g === depId || g === fromGroupId) return null;
  return doc.groups.find((x) => x.id === g)?.title ?? null;
}

/** 노드 id → 제목(「⏳ 앞: X」를 그릴 때). 없는 id 는 id 그대로. */
export function planTitleOf(doc: PlanDoc, id: string): string {
  return doc.groups.find((g) => g.id === id)?.title ?? doc.steps.find((s) => s.id === id)?.title ?? id;
}

export function stepsOf(doc: PlanDoc, group: PlanGroup | null) {
  return doc.steps.filter((s) => (group ? s.groupId === group.id : !s.groupId));
}

/** 펼침 기억(D4) — 스레드별, 처음엔 접힘. 저장소가 막혀도 화면은 그대로 돈다. */
const OPEN_KEY = 'harkroom.threadPlan.open.';
export function loadPlanOpen(rootId: string): boolean {
  try { return localStorage.getItem(OPEN_KEY + rootId) === '1'; } catch { return false; }
}
export function savePlanOpen(rootId: string, open: boolean): void {
  try {
    if (open) localStorage.setItem(OPEN_KEY + rootId, '1');
    else localStorage.removeItem(OPEN_KEY + rootId);
  } catch { /* 저장 못 해도 이번 화면은 연다 */ }
}
