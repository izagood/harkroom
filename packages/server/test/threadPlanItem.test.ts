import { describe, it, expect } from 'vitest';
import type { PlanDoc } from '@harkroom/shared';
import { applyPlanItem } from '../src/services/threadPlanItem.js';

const doc = (): PlanDoc => ({
  goal: 'g',
  groups: [{ id: 'g1', title: 'G', dependsOn: [] }],
  steps: [
    { id: 's1', title: 'a', state: 'pending', groupId: 'g1', links: [], dependsOn: [] },
    { id: 's2', title: 'b', state: 'pending', links: [{ kind: 'pr', repo: 'o/r', number: 1 }], dependsOn: ['s1', 'g1'] },
  ],
});
const ok = (r: ReturnType<typeof applyPlanItem>) => {
  if ('error' in r) throw new Error(JSON.stringify(r.error));
  return r;
};

describe('applyPlanItem — 단계·그룹 하나의 병합', () => {
  it('계획이 없으면 no_plan, ifRev 가 다르면 rev_conflict', () => {
    expect(applyPlanItem(null, { title: 'x' })).toEqual({ error: { code: 'no_plan' } });
    expect(applyPlanItem({ doc: doc(), rev: 3 }, { id: 's1', state: 'done', ifRev: 2 })).toEqual({ error: { code: 'rev_conflict', rev: 3 } });
  });

  it('id 없이 더하면 다음 번호를 고르고, after 로 자리를 정한다', () => {
    const r = ok(applyPlanItem({ doc: doc(), rev: 1 }, { title: 'c', after: 's1' }));
    expect(r.id).toBe('s3');
    expect(r.doc.steps.map((s) => s.id)).toEqual(['s1', 's3', 's2']);
    const g = ok(applyPlanItem({ doc: doc(), rev: 1 }, { type: 'group', title: 'H', after: null }));
    expect(g.id).toBe('g2');
    expect(g.doc.groups.map((x) => x.id)).toEqual(['g2', 'g1']);
  });

  it('고칠 때 다른 칸·다른 노드는 그대로다', () => {
    const before = doc();
    const r = ok(applyPlanItem({ doc: before, rev: 1 }, { id: 's2', state: 'active' }));
    expect(r.doc.steps[1]).toEqual({ ...before.steps[1], state: 'active' });
    expect(r.doc.steps[0]).toBe(before.steps[0]);
    expect(before.steps[1]!.state).toBe('pending');
  });

  it('addDependsOn·removeDependsOn 은 남이 단 간선을 지우지 않는다, dependsOn 은 통째 교체', () => {
    expect(ok(applyPlanItem({ doc: doc(), rev: 1 }, { id: 's2', removeDependsOn: ['g1'] })).doc.steps[1]!.dependsOn).toEqual(['s1']);
    expect(ok(applyPlanItem({ doc: doc(), rev: 1 }, { id: 's1', addDependsOn: ['s2'] })).doc.steps[0]!.dependsOn).toEqual(['s2']);
    expect(ok(applyPlanItem({ doc: doc(), rev: 1 }, { id: 's2', dependsOn: [] })).doc.steps[1]!.dependsOn).toEqual([]);
  });

  it('링크는 같은 것을 두 번 넣지 않고, 같은 꼴로 뺀다', () => {
    const same = ok(applyPlanItem({ doc: doc(), rev: 1 }, { id: 's2', addLinks: [{ kind: 'pr', repo: 'O/R', number: 1 }] }));
    expect(same.doc.steps[1]!.links).toHaveLength(1);
    const gone = ok(applyPlanItem({ doc: doc(), rev: 1 }, { id: 's2', removeLinks: [{ kind: 'pr', repo: 'o/r', number: 1 }] }));
    expect(gone.doc.steps[1]!.links).toEqual([]);
  });

  it('지우면 다른 노드의 dependsOn 에서도 빠지고, 그룹을 지우면 그 단계는 그룹 밖으로 나온다', () => {
    const s = ok(applyPlanItem({ doc: doc(), rev: 1 }, { id: 's1', remove: true }));
    expect(s.doc.steps.map((x) => [x.id, x.dependsOn])).toEqual([['s2', ['g1']]]);
    const g = ok(applyPlanItem({ doc: doc(), rev: 1 }, { type: 'group', id: 'g1', remove: true }));
    expect(g.doc.groups).toEqual([]);
    expect(g.doc.steps.map((x) => [x.id, x.groupId ?? null, x.dependsOn])).toEqual([['s1', null, []], ['s2', null, ['s1']]]);
  });

  it('없는 노드·그 종류에 없는 칸·새 노드의 빈 제목은 거절', () => {
    expect(applyPlanItem({ doc: doc(), rev: 1 }, { id: 's9', state: 'done' })).toEqual({ error: { code: 'unknown_item', id: 's9' } });
    expect(applyPlanItem({ doc: doc(), rev: 1 }, { type: 'group', id: 'g1', state: 'done' }))
      .toEqual({ error: { code: 'field_not_for_type', field: 'state', type: 'group' } });
    expect(applyPlanItem({ doc: doc(), rev: 1 }, { id: 's1', linkedRootId: null }))
      .toEqual({ error: { code: 'field_not_for_type', field: 'linkedRootId', type: 'step' } });
    expect(applyPlanItem({ doc: doc(), rev: 1 }, { state: 'done' })).toEqual({ error: { code: 'title_required' } });
    expect(applyPlanItem({ doc: doc(), rev: 1 }, { title: 'x', after: 's9' })).toEqual({ error: { code: 'unknown_item', id: 's9' } });
  });
});
