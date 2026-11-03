/** 계획판 P6 화면 — ready 줄 제목(meta, 글자로만) · 펼침 기억 로그아웃 정리. */
import { describe, it, expect, beforeEach } from 'vitest';
import type { MessageRow } from '@harkroom/shared';
import { planReadyTitles, systemLineShape, systemRecordIcon } from '../src/lib/systemLine';
import { clearPlanOpenKeys, loadPlanOpen, savePlanOpen } from '../src/lib/threadPlan';

const line = (meta: Record<string, unknown>) => ({ kind: 'system', meta } as unknown as MessageRow);

describe('계획판 ready 줄', () => {
  it('기록 줄(▶)로 그리고, 제목은 meta 의 id 순서대로 글자만 꺼낸다', () => {
    const m = line({
      i18n: { key: 'system.plan.ready', args: { n: 2, ids: 's2 · g1' } },
      planReady: { ids: ['s2', 'g1', 'bad', '__proto__'], rev: 3, titles: { s2: '@someone <b>배포</b>', g1: 'x'.repeat(200), bad: 'no' } },
    });
    expect(systemLineShape(m)).toBe('record');
    expect(systemRecordIcon(m)).toBe('▶');
    const titles = planReadyTitles(m);
    expect(titles.map(([id]) => id)).toEqual(['s2', 'g1']);
    expect(titles[0]![1]).toBe('@someone <b>배포</b>');
    expect(titles[1]![1]).toHaveLength(120);
  });

  it('모양이 틀리면 빈 목록 — 시스템 줄이 아니거나 titles 가 없거나 문자열이 아니면', () => {
    expect(planReadyTitles({ kind: 'user', meta: { planReady: { ids: ['s1'], titles: { s1: 'a' } } } } as unknown as MessageRow)).toEqual([]);
    expect(planReadyTitles(line({ planReady: { ids: ['s1'] } }))).toEqual([]);
    expect(planReadyTitles(line({ planReady: { ids: ['s1'], titles: { s1: 5 } } }))).toEqual([]);
  });
});

describe('펼침 기억 정리', () => {
  beforeEach(() => localStorage.clear());
  it('로그아웃 때 계획판 펼침 키만 지운다', () => {
    savePlanOpen('r1', true);
    savePlanOpen('r2', true);
    localStorage.setItem('harkroom.other', 'keep');
    clearPlanOpenKeys();
    expect(loadPlanOpen('r1')).toBe(false);
    expect(loadPlanOpen('r2')).toBe(false);
    expect(localStorage.getItem('harkroom.other')).toBe('keep');
  });
});
