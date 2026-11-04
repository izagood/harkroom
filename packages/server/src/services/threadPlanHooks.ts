/**
 * 다른 도구가 계획판을 고치는 두 갈래(P6 서버-2) — `message.report` 의 `planStepId`, `message.delegate` 의 `planGroupId`.
 *
 * 둘 다 **부른 계정**(`{ accountId }`)으로 `writeThreadPlan` 한 경로를 탄다(N5) — 그래서 그 계정이 계획의 스레드를 못 보면
 * `forbidden`, 새로 잇는 스레드를 못 보면 `linked_thread_unavailable` 로 막힌다. `system` actor 는 여기서 쓰지 않는다
 * (자동 갱신 구독기만 쓴다).
 *
 * 바꿀 게 없으면(이미 done·이미 그 스레드에 연결) 쓰지 않는다 — rev 가 오르지 않고 이벤트도 나지 않는다.
 */
import type { Pool } from 'pg';
import { applyPlanItem } from './threadPlanItem.js';
import { writeThreadPlan } from './threadPlan.js';

/** 본 도구(보고·위임)는 이미 성공했다 — 계획 쪽 결과만 따로 돌려준다. */
export type PlanHookResult =
  | { ok: true; rev: number; unchanged?: false }
  | { ok: true; unchanged: true }
  | { ok: false; error: { code: string; [k: string]: unknown } };

/** 그 단계를 done 으로. 없는 단계면 `unknown_item`, 계획이 없으면 `no_plan`. */
export async function completePlanStep(
  pool: Pool, rootId: string, accountId: string, stepId: string,
): Promise<PlanHookResult> {
  const res = await writeThreadPlan(pool, rootId, { accountId }, (prev) => {
    if (!prev) return { error: { code: 'no_plan' } };
    const step = prev.doc.steps.find((s) => s.id === stepId);
    if (!step) return { error: { code: 'unknown_item', id: stepId } };
    if (step.state === 'done') return { error: { code: 'unchanged' } };
    const r = applyPlanItem(prev, { type: 'step', id: stepId, state: 'done' });
    return 'error' in r ? r : { doc: r.doc };
  });
  return toHookResult(res);
}

/** 카드를 세운 단계에 그 카드를 잇는다(`message.ask` 의 `planStepId`). 사람이 그 줄을 누르면 카드로 간다. */
export async function linkPlanCard(
  pool: Pool, rootId: string, accountId: string, stepId: string, messageId: string,
): Promise<PlanHookResult> {
  const res = await writeThreadPlan(pool, rootId, { accountId }, (prev) => {
    if (!prev) return { error: { code: 'no_plan' } };
    if (!prev.doc.steps.some((s) => s.id === stepId)) return { error: { code: 'unknown_item', id: stepId } };
    const r = applyPlanItem(prev, { type: 'step', id: stepId, addLinks: [{ kind: 'card', messageId }] });
    return 'error' in r ? r : { doc: r.doc };
  });
  return toHookResult(res);
}

/**
 * 부모 계획(`parentRootId`)의 그룹을 위임 스레드(`childRootId`)에 잇는다. 이미 **다른** 스레드에 이어진 그룹이면
 * `group_already_linked` — 남이 건 연결을 조용히 갈아 끼우지 않는다. 단계를 가진 그룹이면 `linked_group_has_steps`.
 */
export async function linkPlanGroup(
  pool: Pool, parentRootId: string, accountId: string, groupId: string, childRootId: string,
): Promise<PlanHookResult> {
  const res = await writeThreadPlan(pool, parentRootId, { accountId }, (prev) => {
    if (!prev) return { error: { code: 'no_plan' } };
    const group = prev.doc.groups.find((g) => g.id === groupId);
    if (!group) return { error: { code: 'unknown_item', id: groupId } };
    if (group.linkedRootId) {
      return group.linkedRootId.toLowerCase() === childRootId.toLowerCase()
        ? { error: { code: 'unchanged' } }
        : { error: { code: 'group_already_linked', id: groupId } };
    }
    const r = applyPlanItem(prev, { type: 'group', id: groupId, linkedRootId: childRootId });
    return 'error' in r ? r : { doc: r.doc };
  });
  return toHookResult(res);
}

function toHookResult(res: Awaited<ReturnType<typeof writeThreadPlan>>): PlanHookResult {
  if (!res.ok) {
    const error = res.error as { code: string };
    return error.code === 'unchanged' ? { ok: true, unchanged: true } : { ok: false, error };
  }
  // build 가 doc 을 null 로 돌려주는 길이 없다 — 지우기는 일어나지 않는다.
  if ('deleted' in res) return { ok: false, error: { code: 'unexpected_delete' } };
  return { ok: true, rev: res.row.rev };
}
