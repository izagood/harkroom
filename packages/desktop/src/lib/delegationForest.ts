import type { GrantRow } from '@harkroom/shared';

/**
 * 위임 나무(외부 API P5 desktop, 설계 스레드 07519d86 · designer v3 ③-2). 서버는 줄마다 `parentGrantId` 만 준다 — 나무는
 * 소유자가 가진 에이전트들의 `api.call` 줄을 모아 여기서 엮는다. **판정은 서버가 한다**(`apiDelegation.ts`·`apiGrantFor`).
 * 여기서 「사슬 막힘」은 사람이 볼 표시일 뿐이고, 서버가 쓰는 순간 다시 잰다.
 */

/** 서버가 대기 줄에 다는 사유(`apiDelegation.ts` PENDING_APPROVAL). */
export const PENDING_APPROVAL = 'pending_approval';

export type ApiGrant = GrantRow & { id: string };

export interface ForestNode {
  grant: ApiGrant;
  /** 이 줄을 받은 에이전트(= `grant.accountId`). */
  agentId: string;
  parent: ForestNode | null;
  children: ForestNode[];
}

/** `id` 가 있는 `api.call` 줄만 엮는다(옛 서버는 id 를 안 싣는다 → 나무 없음). 부모가 목록에 없으면 그 줄은 고아로 남는다. */
export function buildForest(rows: readonly GrantRow[]): Map<string, ForestNode> {
  const byId = new Map<string, ForestNode>();
  for (const g of rows) {
    if (g.capability !== 'api.call' || !g.id) continue;
    byId.set(g.id, { grant: g as ApiGrant, agentId: g.accountId, parent: null, children: [] });
  }
  for (const n of byId.values()) {
    const p = n.grant.parentGrantId ? byId.get(n.grant.parentGrantId) : undefined;
    if (p) { n.parent = p; p.children.push(n); }
  }
  for (const n of byId.values()) n.children.sort((a, b) => a.grant.grantedAt.localeCompare(b.grant.grantedAt));
  return byId;
}

export const isPending = (g: GrantRow): boolean => g.suspendReason === PENDING_APPROVAL;

const dead = (g: GrantRow, now: number): boolean =>
  (g.expiresAt !== null && Date.parse(g.expiresAt) <= now) || !!g.suspendedAt;

/**
 * 이 줄이 쓰일 수 없는 이유(사람이 볼 것). 위 단계 중 하나라도 만료·정지·대기거나, 부모를 이 목록에서 못 찾거나,
 * 단계 수가 부모보다 작지 않으면(받는 쪽 ≤ 준 쪽 − 1) 「사슬 막힘」이다. 자기 줄이 대기면 `pending`.
 */
export function blockedReason(node: ForestNode, now = Date.now()): 'pending' | 'chain' | null {
  if (isPending(node.grant)) return 'pending';
  if (node.grant.parentGrantId && !node.parent) return 'chain';
  for (let child = node, p = node.parent; p; child = p, p = p.parent) {
    if (dead(p.grant, now)) return 'chain';
    if ((child.grant.delegateDepth ?? 0) > (p.grant.delegateDepth ?? 0) - 1) return 'chain';
  }
  return null;
}

/** 이 마디 아래 줄 수(자기 제외) — [이 아래 전부 거두기] 확인창에 적는다. */
export function descendantCount(node: ForestNode): number {
  return node.children.reduce((n, c) => n + 1 + descendantCount(c), 0);
}

/** 사슬의 맨 위(사람이 준 줄). 부모를 못 찾으면 거기서 멈춘다. */
export function rootOf(node: ForestNode): ForestNode {
  let n = node;
  while (n.parent) n = n.parent;
  return n;
}

/**
 * 「허락 기다림 N」 — 대기 줄 중 **이 사람이 루트인 것**(서버는 루트 사람만 허락·거절을 받는다). 루트를 못 찾는 줄은
 * 빼지 않고 넣는다 — 서버가 403 으로 거절하면 그 말을 보인다.
 */
export function decidableBy(node: ForestNode, humanId: string): boolean {
  const r = rootOf(node);
  return r === node || !!r.grant.parentGrantId || r.grant.grantedBy === humanId;
}

export function pendingForRoot(forest: Map<string, ForestNode>, humanId: string): ForestNode[] {
  return [...forest.values()]
    .filter((n) => isPending(n.grant) && decidableBy(n, humanId))
    .sort((a, b) => a.grant.grantedAt.localeCompare(b.grant.grantedAt));
}
