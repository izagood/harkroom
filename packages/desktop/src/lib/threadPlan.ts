/**
 * 스레드 계획판(P4·P5) 화면 판정 — 순수 함수만. 파생 상태는 서버가 준 `derived` 를 그대로 쓴다
 * (architect D-c: 앱에서 `derivePlan` 을 다시 돌리지 않는다 — 권한으로 거른 연결 맵은 서버만 안다).
 */
import type { PlanDerivedState, PlanDoc, PlanGroup, PlanProgress, PlanStep, ThreadPlanView } from '@harkroom/shared';

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

/**
 * 단계 한 줄의 갈래(개선 시안 R1). 서버 파생 상태에 「보는 사람」을 얹은 것이다 — 내 차례는 사람마다 달라 서버가 줄 수 없다.
 * 진행·시작 가능인 단계의 담당이 나면 내 차례다. **막힘은 내 것이어도 막힘으로 둔다** — 「막힌 까닭」과 막힘 칩이 그 단계를 찾아야 한다.
 */
export type PlanRowKind = 'done' | 'active' | 'blocked' | 'mine' | 'ready' | 'waiting' | 'hidden';

/** 단계의 파생 상태. 맵에 없으면 선언 상태로 본다. */
export function stepState(plan: ThreadPlanView, step: PlanStep): PlanDerivedState {
  return plan.derived[step.id]?.derived ?? (step.state === 'pending' ? 'waiting' : step.state);
}

/** 담당 — 단계에 없으면 그룹 담당을 물려받는다. */
export function stepAssignee(doc: PlanDoc, step: PlanStep): string | null {
  return step.assigneeId ?? doc.groups.find((g) => g.id === step.groupId)?.assigneeId ?? null;
}

export function stepKind(plan: ThreadPlanView, step: PlanStep, me: string | null): PlanRowKind {
  const state = stepState(plan, step);
  if ((state === 'active' || state === 'ready') && me && stepAssignee(plan.doc, step) === me) return 'mine';
  return state;
}

/** 화면의 줄 순서 — 그룹을 문서 순서로, 그 안의 단계를 문서 순서로, 그룹 밖 단계는 맨 뒤. 상태가 바뀌어도 줄이 자리를 옮기지 않는다(W2). */
export function planStepOrder(doc: PlanDoc): PlanStep[] {
  const known = new Set(doc.groups.map((g) => g.id));
  return [
    ...doc.groups.flatMap((g) => doc.steps.filter((s) => s.groupId === g.id)),
    ...doc.steps.filter((s) => !s.groupId || !known.has(s.groupId)),
  ];
}

/**
 * 맨 위 상태 칩의 목록 — 칩이 보여 주는 수이자, 누를 때 차례로 갈 단계들이다. 한 칸은 한 목록에만 든다.
 * 서버 `planProgress` 와 같은 단위로 센다: 단계 하나씩 + **연결 그룹 하나당 한 칸**(파생 상태 그대로, 누르면 그 그룹으로 간다).
 * 안 그러면 연결 그룹이 막혔을 때 「막힘 1」은 보이는데 막힘 칩이 꺼진다. 볼 수 없는 연결 그룹은 갈 곳이 없어 빠진다 — `progress.total` 에는 든다.
 */
export type PlanChipKind = 'done' | 'active' | 'blocked' | 'mine' | 'ready' | 'waiting';
export const PLAN_CHIP_KINDS: PlanChipKind[] = ['done', 'active', 'blocked', 'mine', 'ready', 'waiting'];

export function planLists(plan: ThreadPlanView, me: string | null): Record<PlanChipKind, string[]> {
  const out: Record<PlanChipKind, string[]> = { done: [], active: [], blocked: [], mine: [], ready: [], waiting: [] };
  const put = (kind: PlanRowKind, id: string) => { if (kind !== 'hidden') out[kind].push(id); };
  const known = new Set(plan.doc.groups.map((g) => g.id));
  for (const g of plan.doc.groups) {
    if (g.linkedRootId) put(plan.derived[g.id]?.derived ?? 'waiting', g.id);
    for (const s of plan.doc.steps) if (s.groupId === g.id) put(stepKind(plan, s, me), s.id);
  }
  for (const s of plan.doc.steps) if (!s.groupId || !known.has(s.groupId)) put(stepKind(plan, s, me), s.id);
  return out;
}

/** 이 단계를 앞 단계로 둔 막힌 단계(문서 순서) — 내 차례 줄의 「막힌 n건이 기다린다」. */
export function stepWaiters(plan: ThreadPlanView, stepId: string): string[] {
  return planStepOrder(plan.doc).filter((s) => s.dependsOn.includes(stepId) && stepState(plan, s) === 'blocked').map((s) => s.id);
}

const PR_REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** 단계 줄 끝에 둘 첫 PR(꼴이 맞는 것만)과 첫 글(메시지·카드). 앱 밖으로 나가는 주소는 이 꼴을 지난 것으로만 짓는다. */
export function stepFirstLinks(step: PlanStep): { pr: { repo: string; number: number } | null; messageId: string | null } {
  let pr: { repo: string; number: number } | null = null;
  let messageId: string | null = null;
  for (const l of step.links ?? []) {
    if (l.kind === 'pr' && !pr && PR_REPO_RE.test(l.repo) && Number.isInteger(l.number) && l.number > 0) pr = { repo: l.repo, number: l.number };
    if (l.kind === 'message' && !messageId) messageId = l.id;
    if (l.kind === 'card' && !messageId) messageId = l.messageId;
  }
  return { pr, messageId };
}

export function prUrl(pr: { repo: string; number: number }): string {
  return `https://github.com/${pr.repo}/pull/${pr.number}`;
}

/**
 * 줄을 누르면 갈 곳(시안 v4 R14) — 카드 → 메시지 → PR 순서. 앱 안에서 가는 것이 먼저고 PR 은 밖이라 마지막이다.
 * 작업 항목은 id 만으로 갈 화면이 없어 넣지 않는다. 비면 누를 수 없는 줄이다.
 */
export type PlanGoTarget = { kind: 'card' | 'message'; id: string } | { kind: 'pr'; repo: string; number: number };
export function stepGoTargets(step: PlanStep): PlanGoTarget[] {
  const out: PlanGoTarget[] = [];
  const links = step.links ?? [];
  for (const l of links) if (l.kind === 'card') out.push({ kind: 'card', id: l.messageId });
  for (const l of links) if (l.kind === 'message') out.push({ kind: 'message', id: l.id });
  for (const l of links) {
    if (l.kind === 'pr' && PR_REPO_RE.test(l.repo) && Number.isInteger(l.number) && l.number > 0) out.push({ kind: 'pr', repo: l.repo, number: l.number });
  }
  return out;
}

/**
 * 「▷ 시작」(R13·A안) — 시작 가능한 단계에만 있다. 관리 에이전트가 있으면 담당과 상관없이 그쪽으로 간다.
 * 없을 때 담당이 나 아닌 사람이면 꺼 둔다(그 사람이 시작한다). 담당이 없거나 에이전트면 켠다(담당 없음은 상자에서 고른다).
 */
export type PlanStartState = 'none' | 'enabled' | 'other_human';
export function stepStartState(plan: ThreadPlanView, step: PlanStep, me: string | null, isHuman: (id: string) => boolean): PlanStartState {
  if (stepState(plan, step) !== 'ready') return 'none';
  if (plan.doc.managerId) return 'enabled';
  const a = stepAssignee(plan.doc, step);
  return a && a !== me && isHuman(a) ? 'other_human' : 'enabled';
}

/** 「모두 시작」의 후보 — 시작 가능한 단계 전부(문서 순서). 고를 수 없는 줄은 서버 미리보기가 사유를 준다. */
export function planReadyStepIds(plan: ThreadPlanView): string[] {
  return planStepOrder(plan.doc).filter((s) => stepState(plan, s) === 'ready').map((s) => s.id);
}

/** 패널 크기(R15). 전역 하나만 기억한다 — 크기는 창에 대한 취향이지 스레드의 성질이 아니다. */
export const PLAN_PANEL_DEFAULT = { w: 440, h: 600 };
export const PLAN_PANEL_MIN = { w: 360, h: 320 };
const SIZE_KEY = 'harkroom.threadPlan.size';
export function clampPlanSize(size: { w: number; h: number }, box: { w: number; h: number }): { w: number; h: number } {
  const maxW = Math.max(PLAN_PANEL_MIN.w, box.w - 32);
  const maxH = Math.max(PLAN_PANEL_MIN.h, box.h - 72);
  return {
    w: Math.min(maxW, Math.max(PLAN_PANEL_MIN.w, Math.round(size.w))),
    h: Math.min(maxH, Math.max(PLAN_PANEL_MIN.h, Math.round(size.h))),
  };
}
/** 「⤢ 넓게」 = 칸 폭 60% × 최대 높이. */
export function widePlanSize(box: { w: number; h: number }): { w: number; h: number } {
  return clampPlanSize({ w: box.w * 0.6, h: box.h }, box);
}
export function loadPlanSize(): { w: number; h: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null') as { w?: unknown; h?: unknown } | null;
    return v && typeof v.w === 'number' && typeof v.h === 'number' ? { w: v.w, h: v.h } : null;
  } catch { return null; }
}
export function savePlanSize(size: { w: number; h: number } | null): void {
  try {
    if (size) localStorage.setItem(SIZE_KEY, JSON.stringify(size));
    else localStorage.removeItem(SIZE_KEY);
  } catch { /* 저장 못 해도 이번 화면은 그 크기로 돈다 */ }
}

/** 그룹 머리의 표지·수. 막힘이 먼저고, 내 단계가 있으면 내 차례, 그 밖은 서버 파생 상태다. */
export function groupFacts(plan: ThreadPlanView, g: PlanGroup, me: string | null): {
  kind: PlanRowKind; done: number; total: number; active: number; mine: number;
} {
  const steps = plan.doc.steps.filter((s) => s.groupId === g.id);
  const kinds = steps.map((s) => stepKind(plan, s, me));
  const count = groupCount(plan, g);
  const mine = kinds.filter((k) => k === 'mine').length;
  const state = plan.derived[g.id]?.derived ?? 'waiting';
  return {
    kind: state === 'blocked' ? 'blocked' : mine > 0 ? 'mine' : state,
    done: count?.done ?? 0,
    total: count?.total ?? 0,
    active: kinds.filter((k) => k === 'active').length,
    mine,
  };
}

export type PlanPillKey = 'done' | 'blocked' | 'mine' | 'active' | 'waiting' | 'waitingCount' | 'count' | 'plain';
export interface PlanPill {
  id: string; title: string; state: PlanDerivedState; key: PlanPillKey; done: number; total: number; n: number;
}

/**
 * 그룹 알약 — 막힘 먼저, 그다음 진행·시작 가능·대기·끝남. 같은 순위는 문서 순서(D7).
 * 글자(R3): 막힘 「{그룹} 막힘 d/t」 · 내 차례 「{그룹} 내 차례 n」 · 진행 「{그룹} 진행 n · d/t」 · 그 밖은 앞과 같다.
 */
export function planPills(plan: ThreadPlanView, me: string | null): PlanPill[] {
  const all = plan.doc.groups.map((g, i) => {
    const f = groupFacts(plan, g, me);
    const c = groupCount(plan, g);
    const state = plan.derived[g.id]?.derived ?? 'waiting';
    let key: PlanPillKey = 'plain';
    let n = 0;
    if (state === 'done') key = 'done';
    else if (state === 'blocked' && c) key = 'blocked';
    else if (f.mine > 0) { key = 'mine'; n = f.mine; }
    else if (f.active > 0 && c) { key = 'active'; n = f.active; }
    else if (state === 'waiting') key = c && c.total > 0 && c.done > 0 ? 'waitingCount' : 'waiting';
    else if (c && c.total > 0 && state !== 'hidden') key = 'count';
    return { id: g.id, title: g.title, state, key, n, done: f.done, total: f.total, i };
  });
  all.sort((a, b) => PILL_RANK[a.state] - PILL_RANK[b.state] || a.i - b.i);
  return all.map(({ i: _i, ...p }) => p);
}

/** 패널 머리 흐름 한 줄(W4) — 앞에서 [max] 개만 두고 나머지는 「+n 그룹 ›」. */
export function planFlowVisible(layers: string[][], max: number): { ids: string[]; more: number } {
  const ids = layers.flat();
  return { ids: ids.slice(0, max), more: Math.max(0, ids.length - max) };
}

/** 칩을 거듭 누를 때 다음 차례. 처음이거나 다른 칩에서 왔으면 첫 단계부터. */
export function nextCycleIndex(length: number, current: number | null): number {
  if (length === 0) return -1;
  return current === null ? 0 : (current + 1) % length;
}

export type PlanWhyLink = { kind: 'pr'; repo: string; number: number } | { kind: 'message' | 'card' | 'workitem'; id: string };
export interface PlanWhyDep { id: string; group: string | null; title: string; mine: boolean }

/**
 * 「막힌 까닭」 상자(R9) — 사유 전문 → 끝나지 않은 앞 단계 → 연결(꼴이 틀린 PR 은 뺀다) 순서.
 * 앞 단계는 단계 자신과 그 그룹의 dependsOn 모두다.
 */
export function stepWhy(plan: ThreadPlanView, step: PlanStep, me: string | null): {
  reason: string | null; deps: PlanWhyDep[]; links: PlanWhyLink[];
} {
  const parent = plan.doc.groups.find((g) => g.id === step.groupId);
  const seen = new Set<string>();
  const deps: PlanWhyDep[] = [];
  for (const id of [...step.dependsOn, ...(parent?.dependsOn ?? [])]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const dep = plan.doc.steps.find((s) => s.id === id);
    if (dep && stepState(plan, dep) === 'done') continue;
    if (!dep && plan.derived[id]?.derived === 'done') continue;
    deps.push({ id, group: crossGroupTitle(plan.doc, id, step.groupId ?? null), title: planTitleOf(plan.doc, id), mine: dep ? stepKind(plan, dep, me) === 'mine' : false });
  }
  const links: PlanWhyLink[] = [];
  for (const l of step.links ?? []) {
    if (l.kind === 'pr') { if (PR_REPO_RE.test(l.repo) && Number.isInteger(l.number) && l.number > 0) links.push({ kind: 'pr', repo: l.repo, number: l.number }); }
    else if (l.kind === 'card') links.push({ kind: 'card', id: l.messageId });
    else links.push({ kind: l.kind, id: l.id });
  }
  return { reason: step.blockedReason ?? null, deps, links };
}

/** 떠 있는 버튼의 표지. 막힘이 먼저다 — 닫힌 채로도 막힘이 보여야 한다(W5). */
export function planButtonKind(p: PlanProgress | null | undefined): PlanRowKind {
  if (!p || p.blocked > 0) return 'blocked';
  if (p.total > 0 && p.done >= p.total) return 'done';
  if (p.active > 0) return 'active';
  return p.done > 0 ? 'ready' : 'waiting';
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

/** 로그아웃 때 펼침 기억을 지운다(security 낮음) — 내용은 없지만 연 스레드 id 가 기기에 남지 않게. */
export function clearPlanOpenKeys(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(OPEN_KEY)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch { /* 저장소가 막혀도 로그아웃은 계속한다 */ }
}
