import { describe, it, expect } from 'vitest';
import {
  PLAN_LIMITS,
  derivePlan,
  diffDerived,
  planProgress,
  validatePlan,
  type PlanDoc,
  type PlanGroup,
  type PlanStep,
} from '../src/planGraph.js';

const step = (id: string, over: Partial<PlanStep> = {}): PlanStep => ({
  id, title: id, state: 'pending', links: [], dependsOn: [], ...over,
});
const group = (id: string, over: Partial<PlanGroup> = {}): PlanGroup => ({ id, title: id, dependsOn: [], ...over });
const plan = (groups: PlanGroup[], steps: PlanStep[]): PlanDoc => ({ goal: '목표', groups, steps });

const errorOf = (doc: PlanDoc) => {
  const v = validatePlan(doc);
  return v.ok ? null : v.error;
};

describe('validatePlan — 거절 코드', () => {
  it('빈 계획은 통과한다', () => {
    expect(validatePlan(plan([], []))).toEqual({ ok: true });
  });

  it('그룹 밖 단계와 그룹 안 단계를 섞어도 된다', () => {
    expect(validatePlan(plan([group('g1')], [step('s1', { groupId: 'g1' }), step('s2', { dependsOn: ['g1'] })]))).toEqual({ ok: true });
  });

  it('id 꼴이 틀리면 invalid_id — 그룹은 g<n>, 단계는 s<n>', () => {
    expect(errorOf(plan([group('s1')], []))).toEqual({ code: 'invalid_id', id: 's1' });
    expect(errorOf(plan([], [step('g1')]))).toEqual({ code: 'invalid_id', id: 'g1' });
    expect(errorOf(plan([], [step('s0')]))).toEqual({ code: 'invalid_id', id: 's0' });
  });

  it('같은 id 가 두 번이면 duplicate_id', () => {
    expect(errorOf(plan([], [step('s1'), step('s1')]))).toEqual({ code: 'duplicate_id', id: 's1' });
  });

  it('없는 노드를 가리키면 unknown_ref — dependsOn·groupId 둘 다, groupId 가 단계를 가리켜도', () => {
    expect(errorOf(plan([], [step('s1', { dependsOn: ['s9'] })]))).toEqual({ code: 'unknown_ref', id: 's9', from: 's1' });
    expect(errorOf(plan([], [step('s1', { groupId: 'g3' })]))).toEqual({ code: 'unknown_ref', id: 'g3', from: 's1' });
    expect(errorOf(plan([], [step('s1'), step('s2', { groupId: 's1' })]))).toEqual({ code: 'unknown_ref', id: 's1', from: 's2' });
  });

  it('자기 자신을 가리키면 self_ref', () => {
    expect(errorOf(plan([group('g1', { dependsOn: ['g1'] })], []))).toEqual({ code: 'self_ref', id: 'g1' });
  });

  it('연결 그룹이 단계를 가지면 linked_group_has_steps', () => {
    const doc = plan([group('g1', { linkedRootId: 'r-child' })], [step('s1', { groupId: 'g1' }), step('s2', { groupId: 'g1' })]);
    expect(errorOf(doc)).toEqual({ code: 'linked_group_has_steps', id: 'g1', stepIds: ['s1', 's2'] });
  });

  it('단계 → 그룹 → 단계 순환을 path 로 돌려준다', () => {
    // s3 은 g2 를 기다리고, g2 의 단계 s4 는 s3 을 기다린다 → g2 는 영영 안 끝난다.
    const doc = plan([group('g2')], [step('s3', { dependsOn: ['g2'] }), step('s4', { groupId: 'g2', dependsOn: ['s3'] })]);
    expect(errorOf(doc)).toEqual({ code: 'dependency_cycle', path: ['g2', 's4', 's3', 'g2'] });
  });

  it('그룹끼리의 순환', () => {
    const doc = plan([group('g1', { dependsOn: ['g2'] }), group('g2', { dependsOn: ['g1'] })], []);
    expect(errorOf(doc)).toEqual({ code: 'dependency_cycle', path: ['g1', 'g2', 'g1'] });
  });

  it('단계가 자기 그룹을 기다리면 순환이다(그룹은 그 단계가 끝나야 끝난다)', () => {
    const doc = plan([group('g1')], [step('s1', { groupId: 'g1', dependsOn: ['g1'] })]);
    expect(errorOf(doc)?.code).toBe('dependency_cycle');
  });

  it('그룹이 자기 단계를 기다리면 순환이다(단계는 그룹의 의존을 물려받는다)', () => {
    const doc = plan([group('g1', { dependsOn: ['s1'] })], [step('s1', { groupId: 'g1' })]);
    expect(errorOf(doc)?.code).toBe('dependency_cycle');
  });

  it('그룹을 넘는 의존(순환 아님)은 통과한다', () => {
    const doc = plan(
      [group('g1'), group('g2', { dependsOn: ['s1'] })],
      [step('s1', { groupId: 'g1' }), step('s2', { groupId: 'g2' }), step('s3', { groupId: 'g1', dependsOn: ['s2'] })],
    );
    expect(validatePlan(doc)).toEqual({ ok: true });
  });

  describe('상한 경계', () => {
    const steps = (n: number) => Array.from({ length: n }, (_, i) => step(`s${i + 1}`));
    const groups = (n: number) => Array.from({ length: n }, (_, i) => group(`g${i + 1}`));

    it('단계 40 은 되고 41 은 안 된다', () => {
      expect(validatePlan(plan([], steps(PLAN_LIMITS.steps)))).toEqual({ ok: true });
      expect(errorOf(plan([], steps(PLAN_LIMITS.steps + 1)))).toEqual({ code: 'limit_exceeded', what: 'steps', limit: 40 });
    });

    it('그룹 8 은 되고 9 는 안 된다', () => {
      expect(validatePlan(plan(groups(PLAN_LIMITS.groups), []))).toEqual({ ok: true });
      expect(errorOf(plan(groups(PLAN_LIMITS.groups + 1), []))).toEqual({ code: 'limit_exceeded', what: 'groups', limit: 8 });
    });

    it('dependsOn 8 은 되고 9 는 안 된다', () => {
      const ok = plan([], [...steps(9).slice(1), step('s1', { dependsOn: steps(9).slice(1, 9).map((s) => s.id) })]);
      expect(validatePlan(ok)).toEqual({ ok: true });
      const over = plan([], [...steps(10).slice(1), step('s1', { dependsOn: steps(10).slice(1).map((s) => s.id) })]);
      expect(errorOf(over)).toEqual({ code: 'limit_exceeded', what: 'dependsOn', limit: 8, id: 's1' });
    });

    it('글자 수는 코드 포인트로 센다 — 이모지 120 개 제목은 된다', () => {
      expect(validatePlan(plan([], [step('s1', { title: '🙂'.repeat(120) })]))).toEqual({ ok: true });
      expect(errorOf(plan([], [step('s1', { title: 'a'.repeat(121) })]))).toEqual({ code: 'limit_exceeded', what: 'title', limit: 120, id: 's1' });
    });

    it('goal 200 · next 300 · blocked 300', () => {
      expect(validatePlan({ goal: 'a'.repeat(200), groups: [], steps: [], next: 'a'.repeat(300), blocked: 'a'.repeat(300) })).toEqual({ ok: true });
      expect(errorOf({ goal: 'a'.repeat(201), groups: [], steps: [] })?.code).toBe('limit_exceeded');
      expect(errorOf({ goal: '', groups: [], steps: [], next: 'a'.repeat(301) })).toMatchObject({ what: 'next' });
      expect(errorOf({ goal: '', groups: [], steps: [], blocked: 'a'.repeat(301) })).toMatchObject({ what: 'blocked' });
    });
  });
});

describe('derivePlan — 파생 상태', () => {
  it('빈 계획은 빈 결과', () => {
    expect(derivePlan(plan([], []))).toEqual({});
    expect(planProgress(plan([], []))).toEqual({ done: 0, total: 0, blocked: 0, waiting: 0 });
  });

  it('앞 단계가 덜 끝났으면 waiting(waitingOn), 끝나면 ready', () => {
    const doc = plan([], [step('s1', { title: '리뷰' }), step('s2', { title: '배포', dependsOn: ['s1'] })]);
    expect(derivePlan(doc).s2).toEqual({ derived: 'waiting', waitingOn: ['s1'], startedEarly: false });
    doc.steps[0]!.state = 'done';
    expect(derivePlan(doc).s2).toEqual({ derived: 'ready', waitingOn: [], startedEarly: false });
  });

  it('앞 단계 미완료인데 active 면 막지 않고 startedEarly', () => {
    const doc = plan([], [step('s1'), step('s2', { state: 'active', dependsOn: ['s1'] })]);
    expect(derivePlan(doc).s2).toEqual({ derived: 'active', waitingOn: ['s1'], startedEarly: true });
  });

  it('blocked·done 은 선언 그대로', () => {
    const d = derivePlan(plan([], [step('s1', { state: 'blocked' }), step('s2', { state: 'done' })]));
    expect(d.s1!.derived).toBe('blocked');
    expect(d.s2!.derived).toBe('done');
  });

  it('그룹의 의존은 그 안 단계가 물려받는다', () => {
    const doc = plan(
      [group('g1'), group('g2', { dependsOn: ['g1'] })],
      [step('s1', { groupId: 'g1' }), step('s2', { groupId: 'g2' })],
    );
    const d = derivePlan(doc);
    expect(d.g2).toEqual({ derived: 'waiting', waitingOn: ['g1'], startedEarly: false });
    expect(d.s2).toEqual({ derived: 'waiting', waitingOn: ['g1'], startedEarly: false });
  });

  it('의존 대상이 그룹이면 그 그룹 단계가 다 done 일 때만 풀린다 — A = B + C 완료', () => {
    const doc = plan(
      [group('g1', { title: 'B' }), group('g2', { title: 'C' })],
      [
        step('s1', { groupId: 'g1', state: 'done' }),
        step('s2', { groupId: 'g1', state: 'active' }),
        step('s3', { groupId: 'g2', state: 'done' }),
        step('s4', { title: 'A', dependsOn: ['g1', 'g2'] }),
      ],
    );
    let d = derivePlan(doc);
    expect(d.g1!.derived).toBe('active');
    expect(d.g2!.derived).toBe('done');
    expect(d.s4).toMatchObject({ derived: 'waiting', waitingOn: ['g1'] });
    doc.steps[1]!.state = 'done';
    d = derivePlan(doc);
    expect(d.g1!.derived).toBe('done');
    expect(d.s4!.derived).toBe('ready');
  });

  it('그룹 상태는 단계에서 모은다 — 막힌 단계가 있으면 blocked, 손댔으면 active, 아니면 ready', () => {
    expect(derivePlan(plan([group('g1')], [step('s1', { groupId: 'g1' }), step('s2', { groupId: 'g1', state: 'blocked' })])).g1!.derived).toBe('blocked');
    expect(derivePlan(plan([group('g1')], [step('s1', { groupId: 'g1' }), step('s2', { groupId: 'g1', state: 'done' })])).g1!.derived).toBe('active');
    expect(derivePlan(plan([group('g1')], [step('s1', { groupId: 'g1' })])).g1!.derived).toBe('ready');
  });

  it('앞 그룹이 덜 끝났는데 그룹 안 단계가 시작됐으면 그룹도 startedEarly', () => {
    const doc = plan([group('g1'), group('g2', { dependsOn: ['g1'] })], [step('s1', { groupId: 'g1' }), step('s2', { groupId: 'g2', state: 'active' })]);
    expect(derivePlan(doc).g2).toEqual({ derived: 'active', waitingOn: ['g1'], startedEarly: true });
  });

  it('빈 그룹은 끝난 것이 아니다 — 뒤의 단계가 곧바로 ready 가 되지 않는다', () => {
    const d = derivePlan(plan([group('g1')], [step('s1', { dependsOn: ['g1'] })]));
    expect(d.g1!.derived).toBe('ready');
    expect(d.s1).toMatchObject({ derived: 'waiting', waitingOn: ['g1'] });
  });

  describe('연결 그룹(다른 스레드가 정본)', () => {
    const doc = () => plan([group('g1', { linkedRootId: 'r-child' })], [step('s1', { dependsOn: ['g1'] })]);

    it('연결 스레드가 다 끝났으면 done, 뒤 단계는 ready', () => {
      const d = derivePlan(doc(), new Map([['r-child', { done: 3, total: 3, blocked: 0, waiting: 0 }]]));
      expect(d.g1!.derived).toBe('done');
      expect(d.s1!.derived).toBe('ready');
    });

    it('막힌 것이 있으면 blocked, 끝난 것이 있으면 active', () => {
      expect(derivePlan(doc(), new Map([['r-child', { done: 1, total: 3, blocked: 1, waiting: 0 }]])).g1!.derived).toBe('blocked');
      expect(derivePlan(doc(), new Map([['r-child', { done: 1, total: 3, blocked: 0, waiting: 1 }]])).g1!.derived).toBe('active');
    });

    it('계획이 아직 없는 스레드(맵에 없음)는 끝나지 않았다', () => {
      const d = derivePlan(doc());
      expect(d.g1!.derived).toBe('ready');
      expect(d.s1!.derived).toBe('waiting');
    });

    it("'hidden' 이면 판정하지 않는다 — hidden 으로 감추고, 뒤 단계는 풀리지 않는다", () => {
      const linked = new Map([['r-child', 'hidden' as const]]);
      const d = derivePlan(doc(), linked);
      expect(d.g1).toEqual({ derived: 'hidden', waitingOn: [], startedEarly: false });
      expect(d.s1).toMatchObject({ derived: 'waiting', waitingOn: ['g1'] });
      expect(planProgress(doc(), linked)).toEqual({ done: 0, total: 2, blocked: 0, waiting: 1 });
    });
  });

  it('검증을 거치지 않은 순환 문서에서도 멈추지 않는다', () => {
    const doc = plan([], [step('s1', { dependsOn: ['s2'] }), step('s2', { dependsOn: ['s1'] })]);
    const d = derivePlan(doc);
    expect(d.s1!.derived).toBe('waiting');
    expect(d.s2!.derived).toBe('waiting');
  });
});

describe('planProgress', () => {
  it('단계는 하나씩, 연결 그룹은 한 단위로, 빈 그룹은 세지 않는다', () => {
    const doc = plan(
      [group('g1'), group('g2', { linkedRootId: 'r-child' }), group('g3')],
      [
        step('s1', { groupId: 'g1', state: 'done' }),
        step('s2', { groupId: 'g1', state: 'blocked' }),
        step('s3', { dependsOn: ['g2'] }),
      ],
    );
    const linked = new Map([['r-child', { done: 5, total: 5, blocked: 0, waiting: 0 }]]);
    expect(planProgress(doc, linked)).toEqual({ done: 2, total: 4, blocked: 1, waiting: 0 });
    expect(planProgress(doc)).toEqual({ done: 1, total: 4, blocked: 1, waiting: 1 });
  });
});

describe('diffDerived', () => {
  it('새로 ready·waiting 이 된 노드만 실린다(새로 더한 노드 포함)', () => {
    const doc = plan([], [step('s1', { state: 'active' }), step('s2', { dependsOn: ['s1'] }), step('s3')]);
    const before = derivePlan(doc);
    doc.steps[0]!.state = 'done';
    doc.steps.push(step('s4', { dependsOn: ['s3'] }));
    const after = derivePlan(doc);
    expect(diffDerived(before, after)).toEqual({ nowReady: ['s2'], nowWaiting: ['s4'] });
  });

  it('바뀐 것이 없으면 빈 목록', () => {
    const doc = plan([], [step('s1'), step('s2', { dependsOn: ['s1'] })]);
    expect(diffDerived(derivePlan(doc), derivePlan(doc))).toEqual({ nowReady: [], nowWaiting: [] });
  });
});
