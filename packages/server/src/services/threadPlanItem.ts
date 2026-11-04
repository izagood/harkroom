/**
 * `thread.plan.item` 의 병합 — 잠근 판에 단계·그룹 **하나**의 변경을 얹은 새 판을 만든다. I/O 없는 순수 함수다.
 *
 * 저장은 `writeThreadPlan` 한 경로가 한다(N5) — 이 함수는 그 `build` 자리에 들어간다. 그래서 검증·새 연결 확인·쓰기 검사가
 * 전체 쓰기와 같은 판정을 탄다. 다른 노드는 건드리지 않으므로 병렬 턴이 서로 다른 단계를 고치면 둘 다 들어간다.
 */
import type { PlanDoc, PlanGroup, PlanLink, PlanStep, PlanStepState } from '@harkroom/shared';

export interface PlanItemPatch {
  /** `plan` 은 계획 칸(`managerId`)을 고친다 — 다른 칸은 함께 줄 수 없다. */
  type?: 'step' | 'group' | 'plan';
  /** 없으면 새로 더한다(서버가 `s<n>`·`g<n>` 을 고른다). */
  id?: string;
  /** 이 노드를 지운다. 다른 노드의 dependsOn 에서도 뺀다. 그룹을 지우면 그 단계는 그룹 밖으로 나온다. */
  remove?: boolean;
  /** 같은 종류의 이 노드 바로 뒤에 둔다. null 이면 맨 앞. 생략하면 새 노드는 맨 뒤, 있던 노드는 제자리. */
  after?: string | null;
  title?: string;
  /** 단계만. null 이면 그룹 밖. */
  groupId?: string | null;
  /** 단계만. */
  state?: PlanStepState;
  assigneeId?: string | null;
  /** 그룹만. */
  linkedRootId?: string | null;
  /** 통째 교체. add/remove 와 함께 주면 교체 뒤에 더하고 뺀다. */
  dependsOn?: string[];
  addDependsOn?: string[];
  removeDependsOn?: string[];
  /** 단계만. */
  addLinks?: PlanLink[];
  removeLinks?: PlanLink[];
  /** 단계만. */
  blockedReason?: string | null;
  /** `type: 'plan'` 만. 관리 에이전트를 바꾼다. null 이면 비운다. */
  managerId?: string | null;
  /** 낙관적 동시성(선택). 주면 지금 판의 rev 와 같아야 한다. */
  ifRev?: number;
}

export type PlanItemError =
  | { code: 'no_plan' }
  | { code: 'unknown_item'; id: string }
  /** 그 종류에 없는 칸을 줬다(예: 그룹에 state). */
  | { code: 'field_not_for_type'; field: string; type: 'step' | 'group' | 'plan' }
  | { code: 'title_required' }
  | { code: 'manager_required' }
  | { code: 'rev_conflict'; rev: number };

export interface PlanItemResult {
  doc: PlanDoc;
  /** 쓴(또는 지운) 노드 id. */
  id: string;
}

const STEP_ONLY = ['groupId', 'state', 'addLinks', 'removeLinks', 'blockedReason'] as const;
const GROUP_ONLY = ['linkedRootId'] as const;

function linkKey(l: PlanLink): string {
  switch (l.kind) {
    case 'pr': return `pr:${l.repo.toLowerCase()}#${l.number}`;
    case 'message': return `message:${l.id.toLowerCase()}`;
    case 'card': return `card:${l.messageId.toLowerCase()}`;
    case 'workitem': return `workitem:${l.id.toLowerCase()}`;
  }
}

function maxNum(prefix: 's' | 'g', nodes: { id: string }[]): number {
  let max = 0;
  for (const n of nodes) {
    const m = /^[sg]([0-9]+)$/.exec(n.id);
    if (m && n.id[0] === prefix) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * 판의 번호표 — 앞 판의 seq, 앞 판·새 판에 있는 id 중 가장 큰 번호(R1). 한 번 쓴 번호는 줄지 않는다.
 * 전체 쓰기·item 모두 저장 직전에 이것으로 doc.seq 를 다시 정한다(`writeThreadPlan`).
 */
export function planSeq(prev: PlanDoc | null, next: PlanDoc): { s: number; g: number } {
  return {
    s: Math.max(prev?.seq?.s ?? 0, maxNum('s', prev?.steps ?? []), maxNum('s', next.steps), next.seq?.s ?? 0),
    g: Math.max(prev?.seq?.g ?? 0, maxNum('g', prev?.groups ?? []), maxNum('g', next.groups), next.seq?.g ?? 0),
  };
}

/** 새 id — 남은 id 가 아니라 번호표 다음 번호다. 맨 끝 노드를 지운 뒤 더해도 그 id 를 다시 쓰지 않는다. */
function nextId(prefix: 's' | 'g', doc: PlanDoc): string {
  const used = Math.max(doc.seq?.[prefix] ?? 0, maxNum(prefix, prefix === 's' ? doc.steps : doc.groups));
  return `${prefix}${used + 1}`;
}

function place<T extends { id: string }>(arr: T[], node: T, after: string | null | undefined, isNew: boolean): T[] | { error: PlanItemError } {
  const rest = arr.filter((n) => n.id !== node.id);
  if (after === undefined) {
    if (isNew) return [...rest, node];
    const at = arr.findIndex((n) => n.id === node.id);
    return [...rest.slice(0, at), node, ...rest.slice(at)];
  }
  if (after === null) return [node, ...rest];
  const at = rest.findIndex((n) => n.id === after);
  if (at < 0) return { error: { code: 'unknown_item', id: after } };
  return [...rest.slice(0, at + 1), node, ...rest.slice(at + 1)];
}

function applyDeps(cur: string[], p: PlanItemPatch): string[] {
  let deps = p.dependsOn ? [...p.dependsOn] : [...cur];
  for (const d of p.addDependsOn ?? []) if (!deps.includes(d)) deps.push(d);
  if (p.removeDependsOn?.length) deps = deps.filter((d) => !p.removeDependsOn!.includes(d));
  return deps;
}

export function applyPlanItem(prev: { doc: PlanDoc; rev: number } | null, p: PlanItemPatch): PlanItemResult | { error: PlanItemError } {
  if (!prev) return { error: { code: 'no_plan' } };
  if (p.ifRev !== undefined && p.ifRev !== prev.rev) return { error: { code: 'rev_conflict', rev: prev.rev } };
  const doc: PlanDoc = { ...prev.doc, groups: [...prev.doc.groups], steps: [...prev.doc.steps] };
  const type = p.type ?? (p.id?.startsWith('g') ? 'group' : 'step');
  if (type === 'plan') {
    for (const [field, value] of Object.entries(p)) {
      if (value !== undefined && !['type', 'managerId', 'ifRev'].includes(field)) return { error: { code: 'field_not_for_type', field, type } };
    }
    if (p.managerId === undefined) return { error: { code: 'manager_required' } };
    return { doc: { ...doc, managerId: p.managerId }, id: 'plan' };
  }
  if (p.managerId !== undefined) return { error: { code: 'field_not_for_type', field: 'managerId', type } };
  for (const f of type === 'group' ? STEP_ONLY : GROUP_ONLY) {
    if (p[f] !== undefined) return { error: { code: 'field_not_for_type', field: f, type } };
  }

  if (p.remove) {
    if (!p.id) return { error: { code: 'unknown_item', id: '' } };
    const list = type === 'group' ? doc.groups : doc.steps;
    if (!list.some((n) => n.id === p.id)) return { error: { code: 'unknown_item', id: p.id } };
    const drop = (deps: string[]) => deps.filter((d) => d !== p.id);
    doc.groups = doc.groups.filter((g) => g.id !== p.id).map((g) => ({ ...g, dependsOn: drop(g.dependsOn) }));
    doc.steps = doc.steps.filter((s) => s.id !== p.id).map((s) => ({
      ...s, dependsOn: drop(s.dependsOn), ...(s.groupId === p.id ? { groupId: null } : {}),
    }));
    return { doc, id: p.id };
  }

  if (type === 'group') {
    const cur = p.id ? doc.groups.find((g) => g.id === p.id) : undefined;
    if (p.id && !cur) return { error: { code: 'unknown_item', id: p.id } };
    if (!cur && !p.title) return { error: { code: 'title_required' } };
    const id = cur?.id ?? nextId('g', doc);
    const node: PlanGroup = {
      ...(cur ?? { id, title: '', dependsOn: [] }),
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.assigneeId !== undefined ? { assigneeId: p.assigneeId } : {}),
      ...(p.linkedRootId !== undefined ? { linkedRootId: p.linkedRootId } : {}),
      dependsOn: applyDeps(cur?.dependsOn ?? [], p),
    };
    const placed = place(doc.groups, node, p.after, !cur);
    if ('error' in placed) return placed;
    doc.groups = placed;
    return { doc, id };
  }

  const cur = p.id ? doc.steps.find((s) => s.id === p.id) : undefined;
  if (p.id && !cur) return { error: { code: 'unknown_item', id: p.id } };
  if (!cur && !p.title) return { error: { code: 'title_required' } };
  const id = cur?.id ?? nextId('s', doc);
  let links = [...(cur?.links ?? [])];
  for (const l of p.addLinks ?? []) if (!links.some((x) => linkKey(x) === linkKey(l))) links.push(l);
  if (p.removeLinks?.length) {
    const gone = new Set(p.removeLinks.map(linkKey));
    links = links.filter((l) => !gone.has(linkKey(l)));
  }
  const node: PlanStep = {
    ...(cur ?? { id, title: '', state: 'pending', links: [], dependsOn: [] }),
    ...(p.title !== undefined ? { title: p.title } : {}),
    ...(p.groupId !== undefined ? { groupId: p.groupId } : {}),
    ...(p.state !== undefined ? { state: p.state } : {}),
    ...(p.assigneeId !== undefined ? { assigneeId: p.assigneeId } : {}),
    ...(p.blockedReason !== undefined ? { blockedReason: p.blockedReason } : {}),
    links,
    dependsOn: applyDeps(cur?.dependsOn ?? [], p),
  };
  const placed = place(doc.steps, node, p.after, !cur);
  if ('error' in placed) return placed;
  doc.steps = placed;
  return { doc, id };
}
