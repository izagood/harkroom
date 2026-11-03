import { describe, expect, it } from 'vitest';
import type { MessageRow, ThreadPlanView } from '@harkroom/shared';
import { isPlanStale, planFlow, planPills, planTone, PLAN_STALE_MS } from '../src/lib/threadPlan';
import { keepThreadFacts } from '../src/state/appStore';

const P = (done: number, total: number, blocked = 0) => ({ done, total, active: 0, blocked, waiting: 0 });

describe('계획판 화면 판정', () => {
  it('칩 색 — 막힘만 빨강, 다 끝나면 done, 단계 없으면 그리지 않음', () => {
    expect(planTone(P(1, 3, 1))).toBe('blocked');
    expect(planTone(P(3, 3))).toBe('done');
    expect(planTone(P(1, 3))).toBe('active');
    expect(planTone(P(0, 0))).toBe('empty');
    expect(planTone(null)).toBe('empty');
  });

  it('24시간 넘으면 낡았을 수 있음(D3), 못 읽는 시각은 낡지 않음', () => {
    const now = Date.parse('2026-11-03T08:00:00Z');
    expect(isPlanStale(new Date(now - PLAN_STALE_MS - 1).toISOString(), now)).toBe(true);
    expect(isPlanStale(new Date(now - 1000).toISOString(), now)).toBe(false);
    expect(isPlanStale('nope', now)).toBe(false);
  });

  it('알약은 막힘 먼저, 4개 이상이면 셋 + 개수(D7)', () => {
    const groups = ['g1', 'g2', 'g3', 'g4'].map((id) => ({ id, title: id, dependsOn: [] }));
    const plan = {
      doc: { goal: 'x', groups, steps: [] },
      derived: {
        g1: { derived: 'done', waitingOn: [], startedEarly: false },
        g2: { derived: 'active', waitingOn: [], startedEarly: false },
        g3: { derived: 'blocked', waitingOn: [], startedEarly: false },
        g4: { derived: 'waiting', waitingOn: ['g2'], startedEarly: false },
      },
    } as unknown as ThreadPlanView;
    const { shown, more } = planPills(plan);
    expect(shown.map((p) => p.id)).toEqual(['g3', 'g2', 'g4']);
    expect(more).toBe(1);
    expect(planFlow(plan.doc)).toBe('g1 → g2 → g3 → g4');
  });
});

describe('planProgress 키 없는 갱신(architect D-a)', () => {
  const root = { id: 'r', threadRootId: null, openAskHumanCount: 0 } as unknown as MessageRow;
  const prog = { ...P(1, 2), rev: 3 };
  it('키가 없으면 앞 값을 지킨다', () => {
    const next = keepThreadFacts({ ...root, planProgress: prog }, { ...root });
    expect(next.planProgress).toEqual(prog);
  });
  it('null 이면 지운다', () => {
    const next = keepThreadFacts({ ...root, planProgress: prog }, { ...root, planProgress: null });
    expect(next.planProgress).toBeNull();
  });
});
