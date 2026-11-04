import { describe, expect, it } from 'vitest';
import { findPlanRefs, parsePlanRef, planAskRecipient, planRefText, type PlanDoc } from '../src/planGraph.js';
import rules from './fixtures/planRef.json' with { type: 'json' };

// 아이폰 앱도 이 자료로 같은 규칙을 잰다 — 고치면 그쪽 복사본도 고친다.
describe('단계 링크', () => {
  it.each(rules.parse)('읽기: $in', ({ in: raw, out }) => { expect(parsePlanRef(raw)).toEqual(out); });

  it.each(rules.find)('본문에서 찾기: $in', ({ in: body, out }) => {
    expect(findPlanRefs(body).map(({ length: _l, ...r }) => r)).toEqual(out);
  });

  it('찾은 자리의 글자가 다시 그 링크로 읽힌다', () => {
    const body = rules.find[0]!.in;
    for (const r of findPlanRefs(body)) expect(parsePlanRef(body.slice(r.index, r.index + r.length))?.stepId).toBe(r.stepId);
  });

  it.each(rules.text)('짓기: $title', ({ root, step, title, out }) => { expect(planRefText(root, step, title)).toBe(out); });

  it('긴 제목을 자르고, 지은 글자는 다시 읽힌다', () => {
    const made = planRefText('11111111-2222-4333-8444-555555555555', 's3', '가'.repeat(200));
    expect(made.endsWith('…」')).toBe(true);
    expect(parsePlanRef(made)?.title?.length).toBe(81);
  });
});

describe('받는 이', () => {
  const kindOf = (id: string) => ((rules.kinds as Record<string, 'human' | 'agent'>)[id] ?? null);
  it.each(rules.recipient)('$doc → $out', ({ doc, step, out }) => {
    expect(planAskRecipient(doc as unknown as Pick<PlanDoc, 'groups' | 'steps' | 'managerId'>, step, kindOf)).toEqual(out);
  });
});
