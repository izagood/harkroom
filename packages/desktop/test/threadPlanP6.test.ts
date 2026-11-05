/** 계획판 P6 화면 — ready 줄 제목(meta, 글자로만) · 펼침 기억 로그아웃 정리. */
import { describe, it, expect, beforeEach } from 'vitest';
import type { MessageRow } from '@harkroom/shared';
import { planReadyTitles, systemLineShape, systemRecordIcon } from '../src/lib/systemLine';
import { clearPlanOpenKeys, loadPlanOpen, savePlanOpen } from '../src/lib/threadPlan';

const line = (meta: Record<string, unknown>) => ({ kind: 'system', meta } as unknown as MessageRow);

describe('계획판 ready 줄', () => {
  it('기록 줄(▶)로 그리고, id 순서대로 제목(없으면 id)을 글자로만 꺼낸다', () => {
    const m = line({
      i18n: { key: 'system.plan.ready', args: { n: 3, ids: 's2 · g1 · s5' } },
      planReady: { ids: ['s2', 'g1', 's5', 'bad', '__proto__'], rev: 3, titles: { s2: '@someone <b>배포</b>', g1: 'x'.repeat(200), bad: 'no' } },
    });
    expect(systemLineShape(m)).toBe('record');
    expect(systemRecordIcon(m)).toBe('▶');
    const titles = planReadyTitles(m);
    expect(titles.map((x) => x.id)).toEqual(['s2', 'g1', 's5']);
    expect(titles[0]!.label).toBe('@someone <b>배포</b>');
    expect(titles[1]!.label).toHaveLength(120);
    // 제목이 없는 단계는 id 로 대신한다(designer 2).
    expect(titles[2]!.label).toBe('s5');
  });

  it('제목이 하나도 없거나 모양이 틀리면 빈 목록 — 서버 문장(id 목록)을 그대로 쓴다', () => {
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
    // 지우면 기본값으로 돌아간다 — 닫아 둔 기억도 남지 않는다.
    expect(localStorage.getItem('harkroom.threadPlan.open.r1')).toBeNull();
    expect(localStorage.getItem('harkroom.threadPlan.open.r2')).toBeNull();
    expect(loadPlanOpen('r1')).toBe(true);
    expect(localStorage.getItem('harkroom.other')).toBe('keep');
  });
});
