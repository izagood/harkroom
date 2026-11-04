/** 계획판 판정 규칙(개선 시안 P6) — 아이폰 `test/thread_plan_rules_test.dart` 와 **같은 자료**를 읽어 두 앱의 결과가 같은지 잰다. */
import { describe, expect, it } from 'vitest';
import type { ThreadPlanView } from '@harkroom/shared';
import { derivePlan, planProgress } from '@harkroom/shared/planGraph';
import rules from './fixtures/planRules.json';
import {
  groupFacts, nextCycleIndex, planButtonKind, planFlow, planFlowVisible, planLists, planPills, planStepOrder, stepFirstLinks, stepKind, stepWaiters, stepWhy,
} from '../src/lib/threadPlan';

describe.each(rules.cases)('$name', (c) => {
  const plan = c.plan as unknown as ThreadPlanView;
  const e = c.expect;
  const step = (id: string) => plan.doc.steps.find((s) => s.id === id)!;

  it('줄 순서·칩 목록', () => {
    expect(planStepOrder(plan.doc).map((s) => s.id)).toEqual(e.order);
    expect(planLists(plan, c.me)).toEqual(e.lists);
  });

  it('자료의 파생 상태·진행률이 서버 규칙 그대로다', () => {
    const map = new Map(plan.linked.map((l) => [l.rootId, l.hidden ? ('hidden' as const) : l.progress!]));
    expect(planProgress(plan.doc, map)).toEqual(plan.progress);
    const derived = derivePlan(plan.doc, map);
    for (const [id, node] of Object.entries(plan.derived)) expect({ derived: derived[id]!.derived, waitingOn: derived[id]!.waitingOn }).toEqual({ derived: node.derived, waitingOn: node.waitingOn });
  });

  it('칩 합 + 볼 수 없는 연결 = 전체 수, 막힘 칩 수 = 막힘 수', () => {
    const lists = planLists(plan, c.me);
    const sum = Object.values(lists).reduce((n, l) => n + l.length, 0);
    const hidden = plan.linked.filter((l) => l.hidden).length;
    expect(sum + hidden).toBe(plan.progress.total);
    expect(lists.blocked.length).toBe(plan.progress.blocked);
  });

  it('단계 줄', () => {
    for (const [id, row] of Object.entries(e.rows)) {
      const { pr, messageId } = stepFirstLinks(step(id));
      expect({ kind: stepKind(plan, step(id), c.me), waiters: stepWaiters(plan, id), pr, messageId }).toEqual(row);
    }
  });

  it('그룹 머리·알약', () => {
    for (const [id, g] of Object.entries(e.groups)) {
      expect(groupFacts(plan, plan.doc.groups.find((x) => x.id === id)!, c.me)).toEqual(g);
    }
    expect(planPills(plan, c.me).map(({ id, key, done, total, n }) => ({ id, key, done, total, n }))).toEqual(e.pills);
  });

  it('흐름·버튼 표지', () => {
    const layers = planFlow(plan.doc) ?? [];
    expect(layers).toEqual(e.flow);
    expect({ max: e.flowVisible.max, ...planFlowVisible(layers, e.flowVisible.max) }).toEqual(e.flowVisible);
    expect(planButtonKind(plan.progress)).toBe(e.buttonKind);
  });

  it('막힌 까닭', () => {
    for (const [id, why] of Object.entries(e.why)) expect(stepWhy(plan, step(id), c.me)).toEqual(why);
  });
});

describe('칩 차례', () => {
  it('처음이면 첫 단계, 끝에서 다시 처음, 비면 없다', () => {
    expect(nextCycleIndex(3, null)).toBe(0);
    expect(nextCycleIndex(3, 0)).toBe(1);
    expect(nextCycleIndex(3, 2)).toBe(0);
    expect(nextCycleIndex(0, null)).toBe(-1);
  });
});
