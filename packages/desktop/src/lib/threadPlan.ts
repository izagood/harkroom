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

export interface PlanPill { id: string; title: string; state: PlanDerivedState }

/**
 * 띠의 그룹 알약(D7) — 막힘 먼저, 그다음 진행·시작 가능·대기·끝남. 같은 순위는 문서 순서.
 * 넷 이상이면 셋만 보이고 나머지는 개수로 접는다.
 */
export function planPills(plan: ThreadPlanView, max = 3): { shown: PlanPill[]; more: number } {
  const all = plan.doc.groups.map((g, i) => ({
    id: g.id, title: g.title, state: plan.derived[g.id]?.derived ?? 'waiting', i,
  }));
  all.sort((a, b) => PILL_RANK[a.state] - PILL_RANK[b.state] || a.i - b.i);
  const shown = all.length > max ? all.slice(0, max) : all;
  return { shown: shown.map(({ id, title, state }) => ({ id, title, state })), more: all.length - shown.length };
}

/** 맨 위 흐름 한 줄(D5) — 그룹 제목을 문서 순서로 잇는다. 그룹이 없으면 null. */
export function planFlow(doc: PlanDoc): string | null {
  return doc.groups.length ? doc.groups.map((g) => g.title).join(' → ') : null;
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
