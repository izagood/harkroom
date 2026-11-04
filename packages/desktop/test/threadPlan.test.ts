import { describe, expect, it } from 'vitest';
import type { MessageRow, ThreadPlanView } from '@harkroom/shared';
import { crossGroupTitle, isPlanStale, planFlow, planPills, planTone, PLAN_STALE_MS } from '../src/lib/threadPlan';
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
    const pills = planPills(plan, null);
    expect(pills.map((p) => p.id)).toEqual(['g3', 'g2', 'g4', 'g1']);
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

describe('planFlow — 의존 층(D5·designer 3)', () => {
  it('서로 기다리지 않는 그룹은 한 층(동시에 진행), 기다리면 다음 층 — 단계 의존도 그룹 사이 간선이다', () => {
    const doc = {
      goal: 'x',
      groups: [
        { id: 'g1', title: 'A', dependsOn: [] }, { id: 'g2', title: 'B', dependsOn: [] },
        { id: 'g3', title: 'C', dependsOn: ['g1'] },
      ],
      steps: [
        { id: 's1', title: 'b1', state: 'pending', groupId: 'g2', links: [], dependsOn: [] },
        { id: 's2', title: 'c1', state: 'pending', groupId: 'g3', links: [], dependsOn: ['s1'] },
      ],
    } as unknown as ThreadPlanView['doc'];
    expect(planFlow(doc)).toEqual([['g1', 'g2'], ['g3']]);
    expect(crossGroupTitle(doc, 's1', 'g3')).toBe('B');
    expect(crossGroupTitle(doc, 's1', 'g2')).toBeNull();
    expect(crossGroupTitle(doc, 'g1', 'g3')).toBeNull();
  });
});

