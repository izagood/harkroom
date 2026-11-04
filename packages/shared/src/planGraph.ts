/**
 * 스레드 계획판(Thread Plan) 그래프 — 검증·순환 검사·파생 상태·진행률. **I/O 가 없는 순수 함수**다.
 *
 * 왜 shared 인가: 서버(쓸 때 검증·도구 응답), 앱(띠·패널·목록 칩), 러너(프롬프트 렌더)가 같은
 * 판정을 해야 한다. 판정이 여러 자리에 있으면 갈라진다 — `threadStatus.ts` 와 같은 이유다.
 *
 * 모양(소유자 결정 2026-11-02, 설계 K2·K4·K5):
 * - 계획 문서 한 장 = `goal` + 평평한 두 배열 `groups`·`steps`. 단계는 `groupId` 로 부모 그룹을 가리킨다.
 *   깊이는 2(그룹 > 단계)로 고정이고, 그룹 밖 단계도 된다.
 * - `dependsOn` 은 같은 계획 안의 그룹·단계 id 어느 쪽이든 가리킨다. id 는 접두로 갈린다(`g<n>`·`s<n>`).
 * - 저장하는 것은 사람·에이전트가 **선언한** 단계 상태(pending/active/blocked/done)뿐이다. 「대기」·
 *   「시작 가능」은 읽을 때 여기서 계산한다 — 저장하면 앞 단계가 끝나도 누가 풀어 주기 전까지 대기로 남는다.
 * - 연결 그룹(`linkedRootId`)은 다른 스레드의 계획이 정본이다. 그래서 자기 단계를 갖지 않고, 그 스레드의
 *   진행률을 **한 단계만** 합친다(재귀 없음 — 스레드를 넘는 순환이 생겨도 계산이 돌지 않는다).
 */

export type PlanStepState = 'pending' | 'active' | 'blocked' | 'done';

export type PlanLink =
  | { kind: 'pr'; repo: string; number: number }
  | { kind: 'message'; id: string }
  | { kind: 'card'; messageId: string }
  | { kind: 'workitem'; id: string };

export interface PlanGroup {
  /** `g<n>` */
  id: string;
  title: string;
  /** 계정 id. 이름은 화면에서 푼다. 단계에 담당이 없으면 이것을 물려받는다. */
  assigneeId?: string | null;
  /** 이 그룹의 정본인 다른 스레드의 루트 메시지 id. 있으면 자기 단계를 갖지 않는다. */
  linkedRootId?: string | null;
  dependsOn: string[];
}

export interface PlanStep {
  /** `s<n>` */
  id: string;
  /** 부모 그룹. 없거나 null 이면 그룹 밖 단계. */
  groupId?: string | null;
  title: string;
  state: PlanStepState;
  assigneeId?: string | null;
  links: PlanLink[];
  dependsOn: string[];
  blockedReason?: string | null;
}

export interface PlanDoc {
  goal: string;
  groups: PlanGroup[];
  steps: PlanStep[];
  next?: string | null;
  blocked?: string | null;
  /**
   * 관리 에이전트(계정 id). 사람이 「시작」을 누르면 담당 대신 이 에이전트 하나를 부른다. 에이전트가 계획을 처음 세우면 서버가
   * 그 에이전트로 채우고, 그 뒤로는 서버가 바꾸지 않는다(사람·에이전트가 바꾸거나 비울 수 있다). 없으면 담당을 직접 부른다.
   */
  managerId?: string | null;
  /**
   * 지금까지 쓴 가장 큰 번호(서버만 쓰는 칸). 지운 단계의 id 를 새 단계가 다시 쓰지 않게 한다 — 지난 글·report 의
   * 「s3 끝」이 엉뚱한 단계를 가리키지 않도록. 입력으로는 받지 않고 서버가 쓸 때마다 다시 정한다.
   */
  seq?: { s: number; g: number };
}

export const PLAN_LIMITS = {
  groups: 8,
  steps: 40,
  dependsOn: 8,
  links: 10,
  goal: 200,
  title: 120,
  next: 300,
  blocked: 300,
  blockedReason: 300,
} as const;

export type PlanLimitKey = keyof typeof PLAN_LIMITS;

export const PLAN_GROUP_ID_RE = /^g[1-9][0-9]{0,3}$/;
export const PLAN_STEP_ID_RE = /^s[1-9][0-9]{0,3}$/;

export type PlanValidationError =
  | { code: 'invalid_id'; id: string }
  | { code: 'duplicate_id'; id: string }
  /** `from` 이 가리킨 `id` 가 이 계획에 없다(dependsOn·groupId). groupId 가 단계를 가리켜도 이것이다. */
  | { code: 'unknown_ref'; id: string; from: string }
  | { code: 'self_ref'; id: string }
  /** 처음과 끝이 같은 노드 id 열. 예: `['s3','g2','s3']`. */
  | { code: 'dependency_cycle'; path: string[] }
  | { code: 'linked_group_has_steps'; id: string; stepIds: string[] }
  | { code: 'limit_exceeded'; what: PlanLimitKey; limit: number; id?: string };

export type PlanValidation = { ok: true } | { ok: false; error: PlanValidationError };

/** 글자 수는 코드 포인트로 센다(이모지 하나 = 한 글자). */
function len(s: string | null | undefined): number {
  return s ? [...s].length : 0;
}

/**
 * 그래프의 간선. 「a 가 끝나려면(시작하려면) b 가 먼저 끝나야 한다」를 a → b 로 둔다.
 * - 단계 → 자기 dependsOn + 부모 그룹의 dependsOn(그룹의 의존은 그 안 단계 모두가 물려받는다)
 * - 그룹 → 자기 dependsOn + 자기 단계들(그룹이 끝나려면 단계가 다 끝나야 한다)
 * 그래서 「단계가 자기 그룹을 기다림」·「그룹이 자기 단계를 기다림」도 순환으로 잡힌다.
 */
function edges(doc: PlanDoc): Map<string, string[]> {
  const groupDeps = new Map(doc.groups.map((g) => [g.id, g.dependsOn]));
  const out = new Map<string, string[]>();
  for (const g of doc.groups) out.set(g.id, [...g.dependsOn]);
  for (const s of doc.steps) {
    const inherited = s.groupId ? groupDeps.get(s.groupId) ?? [] : [];
    out.set(s.id, [...s.dependsOn, ...inherited]);
    if (s.groupId) out.get(s.groupId)?.push(s.id);
  }
  return out;
}

/** 첫 번째로 걸린 거절을 돌려준다. 검사 순서: 상한 → id → 참조 → 연결 그룹 → 순환. */
export function validatePlan(doc: PlanDoc): PlanValidation {
  const fail = (error: PlanValidationError): PlanValidation => ({ ok: false, error });
  const L = PLAN_LIMITS;

  // 상한
  if (doc.groups.length > L.groups) return fail({ code: 'limit_exceeded', what: 'groups', limit: L.groups });
  if (doc.steps.length > L.steps) return fail({ code: 'limit_exceeded', what: 'steps', limit: L.steps });
  if (len(doc.goal) > L.goal) return fail({ code: 'limit_exceeded', what: 'goal', limit: L.goal });
  if (len(doc.next) > L.next) return fail({ code: 'limit_exceeded', what: 'next', limit: L.next });
  if (len(doc.blocked) > L.blocked) return fail({ code: 'limit_exceeded', what: 'blocked', limit: L.blocked });
  for (const n of [...doc.groups, ...doc.steps]) {
    if (len(n.title) > L.title) return fail({ code: 'limit_exceeded', what: 'title', limit: L.title, id: n.id });
    if (n.dependsOn.length > L.dependsOn) {
      return fail({ code: 'limit_exceeded', what: 'dependsOn', limit: L.dependsOn, id: n.id });
    }
  }
  for (const s of doc.steps) {
    if (s.links.length > L.links) return fail({ code: 'limit_exceeded', what: 'links', limit: L.links, id: s.id });
    if (len(s.blockedReason) > L.blockedReason) {
      return fail({ code: 'limit_exceeded', what: 'blockedReason', limit: L.blockedReason, id: s.id });
    }
  }

  // id
  const seen = new Set<string>();
  for (const [nodes, re] of [[doc.groups, PLAN_GROUP_ID_RE], [doc.steps, PLAN_STEP_ID_RE]] as const) {
    for (const n of nodes) {
      if (!re.test(n.id)) return fail({ code: 'invalid_id', id: n.id });
      if (seen.has(n.id)) return fail({ code: 'duplicate_id', id: n.id });
      seen.add(n.id);
    }
  }

  // 참조
  const groupIds = new Set(doc.groups.map((g) => g.id));
  for (const s of doc.steps) {
    if (s.groupId && !groupIds.has(s.groupId)) return fail({ code: 'unknown_ref', id: s.groupId, from: s.id });
  }
  for (const n of [...doc.groups, ...doc.steps]) {
    for (const d of n.dependsOn) {
      if (d === n.id) return fail({ code: 'self_ref', id: n.id });
      if (!seen.has(d)) return fail({ code: 'unknown_ref', id: d, from: n.id });
    }
  }

  // 연결 그룹은 자기 단계를 갖지 않는다 — 정본을 하나로 지킨다.
  for (const g of doc.groups) {
    if (!g.linkedRootId) continue;
    const stepIds = doc.steps.filter((s) => s.groupId === g.id).map((s) => s.id);
    if (stepIds.length) return fail({ code: 'linked_group_has_steps', id: g.id, stepIds });
  }

  // 순환(그룹·단계를 섞은 DFS, 문서 순서대로 — 같은 문서면 같은 path 가 나온다)
  const cycle = findCycle(doc);
  if (cycle) return fail({ code: 'dependency_cycle', path: cycle });
  return { ok: true };
}

function findCycle(doc: PlanDoc): string[] | null {
  const g = edges(doc);
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, GREY);
    stack.push(id);
    for (const next of g.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GREY) return [...stack.slice(stack.indexOf(next)), next];
      if (c === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };
  for (const id of g.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

// ── 파생 상태 ────────────────────────────────────────────────────────────────

export interface PlanProgress {
  done: number;
  total: number;
  /** 손댔지만 아직 안 끝난 단위(파생 active). 연결 그룹 판정이 「손만 대고 아무것도 안 끝낸」 자식을 ready 로 잘못 읽지 않게 싣는다. */
  active: number;
  blocked: number;
  waiting: number;
}

/**
 * 연결된 스레드의 진행률. `'hidden'` 은 보는 사람이 그 채널을 못 본다는 뜻이다 — 판정하지 않는다.
 * 맵에 없는 연결 그룹은 「아직 계획이 없는 스레드」(`total 0`)로 읽는다.
 */
export type LinkedProgress = ReadonlyMap<string, PlanProgress | 'hidden'>;

/**
 * - done·active·blocked: 선언한 상태(그룹은 단계에서 모은 상태).
 * - waiting: pending 인데 덜 끝난 앞 노드가 있다(`waitingOn`).
 * - ready: pending 이고 앞 노드가 다 끝났다 — 「이제 시작 가능」.
 * - hidden: 볼 수 없는 스레드에 연결된 그룹. 진행률·상태를 감춘다.
 */
export type PlanDerivedState = 'done' | 'active' | 'blocked' | 'waiting' | 'ready' | 'hidden';

export interface PlanDerivedNode {
  derived: PlanDerivedState;
  /** 덜 끝난 앞 노드(단계는 부모 그룹의 의존을 포함). 문서 순서. */
  waitingOn: string[];
  /** 앞 노드가 덜 끝났는데 이미 시작했다(active·blocked·done). 막지 않고 경고만 단다. */
  startedEarly: boolean;
}

/** 노드 id → 파생 상태. 키 순서는 그룹(문서 순서) 다음 단계(문서 순서)다. */
export type PlanDerived = Record<string, PlanDerivedNode>;

/**
 * 검증을 통과한 문서를 전제로 한다. 그래도 순환·없는 참조가 섞여 들어오면 멈추지 않고
 * 그 노드를 「덜 끝남」으로 읽는다.
 */
export function derivePlan(doc: PlanDoc, linked?: LinkedProgress): PlanDerived {
  const groups = new Map(doc.groups.map((g) => [g.id, g]));
  const stepsOf = new Map<string, PlanStep[]>();
  for (const s of doc.steps) {
    if (!s.groupId) continue;
    const arr = stepsOf.get(s.groupId) ?? [];
    arr.push(s);
    stepsOf.set(s.groupId, arr);
  }
  const stepById = new Map(doc.steps.map((s) => [s.id, s]));

  const linkedOf = (g: PlanGroup): PlanProgress | 'hidden' =>
    linked?.get(g.linkedRootId!) ?? { done: 0, total: 0, active: 0, blocked: 0, waiting: 0 };

  // 「끝났나」만 먼저 정한다 — 의존 판정은 이것만 본다. 순환이 있어도 돌지 않게 진행 중 표시를 둔다.
  const doneMemo = new Map<string, boolean>();
  const inProgress = new Set<string>();
  const isDone = (id: string): boolean => {
    const memo = doneMemo.get(id);
    if (memo !== undefined) return memo;
    if (inProgress.has(id)) return false;
    inProgress.add(id);
    let done = false;
    const step = stepById.get(id);
    const group = groups.get(id);
    if (step) {
      done = step.state === 'done';
    } else if (group) {
      if (group.linkedRootId) {
        const p = linkedOf(group);
        done = p !== 'hidden' && p.total > 0 && p.done === p.total;
      } else {
        const members = stepsOf.get(id) ?? [];
        // 빈 그룹은 끝난 것이 아니다 — 자리만 잡아 둔 그룹 뒤의 일이 곧바로 「시작 가능」이 되면 안 된다.
        done = members.length > 0 && members.every((s) => isDone(s.id));
      }
    }
    inProgress.delete(id);
    doneMemo.set(id, done);
    return done;
  };

  const pendingDeps = (deps: string[]): string[] => {
    const out: string[] = [];
    for (const d of deps) if (!out.includes(d) && !isDone(d)) out.push(d);
    return out;
  };

  // 키가 사용자 입력(id)이라 프로토타입 없는 객체에 담는다 — 검증을 건너뛴 `__proto__` 같은 id 가 원형을 건드리지 않게.
  const result: PlanDerived = Object.create(null) as PlanDerived;
  const stepNodes = new Map<string, PlanDerivedNode>();
  for (const s of doc.steps) {
    const parent = s.groupId ? groups.get(s.groupId) : undefined;
    const waitingOn = pendingDeps([...s.dependsOn, ...(parent?.dependsOn ?? [])]);
    let node: PlanDerivedNode;
    if (s.state === 'pending') {
      node = { derived: waitingOn.length ? 'waiting' : 'ready', waitingOn, startedEarly: false };
    } else {
      node = { derived: s.state, waitingOn, startedEarly: waitingOn.length > 0 };
    }
    stepNodes.set(s.id, node);
  }

  for (const g of doc.groups) {
    const waitingOn = pendingDeps(g.dependsOn);
    let derived: PlanDerivedState;
    if (g.linkedRootId) {
      const p = linkedOf(g);
      if (p === 'hidden') {
        result[g.id] = { derived: 'hidden', waitingOn, startedEarly: false };
        continue;
      }
      // 손댄 것(active)이나 끝난 것이 하나라도 있으면 진행 중이다.
      if (isDone(g.id)) derived = 'done';
      else if (p.blocked > 0) derived = 'blocked';
      else if (p.active > 0 || p.done > 0) derived = 'active';
      else derived = waitingOn.length ? 'waiting' : 'ready';
    } else {
      const members = (stepsOf.get(g.id) ?? []).map((s) => s.state);
      if (isDone(g.id)) derived = 'done';
      else if (members.includes('blocked')) derived = 'blocked';
      else if (members.includes('active') || members.includes('done')) derived = 'active';
      else derived = waitingOn.length ? 'waiting' : 'ready';
    }
    const started = derived === 'done' || derived === 'blocked' || derived === 'active';
    result[g.id] = { derived, waitingOn, startedEarly: started && waitingOn.length > 0 };
  }
  for (const [id, node] of stepNodes) result[id] = node;
  return result;
}

/**
 * 진행률. 그룹 밖 단계와 연결 안 된 그룹의 단계는 하나씩, 연결 그룹은 한 단위로 센다(1단 합침).
 * 빈 그룹은 세지 않는다. 볼 수 없는 연결 그룹은 total 에만 든다.
 */
export function planProgress(doc: PlanDoc, linked?: LinkedProgress): PlanProgress {
  const d = derivePlan(doc, linked);
  const units = [
    ...doc.steps.map((s) => s.id),
    ...doc.groups.filter((g) => g.linkedRootId).map((g) => g.id),
  ];
  const p: PlanProgress = { done: 0, total: units.length, active: 0, blocked: 0, waiting: 0 };
  for (const id of units) {
    const s = d[id]!.derived;
    if (s === 'done') p.done++;
    else if (s === 'active') p.active++;
    else if (s === 'blocked') p.blocked++;
    else if (s === 'waiting') p.waiting++;
  }
  return p;
}

/**
 * 파생 상태가 새로 ready·waiting 이 된 노드. 도구 응답(`nowReady`·`nowWaiting`)과 2차 알림이 쓴다.
 * 앞에 없던 노드(새로 더한 노드)도 그 상태면 실린다. 순서는 `after` 의 키 순서.
 */
export function diffDerived(before: PlanDerived, after: PlanDerived): { nowReady: string[]; nowWaiting: string[] } {
  const nowReady: string[] = [];
  const nowWaiting: string[] = [];
  for (const [id, node] of Object.entries(after)) {
    const prev = before[id]?.derived;
    if (node.derived === 'ready' && prev !== 'ready') nowReady.push(id);
    if (node.derived === 'waiting' && prev !== 'waiting') nowWaiting.push(id);
  }
  return { nowReady, nowWaiting };
}
